---
title: Compile System
tags: [compile, merkle, hash, staleness, review, llm]
category: architecture
updated: 2026-08-12
---

# Compile 系统

## 概述

`compile_arguments` 工具对一个 Claim 及其完整论证子图做确定性结构检查 + LLM 驱动的逻辑审查，返回 `passed` 或 `failed` 并将结果写入 `compile_state` 表。未配置审查模型时，跑完结构检查后默认通过并附警告。

## 核心文件

| 文件 | 职责 |
|------|------|
| `src/compile-service.ts` | 编排各 reviewer，写入 compile_state |
| `src/compile-reviewers.ts` | 各类 reviewer 实现 |
| `src/compile-prompts.ts` | LLM prompt 模板 |
| `src/merkle-hash.ts` | 论证图 Merkle 哈希，用于 staleness 检测 |

## compile_state 裁决

compile 裁决只存在 `compile_state` 表，`data.compile_status` 已删除。verdict 有三种值：

| verdict | 含义 |
|---------|------|
| `"passed"` | 最近一次 compile 通过，且论证结构未变化 |
| `"failed"` | 最近一次 compile 未通过（结构检查或 LLM 审查发现缺陷） |
| `"stale"` | 上次 passed 后，论证结构发生了变化 |

`compile_state` 行不再删除：`stale` 保留记录信息（"曾经 compile 过"），`failed` 保持 `failed`（不因无模型审查而覆盖）。

## 两条独立的失效路径

### 1. 结构失效（`invalidateCompiledClaims`）

content 或关系（`ground_ids`、`backing_ids`、`rebuttal_ids`）变更时触发：

- `compile_state.verdict` → `"stale"`，清空 `argumentHash`
- Claim 的 `status` 若为 `supported` / `disputed` / `refuted`，退回 `"proposed"`
- 只做一跳 direct 反查：子证据不在上层审查输入里，不继续 BFS 传播

### 2. 充分性失效（`revertUnsupportedClaimStatuses`）

verification 或 status 变更时触发。论证的形式没变（content 和关系都没动），所以 compile 仍为 `passed`：

- 按 Claim 当前 status 复检对应的门：`supported` 检查 A1（某条 Warrant 的 Ground 全部已核实），`disputed`/`refuted` 检查 A3/A4（存在已核实的 Rebuttal）
- 门不成立才退回 `proposed`；仍成立的不动
- 向上传播：退回的 Claim 作为上层 Ground/Rebuttal 也不再算已核实，但上层 compile 保持 `passed`
- 警告文案明确说 `do NOT re-run compile_arguments for Claim #N`

## 判定规则

### A0：status 需要 compile 通过

```typescript
// service.ts
const cs = repo.getCompileState(db, claimId);
if (cs?.verdict !== "passed") {
  throw StatusTransitionError("the argument changed after it last passed compile...");
}
```

`supported`、`disputed`、`refuted` 三种目标状态都需要 compile 通过。compile 也反向检查：跑完后若 Claim 没有 `passed` 记录，status 退回 proposed。

### 规则 C′：Claim 算不算已核实

| 节点类型 | 已核实条件 |
|----------|-----------|
| Statement | `verification === "verified"` |
| Claim | `status ∈ {supported, disputed}` |

`disputed` 作为已核实状态是因为：一个记录在案的证据冲突是已定论的状态，上层引用它获取的是 scope 而非 truth value。

## Staleness 检测机制

使用 Merkle Hash 对论证子图做内容摘要：

- `compile_arguments` 通过时，将当前 `argumentHash` 写入 `compile_state`
- 任何结构性变更（content 或关系变化）会清空 `argumentHash` 并将 verdict 设为 `"stale"`
- 哈希只覆盖 content 和关系结构，不覆盖 status/verification
- 三种角色（Ground/Backing/Rebuttal）都只算节点自己的 content 哈希，不递归子树
- 编译调度时 hash 比对若未变，跳过 LLM 审查，只跑结构检查

## 审查类型

均在 `compile_arguments` 显式调用时触发：

| 审查 | 检查内容 | 模型 |
|------|---------|------|
| `structure` | 论证结构完整性 + 7 条确定性质量规则 | 无 LLM |
| `claim` | Claim content 是否符合 Toulmin 定义 | LLM |
| `warrant` | 每个 Warrant content 是否符合 Toulmin 定义 | LLM |
| `chain` | 整体论证链路逻辑连贯性 | LLM |

`claim`/`warrant` 与 `chain` 并行执行（`Promise.all`）。当两者均有 error 时，`chain` 结果标记 `advisory: true`。

chain reviewer 收到的 Ground/Backing/Rebuttal 只有 `{id, content, type}`，不包含子树的完整论证。

Statement 证据审查（`verification: pending/verified`）是独立系统，在 `update_node` 时同步触发，不在 compile 时触发。

## 无审查模型时的行为

未配 `review.json` 时，`compile_arguments` 不再失败。结构检查照跑，全过就记为 `passed`，附加警告说逻辑没人审过。`failed` 记录保持不覆盖。

## 相关类型

```typescript
export interface CompileState {
  claimId: number;
  verdict: "passed" | "failed" | "stale";
  summary: string;
  argumentHash?: string;  // Merkle Root 哈希，passed 时写入
  createdAt: string;
}

export interface ElementReviewResult {
  reviewer: "structure" | "claim" | "warrant" | "chain";
  errors: string[];
  warnings: string[];
  infos?: string[];
  advisory?: boolean;
}
```

## 关联

- [[architecture]] — 工具全貌与三层架构
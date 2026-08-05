---
title: Compile System
tags: [compile, merkle, hash, staleness, review, llm]
category: architecture
updated: 2026-07-22
---

# Compile 系统

## 概述

`compile_arguments` 工具对一个 Claim 及其完整论证子图做 LLM 驱动的质量审查，返回 `passed` 或 `failed` 并将结果写入 `compile_status`。

## 核心文件

| 文件 | 职责 |
|------|------|
| `src/compile-service.ts` | 编排各 reviewer，写入 compile_state |
| `src/compile-reviewers.ts` | 各类 reviewer 实现 |
| `src/compile-prompts.ts` | LLM prompt 模板 |
| `src/merkle-hash.ts` | 论证图 Merkle 哈希，用于 staleness 检测 |

## compile_status 枚举（ClaimData 字段）

| 值 | 含义 |
|----|------|
| `null` | 从未 compile 过 |
| `"passed"` | 最近一次 compile 通过，且论证结构未变化 |
| `"stale"` | compile 通过后，论证结构发生了变化 |

## Staleness 检测机制

使用 Merkle Hash 对论证子图做内容摘要：
- `compile_arguments` 通过时，将当前 `argumentHash` 写入 `compile_state`
- 任何结构性变更（添加/删除 Ground、Warrant 等）会**清空** `compile_state` 并将 `compile_status` 设为 `"stale"`
- `null` 表示从未编译；`stale` 表示编译过但结构已变更——两者都会阻止状态转换

## Reviewer 类型

`ElementReviewResult.reviewer` 字段标识来源。均在 `compile_arguments` 显式调用时并行触发（`Promise.all`）：

| reviewer | 检查内容 |
|----------|---------|
| `structure` | 论证结构完整性（确定性规则，无 LLM） |
| `claim` | Claim content 是否符合 Toulmin 定义（LLM，`compile-service.reviewNodeDefinition`） |
| `warrant` | 每个 Warrant content 是否符合 Toulmin 定义（LLM，`compile-service.reviewNodeDefinition`） |
| `chain` | 整体论证链路逻辑连贯性（LLM，`compile-reviewers.runChainReview`） |

`claim`/`warrant` 与 `chain` 并行执行；当两者对同一 compile 均有 error 时，`chain` 的结果会被标记 `advisory: true`（仍计入 verdict，仅渲染上作区分）。Ground/Backing/Rebuttal 的证据审查（`review-sync.ts`，`verification: pending/verified`）是独立系统，不产出 `ElementReviewResult`，也不在 compile 时触发。

### chain reviewer — Claim-type ground 内容展开

当 Ground 是一个 Claim 节点（直接链式推理，`warrant_grounds` 中有 claim-type 条目）时，chain reviewer 收到的是**该 Claim 的 content**，而非占位文本。这确保 LLM 能对实际前置主张内容作逻辑判断。

## 状态流转约束（A0 规则）

所有非 proposed 转换统一被阻止，当 `compile_status !== "passed"`：

```typescript
// service.ts A0
if (status === "supported" || status === "disputed" || status === "refuted") {
  if (data.compile_status !== "passed") throw StatusTransitionError(...)
}
```

`supported`、`disputed`、`refuted` 三种目标状态都需要 compile 通过。不是只有 `supported` 需要 compile。

## Invalidation — Status 回退

当论证链中任意节点被修改（添加/删除/更新 Ground、Warrant 等），`invalidateCompiledClaims` 触发：

1. `compile_status` → `"stale"`
2. 若 Claim 的 `status` 为 `supported` / `disputed` / `refuted`，**回退到 `"proposed"`**

工具响应中会出现两条 warning：

```
Warning: Claim #N's compiled status has been cleared because node #M in its argument chain was modified.
Warning: Claim #N status reverted from "supported" to "proposed" because node #M in its argument chain was modified. Re-run compile_arguments and re-assess status when ready.
Hint: Call compile_arguments to verify the argument chain.
```

`status: "proposed"` 的 Claim 不触发回退（无 statusReverted warning）。这保证了 Claim 状态始终和论证链一致——不存在"supported 但 stale"的矛盾状态。

## 相关类型

```typescript
export interface CompileState {
  claimId: number;
  verdict: "passed" | "failed";
  summary: string;
  argumentHash?: string;  // Merkle Root 哈希，passed 时写入
  createdAt: string;
}

export interface CompileResult {
  claimId: number;
  verdict: "passed" | "failed";
  summary: string;
  elementReviews: ElementReviewResult[];
  compiledAt: string;
}
```

## 关联

- [[architecture]] — 工具全貌与三层架构
- [[node-semantics]] — Claim.compile_status 字段详情

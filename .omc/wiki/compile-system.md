---
title: Compile System
tags: [compile, merkle, hash, staleness, review, llm]
category: architecture
updated: 2026-07-17
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

`ElementReviewResult.reviewer` 字段标识来源。注意两套独立的审查系统：

**节点定义审查**（create/update content 时触发，同步阻断）：

| reviewer | 触发时机 |
|----------|---------|
| `claim` | create_claim / update_node 修改 claim content |
| `warrant` | create_warrant / update_node 修改 warrant content |
| `ground` | create_ground / update_node 修改 ground content |

**compile_arguments 审查**（显式调用触发）：

| reviewer | 检查内容 |
|----------|---------|
| `structure` | 论证结构完整性（确定性规则，无 LLM） |
| `chain` | 整体论证链路逻辑连贯性（LLM） |

## 状态流转约束（A0 规则）

所有非 proposed 转换统一被阻止，当 `compile_status !== "passed"`：

```typescript
// service.ts A0
if (status === "supported" || status === "disputed" || status === "refuted") {
  if (data.compile_status !== "passed") throw StatusTransitionError(...)
}
```

`supported`、`disputed`、`refuted` 三种目标状态都需要 compile 通过。不是只有 `supported` 需要 compile。

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

---
title: Structural Checks and Review
tags: [structural-check, baseline, review, findings, events, history]
category: architecture
updated: 2026-08-31
---

# 结构检查与显式 Review

> 文件名保留为 `compile-system.md`，是为了不打断旧链接；**当前系统没有 `compile_arguments`、`compile_state` 或 Merkle staleness**。旧 Compile 的设计记录见文末“历史”一节。

## 当前分工

| 层 | 回答什么 | 触发方式 | 是否阻断判断 |
|----|----------|----------|--------------|
| 输入校验 | 写入形状是否可成立：content 非空、引用存在、附件存在 | 每次写入 | 是，只拒绝非法输入 |
| 结构检查 | 当前结构是否与 qualifier 相称、判断依据是否变过 | 每次读取动态计算 | 否，返回 warning |
| 语义 review | 附件是否忠实、证据经由 warrant 能否推出命题 | 显式调用 `review(id)` | 否，返回 finding |
| 最终判断 | 命题应落在哪个 qualifier | agent/用户调用 `set_qualifier` | 最终裁决 |

创建和更新命题不会自动调用 LLM。结构检查无需模型配置；语义 review 只有显式调用时才发生。

## 结构检查

结构检查实现于 `src/structural-check.ts`，warning 定义于 `src/types.ts`。`unestablished` 表示尚未判断，因此不产生 S/A 当前状态检查；一旦命题被定档，检查按档位逐步收紧。

### 当前状态检查（S/A）

| Code | 条件 |
|------|------|
| S1 | `possibly` 及以上但证据槽为空 |
| S2 | `possibly` 及以上且附件后来不存在 |
| S3 | `possibly` 及以上但 warrant 为空 |
| S4 | `probably`/`certainly` 引用了仍为 `unestablished` 的证据或晋升 warrant |
| S5 | `possibly` 及以上且附件解析到项目根之外 |
| A1 | 命题为 `refuted`，但没有 rebuttal |
| A2 | 命题为 `refuted`，但某个 rebuttal 自身不在正向三档 |

附件采用“写硬读软”：写入时不存在会被拒绝；写入后文件被移走或删除，则读取时产生 S2/S5。

### 基线比对（R）

`set_qualifier` 是基线的唯一写入者。它在同一事务内保存：

- 本命题的 content、warrant、证据成员和反驳成员指纹；
- 每个直接引用当时的 content hash 和 qualifier。

之后读取命题时会比较当前值：

| Code | 条件 |
|------|------|
| R0 | 命题自己的 content/warrant/证据成员/反驳成员变了 |
| R1 | 判断时依赖的引用不再位于该槽位，或已被删除 |
| R2 | 直接引用的 content 变了 |
| R3 | 直接引用的 qualifier 变了 |

R 族回答“作判断时依据的东西还是不是原来那份”，不等价于旧版 compile cache。

### Warning 身份与复燃

warning 不落状态表。其 id 从 `(node id, code, trigger, recheck fingerprint)` 派生：

1. 当前图计算 warning 集合；
2. 到 append-only 事件流查同 id 的 dismiss；
3. 命中则显示 `acknowledged`，否则显示 `pending`；
4. 命题或引用发生相关变化后 fingerprint 改变，产生新 id，旧 dismiss 自然失效。

因此“复燃”是读取时计算的结果，不需要 stale 字段或后台失效任务。

## 显式语义 Review

`review(id)` 只审查**一条命题的局部视图**：命题自身、直接证据、附件和 warrant；不递归整张子图，也不把目标命题当前 qualifier 交给 reviewer。

| 问题 | 含义 | 引证要求 |
|------|------|----------|
| Q1 | 附件是否真的表达了该命题声称的内容 | attachment + 原文 quote；协议期望 locator，但当前 F1–F4 不因 locator 为空而拒收；无附件时为 `n/a` |
| Q2 | 即使接受证据，warrant 是否足以推出 content | 引用目标命题或直接证据命题的 content/warrant 原文片段 |

每条 finding 必须经过 F1–F4 机械校验：quote 非空、Q1 附件属于目标槽、Q2 node 在 review 视野内、quote 是对应槽位文本的逐字子串（仅折叠空白）。单条不合格 finding 被拒收并记入 review 事件，其余合格项仍可落库。

未配置 `--review-config`、子进程失败、附件读取工具被拒或输出无法解析时，review 返回不可用并且**不记录 pass**。有效 review 无论“有问题”还是“没问题”都写入事件流，以区分“审过且未发现问题”和“从未审过”。

## Finding 与 Dismiss

- finding 不会因图变化自动过期；它是审查器当时提出过的意见。
- 处理方式是修正图，或调用 `dismiss` 对单条 warning/finding 给出理由。
- dismiss 只追加一条事件，不删除原对象；处理状态由事件流派生。
- warning id 可能因结构变化而复燃成新 id；finding id 不随图变化。

## 历史断代

`90c7acb`（2026-08-20）是明确边界：该提交删除旧三节点模型的 compile/status/verification/Merkle 子系统，切换到 Proposition、qualifier、动态 warning 与显式 review。更早提交中的 `compile_arguments`、`compile_state` 和 Merkle 失效传播只属于历史，不应作为当前接口或迁移指南；旧表只用于识别并拒绝旧库。

## 关联

- [Architecture Overview](architecture.md)
- [Development Conventions](dev-conventions.md)
- `docs/design.md` §2–§3
- `docs/api.md` §4–§5

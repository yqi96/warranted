---
title: Architecture Overview
tags: [architecture, typescript, sqlite, mcp]
category: architecture
updated: 2026-08-31
---

# Warranted 架构总览

## 项目定位

Warranted 是面向研究 agent 的 MCP 服务。它把研究结论保存为可追溯的命题图：命题陈述什么、依赖哪些证据、为什么能由证据推出、受到什么反驳、当前可信度如何，以及这些判断后来为什么改变。

当前本体是**一种节点（Proposition）+ 五个槽位**，不是旧版 Claim/Warrant/Statement 三节点模型。规范来源是 `docs/design.md` 和 `docs/api.md`；本页只描述代码落点。

## 技术栈与启动

| 组件 | 技术 |
|------|------|
| Runtime | Bun >= 1.0.0 |
| Language | TypeScript（strict mode） |
| Database | SQLite（文件库使用 WAL，启用外键） |
| MCP | `@modelcontextprotocol/sdk` |
| Review subprocess | `@anthropic-ai/claude-agent-sdk` |
| Validation | Zod |
| Browser proxy | `chrome-devtools-mcp`（固定依赖版本、每 session 独立进程） |

主服务：`bun src/index.ts [--db-path ./custom.db] [--review-config ./review.json] [--no-persist]`

默认数据库：`.toulmin/graph.db`。旧 `.toulmin/argument.db` 原地保留为历史归档，不会自动迁移。

可视化器：`bun run viz`，默认读取同一个 `graph.db`。

## 代码边界

```text
schema.ts / db.ts           Schema 唯一事实源、建库、旧库拒绝、FTS 探测
          ↓
repo.ts                     纯 SQL 与行级读写
          ↓
service.ts                  事务、输入不变量、事件、基线、命题操作
          ↓
structural-check.ts         读取时派生的结构警告与“该重查”警告
review-*.ts                 显式语义审查、finding 校验与持久化
          ↓
tools.ts                    11 个 MCP 工具的 schema、调用与返回形状
          ↓
index.ts                    CLI、stdio transport、生命周期与优雅关闭
```

`tools.ts` 只负责输入/输出形状；业务规则放在 `service.ts`。Schema 只存在于 `src/schema.ts`，不再维护第二份 `sql/schema.sql`。

## 11 个 MCP 工具

| 类别 | 工具 |
|------|------|
| 写入（5） | `create_propositions`、`update_proposition`、`set_qualifier`、`promote_warrant`、`delete_proposition` |
| 读取（4） | `get_argument`、`find_propositions`、`get_stats`、`get_history` |
| 意见（2） | `review`、`dismiss` |

写入与判断刻意分开：创建命题一律落 `unestablished`；只有 `set_qualifier` 能改变可信度并写入判断基线。`review` 是显式、慢且可选的第二意见，创建或更新命题不会自动触发它。

## 数据模型

### 命题与槽位

`propositions` 是唯一节点表。每条命题有五个槽位：

| 槽位 | 存储 | 说明 |
|------|------|------|
| content | `propositions.content` | 可判断真假的陈述 |
| evidence | `evidence_attachments` + `evidence_nodes` | 文件或其他命题的引用 |
| warrant | `warrant_text` 或 `warrant_node_id` | 内联理由，或晋升后的独立命题；两种形态互斥 |
| rebuttal | `rebuttals` | 攻击该命题的其他命题引用 |
| qualifier | `propositions.qualifier` | `refuted → unestablished → possibly → probably → certainly` |

Ground/Backing 是从中心命题看证据的两种视角；Warrant/Rebuttal 是槽位。它们不再是节点类型。

### 留痕、意见与基线

| 表 | 作用 |
|----|------|
| `events` | append-only 事件流；create/update/delete/qualifier/promote/review/dismiss 均留痕 |
| `findings` | review 事件的查询索引；处理状态由 dismiss 事件派生，不存可变 status |
| `baseline_head` | 最近一次 `set_qualifier` 时本命题的结构指纹 |
| `baseline_refs` | 当时直接引用的 content hash 与 qualifier 快照 |
| `propositions_fts` | FTS5 trigram 索引；不可用时搜索降级为 LIKE |

结构警告不是数据库状态：每次读取按当前图重新计算。warning id 包含重查指纹；图发生相关变化后会生成新 id，因此旧 dismiss 不会误压住新问题。

## 写入与删除语义

- 硬输入不变量包括：content 非空、引用命题存在、附件路径在写入时存在。
- 结构检查和 review finding 都是醒目的意见，不是写入门禁；agent 与用户通过 `set_qualifier` 作最终判断。
- 证据槽存引用而非所有权。`delete_proposition` 只删除被点名的命题，并从引用方槽位摘除关系；不会级联删除其他命题。
- 删除前会把整条命题的 before 快照写入事件流，事件没有节点外键，因此墓碑能活过节点删除。

## 关键文件

| 文件 | 说明 |
|------|------|
| `src/schema.ts` | Schema、枚举、旧表清单、FTS SQL |
| `src/db.ts` | SQLite 连接、WAL、外键、旧库拒绝、FTS 降级 |
| `src/repo.ts` | 数据访问与事件/基线/finding 索引 |
| `src/service.ts` | 命题操作、事务、判断与历史 |
| `src/structural-check.ts` | 当前状态检查和基线比对 |
| `src/review-run.ts` | 单命题显式 review 编排 |
| `src/review-validate.ts` | finding 引证的 F1–F4 机械校验 |
| `src/tools.ts` | 11 个 MCP 工具注册 |
| `src/content/` | 工具与参数说明、警告/通知文案 |
| `visualizer/` | Proposition 图可视化与 HTTP/SSE API |
| `src/browser/index.ts` | 隔离 Chrome session 的 MCP 代理 |
| `tests/` | 当前单元/集成测试与 agent-eval |

## 历史边界

2026-08-20 的 `90c7acb` 将旧“Claim/Warrant/Statement + roles + compile/status/verification/tags”本体断代为当前 Proposition 模型。下列名称只应出现在明确标注的历史说明中：`nodes`、`compile_state`、`warrant_grounds`、`warrant_backings`、`rebuttal_targets`、`tags`、`compile_arguments`、Merkle staleness。

## 关联

- [Structural Checks and Review](compile-system.md)
- [Visualizer Architecture](visualizer.md)
- [Development Conventions](dev-conventions.md)
- `docs/design.md` — 本体与认识论规范
- `docs/api.md` — 工具契约

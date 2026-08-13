---
title: Architecture Overview
tags: [architecture, typescript, sqlite, mcp]
category: architecture
updated: 2026-08-12
---

# warranted 架构总览

## 项目定位

MCP (Model Context Protocol) 服务器，实现 Toulmin 论证模型，用于科学推理和证据管理。支持论文复现、假设验证、科学主张管理等研究任务。为 AI agent 提供结构化论证图管理，使每个结论都有可追溯的论证图。

## 技术栈

| 组件 | 技术 |
|------|------|
| Runtime | Bun >= 1.0.0 |
| Language | TypeScript (strict mode) |
| Database | SQLite (WAL mode，单表 + JSON data 列) |
| MCP SDK | `@anthropic-ai/claude-agent-sdk` ^0.3.201 |
| Validation | Zod ^3.23.8 |

启动命令：`bun src/index.ts [--db-path ./custom.db] [--review-config ./review.json]`

默认 DB：`.toulmin/argument.db`

## 三层架构

```
Repository (repo.ts)    — 纯 SQL CRUD，JSON_EXTRACT 查询
        ↓
Service (service.ts)    — 业务逻辑、验证、状态流转、级联规则
        ↓
Tools (tools.ts)        — MCP 工具注册、输入验证、错误处理（21 个工具）
```

修改规则：新功能先在 tools.ts 注册，再在 service.ts 实现；repo.ts 只做纯 SQL。

## 21 个 MCP 工具

- **创建(5)**: create_claim, create_statement, create_warrant, create_statements, verify_statements
- **标签(5)**: create_tag, create_tags, list_tags, tag_nodes, update_tag, rename_tag, merge_tags
- **读取(6)**: list_claims, list_statements, get_argument, get_node, search_nodes, get_stats
- **修改(1)**: update_node
- **删除(1)**: delete_node
- **编译(1)**: compile_arguments

## 关键文件

| 文件 | 说明 |
|------|------|
| `src/index.ts` | 入口，CLI 参数解析，stdio transport |
| `src/service.ts` | 核心业务逻辑（最复杂） |
| `src/tools.ts` | MCP 工具注册 |
| `src/repo.ts` | 数据访问层 |
| `src/types.ts` | 类型定义 |
| `src/content/` | 工具描述、字段提示、警告文案（拆分为 tools.ts、elements.ts、params.ts、warnings.ts、hints.ts、messages.ts） |
| `src/compile-service.ts` | Compile 系统核心 |
| `src/compile-reviewers.ts` | 各类 reviewer 实现 |
| `src/compile-prompts.ts` | Compile LLM prompt 模板 |
| `src/merkle-hash.ts` | 论证图 Merkle 哈希（staleness 检测） |
| `src/tag-similarity.ts` | 基于嵌入的标签相似度推荐 |
| `src/concurrency.ts` | 并发控制（mapLimit，默认 4 路并发） |
| `sql/schema.sql` | SQLite schema |
| `agents/` | Claude Code agent 定义（Toulmin 层：toulmin-researcher、toulmin-explorer；object 层：code-experimenter、discrepancy-auditor、code-optimizer） |
| `skills/` | paper-reproduce、literature-writing、literature-survey、cite-review、overleaf-setup 技能 |
| `visualizer/` | D3.js v7 模块化可视化（双阶段，14 JS 模块） |
| `tests/` | 测试文件，bun test |

## 数据模型

单张 `nodes` 表，type-specific 字段存储在 JSON `data` 列，5 个 JSON_EXTRACT 索引。

`nodes.type` 只有三种值：**claim / warrant / statement**。Ground、Backing、Rebuttal 是**角色**，由三张关系表决定：

| 角色 | 来源 | 语义 |
|------|------|------|
| ground | `warrant_grounds.ground_id` | 某 warrant 的证据基础 |
| backing | `warrant_backings.statement_id` | 某 warrant 的权威支撑 |
| rebuttal | `rebuttal_targets.statement_id` | 反驳某 claim 或 warrant |

三种角色都接受 Statement 或 Claim 节点。判据：记录（观察到或读到的）是 Statement；论证结论是 Claim。一个节点可同时扮演多个角色。

### 标签系统

| 表 | 作用 |
|----|------|
| `tags` | 标签注册（name UNIQUE, description, claim_id） |
| `node_tags` | 多对多关系（node_id, tag_id, ON UPDATE CASCADE） |

标签必须先注册再使用。`create_tag` / `create_tags` 注册，`tag_nodes` 批量增减。`rename_tag` 利用 `ON UPDATE CASCADE` 跟随，`merge_tags` 合并一项到另一项并去重。`create_claim(tags=[])` 创建时直接打标签。`search_nodes(keyword, tags)` 按标签筛选。

## 级联删除规则

- **Claim** 删除需 `cascade=true`，连带删 Warrant（Ground Statement 独立保留）
- **Warrant** 级联删除时从关系表中移除关联 Ground/Backing 记录
- **Statement（Ground 角色）** 自动从所有 `warrant_grounds` 记录中移除
- **Statement（Backing/Rebuttal 角色）** 直接删除

## 关联

- [[compile-system]] — Compile 系统详细设计
- [[visualizer]] — 可视化器架构
- [[dev-conventions]] — 开发规范
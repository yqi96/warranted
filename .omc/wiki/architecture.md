---
title: Architecture Overview
tags: [architecture, typescript, sqlite, mcp]
category: architecture
updated: 2026-07-25
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
| MCP SDK | `@modelcontextprotocol/sdk` ^1.25.1 |
| Validation | Zod ^3.23.8 |

启动命令：`bun src/index.ts [--db-path ./custom.db] [--review-config ./review.json]`

默认 DB：`.toulmin/argument.db`

## 三层架构

```
Repository (repo.ts)    — 纯 SQL CRUD，JSON_EXTRACT 查询
        ↓
Service (service.ts)    — 业务逻辑、验证、状态流转、级联规则
        ↓
Tools (tools.ts)        — MCP 工具注册、输入验证、错误处理（12 个工具）
```

修改规则：新功能先在 tools.ts 注册，再在 service.ts 实现；repo.ts 只做纯 SQL。

## 12 个 MCP 工具

- **创建(3)**: create_claim, create_statement, create_warrant
- **读取(6)**: list_claims, list_statements, get_argument, get_node, search_nodes, get_stats
- **修改(2)**: update_node, delete_node
- **编译(1)**: compile_arguments

## 关键文件

| 文件 | 说明 |
|------|------|
| `src/index.ts` | 入口，CLI 参数解析，stdio transport |
| `src/service.ts` | 核心业务逻辑（最复杂） |
| `src/tools.ts` | MCP 工具注册 |
| `src/repo.ts` | 数据访问层 |
| `src/types.ts` | 类型定义 |
| `src/content.ts` | 工具描述、字段提示、警告文案 |
| `src/compile-service.ts` | Compile 系统核心 |
| `src/compile-reviewers.ts` | 各类 reviewer 实现 |
| `src/compile-prompts.ts` | Compile LLM prompt 模板 |
| `src/merkle-hash.ts` | 论证图 Merkle 哈希（staleness 检测） |
| `sql/schema.sql` | SQLite schema |
| `agents/` | Claude Code agent 定义（Toulmin 层：toulmin-researcher、toulmin-explorer；object 层：code-experimenter、discrepancy-auditor、code-optimizer） |
| `skills/` | paper-reproduce、literature-writing、cite-review、overleaf-setup、academic-writing 技能 |
| `visualizer/` | D3.js v7 模块化可视化（双阶段，14 JS 模块） |
| `tests/` | 测试文件，bun test |

## 数据模型

单张 `nodes` 表，type-specific 字段存储在 JSON `data` 列，5 个 JSON_EXTRACT 索引。

`nodes.type` 只有三种值：**claim / warrant / statement**。Ground、Backing、Rebuttal 是 statement 节点扮演的**角色**，由三张关系表决定：
- `warrant_grounds` — statement（或 claim）作为 warrant 的证据基础（Ground 角色）
- `warrant_backings` — statement 作为 warrant 的权威支撑（Backing 角色）
- `rebuttal_targets` — statement 反驳某个 claim 或 warrant（Rebuttal 角色）

一个 statement 可同时扮演多个角色。

## 级联删除规则

- **Claim** 删除需 `cascade=true`，连带删 Warrant（Ground Statement 独立保留）
- **Warrant** 级联删除时从关系表中移除关联 Ground/Backing 记录
- **Statement（Ground 角色）** 自动从所有 `warrant_grounds` 记录中移除
- **Statement（Backing/Rebuttal 角色）** 直接删除

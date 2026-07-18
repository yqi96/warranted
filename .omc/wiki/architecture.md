---
title: Architecture Overview
tags: [architecture, typescript, sqlite, mcp]
category: architecture
updated: 2026-07-17
---

# toulmin-mcp 架构总览

## 项目定位

MCP (Model Context Protocol) 服务器，实现 Toulmin 论证模型，用于科学推理和证据管理。支持论文复现、假设验证、科学主张管理等研究任务。为 AI agent 提供结构化论证图管理。

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

- **创建(5)**: create_claim, create_ground, create_warrant, create_backing, create_rebuttal
- **读取(4)**: list_claims, get_argument, search_nodes, get_stats
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
| `agents/` | Claude Code agent 定义 |
| `skills/` | paper-reproduce、declare-barrier 技能 |
| `visualizer/` | Cytoscape.js 图可视化 |
| `tests/` | 测试文件，bun test |

## 数据模型

单张 `nodes` 表，type-specific 字段存储在 JSON `data` 列，5 个 JSON_EXTRACT 索引。

详见 [[node-semantics]]。

## 级联删除规则

- **Claim** 删除需 `cascade=true`，连带删 Warrant/Backing/Rebuttal（Ground 独立保留）
- **Warrant** 级联删 Backing
- **Ground** 自动从所有 `Warrant.ground_ids` 中移除
- **Backing/Rebuttal** 直接删除

---
title: Development Conventions
tags: [dev, bun, test, logging, mcp, review]
category: environment
updated: 2026-07-20
---

# 开发规范

## 工具链

| 场景 | 命令 |
|------|------|
| 开发（内存 DB）| `bun run dev` |
| 测试 | `bun test` |
| 可视化 | `bun run viz` |
| 类型检查 | `npx tsc --noEmit` |

**禁止使用** npm install / yarn / pnpm，一律用 Bun。

## 测试结构

`tests/` 下的测试文件：

| 文件 | 内容 |
|------|------|
| `scenarios.test.ts` | E2E 场景测试（论文复现、假设验证） |
| `service.test.ts` | Service 层单元测试 |
| `repo.test.ts` | Repository CRUD 测试 |
| `tools.test.ts` | 工具注册和输入验证 |
| `review-*.test.ts` | 异步 review 系统相关测试 |
| `compile-viz.test.ts` | Compile 可视化测试 |
| `helpers.ts` | 共享测试工具（createTestDb、factory methods） |

**强制要求**: 任何代码变更都必须附带测试用例，无测试不完成。

## 日志规范

- **格式**: CSV-like，输出到 stderr 和 `.toulmin/operation.log`
- **内容**: 工具名、状态、耗时、输入摘要、输出摘要
- **注意**: 不干扰 MCP 的 JSON-RPC stdio 协议

## 数据存储

| 路径 | 内容 |
|------|------|
| `.toulmin/argument.db` | 默认 SQLite 数据库 |
| `.toulmin/reviews/` | 异步 Review 结果 |
| `.toulmin/operation.log` | 操作日志 |

`.toulmin/` 和 `*.db` 均已 gitignore。

## 审查系统

三种审查，均为同步阻断：

| 审查类型 | 触发时机 | 失败行为 |
|---------|---------|---------|
| 节点定义审查 | create/update content（claim/warrant/ground） | 操作拒绝 |
| Ground 证据审查 | update_node verification=verified | 退回 pending |
| 逻辑链审查 | compile_arguments（显式调用） | verdict=failed |

Ground content 变更时若已 verified，自动退回 pending。

### Pending Ground 提示文案（按 source 区分）

`create_ground` 和 `update_node` 在 Ground 处于 pending 状态时，根据 `source` 返回不同的操作指引：

| source | 提示要点 |
|--------|---------|
| `literature` | 附上来源文件（PDF/网页），含作者/年份/DOI |
| `observed` | 附上所有产出物：原始数据、结果文件、代码、日志等 |
| `hypothesis` | 提供说明文档（描述内容和产出方式）+ 支持文件 |

## MCP 协议

- **通信**: stdio（JSON-RPC 2.0）
- **客户端配置**:
  - Claude Code: `.mcp.json`
  - Claude Desktop: `claude_desktop_config.json`
- **无需环境变量**，所有配置通过 CLI 参数或 JSON 文件

## 关联

- [[architecture]] — 整体项目结构

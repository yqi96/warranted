---
title: Development Conventions
tags: [dev, bun, test, logging, mcp, review]
category: environment
updated: 2026-08-12
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

`tests/` 下 30+ 测试文件，按功能域分组：

| 文件 | 内容 |
|------|------|
| `scenarios.test.ts` | E2E 场景测试 |
| `service.test.ts` | Service 层单元测试 |
| `repo.test.ts` | Repository CRUD 测试 |
| `tools.test.ts` | 工具注册和输入验证 |
| `tools-no-block-review.test.ts` | 无审查模型时的工具行为 |
| `compile.test.ts` | Compile 失效与 staleness 传播 |
| `compile-definition-review.test.ts` | 节点定义审查 |
| `compile-failed-status-revert.test.ts` | compile 失败后的 status 回退 |
| `compile-quality.test.ts` | 结构质量检查 |
| `compile-review-output.test.ts` | 审查输出格式 |
| `compile-no-persist.test.ts` | --no-persist 模式 |
| `claim-ground.test.ts` | Claim 型 Ground 全链路 |
| `claim-subrole.test.ts` | Claim 型 Backing/Rebuttal 全链路 |
| `review-*.test.ts` | 异步 review 系统 |
| `review-prompts.test.ts` | 审查 prompt 模板 |
| `review-outcome.test.ts` | 审查结果判定 |
| `review-config.test.ts` | 审查配置加载 |
| `review-llm-sdk-options.test.ts` | Agent SDK 选项 |
| `review-real-data.test.ts` | 真实数据审查（集成测试，需 API） |
| `review-integration.test.ts` | 真实 API 集成测试 |
| `review-chain-detection.test.ts` | 链式检测 |
| `auto-verify.test.ts` | 自动验证 |
| `verification-withdrawal.test.ts` | 撤回核实 |
| `batch.test.ts` | 批量操作（create_statements, verify_statements） |
| `delete-integrity.test.ts` | 删除完整性 |
| `db.test.ts` | 数据库迁移和 schema |
| `fts.test.ts` | 全文搜索 |
| `tags.test.ts` | 标签系统 |
| `tag-similarity.test.ts` | 标签相似度 |
| `agent-tool-allowlist.test.ts` | Agent 工具白名单 |
| `agent-eval/` | 约束性 agent 评测 |
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

两类审查，各走独立路径：

| 审查类型 | 触发时机 | 失败行为 |
|---------|---------|---------|
| 节点定义审查（claim/warrant content） | compile_arguments（显式调用），与逻辑链审查并行 | verdict=failed |
| 逻辑链审查 | compile_arguments（显式调用） | verdict=failed |
| Statement 证据审查 | update_node(verification="verified") 同步触发 | 退回 pending |

Statement content 变更时若已 verified，自动退回 pending。

### 失效管理 — 两条独立路径

| 路径 | 触发器 | 结果 |
|------|--------|------|
| 结构失效 | content 或关系变化 | compile → stale + status → proposed |
| 充分性失效 | verification 或 status 变化 | compile 保持 passed，status 复检后可能退回 proposed |

### Pending Ground 提示文案（按 source 区分）

`create_statement` 和 `update_node` 在 Statement 处于 pending 状态时，根据 `source` 返回不同的操作指引：

| source | 提示要点 |
|--------|---------|
| `literature` | 附上来源文件（PDF/网页），含作者/年份/DOI |
| `observed` | 附上所有产出物：原始数据、结果文件、代码、日志等 |

## MCP 协议

- **通信**: stdio（JSON-RPC 2.0）
- **客户端配置**:
  - Claude Code: `.mcp.json`
  - Claude Desktop: `claude_desktop_config.json`
- **无需环境变量**，所有配置通过 CLI 参数或 JSON 文件

## 关联

- [[architecture]] — 整体项目结构
- [[compile-system]] — Compile 系统详细设计
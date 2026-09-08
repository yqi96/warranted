---
title: Development Conventions
tags: [dev, bun, test, logging, mcp, review]
category: environment
updated: 2026-08-31
---

# 开发规范

## 工具链

| 场景 | 命令 |
|------|------|
| 启动 MCP 服务 | `bun run dev` 或 `bun run mcp` |
| 全量测试 | `bun test` |
| 类型检查 | `./node_modules/.bin/tsc --noEmit` |
| agent-eval dry-run | `bun run agent-eval` |
| 可视化 | `bun run viz` |
| 可视化热更新 | `bun run viz:dev` |

依赖和脚本统一使用 Bun；不要再生成 npm/yarn/pnpm lockfile。`bun run dev` 使用默认文件库 `.toulmin/graph.db`，不是内存库；测试辅助才通常使用 `:memory:`。

## 当前测试结构

当前 `tests/` 下的自动测试文件：

| 文件 | 内容 |
|------|------|
| `service.test.ts` | Proposition 五槽位、事务、事件、基线、删除与查询 |
| `structural-check.test.ts` | S/A/R 结构警告、fingerprint 与 dismiss 复燃 |
| `review.test.ts` | review 输入、Q1/Q2、finding 校验与落库 |
| `review-llm.test.ts` | reviewer JSON 响应解析与解析失败标记 |
| `review-config.test.ts` | review 配置加载和非法值回退 |
| `review-llm-sdk-options.test.ts` | Agent SDK 隔离和凭据传递 |
| `review-audit.test.ts` | review 审计记录 |
| `agent-tool-allowlist.test.ts` | agent MCP 工具 allowlist |
| `hooks.test.ts` | guard 废弃契约与 visualizer selection 注入 |
| `overleaf-push.test.ts` | Overleaf 推送/引用替换脚本 |
| `agent-eval/` | 8 个 live 行为评测用例；默认 dry-run，不属于 `bun test` 单元测试集 |
| `helpers.ts` | 共享测试 DB 与 fixture 辅助 |

旧的 `compile*.test.ts`、`tags.test.ts`、`batch.test.ts`、`claim-*.test.ts`、`auto-verify.test.ts` 等属于 2026-08-20 前的本体，已随 `90c7acb` 删除；不要把它们当作当前缺失测试清单。

代码行为变更应补最窄的回归覆盖，并至少运行相关测试、全量 `bun test` 与 TypeScript 检查。纯文档变更仍应运行引用/旧术语搜索和 `git diff --check`。

## 模块边界

- `src/schema.ts` 是 schema 唯一事实源；测试通过 `openDatabase`/`initializeSchema` 建库，不复制 DDL。
- `src/repo.ts` 做 SQL 与行级读写，不编码业务裁决。
- `src/service.ts` 承担事务、不变量、事件、基线和命题操作。
- `src/structural-check.ts` 只派生 warning，不写可变 warning 状态。
- `src/review-*.ts` 只生成和验证第二意见，不决定 qualifier。
- `src/tools.ts` 只负责 MCP schema、调用、序列化和错误转换；不要在这里复制 service 规则。
- 工具/参数的用户可见语义集中在 `src/content/`，避免 prompt、tool schema 和错误文案各写一份。

## 数据存储

| 路径 | 内容 |
|------|------|
| `.toulmin/graph.db` | 当前默认 SQLite 数据库 |
| `.toulmin/graph.db-wal` / `-shm` | SQLite WAL 辅助文件 |
| `.toulmin/operation.log` | 工具调用日志；`--no-persist` 时禁用 |
| `.toulmin/audit/` | 显式 review 的原始输入/输出审计；仅配置 review 且未禁用时写入 |

`.toulmin/argument.db` 是旧本体数据库。当前 `openDatabase` 检测到 `nodes`、`compile_state`、tags/role 关系表时会拒绝继续，不做机械迁移；保留旧库只读归档，新工作使用 `graph.db`。

## 日志规范

- 工具日志输出到 stderr，避免干扰 MCP 的 JSON-RPC stdio。
- 日志记录工具名、状态、耗时、输入摘要和输出摘要。
- 文件库默认写 `.toulmin/operation.log`；`--no-persist` 关闭操作日志和 review audit，但不把数据库变成内存库。
- 关闭流程先停止 MCP，再等待 in-flight 工具调用 drain，最后关闭 SQLite。

## 结构检查、Review 与判断

三者不要混写：

| 机制 | 触发 | 结果 |
|------|------|------|
| 输入校验 | create/update/promote 等写入 | 非法 content、缺失引用或缺失附件直接拒绝 |
| 结构检查 | 命题读取、统计、判断后返回 | 动态 warning；不阻止 `set_qualifier` |
| 语义 review | 仅显式 `review(id)` | Q1/Q2 + findings；不自动改 qualifier |
| 判断 | `set_qualifier` | 写 qualifier、判断事件与 baseline |

没有“创建即自动 review”，也没有“修改即 compile stale”。Review 未配置或运行失败时不降级为 pass；结构检查仍免费、同步可用。

`dismiss` 只能逐条处理 warning/finding，理由必填。它追加事件，不删除原意见。结构变化会让 warning 以新 fingerprint/id 复燃；finding 则保留为当时审查提出的历史意见。

## MCP 与浏览器服务

- 论证服务通过 stdio 注册 11 个工具，配置入口是 `.mcp.json`。
- Review 只从 `--review-config <file>` 启用；配置至少需要 `apiKey`，可带 `model`、`baseUrl`、并发/轮数和 audit 路径。
- Browser 是独立 MCP 服务。`browser_open` 为每个 session 启动隔离 Chrome；后续调用必须携带 `_browser_session`，结束后调用 `browser_close`。

## 关联

- [Architecture Overview](architecture.md)
- [Structural Checks and Review](compile-system.md)
- [Visualizer Architecture](visualizer.md)

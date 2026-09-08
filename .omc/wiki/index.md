# Wiki Index

> 6 pages | Last updated: 2026-08-31

## Architecture

- [Architecture Overview](architecture.md) — Proposition 五槽位、11 个 MCP 工具、graph.db、事件与基线
- [Structural Checks and Review](compile-system.md) — 动态 warning、显式 Q1/Q2 review、finding/dismiss；文末保留旧 Compile 历史
- [Visualizer Architecture](visualizer.md) — qualifier/结构编码、三种槽位边、HTTP/SSE API

## Environment

- [Development Conventions](dev-conventions.md) — 当前测试集、模块边界、存储和 review 配置
- [Prompt Layering](prompt-layering.md) — 常驻判断层与场景 skill 的增量边界

## Tooling

- 当前没有单独的 browser wiki；浏览器代理入口和隔离语义见 [Architecture Overview](architecture.md) 与 `src/browser/index.ts`。

## Source of truth

- `docs/design.md` — 本体、认识论与结算原则
- `docs/api.md` — 11 个工具和返回契约
- `src/schema.ts` — 数据库 schema 与枚举
- `src/content/` — 工具/参数/警告的用户可见文案

旧三节点、compile/Merkle、tags/21 tools 材料只有在页面明确标注“历史”时才是有意保留；未标注的旧叙述应视为文档缺陷。

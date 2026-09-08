---
title: Visualizer Architecture
tags: [visualizer, d3, proposition, qualifier, sse]
category: architecture
updated: 2026-08-31
---

# Visualizer 架构

D3.js v7 驱动的 Proposition 图可视化器，通过 `bun run viz` 启动，默认读取 `.toulmin/graph.db`。服务端与 MCP 主服务共用 `src/db.ts`、`src/repo.ts`、`src/service.ts` 和 `src/structural-check.ts`，不维护兼容旧库的第二套读模型。

## 双阶段界面

| 阶段 | 说明 |
|------|------|
| Phase 1 | 全图仪表板：命题总数、正向档、`unestablished`、待处理 warning/finding |
| Phase 2 | D3 力导向/树形图：按 qualifier 过滤、搜索、缩放、框选/平移和详情面板 |

阶段选择保存在 `localStorage`（`toulmin-phase`）。数据库变化通过 SSE 推送，前端刷新图数据时保留用户 pan/zoom 与节点位置缓存。

## 模块职责

```text
index.html          页面结构、qualifier 控件、统计区
css/styles.css      布局、配色和动画
js/config.js        qualifier/边/结构的视觉编码与全局图状态
js/data.js          拉取图、qualifier 过滤、统计、搜索
js/graph-init.js    D3 初始化、缩放、选择与节点绘制
js/renderer.js      边/节点渲染、力模拟、树布局调度
js/forest.js        多树布局和引用节点展开
js/detail.js        五槽位、warning、finding 详情
js/tooltip.js       悬停摘要
js/selection.js     多选状态与服务端同步
js/phase.js         Phase 1/2 切换与仪表板
js/app.js           控件联动和 SSE 重载
js/db.js            数据库切换 UI
js/bottomsheet.js   底部抽屉
js/bg.js            Phase 1 背景
js/utils.js         通用辅助
```

## 一种节点、三种槽位边

服务端 `buildGraph` 从 `propositions` 读取唯一节点类型，并从槽位关系派生三类边：

| 边 | source | target | 含义 |
|----|--------|--------|------|
| `evidence` | 被引用的证据命题 | 拥有 evidence 槽的命题 | 支撑 |
| `rebuts` | 反驳命题 | 被攻击命题 | 攻击 |
| `warrants` | 晋升后的 warrant 命题 | 拥有 warrant 槽的命题 | 推理理由 |

边方向统一为“被引用者 → 槽位主人”。附件不是图节点，只在命题详情与结构形状中显示。

## 视觉编码

三层编码各回答一个问题：

| 视觉属性 | 编码 |
|----------|------|
| 颜色、大小、实线/虚线 | qualifier：`refuted`、`unestablished`、`possibly`、`probably`、`certainly` |
| 形状 | 命题靠什么站着：有命题证据（inference）、只有附件（sourced）、证据槽为空（bare） |
| 角标 | 未处理结构 warning 和未处理 review finding 的数量 |

角标表示“需要看一眼”，不是错误或写入拒绝。dismiss 后 pending 角标消失；warning 的事实基础变化后会以新 id 复燃。

Phase 2 的过滤器按五个 qualifier 档位工作，不再使用 C/G/W/B/R 类型过滤器。隐藏节点时，与之相连的边也一起隐藏，避免悬空边。

## 数据与 API

| Endpoint | 说明 |
|----------|------|
| `GET /viz/graph` | 全图节点、三种槽位边、按 qualifier 统计 |
| `GET /viz/nodes/:id` | 单条命题完整五槽位视图，含 warning/finding 明细 |
| `GET /viz/nodes?qualifier=...` | qualifier 过滤的命题列表 |
| `GET /viz/stats` | 全图结算清单与缺失附件 |
| `GET /viz/search?q=...` | 内容搜索，可叠加 qualifier |
| `GET /viz/events` | SSE 数据更新流 |
| `GET/POST /viz/selection` | 与 hook 共享当前选中命题 |
| `GET /viz/current-db` | 当前数据库路径 |
| `POST /viz/switch-db` | 切换 `.toulmin` 目录或具体 `graph.db` |

切库时必须同时重建 `CheckContext`：附件路径相对数据库所在项目解析，沿用旧 context 会让 S2 缺失附件警告整片误报。

## 搜索与选择

- `#N` 或纯数字按 id 定位；普通文本走 `/viz/search`，新请求会取消旧搜索。
- tree 和 force 两种布局使用各自的节点坐标来源。
- 多选结果写入内存 selection endpoint，`UserPromptSubmit` hook 可把当前命题上下文注入下一条消息。
- selection 只同步 `id/content/qualifier`，完整槽位和意见仍从 `/viz/nodes/:id` 读取。

## 历史边界

2026-08-20 以前的 visualizer 用 shape/color 编码 Claim/Warrant/Statement 与 Ground/Backing/Rebuttal 角色，并显示 compile 状态。`90c7acb` 后这些字段均不存在；当前视觉编码只围绕 Proposition 的 qualifier、证据结构和待处理意见。

## 关联

- [Architecture Overview](architecture.md)
- [Structural Checks and Review](compile-system.md)
- `visualizer/server.ts`
- `docs/design.md` §1–§3

---
title: Visualizer Architecture
tags: [visualizer, d3, frontend, phase-system]
category: architecture
updated: 2026-07-29
---

# Visualizer 架构

D3.js v7 驱动的双阶段论证图可视化器，模块化 JS/CSS 结构，通过 `bun run viz` 启动。

## 双阶段系统

| 阶段 | 文件 | 说明 |
|------|------|------|
| Phase 1 | `phase.js` + `bg.js` | 仪表板：显示总节点数、论证图概览，Canvas 动态背景 |
| Phase 2 | `graph-init.js` + `renderer.js` + `forest.js` | D3 力导向/树形图，节点交互、搜索、缩放 |

阶段切换通过 `localStorage` 持久化（`PHASE_KEY = 'toulmin-phase'`），初次加载用双 `requestAnimationFrame` 压制过渡闪烁。

## 模块职责

```
index.html          — 入口，加载所有模块
js/
  config.js         — 颜色/尺寸/形状常量 + 节点属性解析器（nodeColor 等）
  bg.js             — Phase 1 Canvas 动画背景（6 束光束，边缘分布）
  phase.js          — Phase 1/2 切换、FLIP 动画（数字飞入状态栏）
  app.js            — 命令窗口展开/折叠、类型过滤按钮同步
  graph-init.js     — D3 SVG 初始化、缩放行为、节点定位追踪、drawNodeShape
  renderer.js       — 节点/边渲染、力模拟、tree layout
  forest.js         — 多树布局（树形图模式）
  data.js           — 从 SQLite API 获取图数据，客户端角色过滤
  db.js             — 数据库接口封装
  selection.js      — 节点选中状态管理
  detail.js         — 底部面板节点详情展示
  tooltip.js        — 悬停 tooltip
  bottomsheet.js    — 底部抽屉展开/收起
  utils.js          — 通用工具函数
css/
  styles.css        — 全部样式（包含 dot-grid 背景、动画关键帧）
```

## 三类型 + 角色模型 (v0.4.0)

`nodes.type` 现在只有三种值：**claim / warrant / statement**。Ground、Backing、Rebuttal 是 statement 节点扮演的**语境角色**，由关系表决定：

| 角色 | 来源 | 语义 |
|------|------|------|
| ground | `warrant_grounds.ground_id` | 该 statement 为某 warrant 的证据基础 |
| backing | `warrant_backings.statement_id` | 该 statement 为某 warrant 提供补充支撑 |
| rebuttal | `rebuttal_targets.statement_id` | 该 statement 反驳某 claim 或 warrant |

一个 statement 可同时扮演多个角色（multi-role）。服务端 `buildGraph` 为每个 statement 计算并注入：
- `data.roles: string[]` — 全部角色集合
- `data.primary_role: string` — 主导角色（优先级：rebuttal > backing > ground）

## 视觉设计：主导角色着色

**核心原则**: Shape 承载类型（claim=圆角矩形，warrant=六边形，statement 按主导角色），Color 承载角色重要性。

| 节点 | 主导角色 | 颜色 | 形状 |
|------|---------|------|------|
| claim | — | `#C8A448`（金色）| 圆角矩形 |
| warrant | — | `#A8A0C4`（银紫）| 六边形 |
| statement | ground | `#A0B8C8`（银蓝）| 正方形 |
| statement | backing | `#90A8A0`（银青）| 圆形 |
| statement | rebuttal | `#C89080`（暗玫瑰）| 菱形 |
| statement | (无角色) | `#A0B8C8`（ground 兜底）| 正方形 |

主导角色是有损压缩（lossy）：tooltip 和底部面板展示完整角色列表。

## 角色过滤器 (C/G/W/B/R)

5 个概念过滤器：C(claim) / G(ground) / W(warrant) / B(backing) / R(rebuttal)。
- **C/W**: 按节点 type 过滤（claim 只受 C 控制，即使它也是某个 warrant 的 ground）
- **G/B/R**: 按 statement 的 `data.roles` 数组过滤；multi-role statement 出现在每个匹配角色下
- 过滤在客户端进行：完整 graph 从服务端一次拉取，JS 按 selected roles 筛选后渲染

## 统计计数

| 来源 | 用于 |
|------|------|
| `stats.claim` / `stats.warrant` | C/W 徽章计数 |
| `roleStats.ground/.backing/.rebuttal` | G/B/R 徽章计数（服务端计算，multi-role 在各角色中各计一次）|
| `stats.statement` | 进度条分母（verified evidence 总数）|

## 搜索与导航

- **ID 搜索**: 输入 `#N` 或纯数字，平滑动画定位到对应节点
- **内容搜索**: 文本搜索，用 `AbortController` 取消过期请求
- **节点定位**: tree 模式读 `nodePositionMap`，force 模式直接读 simulation 节点坐标

## 关联

- [[architecture]] — 整体项目结构与 server.ts 静态资源服务
- [[node-semantics]] — 三种节点类型 + 角色语义完整定义

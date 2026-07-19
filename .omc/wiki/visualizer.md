---
title: Visualizer Architecture
tags: [visualizer, d3, frontend, phase-system]
category: architecture
updated: 2026-07-19
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
  config.js         — TYPE_COLORS、NODE_SIZES、EDGE_COLORS 等全局常量
  bg.js             — Phase 1 Canvas 动画背景（6 束光束，边缘分布）
  phase.js          — Phase 1/2 切换、FLIP 动画（数字飞入状态栏）
  app.js            — 命令窗口展开/折叠、类型过滤按钮同步
  graph-init.js     — D3 SVG 初始化、缩放行为、节点定位追踪
  renderer.js       — 节点/边渲染、力模拟、tree layout
  forest.js         — 多树布局（树形图模式）
  data.js           — 从 SQLite API 获取图数据
  db.js             — 数据库接口封装
  selection.js      — 节点选中状态管理
  detail.js         — 底部面板节点详情展示
  tooltip.js        — 悬停 tooltip
  bottomsheet.js    — 底部抽屉展开/收起
  utils.js          — 通用工具函数
css/
  styles.css        — 全部样式（包含 dot-grid 背景、动画关键帧）
```

## 搜索与导航

- **ID 搜索**: 输入 `#N` 或纯数字，平滑动画定位到对应节点
- **内容搜索**: 文本搜索，用 `AbortController` 取消过期请求
- **Esc 行为**: 只关闭命令窗口，不清除高亮（保留 opacity/glow 直到点击空白）
- **节点定位**: tree 模式读 `nodePositionMap`，force 模式直接读 simulation 节点坐标

## 视觉设计

**核心原则**: Shape 承载类型，Color 承载层级重要性。

| 节点类型 | 颜色 | 说明 |
|---------|------|------|
| claim | `#C8A448`（金色）| 主角，视觉焦点 |
| ground | `#A0B8C8`（银蓝） | 去饱和，从属 |
| warrant | `#A8A0C4`（银紫） | 去饱和，从属 |
| backing | `#90A8A0`（银青） | 去饱和，背景层 |
| rebuttal | `#C89080`（暗玫瑰） | 低饱和对立信号 |

节点 fill 接近透明（0.04–0.14），形状轮廓（stroke）是主要视觉标识。
边 stroke-width：claim 连边 3.5，其他 2.2；stroke-opacity 0.75。

**Phase 1 背景**: Canvas 2D，6 束斜向光束从屏幕左右边缘射出（暖金 + 紫色），异步呼吸+漂移动画，中央保持暗色确保内容可读。

**Phase 2 背景**: CSS dot-grid 提供空间深度感。

## 类型标签

节点按钮和过滤器使用首字母缩写：`C / G / W / B / R`（Claim/Ground/Warrant/Backing/Rebuttal）。

## 关联

- [[architecture]] — 整体项目结构与 server.ts 静态资源服务
- [[node-semantics]] — 五种节点类型完整语义

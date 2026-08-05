---
title: Prompt Layering — base agent vs SKILL.md
tags: [prompt, skill, agent, conventions]
category: environment
updated: 2026-08-05
---

# Prompt 分层规范:toulmin-researcher(判断层) vs SKILL.md(协议层)

`toulmin-researcher.md` 是 main agent 的 system prompt,**永远在场**;skill 只在场景命中时加载。
由此推出本规范的所有规则。以 `paper-reproduce` 为已验证范例(2026-08-05 梳理)。

## 两层定义

| | 判断层 `agents/toulmin-researcher.md` | 协议层 `skills/*/SKILL.md` |
|---|---|---|
| 回答的问题 | 面对**任意**任务:图该不该介入、什么形态、防什么作弊 | 在**这个**场景里:哪些规则是硬性契约 |
| 内容性质 | 可推广的方法论、教"如何思考" | 政策决定、教"必须遵守什么" |
| 质量标准 | 单独在场时 agent 能"大差不差"把事办好 | 契约可被逐条检查 |

## 归属清单

**放判断层(基座)的信息类型:**

1. 本体论与不变式 — 节点类型、Statement 的角色、两层架构、compile 门、status 生命周期
2. 介入判据 — stakes 测试、支持性工作豁免、"图记录知识状态变化不记录工作"
3. 四个推导问题 — at stake / Claim 先行还是证据先行 / 什么能击败 / 防什么作弊
4. 场景推导演示(worked scenarios)— 每场景数行:图形态 + 时序 + Blocks + **定义性不变量**
5. 通用图操作词汇表(Graph Operations 表)
6. 通用委派原则 — bounded contract、one task per subagent、报告仅建议;**不点名具体 agent**
7. 通用反模式
8. 用户交互规则(平实语言汇报、图术语输入当 obligation、selection 上下文)

**放协议层(skill)的信息类型:**

1. 触发条件与场景边界(frontmatter description)
2. Graph Mapping 翻译表 — 该场景原材料 → 图角色的具体对应
3. 粒度政策 — 该场景里什么算一个节点、什么必须拆开
4. Obligations 状态机 — 场景特有状态 → 动作(**不含基座已覆盖的通用行**)
5. 硬性契约 / 零容忍规则 — 如独立性测试、citation contract
6. 可调政策 — 如"先优化后缩 scope"、数值修正允许条件、qualifier 收窄规则
7. 具体 subagent 路由 — 何时找谁 + briefing 内容;仅当场景确有长时隔离需求(见 skill-authoring 既有规则)
8. 场景产物要求 — 报告/文档格式

## 判据(写任何一句话前先过一遍)

1. **删除测试**:把这句话删掉,agent 会做"错类型的事"(范畴错误)→ 基座;只会做得"不够严格/不够全"→ skill。
2. **Delta 原则**:skill 假定基座永远已加载,只写增量,**不复述基座**。基座已有的通用规则(如"委派工作者不拥有图"、"矛盾不可抹除")在 skill 中直接删,不改写保留。
3. **不变量锚点例外**:定义性不变量(如"复现 Claim verbatim 不可改"、独立性原则)允许两处出现——基座一行(作为场景的定义),skill 展开(挂政策细节:qualifier 收窄何时合法、零容忍条款、artifact 判别测试)。
4. **方向测试**:教"如何思考/推导"→ 基座;教"这个场景必须遵守什么"→ skill。
5. **How 归 agent 文件**:skill 对被委派 agent 只说 when(触发)/ what(使命一句话),方法论(检查清单、审计问题)在 `agents/<name>.md`。

## paper-reproduce 逐节归属(范例)

| SKILL.md 内容 | 判定 | 理由 |
|---|---|---|
| Graph Mapping 表 + 粒度规则 | skill ✓ | 场景翻译表;基座只有推导演示 |
| Obligations 表(场景行) | skill ✓ | 状态机;曾含 `create_warrant` 通用行,已按 Delta 原则删除 |
| "初始结构建成 → 先 compile" | skill ✓ | 场景时序政策:实验开跑前先测论文逻辑 |
| Fidelity(qualifier 收窄、数值修正条件、歧义记录) | skill ✓ | 可调政策;"矛盾不可抹除"一句已删(基座反模式覆盖) |
| Independence(artifact 测试、零容忍) | skill ✓ | 硬性契约;基座只留一行不变量 |
| Delegation 路由(experimenter/auditor/optimizer + briefing) | skill ✓ | 路由政策;"delegate by default""workers 不拥有图"已删(基座覆盖) |
| Documentation(复现报告要求) | skill ✓ | 场景产物 |
| Claim verbatim 不可改 / 独立性一行 | 两处 | 不变量锚点例外(判据 3) |

## 相关

- 既有 skill-authoring 规则(无跨 skill 引用、无通用 object worker、审计类 skill 用 phased pipeline)见项目 memory `feedback_skill_authoring.md`
- [Architecture Overview](architecture.md) 有 agents 与 skills 清单

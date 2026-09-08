---
title: Prompt Layering — base agent vs SKILL.md
tags: [prompt, skill, agent, conventions]
category: environment
updated: 2026-08-31
---

# Prompt 分层规范：判断层 vs 场景协议层

`agents/toulmin-researcher.md` 是主 research agent 的常驻判断层；`skills/*/SKILL.md` 只在场景命中时加载。Skill 应写常驻层之上的增量，而不是复制一份缩短版 agent prompt。

## 两层定义

| | 判断层 `agents/toulmin-researcher.md` | 场景协议层 `skills/*/SKILL.md` |
|---|---|---|
| 回答的问题 | 任意任务中，图是否介入、何种命题值得记录、如何判断和委派 | 此场景中，哪些步骤、证据标准和产物是硬契约 |
| 内容性质 | 可推广的认识论与工作边界 | 场景特有的流程、映射、零容忍规则 |
| 质量标准 | 单独加载时不会犯范畴错误 | 与常驻层合用时可逐条验收且无重复 |

## 当前本体锚点

所有 prompt/skill 都应使用当前契约：

- 图中只有 Proposition；每条命题有 content/evidence/warrant/rebuttal/qualifier 五槽位。
- 创建命题落 `unestablished`；最终可信度只由主 agent/用户通过 `set_qualifier` 判断。
- 结构 warning 自动派生，显式 `review` 只给 Q1/Q2 第二意见；二者都不是 qualifier gate。
- 变更、判断、review 和 dismiss 进入 append-only events；重要改判应给 note。
- Ground/Backing 是证据视角，Warrant/Rebuttal 是槽位，不是节点类型。

旧 `create_claim/create_statement/create_warrant`、status/verification、`compile_arguments` 和 tags 不应作为当前 prompt 操作词汇。

## 归属清单

### 放在判断层

1. Proposition 五槽位、qualifier、warning/review/events 的通用边界。
2. 图的介入判据：图记录会影响研究判断的知识状态，不记录任务和活动流水。
3. 通用推导问题：什么命题 at stake、应命题先行还是证据先行、什么能击败它、结果如何回图。
4. 通用判断原则：综合证据、warrant、rebuttal 与不确定性；warning/finding 只是依据。
5. 通用委派边界：subagent 做对象层工作，主会话保留图控制和最终判断。
6. 通用反模式：事后改目标、矛盾抹除、为显示进度而造命题、用图术语替代研究结论。
7. 用户交互：用平实语言汇报；图状态提问默认只读；selection 是当前上下文。

### 放在 Skill

1. frontmatter 中的触发条件与场景边界。
2. 场景材料如何映射到命题和五槽位。
3. 此场景的粒度政策：何时拆命题、何时保留内联 warrant、何时晋升。
4. 场景状态机和工作顺序，例如先抽取来源命题再综合，或先预注册命题再实验。
5. 硬契约：独立证据、引用忠实性、接受阈值、禁止使用的材料。
6. 具体 subagent 路由、briefing 字段、产物路径和报告格式。
7. 场景完成判据，包括未处理 warning/finding/rebuttal 如何影响交付。

## 五个判据

1. **删除测试**：删掉一句话会让 agent 做错类型的事，放常驻层；只会让特定场景不够严格，放 skill。
2. **Delta 原则**：skill 假定主 agent 已加载，不复述“矛盾不可抹除”“subagent 不裁决 qualifier”等通用规则。
3. **不变量锚点例外**：定义场景身份的一句不变量可在常驻层点名、在 skill 展开。例如 paper reproduction 的独立证据要求。
4. **方向测试**：教“如何判断”归 agent；教“此场景必须做到什么”归 skill。
5. **How 归角色文件**：skill 给被委派 agent 说明 when/what/产物；角色自身的方法论留在 `agents/<name>.md`。

## Paper reproduction 示例（当前写法）

| 内容 | 归属 | 原因 |
|------|------|------|
| 图只记录会影响结论的命题，不记录执行步骤 | 判断层 | 所有研究任务通用 |
| 论文内容定义复现目标，但不能作为独立复现证据 | skill + 一句判断层锚点 | 场景定义性不变量 |
| core/result proposition 的层级与 evidence 引用 | skill | 场景特定图映射 |
| 在看到结果前声明接受规则 | skill | 复现实验的反事后合理化契约 |
| 新结果必须回图、矛盾不能覆盖旧证据 | 判断层 | 通用研究纪律 |
| fresh artifacts、报告字段、代码一致性审计 | skill | 场景产物与证据标准 |
| 最终 qualifier 由主 agent 综合判断 | 判断层 | 通用裁决边界 |

## 历史说明

本页最初在 2026-08-05 以旧三节点/compile 本体写成。当时的“初始结构后先 compile”“Claim status 生命周期”“create_warrant 通用行”等示例是旧架构的 prompt 分层案例，不是当前操作说明。`90c7acb` 后对应思想分别落到五槽位建模、动态 warning、显式 review 和 `set_qualifier`。

## 关联

- [Architecture Overview](architecture.md)
- [Structural Checks and Review](compile-system.md)
- `agents/toulmin-researcher.md`
- `skills/paper-reproduce/SKILL.md`

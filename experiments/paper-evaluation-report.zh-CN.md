# Warranted 论文评测方案完整报告

> 用途：论文立项、组会汇报、实验排期与后续实现依据\
> 状态：完整评测方案；其中“预期结果”均为待检验假设，不是已有实验结果\
> 日期：2026-08-31\
> 说明：本报告取代早期 [`benchmark-survey.md`](benchmark-survey.md) 的 benchmark 优先级判断，但保留后者作为探索过程记录。

## 0. 一页汇报摘要

### 我们要解决的问题

当前 research agent 即使能够检索文献、运行代码并生成报告，也常把研究过程压缩成一个不可审计的最终回答。RAG 能补充上下文，普通 memory 能保存历史，fact-checker 能输出一次性判断，但它们通常不持续记录：

- 当前结论到底依赖哪些证据；
- 证据为什么足以推出结论；
- 哪些反证仍未解决；
- 结论强度是否超过证据强度；
- 原判断所依据的内容变化后，哪些结论必须重新检查。

Warranted 的核心思想是把 research agent 的**认识状态**显式化：每个可判断命题都有 `content / evidence / warrant / rebuttals / qualifier`，并保留判断基线、结构警告、语义审查意见和事件历史。它不是另一个检索器，也不是任务日志，而是附着在 research agent 之上的 **argument-accountability layer**。

### 核心论文主张

> Warranted 通过持久化命题、证据、推理依据、反驳、置信判断及其历史，使 research agent 的局部推理缺陷、过期判断和未解决反证变得可发现、可定位，并把受影响判断显式暴露为重查义务；在此基础上，agent 可以执行并接受评测的选择性重验证策略。这种认识论约束有望改善开放世界科研审计与部分真实科研任务的可靠性。

### 核心证据链与条件性扩展

| 层级 | Benchmark | 在论文中只负责证明 | 主指标 |
|---|---|---|---|
| 1. 局部语义能力 | SciFact 派生 oracle-cited-abstracts task | `review` 能否完成 attachment-grounded local support audit | 本文自定义 Accuracy、Macro-F1、false-supported rate |
| 2. 动态判断维护 | VitaminC | Warranted 能否暴露证据修订造成的 stale judgment；运行于该信号之上的 agent policy 能否以低于全量重算的成本完成选择性重验证 | warning recall、post-update accuracy、stale-use rate、materiality F1、revalidation cost |
| 3. 核心系统有效性 | DeepFactBench | 在多来源、长研究报告中，完整 Warranted agent 是否优于匹配的强基线 | 官方 binary Accuracy 与 supported-class F1/Precision/Recall；自定义三分类 Macro-F1；成本 |
| 4. 真实轨迹中的问题发现 | DeepFact 轨迹问题审计 | 端到端运行是否产生实质性论证问题；Warranted 报告的问题有多少被人工确认并得到正确处置 | confirmed surfaced issue yield lower bound、detection precision、material precision、correct resolution rate、revision-required repair rate |
| 条件性扩展：下游效度 | ScienceAgentBench | 论证纪律是否能转化为真实科研计算任务的成功率提升 | 官方 SR、VER、CBS、成本；\(P(SR=1 \mid VER=1)\) 仅作描述性诊断 |
| 条件性扩展：人类审计效用 | DeepFact human audit study | 若论文明确主张“帮助人类审计”，检验显式论证轨迹是否帮助人更快、更准地定位结论断点 | diagnosis accuracy、time-to-correct-diagnosis |

结论上，**DeepFactBench 是主实验**，VitaminC 是必须保留的受控机制实验，DeepFact 轨迹问题审计是嵌在主实验中的过程证据；SciFact 只做低成本组件 sanity check。ScienceAgentBench 只承担可选的下游效用验证；小型人类审计效用实验只在论文明确主张“帮助人类审计”时加入。首投稿的最低充分证据是 **DeepFactBench + 轨迹问题审计 + VitaminC + 一个关键消融/强控制**。MQuAKE-Remastered 仅为候补；LongMemEval、RippleEdits、StreamingQA 不进入核心实验。

---

## 1. 项目理解：重构改变了表达方式，没有改变核心思想

### 1.1 稳定不变的思想

从源码、设计文档和提交历史看，Warranted 的核心始终不是某一种节点类型或某一个 `compile` 命令，而是以下约束：

1. 研究结论必须能追溯到证据；
2. 证据到结论之间的推理依据必须显式；
3. 反证与未决问题不能在生成最终文本时被静默抹去；
4. 可信度判断必须与内容编辑分开，并留下历史；
5. 当判断依据变化时，系统必须暴露重新检查义务，而不是继续复用旧结论。

当前 [`README.md`](../README.md)、[`docs/en/concepts.md`](../docs/en/concepts.md) 和 [`agents/toulmin-researcher.md`](../agents/toulmin-researcher.md) 都围绕这一稳定目标展开。

### 1.2 历史演化应如何在论文中表述

提交 `90c7acb` 将早期 Claim/Warrant/Statement 多本体与 compile 状态，收敛为“一个 proposition + 五个槽位”；提交 `400929b` 与 `b6987cd` 进一步明确了 argument layer 与文献搜索、阅读、实验等 object layer 的分工。正确的论文口径是：

> 这是对同一核心思想的机制收敛，而不是研究目标的改变。重构减少了角色类型与门禁状态带来的重复表达，让“证据—理由—反驳—判断—重查”成为更清楚、可组合的认识状态协议。

因此，实验不应比较旧实现和新实现，也不应把工程重构本身当作贡献。实验要验证的是贯穿各版本的稳定命题：**显式论证状态是否确实让 research agent 更可靠、更可审计。**

### 1.3 当前系统已经具备的实验基础

| 能力 | 当前实现 | 实验意义 |
|---|---|---|
| 单一命题五槽位 | [`src/types.ts`](../src/types.ts)、[`src/schema.ts`](../src/schema.ts) | 可以统一承载 claim、evidence、warrant、rebuttal 与 qualifier |
| 显式判断及基线快照 | `set_qualifier`；`baseline_head`、`baseline_refs` | 可以判断“当前依据是否仍与上次判断时一致” |
| 确定性结构警告 | [`src/structural-check.ts`](../src/structural-check.ts) | 零语义成本地发现缺证据、引用变化、判断依据过期等问题 |
| 局部语义审查 | [`src/review-run.ts`](../src/review-run.ts)、[`src/review-prompts.ts`](../src/review-prompts.ts) | 独立回答 Q1 source faithfulness 与 Q2 inference validity |
| 引证机械校验 | [`src/review-validate.ts`](../src/review-validate.ts) | 降低 reviewer 编造引用或泛泛批评的风险 |
| 追加式历史 | `events`、`findings`、`get_history` | 可以重放判断、审查与 dismiss 过程 |
| argument/object 分层 | [`docs/en/research-framework.md`](../docs/en/research-framework.md) | 能把检索、阅读、编码与最终认识判断分离 |

当前缺失的不是核心本体，而是公开 benchmark 的 adapter、统一 runner、评分器、泄漏控制和统计分析管线。

---

## 2. 高级叙事：从“回答问题”转向“维护可失效的研究判断”

### 2.1 理论对象

在时间 \(t\)，将一条命题写成：

\[
p_t = \langle c, E, w, R, q_t, B_t, H_t \rangle
\]

其中：

- \(c\)：被判断的命题内容；
- \(E\)：附件和其他命题构成的证据；
- \(w\)：证据为何能推出命题的 warrant；
- \(R\)：攻击命题或 warrant 的 rebuttals；
- \(q_t\)：当前 qualifier；
- \(B_t\)：最近一次显式判断时的依据快照；
- \(H_t\)：创建、编辑、审查、判断和 dismiss 的事件历史。

Warranted 不声称自动计算真值。它把三种认识论职责分开：

| 层 | 职责 | 当前实现 |
|---|---|---|
| L1：结构与失效检测 | 确定性地发现缺失槽位、引用变化和过期基线 | structural warnings |
| L2：局部语义审查 | 检查来源忠实性与推理有效性 | explicit `review`，只看单命题局部视图 |
| L3：最终判断 | 综合证据、warrant、rebuttals 和不确定性后设置 qualifier | primary agent / human 调用 `set_qualifier` |

这一区分很关键：Warranted 是**镜子与责任协议**，不是自动真理裁判。

还要区分两项容易混淆的能力：

- 当前本体与代码原生保证的是 **dependency invalidation / recheck-obligation exposure**：依据变化后，系统确定性地标出哪些既有判断需要重新关注；
- “哪些 warning 应真正重算、哪些可安全 dismiss”是运行在该信号之上的 **agent policy**，不是 structural checker 自动算出的真值。VitaminC 将联合评价底层 invalidation signal 与上层 selective policy，结果必须分开归因。

### 2.2 相对于 RAG、memory 和 fact-checker 的理论增量

| 方法 | 主要回答的问题 | 未系统回答的问题 |
|---|---|---|
| RAG | “当前该把哪些文本放进上下文？” | “哪些既有判断依赖这些文本，依据变化后谁必须重查？” |
| Long-term memory | “过去发生过什么、说过什么？” | “哪些内容是被判断的研究命题，为什么成立，反证是什么？” |
| Fact-checker | “这条 claim 此刻支持还是不支持？” | “这个判断如何进入后续论证、何时过期、如何保留争议与修订历史？” |
| Workflow / task log | “做了哪些步骤、哪些任务完成？” | “这些步骤实际建立了什么命题，以及结论强度是否合理？” |
| Warranted | “当前研究判断依赖什么、为何成立、受到什么攻击、何时需要重查？” | 不替代领域检索、实验执行和人类最终判断 |

所以论文不能写成“argument graph 比 RAG 检索更强”。更准确的关系是：

> RAG 是 object-layer 的证据获取机制；Warranted 是 argument-layer 的判断维护机制。实验中二者应共享同一个检索后端，比较的变量是是否维护显式论证状态。

### 2.3 四个核心研究问题与两个条件性扩展

- **RQ1：局部支持审查。** 将 claim、attachment 与 warrant 显式分离，是否提高 attachment-grounded support audit 的正确性与断点可定位性？
- **RQ2：动态判断维护。** 当证据发生细微修订时，判断基线和依赖关系能否可靠暴露 stale judgment；在这一信号之上，agent policy 能否避免对全部结论重新计算？
- **RQ3：开放世界论证审计。** 局部审查与显式论证状态能否扩展到长报告、多来源、存在冲突与限定条件的科研审计？
- **RQ4：运行中问题发现与处置。** 端到端运行中是否确实出现了可操作的论证问题；L1 warning 与 L2 finding 能否以可量化 precision 暴露这些问题，signal 出现后 agent 是否完成了与人工标签一致的处置？
- **RQ5（条件性扩展）：下游科研效用。** 在真实科学计算任务中，这种认识论约束能否提高科学成功率，而不只是程序可运行率？
- **RQ6（条件性扩展）：人类审计效用。** 如果论文明确主张帮助人类审计，那么在信息总量相同的条件下，显式论证轨迹是否帮助审计者更快、更准确地定位错误证据、无效 warrant 或未解决反证？

### 2.4 论文不应提出的过强主张

- Warranted 是通用长期记忆系统；
- argument graph 在检索上优于 dense RAG；
- `review` 或 structural warnings 能自动给出真值；
- DeepFactBench 一项实验即可证明整个 research agent 有效；
- ScienceAgentBench 的代码执行成功即可验证论证本体；
- 当前系统已经实现端到端科学发现自动化。

---

## 3. 完整实验总体设计

### 3.1 共同对照原则

所有系统级实验都使用同一套：

- base model 及固定版本；
- system prompt 中除 Warranted 协议外的公共部分；
- 搜索 API、dense retriever、可访问文献库和文档解析器；
- token、工具调用、搜索文档数、执行次数与 wall-clock 上限；
- task input、domain knowledge 与代码运行环境；
- 温度、seed、重试政策与失败处理规则。

**Bare Agent 不是弱 prompt。**它保留与 Warranted 相同的搜索、阅读、自调试和 critic 调用预算，只使用自由 scratchpad，不维护 proposition/evidence/warrant/rebuttal/qualifier/baseline 图。这样才是在比较 argument accountability，而不是比较“强 agent 和弱 agent”。

### 3.2 最小而充分的系统变体

| 变体 | 作用 |
|---|---|
| Bare Agent | 主系统对照；同模型、同工具、同预算，自由 scratchpad |
| Structured Bare Agent | 使用相同的 claim decomposition、证据/反证 checklist、critic 次数与结构化临时表，但没有持久 proposition ids、dependency baseline、warning、events 或跨步骤 graph state；排除“只是多想一步/换了 prompt” |
| Warranted Agent | 完整系统 |
| Warranted without `review` | 只在 DeepFactBench 做一次关键 ablation，区分 persistent graph 与 semantic second opinion 的贡献 |
| Published method | 仅作外部参考，不与不同模型/预算的方法直接作因果比较 |

VitaminC 内部另设 `No-maintenance` 与 `Always-revalidate` 两个机制边界基线。除此之外不在每个 benchmark 上重复大规模组件拆解。

### 3.3 主指标与统计原则

每项实验预注册一个主要终点：

| 实验 | 主要终点 | 配对/聚类单位 |
|---|---|---|
| SciFact | 本文 oracle-cited-abstracts adapter 的 binary Macro-F1 | claim；每个 claim 恰好一个 case，全部 cited abstracts 同挂一个 target |
| VitaminC | post-update accuracy–cost 非劣效关系 | revision tuple |
| DeepFactBench | 共主终点：官方 binary supported-class F1 与自定义三分类 Macro-F1 | claim；bootstrap 按 report 聚类 |
| DeepFact 轨迹问题审计 | substantive detection precision；确认问题产出率下界、正确处置率与需修改问题修复率为关键辅助指标 | 去重后的 issue episode；按 report 聚类，分层抽样时保留抽样权重 |
| ScienceAgentBench | 官方 SR | task |
| 人类审计效用实验 | correct diagnosis rate | benchmark case；annotator 作为重复测量因素 |

统计报告统一包含：效果差、95% CI、配对检验和原始分母，不只报告 p-value。

- 二分类配对差异：McNemar 或 paired bootstrap；
- DeepFactBench：以 report 为 cluster 的 paired bootstrap；mixed-effects logistic model 仅作辅助，其中 report 作为 random intercept、domain 作为 fixed effect；
- DeepFact 轨迹问题审计：以 substantive detection precision 为单一主要人工终点；在 pilot 后、正式 test 前冻结实用性门槛。按 report 聚类计算 95% CI；分层抽样时使用抽样权重，确认问题产出率下界、正确处置率与需修改问题修复率作为关键解释性指标；
- ScienceAgentBench：paired permutation/bootstrap；
- 成本和时延：paired bootstrap；
- confirmatory endpoints 使用预先固定的 hierarchical/Holm procedure；DeepFact 的两个共主终点在实验内校正；
- subgroup 必须在运行前按 benchmark 元数据固定，避免看完结果再划分。

### 3.4 已发表论文如何“抓主要矛盾”

已发表的强系统论文并没有做到所有构念、所有场景和所有威胁都完全覆盖。更常见的结构是：**一个贴近核心 claim 的主评测面 + 一个强对照 + 少量关键消融/人评 + 明确 limitation**。

| 已发表工作 | 实际评测形状 | 它没有证明完什么 | 对 Warranted 的启发 |
|---|---|---|---|
| [STORM, NAACL 2024](https://aclanthology.org/2024.naacl-long.347/) | 围绕一个 FreshWiki 场景比较 outline-driven RAG；消融 perspective、conversation、outline；人评仅抽 20 个 topics，由 10 位 Wikipedia editors 评价 | verifiability 人评并未优于基线，论文仍以 organization/coverage 的主要结果成立 | 人评不必巨大；只要主 endpoint 对准主要创新，未改善维度可作为边界报告 |
| [Self-RAG, ICLR 2024](https://proceedings.iclr.cc/paper_files/paper/2024/file/25f7be9694d7b32d5cc670927b8091e1-Paper-Conference.pdf) | 主结果覆盖 6 个任务；关键 ablation 只在 3 个数据集做，ASQA 还只抽 150 例；公平控制共享 top retrieved documents | 不测试持久科研论证或长期 evidence revision | 主结果可以全量，机制消融可以在预先分层的代表性子集完成 |
| [Reflexion, NeurIPS 2023](https://papers.neurips.cc/paper_files/paper/2023/hash/1b44b878bb782e6954cd888628510e90-Abstract-Conference.html) | 用 ALFWorld、HotPotQA、HumanEval/MBPP 等任务证明 verbal reflection；episodic-memory ablation 在较小任务面上完成 | 作者明确不提供 formal guarantee；memory 只是有限窗口 | 不需要证明所有 agent 场景，只需证明核心反馈/记忆机制在代表性任务上产生稳定差异 |
| [ALCE, EMNLP 2023](https://aclanthology.org/2023.emnlp-main.398/) | 聚焦 cited generation，用 3 个数据集测答案质量、citation correctness/completeness，并用人评校验自动指标 | 不评价完整 research workflow | 局部 evidence-support 指标可以只承担局部 claim，不必扛端到端有效性 |
| [RARR, ACL 2023](https://aclanthology.org/2023.acl-long.910/) | 在 3 类输入上评价 post-hoc research-and-revision，用 attribution 与 preservation 人评/自动指标抓住局部改写主矛盾 | attribution 不等于 truth；修改前提后，下游依赖步骤可能不同步 | 这正说明 Warranted 应把“依赖变化后谁失效”作为区别于 post-hoc attribution 的主要问题 |
| [ScienceAgentBench, ICLR 2025](https://proceedings.iclr.cc/paper_files/paper/2025/hash/f12b4df26344f3be803c06b555252efe-Abstract-Conference.html) | 统一 102 个真实任务为 Python program，集中报告 SR/VER/CBS/Cost | 明确不覆盖文献综述、idea generation、实验规划或完整科学发现 | 主动限定能力边界不会削弱论文，反而提高 construct validity |
| [DeepFact, ACL 2026](https://aclanthology.org/2026.acl-long.1586/) | 一个核心 DRR factuality benchmark，配合强 verifier baselines、成本/轻量变体与外部迁移 | 主要测 verifier，不证明 report-generating agent 的全过程 | 一个高度贴合主构念的 benchmark 可以承担 headline result |

由此得到的评测原则不是“降低标准”，而是把有限资源集中在决定论文是否成立的矛盾上：

> Bare/structured agent 的研究判断散落在一次性上下文中；当证据冲突或发生变化时，它缺乏稳定依赖、失效信号与可重放历史。Warranted 是否能以可接受成本改善这种状态，并在长研究报告审计中转化为更少的错误支持判断？

### 3.5 最低可发表核心与理想扩展

**最低可发表核心（建议先做，约 5–6 周）：**

1. **DeepFactBench headline experiment**：全量 621 claims，至少运行 Matched Bare、Structured Bare、Full Warranted；共享冻结 evidence corpus、模型与预算。
2. **VitaminC mechanism experiment**：约 1,000 个平衡 revision tuples，证明 dependency invalidation / warning-guided revision maintenance，比较 No-maintenance 与 Always-revalidate。
3. **一个关键 ablation**：DeepFact 的 `without-review` 可以只在预先按 report/domain/label 分层的 150–200 claim 子集运行；借鉴 Self-RAG，机制消融不必复制全部昂贵主实验。
4. **DeepFact 轨迹问题审计**：从全量日志导出去重的问题事件；不超过 300 个时全审，否则按 signal type/report 分层抽取 250–300 个并保留抽样概率，盲审问题真实性、实质性与修复结果。
5. **SciFact 组件 sanity check**：规模适中的 oracle-cited-abstracts binary adapter，放正文短节或 appendix；只证明 local support audit。

这套核心足以支持一个严格收窄的主张：

> 在匹配的模型、检索和预算下，显式维护 proposition/evidence/warrant/rebuttal/baseline 的 argument-accountability layer，能够改善深度研究报告的 claim-level factual auditing；运行轨迹盲审能够确认系统是否以可量化 precision 暴露真实的中间论证问题；证据修订实验进一步检验它是否降低静默复用旧判断的风险。

**理想扩展（核心结果成立后再做）：**

- ScienceAgentBench：验证下游科研计算效用；
- 随机盲审 100–150 个未报警状态：只有需要估计总体问题发生率或检测覆盖率时加入；
- 20–40 个 DeepFact cases 的 blinded human audit study：只有当论文标题/摘要明确宣称“帮助人类审计”时才是必需；
- 第二个模型家族、DeepFact live-web robustness track；
- MQuAKE-Remastered：仅在审稿叙事确实缺少多跳传播证据时加入。

换言之，公开 benchmark 不必铺得更宽；先打穿 DeepFact 的“最终效果 + 真实轨迹问题发现”与 VitaminC 的“受控失效机制”，比同时铺开多个构念错位的 benchmark 更接近已发表系统论文的实际做法。

---

## 4. 实验一：SciFact —— `review` 的局部附件支持审查

### 4.1 Benchmark 现状

[SciFact](https://aclanthology.org/2020.emnlp-main.609/) 发表于 EMNLP 2020，包含约 1.4K 条专家撰写的科学 claims；标准 claim 的原始标签为 SUPPORT、CONTRADICT 或 NOINFO，其中有 gold evidence 的 claim 还带对应 abstract 与 rationale sentences。[官方代码和数据](https://github.com/allenai/scifact)公开。官方完整任务包含文档检索、证据句选择和标签判断，并以 abstract-level / sentence-level 的 micro precision、recall、F1 评价证据与标签组合。

本实验构造 **claim-level oracle-cited-abstracts binary adapter**：每条 claim 只生成一个 target，并一次性给出其全部 cited abstracts，排除检索；原始三类标签保留用于审计和分层报告，但二分类主评分将 CONTRADICT 与 NOINFO 合并为负类。它不是 SciFact 官方三分类/full-pipeline 排行任务。其目的也不是证明 Warranted 端到端有效，而是给生产系统中的 `review` 一个独立、可复现的 attachment-grounded local support 指标。

### 4.2 数据构造

1. 固定公开、可本地评分的 dev split；所有 prompt 与映射规则只在独立 train/pilot 上确定，冻结后才运行 dev；
2. dev 的 300 条 claim 全部保留：124 SUPPORT、64 CONTRADICT、112 NOINFO；
3. 每条 claim 只构造一个目标 proposition，claim 写入 `content`；
4. 该 claim 的全部唯一 cited abstracts（以及若存在的 evidence-only abstract）按 doc id 保存为只读附件，并共同挂入同一个 `evidence.attachments`；同一 claim 不按 abstract 拆成多条样本；
5. 使用统一、与标签无关的 warrant，例如：“只有当附件在相同研究对象、条件和关系范围内直接蕴含该命题时，附件才足以支持该命题”；
6. 运行独立 `review`，记录 Q1/Q2 与失败 finding 的引用位置。

主任务只要求判断 supported / not-supported，不要求 `review` 区分负类原因。SUPPORT 为正类；CONTRADICT 与 NOINFO 均为负类：

\[
\widehat{y}=\text{supported} \iff Q1=pass \land Q2=pass
\]

其余输出统一记为 not-supported。不要把 `qualifier` 强行当作 SciFact 三分类标签。如果后续必须做三分类，应在 benchmark adapter 中单独增加 relation verdict，而不是改变生产图的 qualifier 语义。

### 4.3 对照与指标

对照：同一 reviewer model 直接读取 claim + 同一组 cited abstracts 作二分类判断；它拥有相同输入、token 与一次检查机会，但没有 Q1/Q2 分解和强制引用协议。

本文 adapter 的主指标：

- binary Accuracy；
- Macro-F1；
- false-supported rate，即 CONTRADICT 与 NOINFO 合并负类中被判支持的比例。

辅助指标：

- 在 review 判失败且存在 gold rationale 的样本上，finding quote 是否落入 gold rationale sentence；NOINFO 不进入该指标分母；
- finding 引用协议通过率；
- SUPPORT、CONTRADICT、NOINFO 三组分开的通过/拒绝 recall；
- 单例 token、时延和 reviewer failure rate。

生产 `review` 对通过样本不会生成 finding，因此不能在不改协议的情况下计算完整的 evidence-sentence F1。若将来要与 SciFact 官方 rationale 指标完整对齐，应增加一个**仅用于评测的 rationale-selection 输出**，并与生产 Q1/Q2 结果分开报告。

样本单位已经是 claim，同一 claim 的多篇 abstracts 不拆成独立观测。置信区间直接对 claim-case 重采样。报告中必须把本文自定义 binary 指标与 SciFact 官方 micro-F1 清楚分栏，避免借用官方 benchmark 名称却暗示完成了全部任务。

### 4.4 预期结果与解释

预期 Warranted review 的主要优势是减少无法定位依据的 false acceptance，并产生可核查引用，而不是凭空获得更强检索能力。若 Accuracy 不升但 false-supported rate 明显下降，需要如实写成“更保守的审查器”，不能只挑有利指标。

若本实验失败，说明当前 Q1/Q2 prompt、warrant 模板或 citation protocol 没有比直接判断形成更好的局部语义审查；这会削弱 `review` 组件主张，但不能单独否定 persistent graph 与 revision mechanism。

---

## 5. 实验二：VitaminC —— 证据修订、失效暴露与 policy-guided 重验证

### 5.1 Benchmark 现状

[VitaminC](https://aclanthology.org/2021.naacl-main.52/) 发表于 NAACL 2021，来源于 100K+ 次 Wikipedia factual revisions；论文摘要报告 400K+ claim–evidence pairs，官方仓库描述为 450K+。[官方仓库](https://github.com/TalSchuster/VitaminC)同时提供 fact verification、revision flagging、word-level rationale 等任务。

它不是科学文献 benchmark，因此不承担科研外部效度；它的价值在于构造非常干净的“证据只发生细微变化，但判断可能必须改变”的控制实验。

### 5.2 Warranted replay 构造

在 Warranted adapter 中，将 VitaminC 的 contrastive/revision examples 派生为：

\[
u_i = \langle c, e_0, y_0, e_1, y_1, m \rangle
\]

其中 \(m\) 表示该 revision 是否改变事实或是否足以改变 claim verdict。这个完整 replay tuple 和 \(m\) 不是官方 fact-verification 文件中的统一原生字段，而是由 paired evidence、revision flagging 标签和 \(y_0 \neq y_1\) 的 relation change 派生；adapter 必须保存来源 item ids 与构造规则。

主实验优先使用干净的 `SUP ↔ REF` 对称修订，因为两端都有明确判断且能够形成基线；NEI 涉及“尚未建立”与“证据不足”的额外语义，放到后续鲁棒性分析。另从 label-preserving 或 revision-flagging 数据中构造非实质变化对照，并验证同一 claim 在两版证据下的 gold relation 不变。不要把“文本发生变化”直接等同于“claim 必须改判”。

具体流程：

1. 创建 evidence proposition \(p_e\)，`content=e_0`，并先判断其来源陈述可信度；
2. 创建 claim proposition \(p_c\)，写入固定 warrant；当 \(e_0\) 支持 claim 时将 \(p_e\) 放入 `evidence.nodes`，当其反驳 claim 时放入 `rebuttals`；
3. 根据 \(y_0\) 显式设置初始 qualifier，使系统保存判断基线；
4. 用 `update_proposition` 将 \(p_e.content\) 从 \(e_0\) 改为 \(e_1\)，此时暂不提前移动关系或修改 claim verdict；
5. 读取 \(p_e\) 自身及 \(p_c\) 的 changed-reference warning；
6. agent 决定执行 revalidate 或带理由 dismiss；
7. 若 relation 极性改变，再把 \(p_e\) 移到正确的 evidence/rebuttal 槽，输出更新后的 label/qualifier，并保存所有操作与成本。

首轮必须把修订写成**同一 evidence proposition 的内容演化**。当前基线会记录被引用命题的 content hash 和 qualifier，因此能够检测该变化。若只在同一路径上覆盖附件内容，当前 self fingerprint 主要看到附件成员路径，可能漏掉文件内容变化。长期可增加 attachment content digest；首轮无需因此改 schema。

### 5.3 对照系统

- **No-maintenance**：保留 \(y_0\)，不检查更新；
- **Always-revalidate**：每个 \(e_0 \rightarrow e_1\) 都重新判断；
- **Bare replay agent**：看到新证据后从头判断，不保留显式基线；
- **Warning-guided agent policy（运行于 Warranted 之上）**：由 baseline warning 暴露变化，再由 agent 决定 revalidate 或 dismiss。

### 5.4 指标与成功标准

主指标：

- invalidation-signal recall：gold verdict 应改变时，依赖该 evidence 的 claim 是否出现 changed-reference warning；同时在 label-preserving revisions 上报告 false-warning rate；
- post-update label Accuracy / Macro-F1；
- stale-use rate：gold verdict 已应改变，但系统仍输出旧判断；
- materiality F1：对“需要重验证”与“可安全 dismiss”的选择；
- revalidation cost：重审比例、token、模型调用、时延。

第一项直接归因于 Warranted 的 dependency invalidation；后四项联合评价 warning 之上的 agent policy。二者必须分别成表，不能把 policy 的判断能力写成 structural checker 的能力。

建议在 train/pilot 上、根据实际应用对一次漏重查与一次多重查的相对代价，冻结非劣效界值和成本目标；不得看 test 结果后再选择。一个可供 pilot 检验的初始候选是：

> Warning-guided agent policy 的 post-update accuracy 相对 Always-revalidate 的差距不超过 2 个百分点，同时重验证调用至少下降 30%，且 stale-use rate 显著低于 No-maintenance。

2 个百分点与 30% 不是理论常数；只有在 pilot/utility analysis 支持后才能作为 confirmatory margin。无论最终阈值是什么，这都是一项 Accuracy–Cost 非劣效实验，而不是只比谁的 accuracy 最高。最有说服力的组合结果是：Warranted 的 invalidation signal 对真实受影响判断具有高召回率，同时运行其上的 warning-guided policy 位于 Pareto frontier——接近全量重算的准确率，但只处理受影响或真正重要的判断。底层 Warranted 本体本身只对“哪些判断依据变了”负责，不能独自获得 policy 的成本收益归因。

### 5.5 预期结果与解释

预期 No-maintenance 在 label-flip 样本上出现大量 stale use；Always-revalidate 准确但成本最高；Warranted 先暴露依据变化，warning-guided agent policy 再接近全量重算的准确率，并在非事实修订或 verdict-preserving 更新上减少重审。

若每个 warning 最终都必须重算，Warranted 只证明了 change detection，没有证明 selective revalidation。若系统经常 dismiss 实质性变化，则说明 agent 没有正确理解 warning 的认识论含义。

---

## 6. 实验三：DeepFactBench —— 核心开放世界论证审计

### 6.1 Benchmark 现状

[DeepFactBench](https://aclanthology.org/2026.acl-long.1586/) 是 ACL 2026 long paper 发布的 deep research report factuality benchmark。论文中的 DeepFact-Bench v4 共 944 条 claims、20 份报告和 6 个领域，其中 test split 为 621 条 claims、15 份报告和 5 个非 CS 领域；标签为 SUPPORTED、CONTRADICTORY、INCONCLUSIVE。[官方 HF 数据](https://huggingface.co/datasets/kkkevinkkk/DeepFactBench)将当前公开 release 标为 v1.0.0，因此正式实验必须同时记录论文 v4 口径、HF revision/hash 和下载日期。[官方代码](https://github.com/kkkevinkkkkk/DeepFact)公开。

其判断对象不是“报告自己的 citation 是否字面蕴含句子”，而是该句子在更广泛科学文献中是否成立。这使它能覆盖错引、错误综合、因果跃迁、遗漏限定条件、忽略反证和过度概括等 Warranted 真正关心的科研论证错误。

### 6.2 为什么它是主实验

SciFact 只看一个 claim 与其给定 cited abstracts 的局部支持关系；VitaminC 只看受控修订；DeepFactBench 更接近同时覆盖以下能力需求：

- 从完整长报告中理解 claim 语境；
- 将复合陈述拆成可判断命题；
- 在开放文献中检索多来源证据；
- 区分来源支持与推理跨越；
- 主动寻找反证、限定条件与时间边界；
- 最终形成可追溯 verdict。

因此它承担 Bare Agent vs Warranted Agent 的主要端到端系统比较。

### 6.3 运行协议

主结果采用 **frozen-corpus track**，避免 live web 漂移混入系统差异：

1. 在任何系统运行前，用不含 gold label/reason 的中立 query templates 和固定 search API 为每条 claim 构建候选文献快照；
2. 下载或保存允许缓存的正文/片段，记录 URL、时间、内容 hash、retriever/index revision；
3. Bare、Structured Bare 与 Warranted 都只能在同一快照内检索，并拥有相同 query/document/token budget；
4. live-web end-to-end 结果可作为 secondary robustness track，但不能替代冻结主结果。

在该共同证据空间内，对每条 benchmark claim：

1. 输入 claim sentence 与完整 DRR context；
2. 必要时将 sentence 分解成少量 independently judgeable propositions；
3. 使用与 Bare Agent 完全相同的 dense retriever、查询/文档/token 预算搜索冻结的外部科学来源快照；
4. 将来源中的 material findings 写为 evidence propositions，并挂接原文附件；
5. 对综合结论写出 warrant；
6. 将冲突结果、范围限制、时间不一致和替代解释写成 rebuttals；
7. 对关键命题调用局部 `review`；
8. 主 agent 综合 whole argument，输出三分类 verdict 与 rationale；
9. 导出图、事件、搜索日志、最终答案与成本。

### 6.4 系统变体

- **Matched Bare Agent**：同模型、同 search/RAG、同工具和总预算，自由 scratchpad；
- **Structured Bare Agent**：采用同样的 claim decomposition、证据/反证/warrant checklist 和 critic 预算，但只写临时结构化工作表，不获得持久 graph、baseline warning 或 append-only history；
- **Warranted without review**：保留 graph、baseline、rebuttal 与 qualifier，但禁用独立 reviewer；
- **Full Warranted**：完整协议；
- **DeepFactEval / 其他公开方法**：作为不同预算下的外部参考。

最低可发表包在全量 621 claims 上运行 Matched Bare、Structured Bare 与 Full Warranted；`without-review` 可只在预注册的 150–200 claim 分层子集上运行，避免为一个解释性消融复制全部昂贵检索与审查成本。

如果 Full Warranted 获得额外 critic 调用，Bare Agent 必须得到等量 self-critique 调用或相同总 token 预算。否则无法排除“只是多调用了一个模型”。

### 6.5 指标与统计

benchmark-comparable 主报告遵守官方口径：将 CONTRADICTORY 与 INCONCLUSIVE 合并为 unsupported，报告：

- Accuracy；
- supported class F1；
- supported class Precision；
- supported class Recall。

为直接奖励 rebuttal / counterevidence handling，三分类 Macro-F1 与官方 binary supported-class F1 设为**共主终点**并作实验内多重校正；另外报告：

- supported / contradictory / inconclusive 分类别 recall；
- rationale/evidence source coverage；
- false-supported rate；
- 每 claim 的搜索次数、文档数、token、时延和美元成本；
- unresolved warnings/findings、rebuttal 数量等解释性过程指标。

反证处理的专项主张只有在 contradictory recall 同时改善、且不是把 inconclusive 粗暴改判为 contradictory 时才成立。置信区间必须按 report 做 paired cluster bootstrap，不能把 621 条高度相关 claims 当成完全独立样本。完整 test release 建议运行 3 次；如果成本受限，最低可接受方案是全量 deterministic run，加一个按 report/domain 分层的重复运行子集估计 agent 方差。

### 6.6 预期结果与错误分层

预期 Warranted 的优势主要出现在：

- citation misattribution；
- 多来源综合不成立；
- 相关性被误写为因果性；
- 原文限定条件在报告中丢失；
- 支持性文献被 cherry-pick，而反证被忽略；
- claim 强度超过实际证据强度。

不应预期 Warranted 自动解决搜索召回不足。若失败样本根本没有检索到相关文献，这是 object-layer retrieval bottleneck；若已检索到足够材料却仍判断错误，才是 argument-layer failure。报告必须按这两类拆分。

最关键的因果证据是：

- Warranted 相对 Matched Bare Agent 的系统增益；
- Full Warranted 相对 without-review 的增益与成本；
- 在检索成功子集上仍存在的判断增益。

### 6.7 嵌套过程分析：轨迹问题审计

DeepFact 的最终分数回答“系统是否有效”，轨迹问题审计回答“运行中实际出现了什么问题、Warranted 报出的信号是否真实、信号出现后问题是否得到正确处置”。它不另建 benchmark，而是使用主实验已经封存的图、事件和日志。

#### 6.7.1 日志与问题事件

所有系统变体都保存搜索、工具调用、模型消息、最终判断与成本日志。Full Warranted 另外导出：

- warning/finding 出现前的完整局部快照：目标命题、直接 evidence、warrant、rebuttals、qualifier 与判断基线；
- signal 类型、触发点与时间，但人工盲审材料暂不展示 signal 的批评文本；
- signal 之后 agent 的处置：重读、重审、修改、dismiss 或忽略；
- 处置后的命题状态和最终 verdict。

统计单位不是原始 log line，而是去重后的 **issue episode**。同一命题、同一根因、同一判断基线周期内产生的多个 warning/finding 合并为一个事件；L1 与 L2 对同一根因都发出信号时保留两个 detector 标签，但真实问题只计一次。Agent 在没有 warning/finding 的情况下自主发现的问题单独记录，不能归因于 Warranted detector。

#### 6.7.2 抽样与盲审

1. 先从全量 DeepFact 运行导出所有 issue episodes；若不超过 300 个则全部人工审计；若更多，则按 report、L1/L2、warning/finding 类型分层抽取 250–300 个，并保存每层总体数量和抽样概率。
2. 每个样本先只向标注者展示 **signal 产生前**的命题状态和底层来源，不展示 Warranted 的批评文本、agent 后续动作、最终结果或 benchmark gold，避免确认偏差。
3. 两名标注者独立回答：是否存在问题、是否需要重查、是否需要修改、问题类型与潜在影响；分歧由第三人仲裁，并报告一致性。
4. 完成独立问题判断后，再展示 signal 与后续轨迹，判断它是否命中人工确认的根因，以及 agent 是否正确解决该问题。

人工标签采用四级口径：

- `no_issue`：没有可确认的问题；
- `protocol_only`：机械触发正确，但不构成实质性重查义务；
- `recheck_required`：有充分理由重新检查原判断，但未必需要改判；
- `revision_required`：证据、warrant、rebuttal 或 qualifier 至少一项应修改。

同时标注根因：source mismatch、invalid warrant、ignored counterevidence、missing/overstrong qualifier、stale dependency、insufficient evidence 或 other。只有 `recheck_required` 与 `revision_required` 计入实质性真实问题。

#### 6.7.3 指标

核心人工指标为：

\[
\text{Detection Precision}
=
\frac{N(\text{recheck\_required or revision\_required})}
{N(\text{audited surfaced issue episodes})}
\]

并报告：

- **confirmed surfaced issue yield lower bound**：系统报告且经人工确认的不同实质问题总数，以及每份报告、每 100 个已判断命题的确认问题数；它不是总体发生率；
- **revision-required precision**：系统报告的问题中确实需要修改状态的比例；
- **correct resolution rate**：所有 `recheck_required` 与 `revision_required` 问题中，agent 后续采取了与人工标签一致的重查、修改或保留判断的比例；
- **revision-required repair rate**：只在 `revision_required` 子集中，agent 正确修改证据、warrant、rebuttal 或 qualifier 的比例；另报 dismiss correctness 和 unresolved rate；
- **cost per verified issue**：每确认或修复一个真实问题增加的 token、模型调用、时间与美元成本；
- 按 L1 structural warning、L2 semantic finding 和根因类型分层的 precision、确认问题产出率下界、正确处置率与需修改问题修复率。

L1 的“协议 precision”与“实质 precision”必须分开。代码正确检测到引用变化并不自动意味着该变化具有语义影响；论文真正关心的是人工是否认为需要重查或修改。置信区间按 report 聚类；如果使用分层抽样，总体估计必须使用抽样权重，并同时报告各层原始分母。

#### 6.7.4 能与不能证明什么

仅审计系统报告的问题时，确认的问题数只能构成 agent 运行中问题发生的**下界**，Detection Precision 也不能改写为 recall。若要估计总体问题发生率或检测覆盖率，需要再从未报警的判断状态中按概率随机抽取 100–150 个阴性样本，以同一盲审协议标注，并按抽样权重估计未检出问题率。

因此，这项分析支持的是：端到端运行中确实观察到实质性问题；Warranted 能以某一 precision 暴露其中一部分；这些信号之后有多少问题得到正确处置或修复。由于 Warranted 将判断显式拆成命题而 Bare Agent 没有同构节点，不能直接比较不同系统的原始问题数量；若要比较发生率，必须先定义各系统共享的 claim-level decision snapshot。正确处置率与修复率都是条件过程指标，除非进一步随机隐藏部分 signal，否则不能把先后顺序直接表述为 signal 的因果修复效应。系统间最终效果的因果比较仍由 DeepFact 的 Matched Bare / Structured Bare / Full Warranted 实验承担，证据修订机制的受控识别仍由 VitaminC 承担。

### 6.8 泄漏控制

- 固定 DeepFactBench 数据 revision；
- agent 只能看到 sentence、DRR context 与允许的 metadata；
- 屏蔽 `human_verdict`、`human_reason`、benchmark 页面、HF 数据页、GitHub benchmark 仓库和相关镜像；
- 搜索允许访问原始科学文献，但禁止搜索 benchmark claim 原句加“DeepFact”之类标识；
- scorer 在 agent 完成并封存轨迹后运行；
- 主实验使用冻结 corpus/index；secondary live-web track 保存每次检索结果和时间戳，单独估计开放网络漂移。

### 6.9 与 DeepFact 的 Audit-then-Score 区分

DeepFact 的 AtS 维护的是**benchmark 的可修订 ground truth**；Warranted 维护的是**research agent 在任务执行中的活论证状态**。二者都重视审计与修订，但对象不同：

- AtS：谁来纠正 benchmark label；
- Warranted：agent 的哪条结论依赖什么、为何成立、何时需要重查。

论文应把 AtS 作为强相关工作正面讨论，而不是弱化或回避。

---

## 7. 实验四：ScienceAgentBench —— 下游科研任务效用

### 7.1 Benchmark 现状

[ScienceAgentBench](https://proceedings.iclr.cc/paper_files/paper/2025/hash/f12b4df26344f3be803c06b555252efe-Abstract-Conference.html) 发表于 ICLR 2025，包含来自 44 篇同行评议论文的 102 个任务，覆盖 bioinformatics、computational chemistry、GIS、psychology/cognitive neuroscience 四类学科。输入包括 task instruction、dataset tree、data preview 和可选 expert knowledge；输出是可独立运行并保存规定结果的 Python 程序。

[官方仓库](https://github.com/OSU-NLP-Group/ScienceAgentBench)已在 2026-04-30 发布 verified split 与 `benchmark_verified.zip`，应使用该版本和官方 Docker harness。

### 7.2 在论文中的正确定位

ScienceAgentBench 主要测试科研代码与数据任务执行，不直接测试 argument。它只能作为 external validity：显式论证状态是否能让 agent 更少犯“程序能跑，但科学任务做错了”的错误。

它不能替代 DeepFactBench，也不能单独证明 warrant/rebuttal 机制成立。

### 7.3 公平对照

比较：

- **Bare self-debugging Agent**；
- **Structured Bare self-debugging Agent**（完整扩展包建议加入；若预算有限，至少在预注册的跨领域任务子集运行）；
- **同一 self-debugging Agent + Warranted**。

二者固定同一 model、tools、expert knowledge、执行次数、运行时间、token 与 critic 预算。按官方设置每个任务尝试 3 次，同时报告官方 best-of-three 聚合与全部 attempts 的均值，避免只展示挑选后的最好结果。

### 7.4 Warranted 如何入图

图不是任务日志。每个任务只记录会影响科学正确性的命题：

- 根命题：程序正确实现 benchmark 要求的科学分析；
- 数据语义与预处理是否正确；
- 方法是否真的是目标方法，而非更简单的替代物；
- 输出是否满足关键数值/统计/解释条件；
- evidence：agent 在截止前可见的生成程序、结果文件和关键日志；官方 evaluator 输出只在轨迹封存后由实验 harness 附加作分析，绝不反向提供给 agent；
- rebuttals：伪造数据、标签或单位错误、空/退化输出、错误模型替代、环境导致结果无效等。

命令、TODO、安装过程和普通 debug 记录留在 object layer，不进入 argument graph。

建议采用固定触发策略：首次成功执行后，对正向根命题最多进行一次 semantic review；Bare Agent 获得等价 critic 预算。这样避免由 agent 自由决定是否多花计算而造成不可控偏差。

在正式运行前应冻结一份 task-to-proposition rubric，明确什么情况下允许建立 data-semantics、method-validity、result-threshold 和 interpretation proposition。用 10–20 个 pilot tasks 由两名标注者独立映射并检查一致性，防止 Warranted arm 获得未向 baseline 提供的人为任务分解或额外 gold hints。

### 7.5 官方与辅助指标

主指标：

- **SR (Success Rate)**：任务输出是否满足科学成功标准。

辅助指标：

- **VER (Valid Execution Rate)**：程序是否运行并产生要求的文件；
- **CBS (CodeBERTScore)**；
- API cost、wall-clock、执行次数；
- \(P(SR=1 \mid VER=1)\)：在程序能运行的前提下，科学任务真正做对的比例，仅作描述性诊断；
- root overclaim rate：根命题被正向判断，但官方 SR=0；
- 按任务类别和领域的 subgroup effect。

`P(SR=1 | VER=1)` 有助于解释“程序能跑但科学任务没做对”的错误，但 VER 是系统行为产生后的中介变量，跨系统条件比较可能产生 post-treatment selection bias。因此它不做主要显著性检验，也不承担因果主张；主比较始终是官方 SR，并把 VER 与失败类型分开报告。如果 Warranted 只提高 VER 而 SR 不升，则不足以支持 argument-accountability 主张。

### 7.6 预期结果

预期 VER 变化较小；SR 和 conditional SR 在以下任务上更可能提升：

- 需要 expert knowledge 选择正确方法；
- 多阶段预处理与建模；
- 程序可运行但可能使用错误标签、单位或目标变量；
- 需要解释模型输出或满足科学阈值。

对纯安装、文件格式、简单 deterministic transform 和一般可视化任务，Warranted 可能无增益甚至因维护图而变慢。这种异质性应作为边界条件报告，而不是隐藏在平均分中。

### 7.7 泄漏与运行要求

- agent 只挂载 task data 和允许的输入；
- 隐藏 gold programs、evaluation programs、评分 rubric 和 gold outputs；
- 禁止访问 benchmark repo、HF 数据页与排行榜，允许访问一般库文档；
- 保存 model/version、prompt hash、Warranted commit、数据 revision、Docker image digest；
- 全部 evaluator 在 agent 轨迹封存后运行；
- 不重新分发官方禁止再分发的解压数据文件。

---

## 8. 条件性扩展：DeepFact 人类审计效用实验

本节与第 6.7 节的**离线轨迹问题审计**不同：第 6.7 节由标注者核验系统信号是否对应真实问题，不比较人使用哪种界面；本节让人实际使用 Bare/Warranted 两种轨迹完成诊断任务。只有当标题、摘要或贡献列表明确声称“Warranted 帮助人类更高效地审计研究结论”时，本节才应进入 confirmatory package。若不做，应把口径收窄为 **machine-visible dependency invalidation and audit-ready trace preservation**，不要把机器检测 precision 直接等同于人类审计效用。

### 8.1 最小可行设计

1. 从 DeepFactBench 预先按 report、label、系统正确/错误和错误类型分层抽取 20–40 个 cases；
2. 为每个 case 生成两种不泄漏 gold 的审计材料：
   - Bare/Structured Bare 的搜索、证据、critique 与最终判断轨迹；
   - Warranted 的 proposition graph、attachments、warrants、rebuttals、warnings/findings 与最终判断；
3. 保证两种材料包含相同底层来源，并报告长度差异；不能通过删减 Bare 信息人为制造优势；
4. 采用 within-subject、counterbalanced crossover，避免某位审计者总是先看某一种界面；
5. 每个 case 至少两名独立审计者，冲突由第三人 adjudicate；
6. 使用 DeepFact human reason 与预先人工编码的断点作为 scoring key。

### 8.2 任务与指标

审计者在固定时间内回答：

- 哪条来源最直接支持或反驳目标 claim；
- 主要错误属于 source mismatch、invalid warrant、missing qualifier、ignored counterevidence 还是 insufficient evidence；
- 当前 verdict 是否合理；
- 若不合理，最先需要重查哪个 proposition/依据。

主指标是 correct diagnosis rate；辅助指标是 time-to-correct-diagnosis、source localization accuracy、inter-annotator agreement 与主观 workload。按 case 和 annotator 建模重复测量。

STORM 的已发表先例表明，小规模专家研究也可以有价值：其 NAACL 2024 人评只抽取 20 个 topics，并由 10 位 Wikipedia editors 完成。这里同样不追求大而全，而要直接回答“图是否让断点更容易被找到”。

---

## 9. 为什么其他 benchmark 不进入核心实验

| Benchmark | 发表状态 | 最终决定 | 原因 |
|---|---|---|---|
| LongMemEval | ICLR 2025 | 删除核心；最多 appendix | 测 timestamped multi-session chat memory QA，包含 knowledge update 与 temporal reasoning，但不要求显式科研 claim–evidence–warrant 表示；与本文核心 construct 不完全一致 |
| RippleEdits | TACL 2024 | 暂不使用 | 测单个知识编辑的 1–2 hop ripple effect，与科研 argument 只有机制重叠，容易让论文变成知识编辑论文 |
| MQuAKE | EMNLP 2023 | 原版不用 | 原任务关注模型知识编辑后的多跳 QA，且存在数据修订与质量争议 |
| MQuAKE-Remastered | ICLR 2025；数据与工具公开 | 候补 | 若审稿人要求“依赖传播”证据，可作为多跳更新传播补充；仍不是科研证据 benchmark |
| StreamingQA | ICML 2022 | 删除核心 | 测时序新闻 QA、增量语料适应与遗忘；不覆盖显式论证状态、反证或科研 warrant 维护 |

这不是认为这些 benchmark 质量低，而是遵循 construct validity：每个实验必须奖励我们声称要改进的行为。继续堆机制相似但构念错位的 benchmark，只会稀释论文主线。

---

## 10. 最小消融与反驳闭环

### 10.1 “提升只是因为多用了一个模型”

控制方法：相同总 token/critic 调用预算；Bare Agent 获得等量 self-critique。Full Warranted 与 without-review 的差值单独报告。

### 10.2 “提升只是因为检索更强”

控制方法：Bare 与 Warranted 共享同一个 dense retriever、搜索 API 与文档预算；记录 retrieval overlap 与 source coverage。在 DeepFactBench 的检索成功子集上再次比较判断正确率。

### 10.3 “图只是更长的 scratchpad”

控制方法：Bare Agent 允许等长自由 scratchpad；VitaminC 先检验 scratchpad 难以提供的 baseline invalidation，再单独评价运行于 warning signal 之上的 agent revalidation policy；同时用事件历史检查图是否保留了旧判断和修订原因。

### 10.4 “收益来自强制多想一步，而不是 argument 表示”

控制方法：Bare critic 使用相同次数的 structured self-check；Warranted 的额外输入仅为显式 dependency、warrant、rebuttal、qualifier 和 baseline。SciFact 检查 Q1/Q2 协议，VitaminC 检查依赖基线，DeepFact 检查完整系统。

### 10.5 “可审计性只是主观印象”

主实验不仅报告自动中间量，还对 DeepFact 轨迹中的 warning/finding 做盲审，报告确认问题产出率下界、检测 precision、实质 precision、正确处置率与需修改问题修复率。该分析证明机器信号是否对应真实问题，但仍不等于“人更容易审计”。若论文把帮助人类审计提升为主 claim，再追加第 8 节的小型 blinded human study，比较定位错误原因的正确率和时间。

---

## 11. 实现改造方案

### 11.1 最小工程边界

建议新增独立评测目录，不把 benchmark 逻辑塞进生产 MCP 工具：

```text
experiments/evaluation/
  README.md
  common/
    run-spec.ts
    manifest.ts
    graph-export.ts
    budget.ts
    leakage-policy.ts
  scifact/
    adapter.ts
    scorer.ts
  vitaminc/
    adapter.ts
    replay.ts
    scorer.ts
  deepfact/
    adapter.ts
    runner.ts
    scorer.py
    trace-audit/
      export.ts
      sample.ts
      annotation-schema.json
      scorer.ts
  scienceagent/
    adapter.ts
    runner.ts
  protocols/
    prompts/
    model-lock.json
  outputs/              # gitignored
```

上游 benchmark 官方 Python scorer 和 Docker harness 保持原样，通过 JSONL/文件接口调用，不复制其评分逻辑到 TypeScript。

### 11.2 每个 run 必须产出的文件

```text
run_id/
  run-manifest.json
  input.json
  final-answer.json
  graph.db
  graph-export.json
  events.jsonl
  signal-candidates.jsonl
  issue-episodes.jsonl
  search-log.jsonl
  tool-log.jsonl
  artifacts/
  official-score.json
  auxiliary-score.json
```

`run-manifest.json` 至少记录：

- benchmark、split、item id、数据 revision；
- git commit 与 dirty flag；
- model/provider/version、temperature、seed；
- public prompt hash、review protocol hash；
- token/tool/search/time budgets；
- retriever 与索引 revision；
- Docker/image/package versions；
- run start/end time 与失败类别。

### 11.3 当前代码需要特别处理的五点

1. **SciFact verdict adapter。**生产 `review` 只输出 Q1/Q2，不要直接改成三分类 fact-checker；在评测层做二分类映射。
2. **VitaminC evidence version。**首轮用 evidence proposition 的 content 更新触发 `baseline_refs` content hash；附件内容 digest 是后续增强。
3. **DeepFact retrieval parity。**当前 `find_propositions` 主要是 proposition content 的 lexical FTS/LIKE，不应拿它与 dense RAG 直接比较。开放文献检索使用共享外部 retriever。
4. **ScienceAgent graph hygiene。**adapter 必须限制入图对象，防止把每条命令和 TODO 变成 proposition，从而把 Warranted 退化成昂贵 task log。
5. **轨迹问题审计导出。**每个 warning/finding 必须能关联到 signal 前快照、触发点、后续处置与最终状态；issue episode 去重算法只属于评测层，不改变生产事件历史。

### 11.4 测试要求

- 每个 adapter 至少 3 个 deterministic fixture；
- runner 的 budget、路径 allow-list、gold hiding 与 scorer isolation 有单元测试；
- graph export 与 DB 中 proposition/event 数量一致；
- 同一日志重复导出时产生相同的 issue episode id；L1/L2 同根因信号能稳定合并，但 detector 标签不丢失；
- 模拟 review unavailable 时必须记为 run failure，不能降级为 pass；
- official scorer 用一个已知 gold/prediction fixture 做回归测试；
- 同一 manifest 重跑时能产生相同输入与相同 prompt hash。

---

## 12. 实验排期与阶段门

排期分成两个里程碑：**第 6 周得到最低可投稿核心包**；第 7–9 周只做由核心结果和论文 claim 决定的扩展。DeepFact 轨迹问题审计与主实验并行完成，属于核心包；ScienceAgentBench 和人类审计效用实验不阻塞主论文判断。

### 阶段 0：统一 harness（第 1 周）

- 定义 run spec、预算器、manifest、graph export 与 signal 前后快照导出；
- 完成隔离目录、模型锁定和泄漏策略；
- 用 5 个 toy cases 打通 Bare/Warranted 双轨。

**阶段门：**同一 item 可重复运行，官方/辅助评分、图和历史能一一对齐。

### 阶段 1：SciFact sanity check + VitaminC pilot（第 2 周）

- 构造 oracle-cited-abstracts adapter；
- 做 100 条 claim pilot，冻结 prompt 与 mapping；
- 跑冻结的公开 labeled dev/CV 划分，完成 reviewer error analysis；如需官方 test 结果则另走 leaderboard，不把隐藏 test 当成本地可评分数据。
- 同时构造 VitaminC revision tuples，并完成 200 对 pilot；SciFact 达到可诊断组件边界后不继续扩张规模。

**阶段门：**review 输出可稳定映射，citation 能定位到 abstract sentences；VitaminC 能区分 label-flip 与 label-preserving revision。

### 阶段 2：VitaminC 主实验 + DeepFact pilot（第 3 周）

- 构造 real revision tuples 与 factual/non-factual controls；
- 将 pilot 扩展到约 1,000 个平衡样本；
- 绘制 accuracy–revalidation-cost 曲线。
- 同时按 report/domain 分层抽 60–100 条 DeepFact claims，验证冻结 corpus、检索召回和单例预算。
- 用 DeepFact pilot 轨迹校准 issue episode 去重规则与四级人工标签，冻结盲审说明、抽样方案和实用性门槛；正式 test 轨迹不得再用于改标签定义。

**阶段门：**能可靠区分“warning 被发现”和“判断真正被更新”，且 stale-use 可自动计算；DeepFact 预算和检索协议可以冻结。

### 阶段 3：DeepFactBench（第 4–6 周）

- 冻结搜索后端、查询/文档预算和 prompt；
- 运行全量 621 claims：Matched Bare、Structured Bare、Full Warranted；
- 在预注册的 150–200 claim 分层子集运行 `without-review`；
- 导出 Full Warranted 的全部 issue episodes；按第 6.7 节执行全审或 250–300 个分层盲审，完成双人标注、仲裁和修复漏斗；
- 完成 report-cluster bootstrap、轨迹问题 precision/yield/repair 分析与错误类型分析。

**阶段门：**主结果不能依赖访问 benchmark gold；检索失败和推理失败能分开；轨迹标注者先于 signal 文本独立判断问题，且 L1/L2 信号按根因去重后仍可追溯。

**第 6 周投稿核心检查点：**只有当 DeepFact 的共主终点、轨迹问题审计、VitaminC 的准确率—成本关系和 Matched/Structured Bare 控制共同支持收窄主张时，进入论文主结果写作。若不支持，先诊断表示、policy、检测 precision 或检索瓶颈，不用新增 benchmark 掩盖问题。

### 阶段 4：按主张选择一个扩展（第 7–8 周，可选）

- 若要主张下游科研效用：接入 ScienceAgentBench verified split 与 Docker harness，先做 12 个跨领域任务 pilot，再决定是否跑 102 tasks × systems × 3 attempts；
- 若要主张帮助人类审计：优先做 20–40 个 DeepFact cases 的 blinded human audit study；
- 若两项都不进入摘要主张：将预算用于第二模型家族或 DeepFact 重复运行，而不是为了实验数量硬做扩展。

**阶段门：**新增实验必须对应一条明确的新增 claim；ScienceAgentBench 不只看程序运行，人类审计效用实验不以机器检测 precision 代替人的审计表现。

### 阶段 5：鲁棒性、复核与定稿（第 9 周，可选扩展后）

- 冻结结果表和图；
- 对所有 primary endpoints 做预注册检验；
- 复查失败轨迹、预算公平性和数据泄漏；
- 只有在核心论证仍缺多跳依赖传播证据时，才决定是否追加 MQuAKE-Remastered；否则停止扩展。

---

## 13. 预期结果图景与判定规则

以下是研究假设，不是承诺：

| 实验 | 支持论文主张的理想结果 | 不足以支持主张的结果 |
|---|---|---|
| SciFact | Macro-F1/false-supported 优于 matched direct reviewer，引用更准确 | 只生成了更长 explanation，标签和 rationale 均未改善 |
| VitaminC | invalidation signal 高召回；其上的 warning-guided policy 接近 Always-revalidate 准确率，并显著降低重审成本与 stale use | warning 漏掉实质变化；或 policy 对所有更新都全量重审/大量错误 dismiss |
| DeepFactBench | 在同检索/预算下提高官方 F1/Accuracy，尤其减少 synthesis/causal/qualifier/counterevidence 错误 | 只因检索更多文档而提升；在 retrieval-success 子集无增益 |
| DeepFact 轨迹问题审计 | 人工确认端到端运行中存在实质问题；L1/L2 信号达到 pilot 前冻结的 precision/yield 实用性门槛，并有相当比例随后被正确处置；`revision_required` 子集具有可报告的修复率 | 绝大多数信号仅为形式触发、无法定位根因，或 signal 出现后 agent 仍不重查、不修复或错误 dismiss |
| ScienceAgentBench | SR 与 `P(SR=1|VER=1)` 提升，VER 大体持平，成本可解释 | 只提升 VER；或 SR 不升且成本显著增加 |

### 13.1 首投稿核心成功判据

最低充分结果由四部分组成：

1. Full Warranted 在 DeepFact 全量主实验的共主终点上优于 Matched Bare，并且 Structured Bare 不能解释全部增益；
2. 增益在 retrieval-success 子集仍存在，且伴随 false-supported rate、contradictory recall 或 qualifier/counterevidence 错误的改善，而不是只检索了更多文档；
3. DeepFact 轨迹盲审确认了非零且具有实质性的运行中问题；Warranted 的 L1/L2 信号达到在 pilot 后、正式 test 前冻结的 precision/yield 实用性门槛，并形成可观察的正确处置/修复漏斗；
4. VitaminC 上，warning-guided policy 显著减少 stale use，并在预注册的准确率—成本标准下优于 No-maintenance、接近或更高效于 Always-revalidate。

SciFact 成功会加强 `review` 的组件解释，但不是核心论文成立的必要条件。只要上述四点成立，就足以支持第 3.5 节的收窄主张；无需等待 ScienceAgentBench。

### 13.2 完整研究路线的最强成功叙事

如果核心证据与条件性扩展均符合预期，可以形成以下完整结论：

1. Warranted 的局部审查不是只有形式，它在 scientific claim–source 判断上具有可测的语义能力；
2. 显式判断基线把证据更新转化为可定位的重查义务，并形成优于“从不重算/全部重算”的准确率—成本折中；
3. 这些机制组合后，能改善开放世界深度研究报告的 claim-level factual auditing；
4. 真实运行轨迹中确实存在来源错配、无效 warrant、遗漏反证、过强 qualifier 或过期依赖；Warranted 能以可量化 precision 暴露其中一部分，并观察到其中一部分随后被正确处置或修复；
5. 该收益在一部分真实科研计算任务中转化为科学成功率，而不是仅转化为代码可运行率。

### 13.3 部分成功时如何收缩论文

- SciFact、VitaminC 成功，DeepFact 失败：论文收缩为“local review + dynamic epistemic maintenance”，并把开放世界检索列为瓶颈；
- DeepFact 成功，ScienceAgentBench 不成功：核心论文仍可成立，但不宣称普遍下游科研效用；
- DeepFact 最终分数成功，但轨迹信号 precision 低：保留端到端效果，不能声称 Warranted 能可靠定位运行中问题；需要检查 warning 粒度、review calibration 或去重协议；
- 轨迹信号 precision 高但修复率低：只声称问题暴露有效，不声称 agent 能利用该信号完成维护；
- 只有 ScienceAgentBench 成功：不能证明 argument 机制，应首先排除工程 scaffold、额外调用与执行调试因素；
- VitaminC 上 invalidation signal 能发现变化、但其上的 policy 不能减少重审：只宣称 dependency invalidation，不宣称 selective revalidation 的准确率—成本收益；
- Full 与 without-review 无差异：保留 persistent graph 主张，弱化独立 semantic reviewer 的贡献。

### 13.4 真正会否定核心假设的结果

在同模型、同检索、同预算下：

- Warranted 持续提高成本，却不降低 DeepFact false support 或 VitaminC stale use；
- 轨迹审计显示绝大多数 warning/finding 只是形式触发，或者确认的问题几乎都未被正确处置；
- agent 经常无视、误用或机械 dismiss graph signals；
- 若论文声称下游科研效用，ScienceAgentBench 的 scientific task error 不下降且成本显著增加；
- 若论文声称帮助人类审计，graph trace 不能提高错误定位正确率或缩短定位时间；
- 所有收益都可由等预算 self-critique 或普通 RAG 完全解释。

这些结果出现时，应修改系统或收缩理论，而不是继续增加 benchmark 掩盖问题。

---

## 14. 汇报时的建议讲法

### 14.1 十分钟结构

1. **问题（1 分钟）**：research agent 会产出答案，但不会维护“结论为何成立、何时失效”。
2. **方法（2 分钟）**：一个 proposition、五槽位、判断基线；L1 warning、L2 review、L3 judgment。
3. **与 RAG 的区别（1 分钟）**：RAG 找上下文，Warranted 维护判断依赖；两者是互补层。
4. **主要证据（4 分钟）**：DeepFact headline result + 真实轨迹的问题发现/修复漏斗 + VitaminC revision mechanism；SciFact 用一张小图说明 `review` sanity check，ScienceAgentBench 只列为条件性扩展。
5. **公平性与风险（1 分钟）**：同模型/检索/预算，gold 隐藏，按 report 聚类统计。
6. **排期与决策（1 分钟）**：六周形成最低投稿包；之后按论文 claim 选择下游效用、人类审计或第二模型鲁棒性之一。

### 14.2 一句话回答常见质疑

- **“这不就是 RAG 吗？”** RAG 决定取回哪些文本；Warranted 记录哪些判断依赖这些文本、为什么，以及文本变化后谁必须重查。
- **“图只是 scratchpad 吗？”** scratchpad 没有稳定依赖、判断基线与可机械检测的 stale obligation；VitaminC 专门检验这一差异。
- **“为什么不只看最终任务分？”** DeepFact 的 headline score 判断系统是否有效；轨迹盲审确认运行中出现了哪些真实问题、系统以多高 precision 暴露它们，以及这些问题之后有多少被正确处置；VitaminC 再受控检验证据变化机制。
- **“为什么不用 LongMemEval？”** 它奖励聊天历史检索，不奖励科研论证审计；普通 RAG 可能更合构，结果无论好坏都难解释核心贡献。
- **“为什么 DeepFact 最重要？”** 它同时包含开放文献、长报告、多来源综合、反证和限定条件，是最接近 Warranted 核心构念的公开、已发表 benchmark。
- **“ScienceAgentBench 能证明 argument 吗？”** 不能单独证明；它只验证前三层机制是否具有真实科研任务的外部效用。

---

## 15. 结论

最终实验包不追求让每个 benchmark 都覆盖整个系统，而是让每项证据承担一个清晰、不可互相替代的证明责任。首次投稿用 **DeepFactBench 最终结果 + DeepFact 轨迹问题审计 + VitaminC + 强匹配控制/关键消融**回答主要矛盾；SciFact 是组件诊断，ScienceAgentBench 与人类审计效用实验由额外 claim 驱动。

完整研究路线可以继续递进为：

\[
\text{local review}
\rightarrow
\text{revision-aware maintenance}
\rightarrow
\text{open-world endpoint + trajectory audit}
\rightarrow
\text{downstream scientific utility}
\]

这条递进是研究路线而非首投稿门槛。它既尊重 Warranted 一直未变的核心思想，也避免把论文降格为工程功能复述。论文真正要论证的不是“我们实现了一个 argument graph”，而是：

> research agent 的可靠性不仅取决于它能检索和生成什么，也取决于它能否持续维护自己的研究判断、暴露判断的失效条件，并在依据改变时承担重新论证的义务。

## 参考资料

- Wadden et al. [Fact or Fiction: Verifying Scientific Claims](https://aclanthology.org/2020.emnlp-main.609/), EMNLP 2020.
- Schuster et al. [Get Your Vitamin C! Robust Fact Verification with Contrastive Evidence](https://aclanthology.org/2021.naacl-main.52/), NAACL 2021.
- Huang et al. [DeepFact: Co-Evolving Benchmarks and Agents for Deep Research Factuality](https://aclanthology.org/2026.acl-long.1586/), ACL 2026.
- Chen et al. [ScienceAgentBench: Toward Rigorous Assessment of Language Agents for Data-Driven Scientific Discovery](https://proceedings.iclr.cc/paper_files/paper/2025/hash/f12b4df26344f3be803c06b555252efe-Abstract-Conference.html), ICLR 2025.
- Wu et al. [LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory](https://openreview.net/forum?id=pZiyCaVuti), ICLR 2025.
- Cohen et al. [Evaluating the Ripple Effects of Knowledge Editing in Language Models](https://aclanthology.org/2024.tacl-1.16/), TACL 2024.
- Zhong et al. [MQuAKE: Assessing Knowledge Editing in Language Models via Multi-Hop Questions](https://aclanthology.org/2023.emnlp-main.971/), EMNLP 2023.
- Zhong et al. [MQuAKE-Remastered: Multi-Hop Knowledge Editing Can Only Be Advanced With Reliable Evaluations](https://openreview.net/pdf?id=m9wG6ai2Xk), ICLR 2025.
- Liska et al. [StreamingQA: A Benchmark for Adaptation to New Knowledge over Time in Question Answering Models](https://proceedings.mlr.press/v162/liska22a.html), ICML 2022.
- Shao et al. [Assisting in Writing Wikipedia-like Articles From Scratch with Large Language Models](https://aclanthology.org/2024.naacl-long.347/), NAACL 2024.
- Asai et al. [Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection](https://proceedings.iclr.cc/paper_files/paper/2024/file/25f7be9694d7b32d5cc670927b8091e1-Paper-Conference.pdf), ICLR 2024.
- Shinn et al. [Reflexion: Language Agents with Verbal Reinforcement Learning](https://papers.neurips.cc/paper_files/paper/2023/hash/1b44b878bb782e6954cd888628510e90-Abstract-Conference.html), NeurIPS 2023.
- [Enabling Large Language Models to Generate Text with Citations](https://aclanthology.org/2023.emnlp-main.398/), EMNLP 2023.
- [RARR: Researching and Revising What Language Models Say, Using Language Models](https://aclanthology.org/2023.acl-long.910/), ACL 2023.

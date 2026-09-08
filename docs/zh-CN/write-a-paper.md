# 写一篇论文

> [English](../en/write-a-paper.md) | [简体中文](write-a-paper.md)

## 目标

用 `/literature-writing` 撰写或修订 LaTeX，让所有承重陈述都能追溯到论证图。若任务是针对较大文献集合开展问题驱动的综述，先运行 `/literature-survey`，再把综合结果交给 `/literature-writing`。

可靠的交付应满足：

- 每条被引用的论文发现都有对应 Proposition；
- 来源论文附在该命题的 evidence 中；
- 综合命题引用这些论文发现作为 evidence；
- warrant 解释为什么这些证据能支撑综合；
- 文本语气强度与命题 qualifier 一致；
- 矛盾以 rebuttal 命题存在，而不是被改写掉。

当前系统没有 compile 步骤。结构 warning 自动重算，`get_stats` 提供最终结算视图。

## 一次性配置：`overleaf-setup`

`/overleaf-setup` 会安装并认证 `leaf` CLI，把本地 LaTeX 目录连接到 Overleaf 项目，并写入用于 staging 与推送源码的 Stop hook。

该 hook 同时执行 Proposition 引用约束。配置完成后重启 Claude Code。

## 把文章映射到论证图

图里的每个节点都是 Proposition：

| 文章需要表达的内容 | 图中表示 |
|---|---|
| 论文报告的一条发现 | Proposition，并把论文放进 `evidence.attachments` |
| 段落的综合观点 | Proposition，并在 `evidence.nodes` 引用相关发现命题 |
| 这些发现为何支撑观点 | 该命题的 `warrant` |
| 对推理原则本身的证据 | 先晋升 warrant，再给晋升后的命题挂 evidence |
| 冲突发现或边界条件 | 用 `attacks={node, slot}` 创建的 Proposition |

一条命题被别人引用时是 ground，自身可信度正在被判断时是 claim；它们是视角，不是不同节点类型。

若主张范围真的变化，可以修改命题。不要为了隐藏矛盾而改写；应把矛盾放进 rebuttal 槽，再根据全部证据判断 qualifier。

## `\cite{prop_N}` 标准

起草时按 Proposition id 引用：

```latex
\cite{prop_42}
```

Overleaf push hook 会在 `.toulmin/graph.db` 中解析命题 42，找到它附带的论文 PDF，并在 staged 副本中把 `prop_42` 替换成对应 bibliography key。

| 元素 | 示例 |
|---|---|
| `.bib` key | `vaswani2017attention` |
| 附件 PDF | `vaswani2017attention.pdf` |
| 草稿引用 | `\cite{prop_42}` |

每条被引用的命题必须存在，至少附有一份仍存在的 PDF，而且项目某个 `.bib` 文件中必须有匹配 key。多个 PDF 会展开成多个 key；非 PDF 附件继续作为审计证据保留，但不参与引用展开。

由此得到可审计链：

```text
文章句子 ──\cite{prop_N}──► Proposition ──attachment──► 论文
```

这条链证明 provenance，不自动证明 credibility。附上论文不会自动抬高 qualifier，创建 Proposition 也不会自动触发 LLM review。

## 让文本强度匹配 Qualifier

- **论文口吻：**“Smith 等报告 X”只断言论文说了什么，因此可引用任意 qualifier 的命题；若命题为 `refuted`，句子也必须带出被推翻这一事实。
- **综合口吻：**“现有证据表明 X”需要一条带 evidence 和 warrant 的综合命题。`possibly` 应使用试探语气；只有 `probably` 或 `certainly` 才适合平直断言。
- **Unestablished：**不要把 `unestablished` 的综合命题写成结论，但仍可以归因式陈述论文报告了什么。

运行 `/cite-review` 同时检查内容忠实性与强度一致性。它可以修正文句或图连接，但 qualifier 变化仍必须是明确判断。

## 值得留意的状态

| 状态 | 含义 |
|---|---|
| 被引用命题没有 PDF 附件 | 引用没有来源产物，push 会被阻断 |
| PDF stem 没有匹配 bibliography key | 无法展开成合法 LaTeX 引用 |
| 正向 qualifier 的综合命题缺 evidence 或 warrant | 结构 warning：当前强度缺乏可见支撑 |
| 判断之后，证据内容或 qualifier 发生变化 | re-check warning：旧判断依赖的是另一份前提 |
| 重要发现仍为 `unestablished` | 只能归因式使用，或在依赖它之前明确判断 |
| review finding 未处理 | 语义问题会一直可见，直到新 review 取代或写理由 dismiss |

交付前运行 `get_stats`，处理重要红点，并确认文章的语气强度仍与图一致。

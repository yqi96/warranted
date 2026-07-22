# 写一篇论文

> [English](../en/write-a-paper.md) | [简体中文](write-a-paper.md)

## 目标

产出一篇研究论文——或一篇文献综述——其中每一处主张都能追溯到论证图里的证据。**完成**意味着：

- 每个 Ground 都 `verified`（来源论文已附上、内容已确认）
- 每个 Claim 都通过了 `compile_arguments`
- 每个 Claim 都有判定：`supported`、`disputed` 或 `refuted`
- `.tex` 是自洽的：每处引用周围的文字都忠实反映其 Ground

两个 skill 支撑这套流程：先运行一次 `/overleaf-setup` 接好自动推送与引用强制（见下），再用 `/literature-survey` 起草——它在每条外部发现被引用之前先把它接入论证图，并随手维护 `.bib` 文件。

---

## 一次性配置：`overleaf-setup`

写作前运行 `/overleaf-setup`。这是基础设施，不是每次都要做的步骤：

1. 安装 `leaf` CLI，并把你本地的 LaTeX 目录关联到一个 Overleaf 项目
2. 写入一个 hook，在每轮对话结束时自动推送到 Overleaf（没有文件改动的轮次会跳过）
3. 强制执行 `\cite{ground_N}` 引用标准（见下）

配置完成后，重启 Claude Code。之后不用再运行它。

---

## 这个场景下的论证图

根本区别：**证据和前提放进 Ground，你的结论放进 Claim。**

| 节点 | 表示什么 |
|------|---------|
| **Claim** | 你独立的综合结论——你在论证的东西，不是在转述的东西 |
| **Ground** | 一条证据或前提：某篇已发表论文中的发现（附上 PDF）、你自己的实验结果（附上数据文件），或一个作为垫脚石的、已 supported 的 Claim |
| **Warrant** | 连接这组证据与你的 Claim 的推理原则 |
| **Backing** | 使该 Warrant 正当化的方法学共识或元分析 |
| **Rebuttal** | 一篇结论相冲突的论文，或你的 Claim 已记录在案的边界条件 |

一个判断办法：如果句子以"Smith 等人发现……"或"该论文报告……"开头，它属于 Ground；如果以"我们主张……"或"证据表明……"开头，它可能是 Claim。

**Claim 修改纪律。** 当证据确实不支持原有表述时，修改 Claim 是正当的。但把它当作回避承认矛盾的手段就不正当——相冲突的 Ground 应成为 Rebuttal，Claim 的状态则反映证据的真实状态。

---

## `\cite{ground_N}` 标准

按 Ground ID 写引用：`\cite{ground_42}`。起草时别去查 bib key。

每轮结束时，hook 推送到 Overleaf，并自动把每个 `\cite{ground_N}` 替换成由该 Ground 附件文件名推导出的真实 bib key。这只有在文件名本身就是 bib key 时才成立：

| 元素 | 取值 |
|------|------|
| `.bib` 条目 key | `vaswani2017attention` |
| 论文文件名 | `vaswani2017attention.pdf` |
| Ground 附件 | `vaswani2017attention.pdf` |

下载论文时就按它的 bib key 命名——例如 `vaswani2017attention.pdf`。`.bib` 的维护由 Agent 负责。

⭐ **关键在这条链：** `\cite{ground_N}` → 一个 verified 的 Ground → 一份附上的论文。一个 Ground 只有在其来源论文附上、并确认支持所述发现后，才被标记为 `verified`，因此每处引用都能回溯到一份真正被查阅过的文档——而不是大模型凭训练记忆生成的、听起来煞有介事的引用。

---

## 值得留意的图状态

| 状态 | 含义 |
|------|------|
| 来自某篇已发表论文的 `Ground` 没有附上 PDF | 出处缺失；PDF 就是证据记录 |
| 某个 `Ground` 没有任何通往 `Claim` 的 Warrant 路径 | 孤立证据——还没接入任何论证 |
| 某个 `Claim` 没有 `Warrant` | `compile_arguments` 会在结构检查上失败 |
| 某个 `Warrant` 的内容在复述支撑关系 | 循环——不是推理原则；链条审查员会标出来 |
| 某个 `Claim` 被改过、且有相冲突的 `Ground` 却没有 `Rebuttal` | 矛盾被压下去了，而不是被记录下来 |
| `.tex` 里出现 `\cite{authorname}` 而不是 `\cite{ground_N}` | 推送被拦下——每个引用 key 都必须是 `ground_N` |

---

## 当 Agent 跑偏时

**Agent 把引用写成了 `\cite{smith2023}` 而不是 `\cite{ground_N}`。** 到 Overleaf 的推送被拦下——强制 hook 只接受 `ground_N` 形式的 key，正是为了逼每处引用都必须回溯到一个真正被落实过的 Ground。告诉它：*"按 Ground ID 引用——`\cite{ground_N}`——别用作者 key。"*

**Agent 为了让矛盾消失，把 Claim 弱化或改写了。** 冒出了一条相冲突的发现，Agent 没去记录它，反而调整 Claim 让一切不再打架。就说：*"别改 Claim 来回避这个——把相冲突的发现记为 Rebuttal，让 Claim 的状态反映证据的真实状态。"* 只有当证据确实不支持原有表述时，修改 Claim 才正当，而不是用来掩埋冲突。

**某个 Ground 没有附上论文。** 它在引用一份从未被查阅过的来源——正是论证图存在的意义所要防止的那种幻觉风险。在可视化界面选中该 Ground，问：*"这个 Ground 没附论文——它是基于什么？"* 在来源附上、并确认支持所述发现之前，这个 Ground 不能 `verified`，任何建立在它之上的东西都不该被引用。

**Warrant 只是在复述 Ground 支撑 Claim。** "这三篇论文支撑该论证"只是给连接起了个名字，而没解释它。就说：*"这个 Warrant 是循环的。请给出推理原则——这组证据凭什么能推出你的综合结论？"*

**某个 Claim 是 `supported`，但它的 compile 是 `stale`。** 你在它上次通过之后编辑过某个 Ground 或那个 Warrant，这会把 Claim 退回 `proposed`。就说：*"compile 是 stale 的——把这个 Claim 当定论之前，先重新运行 `compile_arguments`。"*

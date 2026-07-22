# 复现一篇论文

> [English](../en/reproduce-a-paper.md) | [简体中文](reproduce-a-paper.md)

## 目标

通过构建一张**独立的**论证图，验证一篇论文的主张是否成立。运行 `/paper-reproduce` 开始。**完成**意味着每个 Claim 都有一个判定——`supported`、`disputed` 或 `refuted`。只有在调用过 `declare-barrier` 并确认存在真实阻塞时，`proposed` 才可接受。

---

## 这个场景下的论证图

这张图表示的是论文的论证，不是一套新论证。每个节点都从论文中提取。

| 节点 | 表示什么 | 初始状态 |
|------|---------|---------|
| **Claim** | 论文的结论，逐字提取 | `proposed` |
| **Ground** | 论文陈述的实验结果 | `source="hypothesis"`、`verification="pending"` |
| **Warrant** | 连接 Ground 与 Claim 的推理原则 | — |
| **Backing** | 对 Warrant 权威性的支持 | — |
| **Rebuttal** | 复现过程中发现的矛盾 | — |

**Claim 不可变。** 一个 Claim 精确编码了你要验证的东西。如果复现得到不同结果，这个差异属于 Rebuttal——而不是去改 Claim。改了 Claim，就改了你在测的东西。Ground 允许微小的数值修正（例如因随机种子或实现差异导致的 42.3 → 42.1），但出于同样的道理，一个 Ground 所断言的发现是固定的。

**Ground 起初是假设。** Ground 初始化为 `verification="pending"`。当一次独立复现完成、并附上一份说明文档后，它才 `verified`。没有说明文档的 Ground 是不完整的。

**独立性。** 如果论文产出了某个产物——补充数据、预计算的输出、模型权重——你不能拿它当验证证据。那是循环论证。作者公开的代码可以复用，只要它与论文所述方法一致。判断标准：*这个产物是这篇论文产出的，还是论文把它当作外部输入使用的？*

---

## declare-barrier

Agent 太容易放弃了——碰上"数据拿不到""这太复杂"就停下来。`declare-barrier` 正是围绕这一本能设计的：它把自己包装成宣告任务受阻的官方、正规入口，而这恰恰是 Agent 会去够它的原因。但它不会放行出口，而是拿声称的阻塞去比对八种反复出现的假性阻塞模式来盘问它。唯一的"出路"是证明阻塞确实为真——而更多时候，是发现它并不成立。

每当 Agent 遇到"做不到 / 拿不到 / 太复杂 / 不可行"，它必须先调用 `/declare-barrier` 再接受阻塞。这个 skill 给出一个分类：

- **Class A**——假性阻塞，路是通的，立即继续
- **Class B**——缩小范围：定义更窄的子任务并执行它（光声明不算交付）
- **Class C**——真实阻塞，只有在四个硬性条件全部满足后才成立

没有调用过 `declare-barrier`，Claim 不得停留在 `proposed`。如果其他都做完了、某个 Claim 还是 `proposed`，你可以自己调用 `/declare-barrier` 来强制它做这项评估。

---

## 值得留意的图状态

这些状态在论证图或可视化界面中可见，提示有东西需要关注。

| 状态 | 含义 |
|------|------|
| 某个 `Ground` 是 `verification='pending'`，而它的 Claim 却是 `supported` | 结论建立在未经验证的证据上 |
| 某个 `Ground` 没有说明文档 | 无论验证状态如何，复现都不完整 |
| 某个 `Claim` 是 `proposed` 且已无进行中的工作 | `declare-barrier` 还没被调用 |
| 某个 `Claim` 的 compile 是 `stale` | 论证链里有东西被改过——重新运行 `compile_arguments` |
| 存在 `Rebuttal`，但 `Claim` 却是 `supported` | 已记录一条矛盾；判定可能需要重新评估 |

---

## 当 Agent 跑偏时

下面这些是你真会遇到的失败，以及点名每种失败最直接的说法。描述图的状态，比描述症状更快触及根因。

**Agent 没调用 `declare-barrier` 就放弃了。** 它把某个 Claim 留在 `proposed`，或说某一步"不可行"，可你从没见到一次阻塞评估。自己调用它：`/declare-barrier`。多数时候评估会发现阻塞是假的，工作得以继续。

**Agent 报告的结论跟论文对不上。** 过程中某处，它悄悄把 Claim 改写成了自己能复现出来的样子。就说：*"复现场景下 Claim 必须与论文逐字一致。如果你的结果不同，那是 Rebuttal——别改 Claim。"* 这是最常见的漂移，而且除非你拿 Claim 节点去对论文的原话，否则根本看不出来。

**某个 Claim 是 `supported`，但它的一个 Ground 还是 `pending`。** 这个判定正建立在从未被独立复现的证据上。在可视化界面选中那个 Ground，问：*"这个 Ground 没验证——Claim 凭什么是 supported？"* 要么复现缺失了，要么这个 Ground 靠的是论文自己产出的产物——那不能算验证。

**Warrant 只是在复述 Ground 支撑 Claim。** 类似"实验结果支撑该结论"这种，不是推理原则——它只是给连接起了个名字，而这正是链条审查失败的常见原因。就说：*"这个 Warrant 是循环的。请给出推理原则——给定这类证据，凭什么推理能推出这个结论？"*

**Agent 把某个 Claim 称作 `supported`，但它的 compile 是 `stale`。** 它改了链条里的某样东西——一个 Ground、那个 Warrant——这会把 Claim 退回 `proposed` 并把 compile 标为 stale，然后它还是照样报告成功了。就说：*"compile 是 stale 的——先重新运行 `compile_arguments` 并重新评估证据，再谈 supported。"*

**Agent 声明了一个 Class B 阻塞就停下了。** Class B 是范围*缩小*，不是出口——那个更窄的子任务仍然要定义并执行。就说：*"Class B 意味着去做缩小后的任务，而不是光声明。更窄的版本是什么，它的结果在哪？"*

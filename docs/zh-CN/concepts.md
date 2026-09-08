# 论证图

> [English](../en/concepts.md) | [简体中文](concepts.md)

## Warranted 是做什么的

Warranted 让研究推理可被审计：正在断言什么、它依赖什么证据、证据为何足以支撑断言、什么在攻击它，以及当前证据究竟挣到了多高可信度。

论证图不是任务清单或活动日志。只有当一条命题的判断会实质影响研究问题、下游论证或决策时，才把它放进图里。

## 一种命题，五个槽位

图里只有一种节点：**命题（Proposition）**，即一条可以判断成立与否的陈述。

| 槽位 | 含义 |
|---|---|
| `content` | 正在被判断的原子陈述 |
| `evidence.attachments` | 直接支撑或记录它的文件 |
| `evidence.nodes` | 作为证据引用的其他命题 |
| `warrant` | 连接证据与内容的通用推理原则 |
| `rebuttals` | 攻击内容或已晋升 warrant 的命题 |
| `qualifier` | 当前可信度：`refuted → unestablished → possibly → probably → certainly` |

warrant 可以内联。只有当这条推理原则本身需要证据、反驳、独立 qualifier 或跨处复用时，才把它晋升为独立命题。

Claim、Ground、Backing、Rebuttal 描述的是从某个视角看到的角色：

- 一条命题自身的可信度正在被判断时，它是 **Claim**；
- 被另一条命题放进 evidence 槽时，它是 **Ground**；
- 支撑已晋升 warrant 时，它是 **Backing**；
- 出现在另一条命题的 rebuttal 槽时，它是 **Rebuttal**。

同一条命题可以同时处于多个视角；不需要转换类型，也不需要复制节点。

## Qualifier 是判断

新命题一律从 `unestablished` 开始。只有 `set_qualifier` 会记录可信度判断：

| Qualifier | 含义 |
|---|---|
| `refuted` | 当前证据否定这条命题 |
| `unestablished` | 尚未记录可辩护的判断 |
| `possibly` | 有可能成立，但支撑仍弱或暂时 |
| `probably` | 现有证据使其更可能成立 |
| `certainly` | 证据达到了系统提供的最高可信档 |

改内容与改可信度是两个动作。`update_proposition` 改“正在判断什么”；`set_qualifier` 改判断，并快照当时所依据的证据状态。

## 结构警告

结构检查在读取或修改命题时自动运行，可以报告：

- 正向 qualifier 下证据或 warrant 为空；
- 附件丢失或不可移植；
- 所引用的命题仍为 `unestablished`；
- `refuted` 命题没有一条正向判档的 rebuttal；
- 上次判断之后，内容、成员或引用命题的 qualifier 发生变化。

警告**不阻断**。系统不会因为警告存在就改 qualifier，也不会拒绝记录判断。应修复根因，或用理由调用 `dismiss`。dismiss 会进入事件历史；图发生实质变化后，重新计算的警告会得到新 id，因此以前驳回过的警告可能复燃。

只有三条写入校验会硬拒绝：content 不得为空、引用的命题 id 必须存在、附件路径必须能解析。

## 显式语义 Review

`review(id)` 是可选、明确触发、可能昂贵的第三方模型意见。它只检查一条命题：

1. **Q1——忠实性：**附件来源是否真的说了命题所声称的内容？
2. **Q2——有效性：**即使承认证据为真，warrant 是否能推出 content？

review 不会自动运行，也不会设置 qualifier。finding 会一直可见，直到新一次 review 取代它，或有人写明理由显式 dismiss。即使没有配置 review 模型，确定性的结构检查仍正常工作。

## 11 个工具

| 用途 | 工具 |
|---|---|
| 创建与修改 | `create_propositions`、`update_proposition`、`set_qualifier`、`promote_warrant`、`delete_proposition` |
| 读取与结算 | `get_argument`、`find_propositions`、`get_stats`、`get_history` |
| 独立意见 | `review`、`dismiss` |

`get_stats` 是全图结算视图，列出未处理 finding、结构警告、缺失附件和各 qualifier 数量。当前系统没有 compile 步骤；结构状态始终从当前图实时重算。

## 历史术语

0.5.0 及更早发布版使用独立的 Claim、Warrant、Statement 节点，以及 `status`、`verification` 和 `compile_state`。提交 `90c7acb` 已废除该模型。旧 `.toulmin/argument.db` 只作为只读档案保留；当前论证图位于 `.toulmin/graph.db`。

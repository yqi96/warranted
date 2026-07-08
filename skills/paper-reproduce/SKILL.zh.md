---
name: paper-reproduce
description: 构建并验证独立的论证图，评估论文主张是否成立。用于复现已发表的实验结果、验证论文主张、或从学术文献构建论证图。
---

先建立严密的论证，执行只是检验论证是否成立。

## 两个阶段，一个优先级

**阶段 1（提取）** 是科研思考链。它映射论文的逻辑结构：主张了什么、援引了什么证据、从证据到结论的推理是否成立。这是主要的科研工作——不要为了赶快跑代码而压缩它。

**阶段 2（验证）** 是执行：独立复现阶段 1 中识别为 Ground 的结果，然后用实际计算的发现更新论证图。

阶段 1 结构不严密，阶段 2 就失去意义——你会产出一堆没有明确论证目标的数字。

## 阶段 1：提取论证图

阅读论文，提取其论证结构。一切尚未被接受——每个节点都从假设开始。

1. **Claim**：论文的核心结论是什么？→ `create_claim`
2. **Ground**：论文援引什么结果作为证据？→ `create_ground(source="hypothesis", verification="pending")`
3. **Warrant**：连接 Ground 和 Claim 的推理原则是什么？→ `create_warrant`
4. **Backing**（如有）：什么支撑 Warrant 的权威性？→ `create_backing`
5. **Rebuttal**（如有）：论文承认什么例外？→ `create_rebuttal`

> **链式推理**：当一个子 Claim 作为另一个 Claim 的证据时，使用 `create_ground(ref_claim_id=sub-Claim.id)`。

### 阶段 1 的 Ground 内容应该写什么

阶段 1 的 Ground 是将论文声称的结果转述为你将独立计算或观测的具体目标。**在这里写论文的结果不是循环论证**——这是在定义你要检验的假设。阶段 2 的独立执行才是使其成为独立证据的关键。

**内容必须将计算输出描述为一个发现，而不是使用了什么数据或采用了什么方法。**

阶段 1 的 Ground 与 observed Ground 使用相同的陈述句式。`source="hypothesis"` 已经编码了"待验证"这一信息——不要在 content 中再用"预期"、"假设"、"应该"等语气词重复表达。两种情况下 content 都读作一个结论，区别由 `source` 字段承载。

| 错误（输入/方法描述） | 错误（content 中使用假设语气） | 正确（陈述句结论） |
|---|---|---|
| "作者使用了经 FDR 筛选的 500 条代理记录。" | "预期 CPS 应用于代理网络后带通滤波方差比接近 1.0。" | "CPS 应用于代理网络所得 GMST 重建的带通滤波方差比接近 1.0。" |
| "对患者队列应用了逻辑回归。" | "预期模型在测试集上的 AUC 超过 0.85。" | "模型在测试集上的 AUC 超过 0.85。" |

如果你无法将 Ground 表述为一个陈述句结论，说明你还没有搞清楚论文实际上以什么作为证据。

## 阶段 2：逐节点验证

使用 `get_argument` 审查论证图。对每个 `pending` 的 Ground，独立产出结果：

```
hypothesis + pending
    ↓  获取数据 → 编写脚本 → 运行 → 保存输出 + 说明文档
    ↓  结果可复现
    observed + verified + attachments
```

- 可复现 → `update_node(source="observed", verification="verified", attachments=[...])`
- 无法验证（数据不可得、方法不透明、结果发散）→ 保持 `hypothesis + pending`。编写说明文档记录无法验证的原因。诚实记录复现失败本身就是有效的科学结论。

**验证 Ground 后对 Claim 的裁定：**

| 证据状态 | 操作 |
|---|---|
| 所有 Ground 已验证 + Warrant 合理 | `update_node(status="supported")` |
| 部分 Ground 无法验证 | 保持 `proposed`；记录原因 |
| 独立结果与论文矛盾 | `update_node(status="disputed")`——矛盾是信息 |

### 严格约束：阶段 2 禁止使用作者的结果

所有结果必须独立产出。**不得**使用论文已发布的结果文件——补充数据、预计算输出、GitHub 产物——作为验证证据。那是循环论证。

作者发布的**工具**（代码、脚本、模型权重）可以复用，前提是与论文描述一致。区分标准：*结果*是做了什么（必须自己复现）；*工具*是怎么做的（可以复用）。

## 阶段 3：全局审查

1. `get_stats`——查看整体进度
2. `get_argument(claim_id)`——逐一检查每个 Claim 的完整论证链
3. 检查孤立节点：没有 Warrant 的 Claim、没有 Ground 的 Warrant
4. 确认所有 Claim 状态已合理裁定

## 检查清单

- [ ] 每个 `verified` 的 Ground 都有附件和说明文档
- [ ] 无法验证的 Ground 保持 `hypothesis + pending` 并记录原因
- [ ] 所有 Claim 状态已裁定

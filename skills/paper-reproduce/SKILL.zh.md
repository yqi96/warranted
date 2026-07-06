---
name: paper-reproduce
description: 构建并验证独立的论证图，评估论文主张是否成立。用于复现已发表的实验结果、验证论文主张、或从学术文献构建论证图。
---

提取论文的论证结构。通过独立执行验证每个节点。

## 核心原则

论文的论证是你要评估的对象。将其提取为 Toulmin 论证图——每个 Ground 从 `source="hypothesis"` + `verification="pending"` 开始，每个 Claim 从 `proposed` 开始。你的工作是通过独立验证来判断论文的主张是否成立。

**独立复现的严格约束**：禁止使用作者公开的任何结果作为你的 Ground 证据——包括数字、图表、以及任何形式的已发布结果文件（补充数据、GitHub 上的 output.npy、预计算产物等）。用作者的结果来验证作者的结论是循环论证。但是，作者发布的工具（代码、脚本、模型权重）可以使用——前提是它们与论文描述一致。区分标准是：结果是"做了什么"（必须自己产出），工具是"怎么做的"（可以复用）。

## 流程

### 阶段 1：提取论证图

阅读论文，提取作者的论证结构。一切尚未被接受：

1. **Claim**：论文的核心结论是什么？→ `create_claim`
2. **Ground**：论文援引什么证据？→ `create_ground(source="hypothesis", verification="pending")`
3. **Warrant**：论文用什么推理连接 Ground 和 Claim？→ `create_warrant`
4. **Backing**（如有）：什么支撑论文的 Warrant？→ `create_backing`
5. **Rebuttal**（如有）：论文承认什么例外？→ `create_rebuttal`

> **链式推理**：当一个子 Claim 作为另一个 Claim 的证据时，使用 `create_ground(ref_claim_id=sub-Claim.id)`。

### 阶段 2：逐节点验证

使用 `get_argument` 审查论证图。验证每个节点：

**Ground 验证**（产出独立证据）：

```
hypothesis + pending
    ↓ 设计并执行验证
    任务：获取数据 → 编写脚本 → 运行 → 保存输出 + README
    ↓ 结果可复现
    observed + verified + attachments
```

- 可以验证 → `update_node(source="observed", verification="verified", attachments=[...])`
- 无法验证（数据不可得、方法不透明、结果发散）→ 保持 `hypothesis + pending`。添加 README 说明无法验证的原因。这是有效的科学结果——目标是诚实记录，不是强行成功。

**Claim 裁定**（结论评估）：

- 所有 Ground 已验证 + Warrant 合理 → `update_node(status="supported")`
- 部分 Ground 无法验证 → 保持 `proposed`。记录原因。无法验证的主张是诚实的发现，不是失败。
- 结果与论文矛盾 → `update_node(status="disputed")`。矛盾是信息。

### 阶段 3：全局审查

验证完成后：

1. `get_stats` 查看整体进度
2. `get_argument(claim_id)` 逐一审查每个 Claim 的论证
3. 检查孤立节点（没有 Warrant 的 Claim、没有 Ground 的 Warrant）
4. 确认所有 Claim 状态已合理裁定

## 检查清单

- [ ] 每个 `verified` Ground 都有附件
- [ ] 无法验证的 Ground 保持 `hypothesis + pending` 并记录原因；Claim 状态如实反映证据
- [ ] 所有 Claim 状态已合理裁定

# Toulmin 论证工作指南

## 两种核心推理模式

### 正向推理（归纳）

先执行工作，得到事实，再归纳出结论。

```
[执行] 查找文献 / 跑实验 / 分析数据
    ↓
[提交] create_ground(source="literature/observed", verification="verified")
    ↓
[分析] 这个事实能支撑什么结论？推理规则是什么？
    ↓
[提交] create_warrant(ground_ids=[...]) + create_claim
    ↓
[判定] update_node(claim, status="supported")
```

### 反向推理（假设演绎）

先提出假设，推导出所需证据，再执行工作验证。

```
[分析] 要证明什么？
    ↓
[提交] create_claim（假设）
    ↓
[分析] 需要什么证据？推理规则是什么？
    ↓
[提交] create_warrant + create_ground(source="hypothesis", verification="pending")
    ↓
[执行] 查找文献 / 跑实验 → 验证 Ground
    ↓
[提交] update_node(ground, source="observed", verification="verified")
    ↓
[判定] update_node(claim, status="supported" 或 "disputed")
```

---

## 六要素

| 要素 | 含义 | 使用时机 |
|------|------|---------|
| **Claim** | 要证明的结论 | 始终需要 |
| **Ground** | 支撑论证的具体事实/数据 | 始终需要 |
| **Warrant** | 从 Ground 推出 Claim 的规则 | 始终需要 |
| **Backing** | 支撑 Warrant 可信度的依据 | Warrant 本身需要证明时 |
| **Qualifier** | Claim 的适用范围或成立条件 | Claim 不普适时 |
| **Rebuttal** | 使 Claim 失效的反驳条件 | 发现反证或例外时 |

---

## 硬规则

**禁止孤立 Claim**：create_claim 之后必须紧跟 create_warrant，没有 Warrant 的 Claim 只是断言，不是论证。

---

## 节点辨析

**Ground vs Warrant**：Ground 回答"发生了什么/观测到了什么"（事实），Warrant 回答"凭什么这个事实能推出结论"（推理规则）。

**链式推理**：同一命题在当前论证中是结论 → 用 `create_claim`；在后续论证中被当作证据 → 用 `create_ground(ref_claim_id=...)`。

# SciFact 全量 `review` 实验报告

> 日期：2026-09-02\
> 状态：全量完成；最终结果为可审计的恢复合成运行\
> 模型：`deepseek-v4-flash`\
> 代码版本（事后 HEAD 核对；manifest 未锁定）：`57b175660c216a15d9caa7360e743c522a6b5657`\
> 主结果目录：[`run-parserfix-57b1756-complete-20260902T040600Z`](../../outputs/scifact/runs/run-parserfix-57b1756-complete-20260902T040600Z/)\
> 评分口径：完整人工裁决的 `graphExpectedVerdict` overlay v2

## 0. 结论摘要

本轮在冻结的 SciFact dev claim-level fixture 上，使 300/300 个 case 都获得了成功的 verdict-producing `review`；此外，`primary-000300` 的首次 attempt 在收到 verdict 前被中断，随后单独补跑。每条样本均由 Warranted 图中的 target claim、固定且标签无关的 warrant、以及该 claim 对应的全部 SciFact 摘要附件组成。判分规则为：

```text
graph pass  iff Q1=pass AND Q2=pass
graph fail  otherwise
```

主要结果：

| 指标 | 结果 |
|---|---:|
| 完成率 | 300/300（100%） |
| Reviewer/runner case error | 0 |
| Accuracy | **272/300 = 90.67%** |
| Macro-F1 | **88.82%** |
| Graph-pass recall | **75/102 = 73.53%** |
| Graph-fail recall | **197/198 = 99.49%** |
| False-supported rate | **1/198 = 0.51%** |
| False-fail rate | **27/102 = 26.47%** |

结论是：当前 `review` 对不应通过的图几乎不会错误放行，但会拒绝约四分之一实际应通过的图，行为明显偏保守。下一阶段的主要问题是提高 graph-pass 正类召回，而不是继续加强负例拒绝。

这不是 SciFact 官方三分类、证据检索或 evidence-selection 排行结果。本轮观察支持一个更窄的结论：在 oracle 提供 cited abstracts、图由 builder 预先构造的条件下，Warranted 生产 `review` 能以较低 false-supported rate 完成局部 attachment-grounded 审查。

## 1. 实验问题与判定对象

### 1.1 本轮检验什么

本实验检验一条预先构造好的 Warranted proposition 是否能够被生产 `review` 正确审查：

- **Q1（附件忠实性）**：附件是否真的陈述或直接支持 target claim 所声称的内容；
- **Q2（推理有效性）**：在证据为真的前提下，当前 warrant 是否足以把证据连接到 target claim；
- **综合 verdict**：只有 Q1、Q2 同时通过，图才通过。

本轮不让 agent 自行检索、选择附件、构图或修改 qualifier，因此不能评价这些能力。Q1 与 Q2 由同一次生产 `review` 联合生成，本实验也不构成隔离的 Q2 能力测试。

### 1.2 图标签与 SciFact 原始标签的区别

fixture 保留 SciFact 原始 `SUPPORT / CONTRADICT / NOINFO` 标签用于来源追踪和分组，但最终评分使用独立人工裁决的 `graphExpectedVerdict`：

- 每个挂入 `evidence.attachments` 的摘要都被视为一条主动声明的证据边；
- 无关摘要不能被静默忽略；按当前 overlay 裁决规则，给 claim 挂无关证据时整张图应判为 `fail`；
- 多篇摘要可以联合提供支持，不拆成 claim–abstract 样本；
- 任何明确矛盾、无关附件或关键实体、范围、数量、条件不匹配，都可以使整张图判为 `fail`。

因此，SciFact 原始 `SUPPORT` 不必然等于 materialized graph 的 `pass`；同理，少数原始负类也可能在实际附件集合下被裁决为 graph pass。

## 2. 数据与冻结条件

### 2.1 数据规模

使用 SciFact dev split 的全部 300 条 claim：

| SciFact 原始标签 | 数量 |
|---|---:|
| SUPPORT | 124 |
| CONTRADICT | 64 |
| NOINFO | 112 |
| 合计 | 300 |

本轮没有删除 NOINFO，没有删除多文档 claim，也没有把多文档 claim 拆成多个样本。每条 claim 恰好对应一个 primary case。

### 2.2 Reviewer 可见输入

每条 case 的 reviewer 可见目录仅包含：

```text
project/
  evidence/<doc-id>.md   # SciFact 摘要，不是论文全文
  .toulmin/graph.db      # target claim、附件关系、固定 warrant
```

gold label、最终图标签、manifest、评分结果和 review 配置均在 reviewer 工作目录之外。该目录隔离用于防止意外 gold 泄漏，但不是 OS sandbox，不能抵御恶意 reviewer 的越界访问。附件是 SciFact 摘要；本轮没有下载或提供论文全文。

### 2.3 冻结 fixture

- Manifest：[`fixture-manifest.json`](../../outputs/scifact/fixtures/dev-20260901T063533825Z/fixture-manifest.json)
- Case 数：300
- Manifest SHA-256：`fb7c057bf40a04e48a502fab59c89197f163699e1d6cacf7dfdd75543542f707`
- Case ID 集合 SHA-256：`8c7066c2bbe190342eecb281f810bf5c167636a041a63f938cc513dfe126d78b`

所有附件和初始 SQLite 图数据库均由 fixture manifest 锁定。运行和评分阶段会重新验证这些哈希。

## 3. 运行配置

| 配置项 | 值 |
|---|---|
| Model | `deepseek-v4-flash` |
| Endpoint | `https://api.agtcloud.cn` |
| Fallback model | 无 |
| Max turns | 20 |
| Concurrency | 4 |
| 外层 case retry | 无 |
| Parser 内置第二次模型采样 | 仅解析失败时允许；本轮未发生 |
| Reviewer 调用范围 | 全部 300 个 primary cases |

运行前已获得将 300 条 claim、warrant 与 SciFact 摘要附件发送到上述 endpoint 的明确授权。报告不记录凭据。

## 4. 执行过程与 SIGTERM 恢复

### 4.1 原始运行

原始运行目录：[`run-parserfix-57b1756-20260902T030920Z`](../../outputs/scifact/runs/run-parserfix-57b1756-20260902T030920Z/)

原始命令运行约 3157.7 秒后，在以下状态收到 `SIGTERM`：

- `primary-000001` 至 `primary-000299`：299 条原子 `result.json` 全部成功；
- `primary-000300`：已开始 review，只创建了空的 `audit/` 目录；
- 已完成 case 中没有 `status:error`；
- 进程退出码为 143，即 signal 15；
- 因 runner 没有处理 `SIGTERM`，原始目录没有来得及封存顶层 `results.jsonl` 和 `run-manifest.json`。

代码只为 `SIGINT` 安装了优雅中断处理器，参见 [`run-reviews.ts`](../../scifact/run-reviews.ts#L497-L509)。模型/API 的普通异常会被 case 层捕获并原子写成 `status:error`，与本次现场形态不同。因此可以高置信判断：`SIGTERM` 的直接发送者在 SciFact runner 之外，且本次不是 runner 的常规 case-error 收口路径。现有日志没有 sender PID 或 watchdog reason，无法确定具体发送者，也不能排除模型、API、数据或其他外部状态间接触发了某个监督策略。

### 4.2 恢复运行

只补跑唯一缺失的 `primary-000300`：

- 恢复目录：[`run-parserfix-57b1756-recovery-000300-20260902T040500Z`](../../outputs/scifact/runs/run-parserfix-57b1756-recovery-000300-20260902T040500Z/)
- 完成：1/1
- Reviewer error：0
- 耗时：约 33.2 秒

### 4.3 最终合成运行

恢复 assembler 使用原子 case 产物和文件哈希选择：

- 原始运行选入：299 cases；
- 恢复运行选入：1 case；
- 重复或 superseded case：0；
- 最终唯一 case ID：300；
- 最终失败：0。

最终运行目录：[`run-parserfix-57b1756-complete-20260902T040600Z`](../../outputs/scifact/runs/run-parserfix-57b1756-complete-20260902T040600Z/)

其 [`run-manifest.json`](../../outputs/scifact/runs/run-parserfix-57b1756-complete-20260902T040600Z/run-manifest.json) 的 `interrupted:false` 表示**恢复合成后的最终运行完整**，不表示原始进程从未中断。完整恢复记录见 [`recovery-provenance.json`](../../outputs/scifact/runs/run-parserfix-57b1756-complete-20260902T040600Z/recovery-provenance.json)。

## 5. 主要结果

### 5.1 混淆矩阵

最终人工裁决的 graph gold 为 `pass=102 / fail=198`：

| Gold \ Predicted | pass | fail | 合计 |
|---|---:|---:|---:|
| graph pass | 75 | 27 | 102 |
| graph fail | 1 | 197 | 198 |
| 合计 | 76 | 224 | 300 |

由此得到：

- Precision：75/76 = **98.68%**；
- Recall / graph-pass recall：75/102 = **73.53%**；
- F1：**84.27%**；
- Macro-F1：**88.82%**；
- Accuracy：272/300 = **90.67%**。

### 5.2 Bootstrap 95% 区间

按 claim 聚类，10,000 次 bootstrap，seed=`20260901`：

| 指标 | 点估计 | 95% CI |
|---|---:|---:|
| Accuracy | 90.67% | [87.33%, 93.67%] |
| Macro-F1 | 88.82% | [84.65%, 92.57%] |
| False-supported rate | 0.51% | [0%, 1.59%] |
| Graph-pass recall | 73.53% | [64.65%, 81.90%] |
| Graph-fail recall | 99.49% | [98.41%, 100%] |

### 5.3 按 SciFact 原始标签分组

下表的“正确”仍以 `graphExpectedVerdict` 为准，只是按原始 SciFact 标签分组；不能读成官方三分类 accuracy：

| 原始标签 | Cases | Graph gold pass / fail | 预测 pass / fail | Graph verdict 正确 |
|---|---:|---:|---:|---:|
| SUPPORT | 124 | 96 / 28 | 70 / 54 | 98/124 = 79.03% |
| CONTRADICT | 64 | 1 / 63 | 1 / 63 | 64/64 = 100% |
| NOINFO | 112 | 5 / 107 | 5 / 107 | 110/112 = 98.21% |

在被人工裁决为 graph fail 的原始子组中：

- CONTRADICT graph-fail recall：**100%**；
- NOINFO graph-fail recall：**99.07%**。

这进一步说明主要误差集中在应当通过的图，而不是负例识别。

## 6. Finding、引用与运行行为

### 6.1 Finding 协议

| 项目 | 结果 |
|---|---:|
| 综合 fail verdict | 224 |
| 每个失败 Q1/Q2 均有对应 finding 的 fail case | 224 |
| Required-finding coverage | 100% |
| Accepted findings | 464 |
| Rejected findings | 0 |
| Pass with finding | 0 |
| Fail without finding | 0 |

协议一致性正常：每个 fail case 中所有失败的 Q1/Q2 都有相应 finding，所有 pass 都没有遗留 finding。

### 6.2 Q1 引用机械检查

| 项目 | 结果 |
|---|---:|
| Q1 quotes | 242 |
| Verbatim quote | 237/242 = 97.93% |
| Locator present | 242/242 = 100% |
| Locator match | 184/242 = 76.03% |
| Valid citation | 184/242 = 76.03% |
| Gold rationale hit（符合统计资格的失败 case） | 62/107 = 57.94% |

引用文本本身大多逐字存在，但 locator 机械匹配只有 76.03%，说明“引用了真实文本”和“定位字段严格可验证”是两件事。后续应优先改进 locator 规范化和验证，而不能只报告 verbatim rate。

### 6.3 时延

| 指标 | 结果 |
|---|---:|
| 单 case 平均时延 | 41.94 s |
| 中位时延 | 30.98 s |
| P95 | 106.55 s |
| 300 case 累计时延 | 12,581,668 ms |
| Token usage | SDK 未提供，不估算 |

累计时延是各 case 时延之和，不是并发运行的 wall-clock。原始运行中断并补跑一例，因此本报告不把本轮 wall-clock 当作可直接比较的性能指标。

## 7. 解析器与重点 case 复核

本轮运行使用提交 `57b1756` 中优化后的终止 JSON 恢复逻辑。300 个最终 case 均满足：

- 恰好 1 个原子结果；
- 恰好 1 个 graph database；
- 恰好 1 份 verdict-producing audit；
- `actualModel=deepseek-v4-flash`；
- 无 fallback；
- 无第二次模型采样。

审计没有在线记录“纯 JSON 快速路径”还是“混合文本中的终止 JSON 恢复路径”，但保存了 parser 实际收到的 raw 输出。用提交 `57b1756` 的同一纯函数对 300 份 raw 输出离线重放，得到：

| Parser 路径 | Cases |
|---|---:|
| 整段纯 JSON 对象 | 273 |
| 终止 JSON 对象恢复 | 27 |
| Parse failure | 0 |
| Q1/Q2 协议字段无效 | 0 |

结合每 case 恰好一份 audit，可确认 27 条混合文本输出由优化后的恢复路径直接解析，未触发第二次模型采样；本轮也没有解析失败后的默认 verdict。

### `primary-000105`

- 上一轮：`Q1=pass, Q2=pass`，综合 pass，错误；
- 本轮：`Q1=fail, Q2=fail`，综合 fail，正确；
- 审计：1 次；无 fallback；
- finding 明确指出摘要最高维生素 D 分层为 `>18 ng/mL`（约 `>45 nmol/L`），不能支持 claim 的 `>75 nmol/L` 边界。

### `primary-000269`

- 上一轮：`Q1=pass, Q2=pass`，综合 pass，错误；
- 本轮：`Q1=fail, Q2=pass`，综合 fail，正确；
- 审计：1 次；无 fallback；
- Q1 指出摘要只报告 ON response，没有明确陈述 single-flash ERG b-wave；Q2 仍表现出随机波动，但综合 verdict 已由 Q1 正确拦截。

这两例的本轮结果不是调用失败后的默认值：均有非空、case-specific finding、附件读取轨迹、review event 和唯一审计文件。

## 8. 与上一轮的比较

上一轮使用同一套最终 overlay v2 评分：

| 指标 | 上一轮 | 本轮 | 变化 |
|---|---:|---:|---:|
| Correct | 270/300 | 272/300 | +2 |
| Accuracy | 90.00% | 90.67% | +0.67 pp |
| Macro-F1 | 88.17% | 88.82% | +0.65 pp |
| False pass | 4 | 1 | -3 |
| False fail | 26 | 27 | +1 |

逐例比较显示：

- 41 例的 Q1、Q2 或综合 verdict 至少有一项变化；
- 13 例由错误变为正确；
- 11 例由正确变为错误；
- 净改善 2 例。

因此，本轮提升不能因果归因给解析器。解析器针对已知的终止 JSON 格式脆弱性做了修复，但 41/300 的判定变化说明模型本身仍有明显随机性。需要固定 case 的重复运行才能把 parser 稳定性和语义判断方差分开估计。

## 9. 完整性与哈希

最终检查结果：

- `results.jsonl`：300 行；
- 唯一 case IDs：300；
- `result.json`：300；
- `graph.db`：300；
- verdict-producing audit：300；
- audit 数量不等于 1 的 case：0；
- 评分 manifest 中 8 个锁定产物的实际 SHA-256 全部匹配。

| 锁定产物 | SHA-256 |
|---|---|
| Run manifest | `b87adddca0ced9563becaf5bc9e27e2a514ca33f29dccab3ef3b0225898c6070` |
| Results JSONL | `13b62d7feb0b0cc2f0814581a103239fae471312fa970aece2251e2e84d91ea6` |
| Recovery provenance | `81054fe8e86cfa8c3e26cb157bbf7fcfd0f33f3b4a6d757aea02e72807940161` |
| Fixture manifest | `fb7c057bf40a04e48a502fab59c89197f163699e1d6cacf7dfdd75543542f707` |
| Graph verdict overlay | `89bdf2f2d1d6340eda381823e3406bc0aab15fce3fffeef1829a2df2f0d1366a` |
| Adjudication bundle | `d9c771df545cdbcb9aeec063cb204f9acc630773609787fe1e4ef5795742bfa5` |
| Score summary | `adc284d1ef597f6053e80a4bcc57cec1e3e8a0983aea98eec1bbc20dc5829c3d` |
| Per-case CSV | `7ee7ce4e1a0d90b3af02a90ce9113acdfe8ddce936dfed50b6df59e1914ed51c` |

评分产物：

- [`summary.json`](../../outputs/scifact/runs/run-parserfix-57b1756-complete-20260902T040600Z/scores/summary.json)
- [`cases.csv`](../../outputs/scifact/runs/run-parserfix-57b1756-complete-20260902T040600Z/scores/cases.csv)
- [`score-manifest.json`](../../outputs/scifact/runs/run-parserfix-57b1756-complete-20260902T040600Z/scores/score-manifest.json)

## 10. 结论边界与后续动作

### 可以支持的结论

1. 冻结的 300 条 claim-level fixture 已全部通过生产 `review` 路径执行，运行覆盖和审计覆盖均为 100%。
2. 在当前人工裁决的图标签下，`deepseek-v4-flash` reviewer 达到 90.67% accuracy、88.82% Macro-F1。
3. 当前 reviewer 的 false-supported rate 很低，但 graph-pass recall 明显不足，整体是保守型错误结构。
4. 优化后的 parser 在本轮没有产生解析失败重试、fallback 或默认 verdict 证据。

### 不能支持的结论

1. 不能把该结果称为 SciFact 官方 leaderboard 分数；本轮没有检索、证据句选择或官方三分类评分。
2. 不能推断全文输入一定会得到相同结果；本轮附件仅为摘要。
3. 不能把 0.67 个百分点的净提升全部归因给 parser；两轮间存在显著模型随机波动。
4. 不能把本轮当作独立 Q2 benchmark；Q1/Q2 来自同一次 review，且 fixture 的 warrant 是统一构造的。
5. 不能把恢复合成运行表述为一次从头到尾无中断的原生运行，尽管最终 300 例产物完整且哈希可审计。
6. 当前 HEAD 已核对为 `57b1756`，但本轮 run/score manifest 没有锁定 Git revision 或 dirty-worktree 状态；代码版本仍有一项 provenance 缺口。

### 建议的下一步

1. 对固定分层子集重复运行 3–5 次，估计 Q1、Q2 和综合 verdict 的 case-level 方差；
2. 优先分析 27 个 false-fail，区分范围过严、摘要信息不足、Q1/Q2 耦合和 warrant 解释偏差；
3. 对少量边界 case 做“摘要 vs 全文”配对实验，检验全文是否减少信息缺失型 false-fail；
4. 给 runner 增加 `SIGTERM` 优雅封存与正式 resume/checkpoint 支持；
5. 为 parser 路径增加结构化 telemetry，区分纯 JSON、围栏 JSON、终止 JSON 恢复和二次采样；
6. 在 run manifest 中锁定 Git revision 与 dirty-worktree 摘要，避免仅依赖 run ID 和事后 HEAD 核对代码版本。

## 11. 相关说明

实验协议、fixture 构造、gold 隔离和评分定义详见 [`experiments/evaluation/scifact/README.md`](../../scifact/README.md)。本报告将事后核对的 HEAD `57b1756` 作为 2026-09-02 全量运行的代码版本记录，但原 run/score manifest 没有锁定该字段；后续修改 fixture、overlay、parser、prompt、模型或 provider 后，应生成新报告，不覆盖本文件。

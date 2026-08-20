# Warranted 工具面契约

> 状态:草案 v0.1(与 `docs/design.md` v0.4 配套)。
> 本文是 `docs/design.md` 在**接口面**上的投影。判据、姿态、认识论分工都在 design.md,改规则先改那边;本文只回答三个问题:**有哪些工具、每个参数怎么填、21 个旧工具各自去哪了**。
> 本文推导过程中反向暴露出的 design.md 缺口,集中列在 §8——那几条需要拍板后回写事实源。

---

## 0. 三条总原则

1. **工具 description 只放触发与判别,参数描述承担写作引导。** description 的读者是在"要不要用它"这一刻读它的,所以只有场景、与最近邻的判别值得占位(见 `CLAUDE.md`);"这个字段怎么填"进参数描述(design.md §1.4)。本文因此对每个工具都给两行:`description` 与**与最近邻的判别**。
2. **一个动作一条事件,系统不替 agent 改状态。** 旧系统里大量工具会顺手回退 `status` / `verification` / `compile_state`,新系统一律不改——只标红(design.md §3.1 姿态原则)。这一条直接决定了 §7 里六条旧警告的死亡。
3. **警告是读时算出的可寻址对象,不是写时发的一句话。** 旧 `warnings.ts` 是一批在写入返回体里发一次、之后无从引用的字符串;新设计要求警告能被 `dismiss` 指名驳回,所以它必须有稳定 id。派生方案见 §5。

---

## 1. 工具面总览(11 个)

| 工具 | 干什么 | 与最近邻的判别 |
| --- | --- | --- |
| `create_propositions` | 新建命题(批量) | 建新节点;改已有节点用 `update_proposition` |
| `update_proposition` | 改 content / warrant 文本 / 证据成员 / 反驳成员 | 不动 qualifier;判可信度用 `set_qualifier` |
| `set_qualifier` | 判定可信度(批量),并落基线快照 | 这是 L3 判断动作;改事实内容用 `update_proposition` |
| `promote_warrant` | 把内联理由晋升成独立命题 | 仅当要反驳/补依据/复用这条理由时;否则留内联 |
| `delete_proposition` | 删除命题 | 硬删,墓碑进事件流;想保留痕迹但降权是 `set_qualifier(refuted)` |
| `get_argument` | 读一条命题及其邻域(含警告与意见) | 按 id 精确读;不知道 id 用 `find_propositions` |
| `find_propositions` | 按关键词/可信度/待处理筛命题 | 找 id 与批量扫描;拿单条全貌用 `get_argument` |
| `get_stats` | 结算摘要(红点清单) | 交付前扫全图;看单条用 `get_argument` |
| `get_history` | 读事件流(变更、判断、意见) | 看"怎么变成现在这样";看"现在是什么样"用 `get_argument` |
| `review` | 请第三方 LLM 审查单条命题的证据与推理 | 慢且贵、只发现不裁决;结构性检查是免费的、自动的,不需要调 |
| `dismiss` | 驳回一条警告或一条 finding,必写理由 | 驳回是"我判它不成立";真去修是 `update_proposition` / `set_qualifier` |

**没有的工具**:没有 `create_warrant`(warrant 是槽位不是节点,design.md §1.2);没有 `compile_arguments`(动词退役,§2.6);没有 `verify_statements`(verified 并入 qualifier 正向档);没有任何 tag 工具(体系废除);没有 `confirm`(人直接改图即留痕)。

---

## 2. 写入(5 个)

### 2.1 `create_propositions`

**description**:新建一条或多条命题。

**与最近邻的判别**:建新节点用本工具;改已有节点用 `update_proposition`。

**入参**:`items: Array<Item>`(1..N),每项:

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `content` | ✅ | 命题本身(V1 非空) |
| `warrant` | | 内联理由文本。**可空**——但命题上到 `possibly` 及以上时结构检查要求非空(design.md §3.1) |
| `evidence` | | `{ attachments?: string[], nodes?: number[] }`(V2/V3) |
| `attacks` | | `{ node: number, slot: "content" \| "warrant" }`——把本命题登记为对目标的反驳 |
| `note` | | 动机留痕(design.md §3.1c) |

**没有 `qualifier` 参数。** 新建的命题一律落 `unestablished`,可信度只能经 `set_qualifier` 设。这不是风格选择,是被 design.md §3.1c 的基线契约逼出来的:基线的安全性**全部**建立在"只有一个写入者"上,允许 create 顺手设 qualifier 就出现第二个写入者,基线立刻退化成旧 `compile_state` 那种会漂移的谎话。代价是"新建一条已判定的命题"要两次调用,但两个工具都是批量的,代价是常数。附带好处:事件流里"判断"永远是一个能被单独认出的动作。

**始终批量。** 不另设单条版本:两条工具描述占的常驻上下文比每次多打一对方括号贵,而且合并之后就没有"该用哪个"的近邻判别问题了(旧 `create_statement` / `create_statements` 正是这个问题的实例)。

**`attacks` 与自动晋升**:`slot: "content"` 时反驳直接挂到目标命题的反驳槽。`slot: "warrant"` 且目标的理由当前是内联的,系统在同一事务内把该内联理由晋升成命题,再把反驳挂到晋升后的命题上(design.md §1.2)。**返回体必须显式报告这次晋升**(`promoted: { from_node, new_id }`)——这是全系统唯一一处系统替 agent 建节点的地方,不报告就等于图里凭空多了一个节点。晋升出的命题带**空理由**、落 `unestablished`,`by=system`,完全合法;它的理由欠账不需要专门的警告去追,由已有判据自动追讨:原命题要上 `probably` 就得让这条引用 ≠ `unestablished`,而给它判档时又撞上"理由非空"。

**返回**:每项 `{ id, warnings: [...], promoted?: {...} }`。

### 2.2 `update_proposition`

**description**:修改一条命题的内容、理由文本,或增删它的证据与反驳。

**与最近邻的判别**:本工具改的是"事实与结构";改可信度用 `set_qualifier`。

| 字段 | 说明 |
| --- | --- |
| `id` | 命题 id |
| `content` | 新内容 |
| `warrant` | 新的内联理由文本。**若该命题的理由已晋升,本字段拒绝**并返回晋升后的命题 id——那时理由是一条独立命题,改它要改那条命题,不是改这个槽里的一个文本 |
| `evidence` | `{ add_attachments?, remove_attachments?, add_nodes?, remove_nodes? }` |
| `rebuttals` | `{ add?: number[], remove?: number[] }` |
| `note` | 动机留痕 |

**证据与反驳成员一律 add/remove,不提供整体替换。** 依据是本仓库自己踩过的坑:`9393354 fix: warn when update_node's attachments replace silently drops files`——整体替换会静默丢路径,当时的修法是补一条警告去说"你丢了什么"。而"静默"正是这个系统存在的理由(design.md §0),用一条警告去补一个可以从接口上消除的静默是本末倒置。新接口直接不给这把枪,`attachmentsReplaced` 那条警告随之失去存在理由(§7)。

**不接受 qualifier。** 理由同 §2.1:基线只有一个写入者。次级理由是可读性——合在一起会让"改个错字"和"重新判定"在事件流里长得一样。

### 2.3 `set_qualifier`

**description**:判定一条或多条命题的可信度。这是最终裁决动作,只有 agent / 人能做。

**与最近邻的判别**:本工具落的是判断;改事实内容用 `update_proposition`。

| 字段 | 说明 |
| --- | --- |
| `updates` | `Array<{ id, qualifier, note? }>` |

`qualifier ∈ {refuted, unestablished, possibly, probably, certainly}`。

副作用(三件,都在同一事务内):

1. **落基线快照**:对每条直接引用的节点快照 `(content hash, qualifier)`,作为这次判断的基线(design.md §3.1c)。content hash 复用现成的 `computeNodeHash`(`src/merkle-hash.ts`,只哈希 content,与"命题对外只暴露 (content, qualifier)"完全对齐)。
2. **跑结构检查并返回结果**:按 design.md §3.1 的四档判据。违反**不拦截**,返回警告 + 标红。
3. **未处理 finding 提示**:qualifier 落到非 `unestablished` 且该命题仍有未处理 finding 时,返回醒目 warning(design.md §2.5)。

**批量的理由与 §2.1 相同**,并且不与 §3.1b"不提供命题级批量驳回"冲突——那一条防的是"一个理由清掉一片警告",而这里每项自带自己的 id 与可选 note,批量省掉的是往返,不是思考。

### 2.4 `promote_warrant`

**description**:把一条命题的内联理由拎出来立成独立命题,原槽位改为指向它。

**与最近邻的判别**:只在要**反驳这条理由本身、给它补依据、或跨命题复用它**时才晋升;其余时候理由留在内联(design.md §1.2)。

| 字段 | 说明 |
| --- | --- |
| `id` | 理由所在的命题 |
| `warrant` | 晋升后那条命题**自己的**理由。可空(与 `create_propositions` 一致),但那条命题上到 `possibly` 及以上时结构检查要求非空 |
| `evidence` | 可选,给晋升出来的理由挂依据(backing) |
| `note` | 动机留痕 |

晋升后的命题落 `unestablished`,由 `set_qualifier` 判定。晋升本身不触发原命题重查(design.md §3.1:"warrant 晋升 = 新命题诞生 = 该命题自身的结构检查启动,不额外触发原命题")。

### 2.5 `delete_proposition`

**description**:删除一条命题。

**与最近邻的判别**:想让这条命题不再支撑上游、但保留它存在过的事实,用 `set_qualifier(refuted)`;真要它消失才用本工具。

| 字段 | 说明 |
| --- | --- |
| `id` | 命题 id |
| `note` | 动机留痕 |

**没有 `cascade` 参数。** 旧 `delete_node.cascade_delete` 存在的前提是"Claim 有子节点",而新本体没有父子——证据槽里挂的是引用,不是所有权。级联删会销毁 agent 没有指名的节点,与姿态原则相反。

删除一条被引用的命题时,系统从各引用方的槽里摘掉这条引用(否则违反 V2),并把这些引用方按 design.md §3.1 触发条件①(成员清单变化)标为该重查,其"已阅"警告全部复燃。**返回体列出受影响的命题清单。** 旧系统的三条删除警告(`deleteClaimReferencedByGround` / `deleteGroundReferencedByWarrant` / `deleteWarrantSupportingClaim`)合并为这一份清单——它们分三条写是因为旧本体有三种节点类型,类型塌缩后区分就消失了。

墓碑 = 事件流里的整节点 before 快照,不设归档表、不设软删标记(design.md §3.1c)。

---

## 3. 读取(4 个)

### 3.1 `get_argument`

**description**:读一条命题的完整状态:五个槽位、结构检查警告、未处理意见,以及可选深度的邻域。

**与最近邻的判别**:已知 id 用本工具;不知道 id 先 `find_propositions`。

| 字段 | 说明 |
| --- | --- |
| `id` | 命题 id |
| `depth` | 默认 1(自己 + 直接证据 / 反驳 / 晋升后的理由)。`0` = 只读这一条 |

返回每条命题:`content` / `qualifier` / `warrant`(内联文本或 `{ promoted_to: id }`)/ `evidence`(attachments + nodes)/ `rebuttals` / `warnings[]` / `findings[]`。

`get_node` 由 `depth=0` 吸收。两个工具的差别只是深度,而"该用哪个"的判别成本要付在常驻上下文里,一个参数默认值就够了。

`warnings[]` 与 `findings[]` **对每条命题都出现**,不需要额外开关——design.md §2.5 要求"所有图读取接口对有未处理 finding 的命题给出醒目标记",可选的醒目就不是醒目。每条警告带 `id`(§5)、判据编号、**触发点**(哪个证据掉出可用档位、哪条 content 变了、哪个附件不见了)与 `state`(`pending` / `acknowledged` + 驳回理由与时间)。

### 3.2 `find_propositions`

**description**:按关键词、可信度、是否有待处理意见筛出命题。

**与最近邻的判别**:找 id、做批量扫描用本工具;拿单条全貌用 `get_argument`。

| 字段 | 说明 |
| --- | --- |
| `query` | 关键词检索 |
| `qualifier` | 按档位过滤(可多选) |
| `has_unresolved` | 只要有未处理 finding 或未处理警告的 |
| `limit` / `offset` | 分页 |

三合一取代 `list_statements` + `search_nodes`,并接掉 `list_claims` 的用途——`list_claims` 本身随"claim 是状态不是类型"失去所指(design.md §2.5)。

**不设 `role` / `node_type` 过滤。** 旧 `statement_role_filter` / `node_type_filter` 是对关系表的虚拟过滤,而新本体里角色只取决于以谁为中心看(design.md §1.3),一个全局的 role 过滤没有确定的所指。若日后出现真实需求("列出所有被用作反驳的命题"),它是本工具的一个过滤参数,不是一个新工具。

`offset` 的描述沿用旧 `pagination_offset` 那句已验证过的提醒:自消耗队列(过滤条件会移除已处理项的查询)永远用 `offset=0` 重查。

### 3.3 `get_stats`

**description**:全图结算摘要——红点清单:未处理 finding、结构检查违反、待重查警告,以及各档位的命题计数。

**与最近邻的判别**:交付/报告前扫全图用本工具;看单条用 `get_argument`。

无必填参数。persona 约定交付前扫一遍并处理(design.md §4)。

### 3.4 `get_history`

**description**:读事件流——某条命题(或全图最近)的变更、判断、意见记录,含时间与归因。

**与最近邻的判别**:问"怎么变成现在这样"用本工具;问"现在是什么样"用 `get_argument`。

| 字段 | 说明 |
| --- | --- |
| `id` | 省略则返回全图最近事件 |
| `limit` | 分页 |

每条事件:`at` / `by`(`tool` / `human` / `system`)/ `op` / 载荷(update 是字段级 diff,delete 是整节点 before 快照,`review` 是 findings,`dismiss` 是理由)/ 可选 `note`。这是 design.md §4"隐匿可检测"的唯一兑现路径:不设停止准则的前提是事后查得到。

`by=human` 在 visualizer 写入通道落地前不会实际产出(design.md §3.1c / §5.1,优先级低),人的意图靠 `note` 记录。

---

## 4. 意见(2 个)

### 4.1 `review`

**description**:请一个独立的第三方 LLM 审查这条命题:证据有没有真的说它声称的事(Q1),证据即便为真是否推得出它(Q2)。慢且贵,按需调用。

**与最近邻的判别**:结构性问题(证据空了、附件没了、引用掉档)是免费自动查的,不需要调本工具;本工具查的是语义。

| 字段 | 说明 |
| --- | --- |
| `id` | 单条命题(不递归、不吃子图,design.md §2.2) |

产出:带引证的 findings,落库并绑定到该命题;进同一条事件流。

**finding 结构**(契约与理由见 design.md §2.2"一条 finding 的构成"):

```ts
type Finding =
  | { id: string; node_id: number; confidence: "high" | "low";
      question: "Q1"; content: string;
      citation: { attachment: string; locator: string; quote: string } }
  | { id: string; node_id: number; confidence: "high" | "low";
      question: "Q2"; content: string;
      citation: { node_id: number; slot: "content" | "warrant"; quote: string } }
```

| 字段 | 说明 |
| --- | --- |
| `id` | `f_<review_event_id>_<序号>`。**不含重查指纹**——finding 不随图变化过期(§4.2),而且 id 天然带着"哪次 review 产的",查历史直接定位 |
| `node_id` | 被审查的命题 |
| `question` | `Q1` 忠实性 / `Q2` 有效性。它**唯一决定 citation 的形态**,所以是判别联合的判别式:Q1 只能引附件、Q2 只能引图内文本,在类型层面无法违反 |
| `content` | 断点陈述:哪里断了。不是"这个论证不够好" |
| `citation` | 必填,无例外 |
| `citation.locator` | Q1 专用,页码 / 行号 / 章节等,让人能翻到 |
| `citation.quote` | 两种形态都必须有,**逐字**片段 |
| `confidence` | `high` / `low` 两档,不设 medium(中间档是垃圾桶)。这是"我这条判断有多大把握",**不是**"这个问题有多严重"——后者要看到局部之外,审查器无权判 |

**落库前的机械校验**(不通过 = 该条 finding 不合格,拒收并记一次协议违规;不是拒绝 `review` 整体):

| 编号 | 校验 | 为什么可验 |
| --- | --- | --- |
| F1 | `citation.quote` 非空 | —— |
| F2 | Q1:`citation.attachment` ∈ 被审查命题的附件槽 | 附件清单在图里 |
| F3 | Q2:`citation.node_id` ∈ {被审查命题} ∪ {其证据槽里的命题} | 同上 |
| F4 | Q2:`citation.quote` 是 `citation.node_id` 该 `slot` 内容的**逐字子串** | 两侧都在图里,字符串比对即可。**验不过 = 审查器在编** |

F4 是把 §2.3"强制引证"从措辞变成可执行判据的地方——Q1 的引证真伪要读 PDF 才知道(留给人),Q2 的引证真伪机器当场就能验。

**review 事件本身记每个问题的结论**,而不只是记 findings:

```ts
{ node_id, Q1: "pass" | "fail" | "n/a", Q2: "pass" | "fail", findings: Finding[],
  model, protocol_hash, at }
```

`n/a` 专给"该命题没有附件型证据、Q1 无所施力"。记成 `pass` 会造出"忠实性已核实"的假象。没有这一层,"从没 review 过"与"review 过且没问题"在图上分不开。

**没有 `status` 字段。** finding 的"未处理 / 已阅"不落在 finding 上,由事件流里有没有对应 id 的 `dismiss` 事件算出来——与警告一致,零可变状态(design.md §3.1c"永不更新、永不删除")。在 findings 表上加一列 `status` 就破了 I8。

**输入边界是本工具的实现约束,不是措辞约束**(design.md §2.2):

- 递给审查器的每条命题型证据带 **(content, qualifier)**——前提的极性是前提的一部分。
- **被审查命题自己的 qualifier 不进**——那是待判的结论。
- 检查点在 prompt 构建函数的入参类型:越界的修法是**删字段**,不是在 prompt 里加禁令。

审查器带只读工具(Read/Glob/Grep),`temperature=0`,模型与 prompt 版本钉死,协议 hash 入库(design.md §2.3)。未配置审查模型时拒绝执行并说明如何配置——旧 `compiledWithoutReviewModel` 是"没审查但记为 passed"的补丁,而新系统里 review 不产出 passed,所以这里应当直接失败而不是发警告(§7)。

### 4.2 `dismiss`

**description**:驳回一条结构检查警告或一条 finding,判定它不成立或无需处理。必须写理由。

**与最近邻的判别**:本工具表达"我看过了,判它不成立";真要修是 `update_proposition` / `set_qualifier`。

| 字段 | 说明 |
| --- | --- |
| `items` | `Array<{ id, reason }>`,`id` 是警告 id 或 finding id |

- **`reason` 强制非空,但不设长度下限。** 长度下限是可以刷的,刷起来比写一句真话便宜,加了只是给审计一种虚假的确定感。真正让"没看就驳回"变贵的是它进事件流、可被 `get_history` 逐条读出来。
- **驳回是降级不是删除**:警告降为"已阅",留时间 + 理由(design.md §3.1b)。
- **批量不违反 §3.1b**:那条防的是"命题级批量"——一个理由清掉一条命题上所有警告。本工具每项自带自己的警告 id 与自己的理由,该付的成本一分没省。

**警告与 finding 的过期语义相反,这是有意的:**

| | 复燃 |
| --- | --- |
| **结构检查警告** | 自动。判据 = 重查触发条件(design.md §3.1b),由 §5 的 id 派生免费得到 |
| **finding** | 不自动过期。一条 finding 只能被"驳回并写理由"或"新一次 review 取代"结算 |

理由:警告是从当前状态**算出来**的,所以它永远说的是现在;finding 是一条历史意见,算不出来。若让 finding 随指纹变化自动失效,改一个逗号就能清掉一条"你的论据推不出结论"——那是一条洗白通道,正是 design.md §0 要消灭的东西。

---

## 5. 警告的可寻址性(对实现的约束)

`dismiss` 要求警告有稳定 id。方案:**id 从内容派生,不存可变状态。**

```
warning_id = hash(node_id, 判据编号, 触发点标识, recheck_fingerprint)

recheck_fingerprint = hash(
  content,
  内联 warrant 文本 或 晋升后 warrant 的 id,
  证据成员清单(排序),
  反驳成员清单(排序),
  每个直接引用节点的 (content hash, qualifier)
)
```

指纹的字段清单**逐字对应** design.md §3.1"原理"的两条触发条件。于是:

- **复燃是免费的。** 指纹一变,该命题上所有 warning_id 全变,事件流里旧的 `dismiss` 事件再也匹配不上任何当前警告——"任一触发发生则所有已阅警告一律复燃"由 id 派生直接得到,不需要一张可变的警告状态表,也不需要第二套判据(§3.1b 明确禁止另立窄口径)。
- **读取时的算法**:算出当前警告集合 → 到事件流查同 id 的 `dismiss` 事件 → 命中标"已阅(附理由与时间)",未命中标"待处理"。
- **与 I8 一致**:零可变状态,`dismiss` 保持为一条纯 append 事件(design.md §3.1c"永不更新、永不删除")。

finding id 不含指纹(理由见 §4.2),用事件流里 review 事件的稳定标识。

---

## 6. 参数描述(写作引导的落点)

design.md §1.4 把旧"类型"承担的写作引导转移到参数描述。以下是各字段的措辞要点;`warrant` 与 `content` 直接继承 `src/content/elements.ts` 里已经用过的表述(那是验证过的措辞,不重新发明)。

| 参数 | 引导要点 |
| --- | --- |
| `content` | 写一句可独立判定的陈述:什么被确立、被观察、被发表。**不写产生它的方法与过程,不写活动流水。** 保持原子:一个节点一个可独立判定的命题 |
| `warrant` | 写让这些证据得以支撑这个内容的**领域通用推理原则**。它要解释"为什么这类证据可以支撑这类结论",且必须在本论证之外也成立。不复述内容、不总结证据、不引用来源、**不写就事论事的 if-then 桥**。反例:"如果气温升高了,那么发生了气候变化"(就事论事的桥);正例:"多个独立数据集上持续的气温升高表明系统性气候变化"(推理原则) |
| `evidence.attachments` | 支撑本命题的文件路径。引用文献时把文献本身作为附件,文献即说明文档;其余情况给一份说明文档(如 `statement-<topic>.md`)加上必要的代码、结果、日志、数据,说明文档要能独立解释这条命题记录了什么、这些文件怎么支撑它 |
| `evidence.nodes` | 挂进来的是**引用不是副本**,上游看到的永远是那条命题当下的 content。挂 `refuted` 的命题是合法的——那时你依赖的是"它已被推翻"为真,此时应在 `warrant` 里显式写明"因为 X 已被推翻",别把语义反转留在读者脑子里 |
| `qualifier` | 单条有序标尺 `refuted → unestablished → possibly → probably → certainly`。**不要把方法论局限写在这里,那属于反驳** |
| `attacks` | 只在这条命题确实构成反例、例外或矛盾时用;普通的观察记录不是反驳。`slot` 选 `content`(攻击结论)还是 `warrant`(攻击推理原则) |
| `note` | 什么证据逼的这次变更。变更已定案的命题时建议写(C4,不强制) |
| `dismiss.reason` | 为什么这条意见不成立或无需处理 |

---

## 7. 旧工具面去向(21 → 11)

| 旧工具 | 去向 |
| --- | --- |
| `create_claim` | → `create_propositions`(claim 是状态不是类型) |
| `create_statement` | → `create_propositions` |
| `create_statements` | → `create_propositions`(批量成为唯一形态) |
| `create_warrant` | **删除**(warrant 是槽位不是节点);晋升场景 → `promote_warrant` |
| `update_node` | → `update_proposition`(qualifier 剥出;attachments 整体替换改 add/remove) |
| `delete_node` | → `delete_proposition`(`cascade` 参数删除) |
| `verify_statements` | → `set_qualifier`(verified 并入正向档) |
| `compile_arguments` | → `review`(动词退役,重新定位为顾问) |
| `get_node` | → `get_argument(depth=0)` |
| `get_argument` | → `get_argument`(加 `warnings` / `findings` 字段) |
| `list_claims` | **删除**(失去所指)→ `find_propositions(qualifier=...)` |
| `list_statements` | → `find_propositions` |
| `search_nodes` | → `find_propositions` |
| `get_stats` | → `get_stats`(加结算摘要) |
| `create_tag` / `create_tags` / `update_tag` / `rename_tag` / `merge_tags` / `list_tags` / `tag_nodes` | **全部删除**(tags 体系废除) |

**新增**(3 个):`promote_warrant`、`get_history`、`dismiss`。

### 7.1 旧警告的去向(`src/content/warnings.ts`)

| 旧警告 | 去向 |
| --- | --- |
| `statusReverted` / `statusRevertedVerificationWithdrawn` / `statusRevertedGroundClaimUnsettled` / `statusRevertedCompileNotPassed` / `verificationRevertedOnContentChange` / `compileInvalidated` | **全部删除**。它们的共同前提是"系统会替 agent 回退状态",而新系统从不回退,只标红(§0-②)。其中三条的正文还在指挥 agent 要不要重跑 compile,而 compile 已不存在 |
| `revertGroundVerification` | **删除**(同上) |
| `deleteClaimReferencedByGround` / `deleteGroundReferencedByWarrant` / `deleteWarrantSupportingClaim` | **合并**为 `delete_proposition` 返回体里的受影响命题清单(§2.5)。分三条写是旧本体三种类型的产物 |
| `attachmentsReplaced` | **删除**。接口改成 add/remove 后这件事不可能发生(§2.2) |
| `paperTagObservedSource` | **删除**(`source` 字段与 tag 体系一并废除) |
| `attachmentOutOfRoot` | **保留**。它查的是可移植性,与 V3 无关(V3 只查存在),两者都要 |
| `compiledWithoutReviewModel` | **改为失败**。它原本是"没审查却记为 passed"的补丁,而 review 不产出 passed,缺配置时应直接拒绝执行(§4.1) |

新增的警告类别只有一族:**结构检查警告 / 该重查警告**,按 design.md §3.1 的四档判据派生,带触发点与 id(§5)。

---

## 8. 回流到 `docs/design.md` 的修订(已全部并入)

撰写接口面暴露出四处 design.md 未覆盖的地方,外加一条备查。**四条均已并入事实源**,本节保留为推导记录——记的是"这条约束是从哪儿逼出来的",而不是待办。

**① `create` 不能设 qualifier(已并入 §3.1c 派生关系行)。** design.md §3.1c 说基线的安全性来自"只有一个写入者",但没有把这条约束推到接口面。推论是新建时不允许设 qualifier,否则出现第二个写入者。

**② 自动晋升与 V4 冲突(已消解:V4 取消)。** 原冲突是:design.md §1.2 承诺"攻击一段内联理由时,系统自动把它晋升成命题,agent 无需额外调工具";而 V4 又要求每条命题写入时理由非空——系统替 agent 建出来的那条命题,它自己的理由由谁写?系统不能凭空编一句,agent 也没道理为自己要攻击的理由写辩词。

**解法:取消 V4,把"理由非空"移入结构检查表的 `possibly` 及以上。** 理由不是让步,是纠正一处类型错误:整张表的逻辑是"你要多确信,就交多少结构成本",warrant 完全符合这个梯度,把它拎出来当入场券是把梯度化要求做成了门。放回表里之后它与"证据非空""附件存在"同构,三条都是零语义的槽位检查。

于是冲突自行消失,且不需要任何新机制:晋升出的命题带空理由 + `unestablished` 落库完全合法,理由欠账由**已有判据**追讨——原命题要上 `probably` 就得让这条引用 ≠ `unestablished`(表格第四条,晋升后的 warrant 算直接引用,见 design.md §3.1 原理第三条),而给它判档时又撞上"理由非空"。补理由的时刻因此从"建节点"移到"判档",而判档才是这个问题到期的时刻——warrant 回答"为什么这些证据撑得起这个 content",在你还没判它撑不撑得起的时候,这个问题本身没到期。

顺带解掉 V4 原本认下的那笔代价:`unestablished` 的记录性命题("某文献声称 X")与中间态命题不必先编一句理由才能落库,归纳期的摩擦消失在它本该消失的地方。

**新的代价(已写入 design.md §3.1 表注)**:一条空理由、`unestablished` 的命题可以支撑一条 `possibly` 结论且全程不标红——分界线是"你说有可能,你自己得说出凭什么;你引用的东西可以还没论证"。实现侧:warrant 字段可空,读取路径须处理空值。

**本条已回写 design.md**(§1.2 槽位表与晋升段、§3.1 姿态原则/表注/判据表/硬拒表、§2 L1 行、§2.1、§6 决策记录)。

**③ finding 的处置路径(已并入 §3.1b 改写 + §2.5 补出口)。** design.md §2.5 假设 finding 有"未处理 / 已处理"两态,但没有定义任何完成这个转移的工具;§3.1b 的 dismiss 又只覆盖"该重查警告"。解法:`dismiss` 统一到两类对象上,并写明两者过期语义相反(§4.2)——警告可重算故自动复燃,finding 是历史意见故必须显式结算,否则改一个逗号就是一条洗白通道。§3.1b 标题已改为"处置警告与意见(dismiss)"。

**④ 警告必须可寻址(已并入 §3.1"归属")。** design.md 原本只要求"标出触发点",而 dismiss 要求警告能被指名。解法是 §5 的指纹派生 id,顺带把 §3.1b 的"复燃"从一条需要实现的规则变成 id 派生的自动结果,不设可变警告状态表。

**⑤ 顺带**:`delete_proposition` 不设 cascade(新本体无父子)、`find_propositions` 不设 role 过滤(角色只取决于视角)这两条是 §1.3 的直接推论,不需要回写,记在此处备查。

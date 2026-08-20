/**
 * Warranted — 类型定义
 *
 * 本体是**一个命题 + 五个槽位**(docs/design.md §1.2):
 * content / evidence / warrant / rebuttal / qualifier。
 *
 * 没有节点类型:claim 退成"有争议"这个状态,ground / backing 退成对证据的两种
 * **视角**,warrant 与 rebuttal 退成**槽位**(§1.3)。所以这里既没有 NodeType,
 * 也没有按角色分叉的返回形状——角色只取决于以谁为中心看,不取决于数据。
 */

import type { Qualifier, EventOp, EventActor, RefRole } from "./schema.ts";

export type { Qualifier, EventOp, EventActor, RefRole };
export { QUALIFIERS, POSITIVE_QUALIFIERS, EVENT_OPS, EVENT_ACTORS, REF_ROLES } from "./schema.ts";

// =============================================================================
// 命题与槽位
// =============================================================================

/** propositions 表的原始行。 */
export interface PropositionRow {
  id: number;
  content: string;
  warrant_text: string | null;
  warrant_node_id: number | null;
  qualifier: Qualifier;
  created_at: string;
  updated_at: string;
}

/**
 * 理由槽的三种形态(design.md §1.2)。
 *
 * 写成判别联合而不是"两个可空字段",是为了让"同时内联又晋升"在类型层面无法表达——
 * 与 DB 里那条 CHECK 是同一条约束的两次落地。
 */
export type WarrantSlot =
  | { kind: "empty" }
  | { kind: "inline"; text: string }
  | { kind: "promoted"; node_id: number };

/** 证据槽:附件与命题共用一个槽,只是存储分两张表。 */
export interface EvidenceSlot {
  attachments: string[];
  /** 挂进来的是**引用不是副本**:读到的永远是那条命题当下的 content。 */
  nodes: number[];
}

/** 一条命题的完整槽位视图。 */
export interface Proposition {
  id: number;
  content: string;
  evidence: EvidenceSlot;
  warrant: WarrantSlot;
  /** 攻击本命题的命题 id。 */
  rebuttals: number[];
  qualifier: Qualifier;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// 结构检查:判据编号与警告
// =============================================================================

/**
 * 判据编号。两族,派生方式不同:
 *
 * - **S/A 族(当前状态)**:只看图现在长什么样,按命题自己的 qualifier 分档启用
 *   (design.md §3.1 判据表)。S = 支撑侧,A = 攻击侧。
 * - **R 族(基线比对)**:拿当前值与"设 qualifier 那一刻的快照"比,回答
 *   "我判断时依据的东西还是不是这个"(§3.1c)。
 *
 * R 族**不按档位放宽**(只跳过 `unestablished`——它没有基线)。§3.1 给 `possibly`
 * 的放宽针对的是**可信度要求**("引用链得多可信"),而 R 族问的是**事实变没变**:
 * 你判 `possibly` 时读的那段证据被改写了,这条 possibly 一样需要重看。两者是不同
 * 的东西,放宽其一不蕴含放宽其二。
 */
export const CheckCode = {
  /** 证据槽为空(possibly 及以上)。 */
  EvidenceEmpty: "S1",
  /** 附件文件不存在(possibly 及以上)。写硬读软:写入时查过,之后被删在读时标红。 */
  AttachmentMissing: "S2",
  /** 理由为空(possibly 及以上)。曾经的 V4,已移回表内。 */
  WarrantEmpty: "S3",
  /**
   * 附件解析到项目根之外(possibly 及以上)。
   *
   * 不在 §3.1 判据表里,是唯一从旧警告体系保留下来的一条(api.md §7.1):它查的是
   * **可移植性**,与 V3(存在性)是两回事,两者都要。旧实现在写入返回体里发一句
   * 字符串,而 api.md §0-③ 要求警告可被指名驳回,所以它必须搬到读时算、带 id ——
   * 落到这里就是判据表之外的一条。档位跟 S2 走:同一个槽、同一个触发点,分开
   * 分档会让"附件不见了"与"附件不可移植"在某些档位上一个响一个不响。
   */
  AttachmentOutOfRoot: "S5",
  /** 引用的命题落 `unestablished`(probably / certainly)。`refuted` 不在此列。 */
  EvidenceUnestablished: "S4",
  /** 反驳槽为空(refuted)。 */
  RebuttalEmpty: "A1",
  /** 反驳自己没落在正向三档(refuted)。攻击力随它被推翻一起消解。 */
  RebuttalNotPositive: "A2",
  /** 本命题自判断以来已变(content / 理由 / 证据成员 / 反驳成员)。 */
  SelfChanged: "R0",
  /** 判断时依据的引用已被删除。 */
  RefGone: "R1",
  /** 判断时依据的引用 content 已变。 */
  RefContentChanged: "R2",
  /** 判断时依据的引用 qualifier 已变(证据从 certainly 掉到 refuted 在这里抓)。 */
  RefQualifierChanged: "R3",
} as const;

export type CheckCode = (typeof CheckCode)[keyof typeof CheckCode];

/**
 * 一条结构检查警告。
 *
 * `id` 从 `(node_id, code, trigger, recheck_fingerprint)` 派生(api.md §5),
 * 不存可变状态。于是"复燃"是免费的:指纹一变 id 全变,旧的 dismiss 事件
 * 自然匹配不上——不需要警告状态表,dismiss 保持为纯 append 事件。
 */
export interface StructuralWarning {
  id: string;
  nodeId: number;
  code: CheckCode;
  /** 触发点标识:哪个附件、哪条引用。整条命题级的判据(如 S1)为 null。 */
  trigger: string | null;
  /** 人读的一句话:断在哪。 */
  message: string;
  state: "pending" | "acknowledged";
  /** state = acknowledged 时非空。 */
  dismissal?: { reason: string; at: string };
}

// =============================================================================
// 审查:finding
// =============================================================================

/**
 * 一条 finding(design.md §2.2 / api.md §4.1)。
 *
 * `question` 是**判别式**:它唯一决定 citation 的形态。做成判别联合之后,
 * "Q1 只针对附件型证据"从一句措辞变成类型层面无法违反的事。
 *
 * 不带 `severity`(要看到局部之外,审查器无权判)、不带修改建议(那是 L3 的活)、
 * 不带 `status`(已阅由事件流算出来,加了就破 I8)、不带反模式分类。
 */
export type Finding = Q1Finding | Q2Finding;

interface FindingBase {
  /** `f_<review_event_id>_<序号>`。**不含重查指纹**——finding 不随图变化过期。 */
  id: string;
  nodeId: number;
  /** 断点陈述:哪里断了。不是"这个论证不够好"。 */
  content: string;
  /** 我这条判断有多大把握。只有两档——三档的中间档是垃圾桶。 */
  confidence: "high" | "low";
}

/** 忠实性:附件有没有真的说这条命题声称的事。只针对附件型证据。 */
export interface Q1Finding extends FindingBase {
  question: "Q1";
  citation: {
    /** 必须 ∈ 被审查命题的附件槽(F2)。 */
    attachment: string;
    /** 页码 / 行号 / 章节,让人能翻到。 */
    locator: string;
    /** 逐字片段。真伪要读原文才知道,留给人(F1 只查非空)。 */
    quote: string;
  };
}

/** 有效性:证据即便为真,这条理由能否推出 content。 */
export interface Q2Finding extends FindingBase {
  question: "Q2";
  citation: {
    /** 必须 ∈ {被审查命题} ∪ {其证据槽里的命题}(F3)。 */
    nodeId: number;
    slot: "content" | "warrant";
    /** 必须是该槽位内容的**逐字子串**(F4)。验不过 = 审查器在编。 */
    quote: string;
  };
}

/**
 * 审查器交出来的 finding:**没有 id**。
 *
 * id 是 `f_<review_event_id>_<序号>`,而 review 事件的 id 要等落库那一刻才存在。
 * 让审查器自己编一个 id,就等于允许它编一个能跟已有 dismiss 事件对上的 id。
 */
export type FindingDraft = Omit<Q1Finding, "id"> | Omit<Q2Finding, "id">;

/** 带处置状态的 finding(读取接口用)。状态是算出来的,不是存出来的。 */
export interface FindingView extends FindingBase {
  question: "Q1" | "Q2";
  citation: Q1Finding["citation"] | Q2Finding["citation"];
  state: "pending" | "acknowledged";
  dismissal?: { reason: string; at: string };
  at: string;
}

/**
 * 一条被 F1–F4 拒收的 finding(api.md §4.1)。
 *
 * 拒收是**逐条**的:不合格的那条不落库,同一次 review 的其余部分照常。原样留 `raw`,
 * 因为协议违规要能被人读出来是怎么违的——只记一个计数,下次改 prompt 时没有依据。
 */
export interface RejectedFinding {
  /** `shape` 不在那张表里:形状不对的东西根本不是一条 finding,不是一条不合格的 finding。 */
  failed: "shape" | "F1" | "F2" | "F3" | "F4";
  detail: string;
  raw: unknown;
}

/** review 事件的载荷。答"是"也留痕:没有这一层,"从没 review 过"与"review 过且没问题"分不开。 */
export interface ReviewOutcome {
  nodeId: number;
  /** `n/a` 专给"该命题没有附件型证据、Q1 无所施力"。记成 pass 会造出假象。 */
  Q1: "pass" | "fail" | "n/a";
  Q2: "pass" | "fail";
  findings: FindingDraft[];
  model: string;
  protocolHash: string;
  /** 本次被拒收的条目。进事件载荷,不进 findings 表。 */
  rejected?: RejectedFinding[];
}

// =============================================================================
// 事件流(I8)
// =============================================================================

export interface EventRow {
  id: number;
  node_id: number | null;
  op: EventOp;
  actor: EventActor;
  payload: string;
  note: string | null;
  target_key: string | null;
  at: string;
}

/** 对外形状。列名 actor 在这里变回契约里的名字 `by`(design.md §3.1c)。 */
export interface EventRecord {
  id: number;
  at: string;
  by: EventActor;
  op: EventOp;
  nodeId: number | null;
  /** update 是字段级 diff,delete 是整节点 before 快照,review 是 findings,dismiss 是理由。 */
  payload: Record<string, unknown>;
  note?: string;
  targetKey?: string;
}

/** update 事件的载荷:字段级 diff。 */
export type FieldDiff = Record<string, { old: unknown; new: unknown }>;

// =============================================================================
// 基线(设 qualifier 那一刻的快照)
// =============================================================================

export interface BaselineHead {
  nodeId: number;
  qualifier: Qualifier;
  /** 判断当时本命题自身的指纹(content + 理由 + 证据成员 + 反驳成员)。 */
  selfFingerprint: string;
  at: string;
}

export interface BaselineRef {
  nodeId: number;
  refId: number;
  refRole: RefRole;
  contentHash: string;
  qualifier: Qualifier;
}

// =============================================================================
// 工具入参
// =============================================================================

export interface CreatePropositionItem {
  content: string;
  /** 内联理由。可空——`possibly` 及以上才由结构检查追讨(V4 已取消)。 */
  warrant?: string;
  evidence?: { attachments?: string[]; nodes?: number[] };
  /** 把本命题登记为对目标的反驳。`slot: "warrant"` 会触发目标的内联理由自动晋升。 */
  attacks?: { node: number; slot: "content" | "warrant" };
  note?: string;
}

export interface UpdatePropositionParams {
  id: number;
  content?: string;
  /** 理由已晋升时本字段被拒绝——那时理由是一条独立命题,改它要改那条命题。 */
  warrant?: string;
  evidence?: {
    add_attachments?: string[];
    remove_attachments?: string[];
    add_nodes?: number[];
    remove_nodes?: number[];
  };
  /** 一律 add/remove,不提供整体替换:整体替换会静默丢成员(见 9393354)。 */
  rebuttals?: { add?: number[]; remove?: number[] };
  note?: string;
}

export interface SetQualifierItem {
  id: number;
  qualifier: Qualifier;
  note?: string;
}

export interface PromoteWarrantParams {
  id: number;
  /** 晋升出来那条命题**自己的**理由,可空。 */
  warrant?: string;
  evidence?: { attachments?: string[]; nodes?: number[] };
  note?: string;
}

export interface FindPropositionsParams {
  query?: string;
  qualifier?: Qualifier[];
  /** 只要有未处理 finding 或未处理警告的。 */
  has_unresolved?: boolean;
  limit?: number;
  offset?: number;
}

export interface DismissItem {
  /** 警告 id 或 finding id。 */
  id: string;
  reason: string;
}

// =============================================================================
// 返回形状
// =============================================================================

/** 一条命题的完整对外视图:五个槽位 + 结构检查警告 + 未处理意见。 */
export interface PropositionView {
  id: number;
  content: string;
  qualifier: Qualifier;
  warrant: WarrantSlot;
  evidence: EvidenceSlot;
  rebuttals: number[];
  /** 对每条命题都出现,不需要开关——可选的醒目就不是醒目(design.md §2.5)。 */
  warnings: StructuralWarning[];
  findings: FindingView[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateResultItem {
  id: number;
  warnings: StructuralWarning[];
  /** 系统替 agent 建了节点时必须显式报告,否则图里凭空多一个节点。 */
  promoted?: { from_node: number; new_id: number };
  /** 不可寻址的一句话提示(C4 建议留 note 之类)。不能被 dismiss——它不是断点。 */
  notices?: string[];
}

export interface UpdateResult {
  id: number;
  warnings: StructuralWarning[];
  notices?: string[];
}

export interface SetQualifierResultItem {
  id: number;
  qualifier: Qualifier;
  /** 上一档。事件流里也有,放在返回体里是为了让"我刚把它从哪儿改到哪儿"一眼可见。 */
  previous: Qualifier;
  warnings: StructuralWarning[];
  notices?: string[];
}

export interface PromoteResult {
  id: number;
  /** 晋升出来的那条命题。 */
  newId: number;
  warnings: StructuralWarning[];
}

export interface DeleteResult {
  id: number;
  /** 从槽里被摘掉这条引用的命题。它们已被标为该重查。 */
  affected: number[];
  notices?: string[];
}

/** `get_argument` 的返回:自己 + 邻域。角色只取决于以谁为中心看,所以邻居不分组。 */
export interface ArgumentResult {
  root: PropositionView;
  neighbors: PropositionView[];
}

export interface FindResult {
  items: PropositionView[];
  total: number;
}

export interface DismissResultItem {
  id: string;
  /** 命中了什么:一条结构检查警告,还是一条 finding。 */
  target: "warning" | "finding" | "unknown";
  ok: boolean;
  message?: string;
}

/** get_stats 的结算摘要(design.md §4)。红点清单在前,计数在后。 */
export interface SettlementSummary {
  total: number;
  byQualifier: Record<Qualifier, number>;
  /** 有未处理 finding 的命题。 */
  unresolvedFindings: Array<{ nodeId: number; count: number }>;
  /** 有未处理结构检查警告的命题,按判据分组计数。 */
  unresolvedWarnings: Array<{ nodeId: number; codes: CheckCode[] }>;
  attachments: { total: number; missing: string[] };
}

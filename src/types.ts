/**
 * Toulmin 论证模型 — 类型定义
 *
 * 5 种节点类型：Claim, Ground, Warrant, Backing, Rebuttal
 * 所有节点共享基础字段，类型特有字段存储在 data JSON 中。
 */

// =============================================================================
// 枚举常量
// =============================================================================

export type NamespaceCardinality = "dense" | "bounded";

export interface TagRow {
  name: string;
  description: string;
  claim_id: number | null;
  created_at: string;
}

export interface TagNamespaceRow {
  namespace: string;
  cardinality: NamespaceCardinality;
  declared_at: string;
}

export const NodeType = {
  Claim: "claim",
  Warrant: "warrant",
  Statement: "statement",
} as const;

export type NodeType = (typeof NodeType)[keyof typeof NodeType];

export const GroundSource = {
  Literature: "literature",
  Observed: "observed",
} as const;

export type GroundSource = (typeof GroundSource)[keyof typeof GroundSource];

export const VerificationStatus = {
  Verified: "verified",
  Pending: "pending",
} as const;

export type VerificationStatus =
  (typeof VerificationStatus)[keyof typeof VerificationStatus];

export const ClaimStatus = {
  Proposed: "proposed",
  Supported: "supported",
  Disputed: "disputed",
  Refuted: "refuted",
} as const;

export type ClaimStatus = (typeof ClaimStatus)[keyof typeof ClaimStatus];

export const TargetType = {
  Claim: "claim",
  Warrant: "warrant",
} as const;

export type TargetType = (typeof TargetType)[keyof typeof TargetType];

// =============================================================================
// 节点接口
// =============================================================================

/** 所有节点共享的基础接口 */
export interface BaseNode {
  id: number;
  type: NodeType;
  content: string;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
}

/** Claim 节点 */
export interface ClaimNode extends BaseNode {
  type: "claim";
  status: ClaimStatus;
}

/** Warrant 节点 */
export interface WarrantNode extends BaseNode {
  type: "warrant";
  claimId: number;
  groundIds: number[];
}

/** Statement 节点（统一替代 Ground/Backing/Rebuttal） */
export interface StatementNode extends BaseNode {
  type: "statement";
  source?: GroundSource;
  verification?: VerificationStatus;
  attachments: string[];
}

/** 所有节点类型的联合类型 */
export type ToulminNode =
  | ClaimNode
  | WarrantNode
  | StatementNode;

// =============================================================================
// data JSON 结构（与 SQLite data 列对应）
// =============================================================================

export interface ClaimData {
  status: ClaimStatus;
  qualifier?: string | null;
}

export interface WarrantData {
  claim_id: number;
  ground_ids: number[];
}

export interface StatementData {
  source?: GroundSource;
  verification?: VerificationStatus;
  attachments: string[];
}

export type NodeData =
  | ClaimData
  | WarrantData
  | StatementData;

// =============================================================================
// update_node 参数类型
// =============================================================================

export interface GroundIdsUpdate {
  add?: number[];
  remove?: number[];
}

export interface UpdateNodeParams {
  content?: string;
  attachments?: string[];
  status?: ClaimStatus;
  source?: GroundSource;
  verification?: VerificationStatus;
  ground_ids?: GroundIdsUpdate;
  backing_ids?: { add?: number[]; remove?: number[] };
  rebuttal_ids?: { add?: number[]; remove?: number[] };
  qualifier?: string | null;
  tags?: { add?: string[]; remove?: string[] };
}

// =============================================================================
// get_argument 返回类型
// =============================================================================

export interface ArgumentGround {
  id: number;
  content: string;
  attachments: string[];
  source: GroundSource;
  verification: VerificationStatus;
}

export interface ArgumentBacking {
  id: number;
  content: string;
  attachments: string[];
}

export interface ArgumentWarrant {
  id: number;
  content: string;
  grounds: ArgumentGround[];
  backings: ArgumentBacking[];
}

export interface ArgumentRebuttal {
  id: number;
  target_type: TargetType;
  content: string;
  attachments: string[];
}

export interface ClaimArgument {
  claim: {
    id: number;
    content: string;
    status: ClaimStatus;
    qualifier: string | null;
    /** 来自 compile_state 表；null 表示从未编译过 */
    compile_status?: CompileStateVerdict | null;
  };
  warrants: ArgumentWarrant[];
  rebuttals: ArgumentRebuttal[];
}

export interface WarrantArgument {
  warrant: { id: number; content: string; claim_id: number };
  grounds: ArgumentGround[];
  backings: ArgumentBacking[];
  rebuttals: ArgumentRebuttal[];
}

export interface NodeArgument {
  node: {
    id: number;
    type: NodeType;
    content: string;
    attachments?: string[];
    source?: GroundSource;
    verification?: VerificationStatus;
  };
  rebuttals?: ArgumentRebuttal[];
  used_in_warrants?: Array<{
    warrant_id: number;
    claim_id: number;
    claim_content: string;
  }>;
}

export type ArgumentResult = ClaimArgument | WarrantArgument | NodeArgument;

// =============================================================================
// get_stats 返回类型
// =============================================================================

export interface Stats {
  claims: { total: number; by_status: Record<string, number>; stale_count?: number };
  grounds: { total: number; by_source: Record<string, number>; by_verification: Record<string, number> };
  warrants: { total: number };
  backings: { total: number };
  qualifiers: { total: number };
  rebuttals: { total: number; by_target_type: Record<string, number> };
  scale?: ScaleBlock;
}

export interface ScaleBlock {
  tags: { total: number; namespaces: Array<{ name: string; count: number; with_nodes: number; cardinality: string }> };
  untagged: number;
  /** §4.2's `Statements:` line — counts statements, not tags. */
  statements: { total: number; tagged: number; untagged: number };
  namespace_gaps: Array<{ from: string; to: string; count: number }>;
  gaps_omitted: number;
  roles: { grounds: { total: number; verified: number; pending: number }; backings: { total: number; pending: number }; rebuttals: { total: number; pending: number } };
  claims_detail: { never_compiled: number; stale: { count: number; ids: number[] }; passed_awaiting: number };
  attachments: { total: number; files: Array<{ path: string; missing: boolean }> };
}

// =============================================================================
// 数据库行类型（从 SQLite 读取的原始行）
// =============================================================================

export interface NodeRow {
  id: number;
  type: string;
  content: string;
  data: string; // JSON string
  created_at: string;
  updated_at: string;
}

// =============================================================================
// compile 相关类型
// =============================================================================

export const CompileVerdict = {
  Passed: "passed",
  Failed: "failed",
} as const;

export type CompileVerdict = (typeof CompileVerdict)[keyof typeof CompileVerdict];

/**
 * compile_state.verdict 的取值 —— 比 CompileVerdict 多一个 "stale"。
 *
 * CompileVerdict 是"一次检查得出的结论"，只有 passed/failed；stale 不是任何一次检查的
 * 结论，而是"曾经 passed，但通过的那个结构已经被改掉了"。两者不可混用：
 * CompileResult.verdict 出现 stale 是错的。
 *
 * 没有行 = 从未编译过。这三个值加"没有行"共四种状态互斥且穷尽。
 */
export type CompileStateVerdict = CompileVerdict | "stale";

export interface CompileState {
  claimId: number;
  verdict: CompileStateVerdict;
  summary: string;
  argumentHash?: string; // Merkle Root 哈希；仅 verdict === "passed" 时非空
  createdAt: string;
}

export interface ElementReviewResult {
  reviewer: "claim" | "warrant" | "chain" | "structure";
  nodeId?: number;
  errors: string[];
  warnings: string[];
  infos?: string[];
  skipped?: boolean;
  /** true 表示本结果的 errors 与其他 reviewer 的 error 重叠，已被降级为咨询性提示（不代表 compile 失败原因的唯一来源） */
  advisory?: boolean;
}

export interface CompileResult {
  claimId: number;
  verdict: CompileVerdict;
  summary: string;
  elementReviews: ElementReviewResult[];
  compiledAt: string;
}

// =============================================================================
// 自动验证类型
// =============================================================================

export interface AutoVerifyResult {
  claimId: number;
  /**
   * 这次对该 Claim 实际发生了什么。
   *
   * D25/D26：这里曾经只有一个 "marked-stale"，同时表示五种不同结局，渲染层只能猜，
   * 于是把"结构齐全但某条检查没过"也印成 "incomplete structure"。按结局拆开之后
   * 渲染层不必猜，每个词只对应一件事：
   *
   * - auto-reviewed        模型审查跑了，结论在 compileResult 里
   * - no-change            结构指纹没变，不必重审
   * - structure-incomplete 结构缺东西（少推理、少证据、Ground 指向不存在的节点）
   * - check-failed         结构齐全，但确定性检查没通过（structuralQualityCheck）
   * - passed-unreviewed    没有配审查模型，只跑了不需要模型的检查就记为通过
   * - skipped              节点不存在或不是 Claim
   */
  action:
    | "auto-reviewed"
    | "no-change"
    | "structure-incomplete"
    | "check-failed"
    | "passed-unreviewed"
    | "skipped";
  /**
   * 这次是否真的把一条 passed 记录降级成了 stale。
   *
   * 与 action 无关，是独立的一件事：markCompileStale 只动 passed 的行，所以同一个
   * 分支在 failed / 没有记录 的 Claim 上什么都不会改。取的是 SQL 实际改动的行数，
   * 不是从分支位置推断的——D26 就是把"叫 marked-stale"当成"真的标了"。
   */
  staled?: boolean;
  compileResult?: CompileResult;
  message?: string;
}

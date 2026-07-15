/**
 * Toulmin 论证模型 — 类型定义
 *
 * 5 种节点类型：Claim, Ground, Warrant, Backing, Rebuttal
 * 所有节点共享基础字段，类型特有字段存储在 data JSON 中。
 */

// =============================================================================
// 枚举常量
// =============================================================================

export const NodeType = {
  Claim: "claim",
  Ground: "ground",
  Warrant: "warrant",
  Backing: "backing",
  Rebuttal: "rebuttal",
} as const;

export type NodeType = (typeof NodeType)[keyof typeof NodeType];

export const GroundSource = {
  Literature: "literature",
  Observed: "observed",
  Hypothesis: "hypothesis",
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
  Validated: "validated",
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
}

/** Claim 节点 */
export interface ClaimNode extends BaseNode {
  type: "claim";
  status: ClaimStatus;
}

/** Ground 节点 */
export interface GroundNode extends BaseNode {
  type: "ground";
  source: GroundSource;
  verification: VerificationStatus;
  attachments: string[];
  refClaimId: number | null;
}

/** Warrant 节点 */
export interface WarrantNode extends BaseNode {
  type: "warrant";
  claimId: number;
  groundIds: number[];
}

/** Backing 节点 */
export interface BackingNode extends BaseNode {
  type: "backing";
  attachments: string[];
  warrantId: number;
}

/** Rebuttal 节点 */
export interface RebuttalNode extends BaseNode {
  type: "rebuttal";
  attachments: string[];
  targetId: number;
  targetType: TargetType;
}

/** 所有节点类型的联合类型 */
export type ToulminNode =
  | ClaimNode
  | GroundNode
  | WarrantNode
  | BackingNode
  | RebuttalNode;

// =============================================================================
// data JSON 结构（与 SQLite data 列对应）
// =============================================================================

export interface ClaimData {
  status: ClaimStatus;
  qualifier?: string | null;
  compiled?: boolean;
  compiled_at?: string;
  stale?: boolean;
}

export interface GroundData {
  source: GroundSource;
  verification: VerificationStatus;
  attachments: string[];
  ref_claim_id: number | null;
}

export interface WarrantData {
  claim_id: number;
  ground_ids: number[];
}

export interface BackingData {
  attachments: string[];
  warrant_id: number;
}

export interface RebuttalData {
  attachments: string[];
  target_id: number;
  target_type: TargetType;
}

export type NodeData =
  | ClaimData
  | GroundData
  | WarrantData
  | BackingData
  | RebuttalData;

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
  qualifier?: string | null;
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
  ref_claim_id?: number | null;
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
    stale?: boolean;
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
    ref_claim_id?: number | null;
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

export interface CompileState {
  claimId: number;
  verdict: CompileVerdict;
  summary: string;
  argumentHash?: string; // Merkle Root 哈希
  createdAt: string;
}

export interface ElementReviewResult {
  reviewer: "claim" | "warrant" | "ground" | "chain" | "structure";
  nodeId?: number;
  errors: string[];
  warnings: string[];
  infos?: string[];
  skipped?: boolean;
}

export interface CompileResult {
  claimId: number;
  verdict: CompileVerdict;
  summary: string;
  elementReviews: ElementReviewResult[]; // 仅 chain review
  compiledAt: string;
}

// =============================================================================
// 自动验证类型
// =============================================================================

export interface AutoVerifyResult {
  claimId: number;
  action: "auto-reviewed" | "marked-stale" | "no-change" | "skipped";
  compileResult?: CompileResult;
  message?: string;
}

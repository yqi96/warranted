/**
 * Toulmin MCP — 测试辅助工具
 *
 * 提供内存数据库创建、工厂函数和种子数据。
 */

import { Database } from "bun:sqlite";
import { openDatabase } from "../src/db.ts";
import type {
  ClaimNode,
  GroundNode,
  WarrantNode,
  BackingNode,
  QualifierNode,
  RebuttalNode,
  ClaimStatus,
  GroundSource,
  VerificationStatus,
  TargetType,
} from "../src/types.ts";

// =============================================================================
// 数据库管理
// =============================================================================

/** 创建内存测试数据库 */
export function createTestDb(): Database {
  return openDatabase(":memory:");
}

/** 关闭测试数据库 */
export function cleanupDb(db: Database): void {
  db.close();
}

// =============================================================================
// 工厂函数 — 直接操作 repo 层创建节点
// =============================================================================

let _idCounter = 0;

/** 重置 ID 计数器（每个测试前调用） */
export function resetIdCounter(): void {
  _idCounter = 0;
}

function nextId(): number {
  return ++_idCounter;
}

/** 创建 Claim 节点 */
export function makeClaim(
  db: Database,
  content: string = "Test claim",
  status: ClaimStatus = "proposed"
): ClaimNode {
  const now = new Date().toISOString().slice(0, 19);
  const data = JSON.stringify({ status });
  const stmt = db.prepare(
    "INSERT INTO nodes (type, content, data, created_at, updated_at) VALUES ('claim', ?, ?, ?, ?)"
  );
  const result = stmt.run(content, data, now, now);
  const id = result.lastInsertRowid as number;
  return {
    id,
    type: "claim",
    content,
    status,
    createdAt: now,
    updatedAt: now,
  };
}

/** 创建 Ground 节点 */
export function makeGround(
  db: Database,
  opts: {
    content?: string;
    source?: GroundSource;
    verification?: VerificationStatus;
    attachments?: string[];
    refClaimId?: number | null;
  } = {}
): GroundNode {
  const {
    content = "Test ground",
    source = "observed",
    verification = "verified",
    attachments = [],
    refClaimId = null,
  } = opts;

  const now = new Date().toISOString().slice(0, 19);
  const data = JSON.stringify({
    source,
    verification,
    attachments,
    ref_claim_id: refClaimId,
  });
  const stmt = db.prepare(
    "INSERT INTO nodes (type, content, data, created_at, updated_at) VALUES ('ground', ?, ?, ?, ?)"
  );
  const result = stmt.run(content, data, now, now);
  const id = result.lastInsertRowid as number;
  return {
    id,
    type: "ground",
    content,
    source,
    verification,
    attachments,
    refClaimId,
    createdAt: now,
    updatedAt: now,
  };
}

/** 创建 Warrant 节点 */
export function makeWarrant(
  db: Database,
  claimId: number,
  groundIds: number[] = [],
  content: string = "Test warrant"
): WarrantNode {
  const now = new Date().toISOString().slice(0, 19);
  const data = JSON.stringify({ claim_id: claimId, ground_ids: groundIds });
  const stmt = db.prepare(
    "INSERT INTO nodes (type, content, data, created_at, updated_at) VALUES ('warrant', ?, ?, ?, ?)"
  );
  const result = stmt.run(content, data, now, now);
  const id = result.lastInsertRowid as number;
  return {
    id,
    type: "warrant",
    content,
    claimId,
    groundIds,
    createdAt: now,
    updatedAt: now,
  };
}

/** 创建 Backing 节点 */
export function makeBacking(
  db: Database,
  warrantId: number,
  content: string = "Test backing",
  attachments: string[] = []
): BackingNode {
  const now = new Date().toISOString().slice(0, 19);
  const data = JSON.stringify({ attachments, warrant_id: warrantId });
  const stmt = db.prepare(
    "INSERT INTO nodes (type, content, data, created_at, updated_at) VALUES ('backing', ?, ?, ?, ?)"
  );
  const result = stmt.run(content, data, now, now);
  const id = result.lastInsertRowid as number;
  return {
    id,
    type: "backing",
    content,
    attachments,
    warrantId,
    createdAt: now,
    updatedAt: now,
  };
}

/** 创建 Qualifier 节点 */
export function makeQualifier(
  db: Database,
  claimId: number,
  content: string = "Test qualifier",
  attachments: string[] = []
): QualifierNode {
  const now = new Date().toISOString().slice(0, 19);
  const data = JSON.stringify({ attachments, claim_id: claimId });
  const stmt = db.prepare(
    "INSERT INTO nodes (type, content, data, created_at, updated_at) VALUES ('qualifier', ?, ?, ?, ?)"
  );
  const result = stmt.run(content, data, now, now);
  const id = result.lastInsertRowid as number;
  return {
    id,
    type: "qualifier",
    content,
    attachments,
    claimId,
    createdAt: now,
    updatedAt: now,
  };
}

/** 创建 Rebuttal 节点 */
export function makeRebuttal(
  db: Database,
  targetId: number,
  targetType: TargetType = "claim",
  content: string = "Test rebuttal",
  attachments: string[] = []
): RebuttalNode {
  const now = new Date().toISOString().slice(0, 19);
  const data = JSON.stringify({ attachments, target_id: targetId, target_type: targetType });
  const stmt = db.prepare(
    "INSERT INTO nodes (type, content, data, created_at, updated_at) VALUES ('rebuttal', ?, ?, ?, ?)"
  );
  const result = stmt.run(content, data, now, now);
  const id = result.lastInsertRowid as number;
  return {
    id,
    type: "rebuttal",
    content,
    attachments,
    targetId,
    targetType,
    createdAt: now,
    updatedAt: now,
  };
}

// =============================================================================
// 种子数据 — 创建完整的论证结构
// =============================================================================

export interface SeedResult {
  claim: ClaimNode;
  ground1: GroundNode;
  ground2: GroundNode;
  warrant: WarrantNode;
  backing: BackingNode;
  qualifier: QualifierNode;
}

/**
 * 创建一个完整的论证结构用于测试：
 * Claim ← Warrant(ground1, ground2) ← Backing
 * Claim ← Qualifier
 */
export function seedBasicArgument(db: Database): SeedResult {
  const claim = makeClaim(db, "核心主张：方法A优于方法B");
  const ground1 = makeGround(db, {
    content: "实验数据：方法A准确率95%",
    source: "observed",
    verification: "verified",
    attachments: ["/data/exp1.csv"],
  });
  const ground2 = makeGround(db, {
    content: "文献数据：方法B准确率85%",
    source: "literature",
    verification: "verified",
    attachments: ["/papers/ref.pdf"],
  });
  const warrant = makeWarrant(
    db,
    claim.id,
    [ground1.id, ground2.id],
    "实验准确率差异10%以上 → 方法A显著优于方法B"
  );
  const backing = makeBacking(
    db,
    warrant.id,
    "跨数据集一致性验证方法论",
    ["/papers/methodology.pdf"]
  );
  const qualifier = makeQualifier(
    db,
    claim.id,
    "仅在图像分类任务上验证",
    ["/data/benchmark_config.json"]
  );

  return { claim, ground1, ground2, warrant, backing, qualifier };
}

/**
 * Toulmin MCP — 测试辅助工具
 *
 * 提供内存数据库创建、工厂函数和种子数据。
 */

import { Database } from "bun:sqlite";
import { openDatabase } from "../src/db.ts";
import type {
  ClaimNode,
  StatementNode,
  WarrantNode,
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

/** 创建 Ground/Statement 节点 */
export function makeGround(
  db: Database,
  opts: {
    content?: string;
    source?: GroundSource;
    verification?: VerificationStatus;
    attachments?: string[];
  } = {}
): StatementNode {
  const {
    content = "Test ground",
    source = "observed",
    verification = "verified",
    attachments = [],
  } = opts;

  const now = new Date().toISOString().slice(0, 19);
  const data = JSON.stringify({
    source,
    verification,
    attachments,
  });
  const stmt = db.prepare(
    "INSERT INTO nodes (type, content, data, created_at, updated_at) VALUES ('statement', ?, ?, ?, ?)"
  );
  const result = stmt.run(content, data, now, now);
  const id = result.lastInsertRowid as number;
  return {
    id,
    type: "statement",
    content,
    source,
    verification,
    attachments,
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
  // Also populate warrant_grounds relationship table
  for (const gid of groundIds) {
    db.prepare("INSERT OR IGNORE INTO warrant_grounds (warrant_id, ground_id) VALUES (?, ?)").run(id, gid);
  }
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

/** 创建 Backing/Statement 节点 */
export function makeBacking(
  db: Database,
  warrantId: number,
  content: string = "Test backing",
  attachments: string[] = []
): StatementNode {
  const now = new Date().toISOString().slice(0, 19);
  const data = JSON.stringify({ attachments });
  const stmt = db.prepare(
    "INSERT INTO nodes (type, content, data, created_at, updated_at) VALUES ('statement', ?, ?, ?, ?)"
  );
  const result = stmt.run(content, data, now, now);
  const id = result.lastInsertRowid as number;
  // Link as backing via relationship table
  db.prepare("INSERT OR IGNORE INTO warrant_backings (warrant_id, statement_id) VALUES (?, ?)").run(warrantId, id);
  return {
    id,
    type: "statement",
    content,
    attachments,
    createdAt: now,
    updatedAt: now,
  };
}

/** 创建 Rebuttal/Statement 节点 */
export function makeRebuttal(
  db: Database,
  targetId: number,
  targetType: TargetType = "claim",
  content: string = "Test rebuttal",
  attachments: string[] = []
): StatementNode {
  const now = new Date().toISOString().slice(0, 19);
  const data = JSON.stringify({ attachments });
  const stmt = db.prepare(
    "INSERT INTO nodes (type, content, data, created_at, updated_at) VALUES ('statement', ?, ?, ?, ?)"
  );
  const result = stmt.run(content, data, now, now);
  const id = result.lastInsertRowid as number;
  // Link as rebuttal via relationship table
  db.prepare("INSERT OR IGNORE INTO rebuttal_targets (statement_id, target_id, target_type) VALUES (?, ?, ?)").run(id, targetId, targetType);
  return {
    id,
    type: "statement",
    content,
    attachments,
    createdAt: now,
    updatedAt: now,
  };
}

// =============================================================================
// 种子数据 — 创建完整的论证结构
// =============================================================================

export interface SeedResult {
  claim: ClaimNode;
  ground1: StatementNode;
  ground2: StatementNode;
  warrant: WarrantNode;
  backing: StatementNode;
}

/**
 * 创建一个完整的论证结构用于测试：
 * Claim(qualifier="仅在图像分类任务上验证") ← Warrant(ground1, ground2) ← Backing
 */
export function seedBasicArgument(db: Database): SeedResult {
  const claim = makeClaim(db, "核心主张：方法A优于方法B");
  // Set qualifier on the claim via repo
  const claimData = JSON.parse((db.prepare("SELECT data FROM nodes WHERE id = ?").get(claim.id) as { data: string }).data);
  claimData.qualifier = "仅在图像分类任务上验证";
  db.prepare("UPDATE nodes SET data = ? WHERE id = ?").run(JSON.stringify(claimData), claim.id);
  const updatedClaim = { ...claim } as any;
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
  return { claim: updatedClaim, ground1, ground2, warrant, backing };
}

// =============================================================================
// Compile / 自动验证辅助
// =============================================================================

/**
 * 创建一个已 compiled 的 Claim（含 compile_state 记录）。
 * 可选提供 argumentHash，否则使用 null。
 */
export function makeCompiledClaim(
  db: Database,
  content: string = "Compiled claim",
  argumentHash?: string
): ClaimNode {
  const claim = makeClaim(db, content);
  const now = new Date().toISOString().slice(0, 19);
  // Set compile_status = "passed" in data
  const data = JSON.parse((db.prepare("SELECT data FROM nodes WHERE id = ?").get(claim.id) as { data: string }).data);
  data.compile_status = "passed";
  db.prepare("UPDATE nodes SET data = ? WHERE id = ?").run(JSON.stringify(data), claim.id);
  // Save compile_state
  db.prepare(
    "INSERT OR REPLACE INTO compile_state (claim_id, verdict, summary, node_hashes, argument_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(claim.id, "passed", "Test compiled claim", "{}", argumentHash ?? null, now);
  return { ...claim, status: "proposed" };
}

/**
 * 创建链式推理结构：parentClaim ← Warrant ← Claim(subClaimId) 直接挂入 warrant_grounds
 * 返回创建的 Warrant。
 */
export function makeChainReasoning(
  db: Database,
  parentClaimId: number,
  subClaimId: number,
  warrantContent: string = "Chain reasoning warrant"
): { warrant: WarrantNode } {
  const warrant = makeWarrant(
    db,
    parentClaimId,
    [subClaimId],
    warrantContent
  );
  return { warrant };
}

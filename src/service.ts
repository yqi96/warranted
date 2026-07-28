/**
 * Warranted — Service 层
 *
 * 业务逻辑：参数校验、互斥模式检查、级联删除、类型检查。
 * 所有函数接收 Database 作为首参数。
 */

import type { Database } from "bun:sqlite";
import * as repo from "./repo.ts";
import type {
  NodeRow,
  ClaimNode,
  WarrantNode,
  StatementNode,
  ClaimData,
  ClaimStatus,
  GroundSource,
  VerificationStatus,
  TargetType,
  UpdateNodeParams,
  ArgumentResult,
  ClaimArgument,
  WarrantArgument,
  NodeArgument,
  ArgumentGround,
  ArgumentBacking,
  ArgumentWarrant,
  ArgumentRebuttal,
  Stats,
  ToulminNode,
} from "./types.ts";
import {
  NotFoundError,
  ValidationError,
  CascadeRequiredError,
  TypeMismatchError,
  StatusTransitionError,
} from "./errors.ts";
import { WARNINGS, HINTS } from "./content.ts";

// =============================================================================
// 辅助函数
// =============================================================================

/** 将 NodeRow 转换为具体类型的节点对象 */
function toClaimNode(row: NodeRow): ClaimNode {
  const data = JSON.parse(row.data);
  return {
    id: row.id,
    type: "claim",
    content: row.content,
    status: data.status || "proposed",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toWarrantNode(row: NodeRow): WarrantNode {
  const data = JSON.parse(row.data);
  return {
    id: row.id,
    type: "warrant",
    content: row.content,
    claimId: data.claim_id,
    groundIds: data.ground_ids || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStatementNode(row: NodeRow): StatementNode {
  const data = JSON.parse(row.data);
  return {
    id: row.id,
    type: "statement",
    content: row.content,
    source: data.source,
    verification: data.verification,
    attachments: data.attachments || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 根据 type 转换 NodeRow 为具体节点 */
function toNode(row: NodeRow): ToulminNode {
  switch (row.type) {
    case "claim": return toClaimNode(row);
    case "warrant": return toWarrantNode(row);
    case "statement": return toStatementNode(row);
    default: throw new ValidationError(`Unknown node type: ${row.type}`);
  }
}

function assertNodeExists(row: NodeRow | null, id: number): NodeRow {
  if (!row) throw new NotFoundError(id);
  return row;
}

function assertNodeType(row: NodeRow, expectedType: string): void {
  if (row.type !== expectedType) {
    throw new TypeMismatchError(row.id, expectedType, row.type);
  }
}

// =============================================================================
// 审查辅助函数
// =============================================================================

/** 查找引用某 Ground 的所有 Warrants */
export function findWarrantsUsingGround(db: Database, groundId: number): NodeRow[] {
  return db.prepare(
    "SELECT n.* FROM nodes n JOIN warrant_grounds wg ON n.id = wg.warrant_id WHERE wg.ground_id = ?"
  ).all(groundId) as NodeRow[];
}

/** 查找某 Warrant 的 Backings（via warrant_backings 关系表） */
function findAllBackingsByWarrant(db: Database, warrantId: number): NodeRow[] {
  return repo.findBackingsByWarrant(db, warrantId);
}

/** 查找指向目标的 Rebuttals（via rebuttal_targets 关系表） */
function findAllRebuttalsByTarget(db: Database, targetId: number, targetType?: string): NodeRow[] {
  return repo.findRebuttalsByTarget(db, targetId, targetType);
}

/** 检查 Claim 或其 Warrants 是否有 Rebuttal */
function hasRebuttals(db: Database, claimId: number): boolean {
  const claimRebuttals = findAllRebuttalsByTarget(db, claimId, "claim");
  if (claimRebuttals.length > 0) return true;
  const warrantRows = repo.findWarrantsByClaim(db, claimId);
  for (const w of warrantRows) {
    const warrantRebuttals = findAllRebuttalsByTarget(db, w.id, "warrant");
    if (warrantRebuttals.length > 0) return true;
  }
  return false;
}

/**
 * 检测 Warrant 是否形成完整的推理链（Claim → Warrant → Ground）。
 * 返回链路数据（供审查 agent 使用），或 null（链路不完整）。
 */
export function detectConnectedChain(
  db: Database,
  warrantId: number
): { claimId: number; warrantId: number; groundIds: number[] } | null {
  const wRow = repo.getNodeById(db, warrantId);
  if (!wRow || wRow.type !== "warrant") return null;

  const wData = JSON.parse(wRow.data);
  const claimId: number = wData.claim_id;

  // Use relationship table for ground IDs
  const groundRows = repo.findGroundsByWarrant(db, warrantId);
  const groundIds = groundRows.map(g => g.id);

  // 链路不完整：无 Ground 或无 Claim
  if (groundIds.length === 0 || !claimId) return null;

  const claimRow = repo.getNodeById(db, claimId);
  if (!claimRow || claimRow.type !== "claim") return null;

  // 验证所有 Ground 存在
  for (const gid of groundIds) {
    const gRow = repo.getNodeById(db, gid);
    if (!gRow || gRow.type !== "statement") return null;
  }

  return { claimId, warrantId, groundIds };
}

/** BFS cycle detection: check if adding claimId as ground of a warrant for targetClaimId creates a cycle */
function wouldCreateCycle(db: Database, groundClaimId: number, targetClaimId: number): boolean {
  const visited = new Set<number>();
  const queue = [groundClaimId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    if (current === targetClaimId) return true;
    // Find warrants for this claim, then find claim-type grounds of those warrants
    const warrants = repo.findWarrantsByClaim(db, current);
    for (const w of warrants) {
      const groundRows = db.prepare(
        "SELECT n.* FROM nodes n JOIN warrant_grounds wg ON n.id = wg.ground_id WHERE wg.warrant_id = ? AND n.type = 'claim'"
      ).all(w.id) as NodeRow[];
      for (const gRow of groundRows) {
        if (!visited.has(gRow.id)) queue.push(gRow.id);
      }
    }
  }
  return false;
}

// =============================================================================
// 创建操作
// =============================================================================

/** 创建 Claim */
export function createClaim(db: Database, content: string, qualifier?: string | null): ClaimNode {
  if (!content || !content.trim()) {
    throw new ValidationError("Claim content cannot be empty");
  }
  const data: ClaimData = { status: "proposed" };
  if (qualifier) data.qualifier = qualifier;
  const row = repo.insertNode(db, "claim", content.trim(), data);
  return toClaimNode(row);
}

/**
 * 创建 Statement 节点（通用）。可选立即挂载为 rebuttal。
 */
export function createStatement(
  db: Database,
  opts: {
    content: string;
    source: GroundSource;
    verification: VerificationStatus;
    attachments?: string[];
    rebuttal_for?: { target_id: number; target_type: TargetType };
  }
): StatementNode {
  const { content, source, verification, attachments, rebuttal_for } = opts;

  if (!content || !content.trim()) {
    throw new ValidationError("Statement content cannot be empty");
  }
  const validSources: string[] = ["literature", "observed", "hypothesis"];
  if (!validSources.includes(source)) {
    throw new ValidationError(`Invalid source: ${source}. Must be one of: ${validSources.join(", ")}`);
  }
  const validVerifications: string[] = ["verified", "pending"];
  if (!validVerifications.includes(verification)) {
    throw new ValidationError(`Invalid verification: ${verification}. Must be one of: ${validVerifications.join(", ")}`);
  }

  const row = repo.insertNode(db, "statement", content.trim(), {
    source,
    verification,
    attachments: attachments || [],
  });

  if (rebuttal_for) {
    const targetRow = assertNodeExists(repo.getNodeById(db, rebuttal_for.target_id), rebuttal_for.target_id);
    if (targetRow.type !== rebuttal_for.target_type) {
      throw new TypeMismatchError(rebuttal_for.target_id, rebuttal_for.target_type, targetRow.type);
    }
    repo.insertRebuttalTarget(db, row.id, rebuttal_for.target_id, rebuttal_for.target_type);
  }

  return toStatementNode(row);
}


/** 创建 Warrant */
export function createWarrant(
  db: Database,
  opts: {
    content: string;
    claimId: number;
    groundIds?: number[];
  }
): WarrantNode {
  const { content, claimId, groundIds } = opts;

  if (!content || !content.trim()) {
    throw new ValidationError("Warrant content cannot be empty");
  }

  // 校验 claimId
  const claimRow = assertNodeExists(repo.getNodeById(db, claimId), claimId);
  assertNodeType(claimRow, "claim");

  // 校验 groundIds：接受 statement 或 claim 类型
  const gIds = groundIds || [];
  for (const gid of gIds) {
    const groundRow = assertNodeExists(repo.getNodeById(db, gid), gid);
    if (groundRow.type !== "statement" && groundRow.type !== "claim") {
      throw new TypeMismatchError(gid, "statement", groundRow.type);
    }
  }

  // B1: Warrant 必须有至少一个 Ground
  if (gIds.length === 0) {
    throw new ValidationError("A Warrant must link at least one Ground. Provide ground_ids.");
  }

  // E1: 循环推理检测（仅对 claim-type grounds）
  for (const gid of gIds) {
    const gRow = repo.getNodeById(db, gid);
    if (!gRow || gRow.type !== "claim") continue;
    if (wouldCreateCycle(db, gRow.id, claimId)) {
      throw new ValidationError(
        `Circular chain reasoning detected: Claim #${claimId} would reference itself through Claim #${gid}.`
      );
    }
  }

  const row = repo.insertNode(db, "warrant", content.trim(), {
    claim_id: claimId,
    ground_ids: gIds,
  });
  // Also populate warrant_grounds relationship table
  for (const gid of gIds) {
    db.prepare("INSERT OR IGNORE INTO warrant_grounds (warrant_id, ground_id) VALUES (?, ?)").run(row.id, gid);
  }
  return toWarrantNode(row);
}

// =============================================================================
// 读取操作
// =============================================================================

/** 列出所有 Claim */
export function listClaims(db: Database, statusFilter?: string): ClaimNode[] {
  const rows = repo.listNodesByType(db, "claim");
  let claims = rows.map(toClaimNode);

  if (statusFilter) {
    const statuses = statusFilter.split(",").map(s => s.trim());
    claims = claims.filter(c => statuses.includes(c.status));
  }

  return claims;
}

/** 列出所有 Ground (statement 类型节点)，可按 source 和/或 verification 过滤 */
export function listStatements(db: Database, sourceFilter?: string, verificationFilter?: string): StatementNode[] {
  const rows = repo.listNodesByType(db, "statement");
  let grounds = rows.map(toStatementNode);

  if (sourceFilter) {
    const sources = sourceFilter.split(",").map(s => s.trim());
    grounds = grounds.filter(g => g.source !== undefined && sources.includes(g.source));
  }
  if (verificationFilter) {
    const statuses = verificationFilter.split(",").map(s => s.trim());
    grounds = grounds.filter(g => g.verification !== undefined && statuses.includes(g.verification));
  }

  return grounds;
}

/** 获取节点的完整论证子图 */
export function getArgument(db: Database, nodeId: number): ArgumentResult {
  const row = assertNodeExists(repo.getNodeById(db, nodeId), nodeId);

  switch (row.type) {
    case "claim":
      return getClaimArgument(db, row);
    case "warrant":
      return getWarrantArgument(db, row);
    default:
      return getNodeArgument(db, row);
  }
}

function getClaimArgument(db: Database, claimRow: NodeRow): ClaimArgument {
  const claim = toClaimNode(claimRow);

  // Qualifier (now a Claim attribute)
  const claimData = JSON.parse(claimRow.data);
  const qualifier = claimData.qualifier || null;

  // Warrants + their Grounds and Backings
  const warrantRows = repo.findWarrantsByClaim(db, claim.id);
  const warrants: ArgumentWarrant[] = warrantRows.map(w => {
    const groundRows = repo.findGroundsByWarrant(db, w.id);

    const grounds: ArgumentGround[] = groundRows
      .filter((g): g is NodeRow => g !== null && (g.type === "statement" || g.type === "claim"))
      .map(g => {
        const gData = JSON.parse(g.data);
        return {
          id: g.id,
          content: g.content,
          attachments: gData.attachments || [],
          source: gData.source,
          verification: gData.verification,
        };
      });

    const backingRows = findAllBackingsByWarrant(db, w.id);
    const backings: ArgumentBacking[] = backingRows.map(b => ({
      id: b.id,
      content: b.content,
      attachments: JSON.parse(b.data).attachments || [],
    }));

    return { id: w.id, content: w.content, grounds, backings };
  });

  // Rebuttals targeting this claim or its warrants
  const claimRebuttals = findAllRebuttalsByTarget(db, claim.id, "claim");
  const warrantIds = warrantRows.map(w => w.id);
  const warrantRebuttals = warrantIds.flatMap(wid => findAllRebuttalsByTarget(db, wid, "warrant"));
  const allRebuttals = [...claimRebuttals, ...warrantRebuttals];

  const rebuttals: ArgumentRebuttal[] = allRebuttals.map(r => {
    const rData = JSON.parse(r.data);
    // For statement nodes, target_type is in rebuttal_targets table, not data JSON
    let targetType = rData.target_type;
    if (!targetType) {
      const rtRow = db.prepare(
        "SELECT target_type FROM rebuttal_targets WHERE statement_id = ?"
      ).get(r.id) as { target_type: string } | null;
      targetType = rtRow?.target_type;
    }
    return {
      id: r.id,
      target_type: targetType,
      content: r.content,
      attachments: rData.attachments || [],
    };
  });

  return { claim: { ...claim, qualifier, compile_status: claimData.compile_status ?? null }, warrants, rebuttals } as ClaimArgument;
}

function getWarrantArgument(db: Database, warrantRow: NodeRow): WarrantArgument {
  const wData = JSON.parse(warrantRow.data);
  const groundRows = repo.findGroundsByWarrant(db, warrantRow.id);

  const grounds: ArgumentGround[] = groundRows
    .filter((g): g is NodeRow => g !== null && (g.type === "statement" || g.type === "claim"))
    .map(g => {
      const gData = JSON.parse(g.data);
      return {
        id: g.id,
        content: g.content,
        attachments: gData.attachments || [],
        source: gData.source,
        verification: gData.verification,
      };
    });

  const backingRows = findAllBackingsByWarrant(db, warrantRow.id);
  const backings: ArgumentBacking[] = backingRows.map(b => ({
    id: b.id,
    content: b.content,
    attachments: JSON.parse(b.data).attachments || [],
  }));

  const rebuttalRows = findAllRebuttalsByTarget(db, warrantRow.id, "warrant");
  const rebuttals: ArgumentRebuttal[] = rebuttalRows.map(r => {
    const rData = JSON.parse(r.data);
    let targetType = rData.target_type;
    if (!targetType) {
      const rtRow = db.prepare(
        "SELECT target_type FROM rebuttal_targets WHERE statement_id = ?"
      ).get(r.id) as { target_type: string } | null;
      targetType = rtRow?.target_type;
    }
    return {
      id: r.id,
      target_type: targetType,
      content: r.content,
      attachments: rData.attachments || [],
    };
  });

  return {
    warrant: { id: warrantRow.id, content: warrantRow.content, claim_id: wData.claim_id },
    grounds,
    backings,
    rebuttals,
  };
}

function getNodeArgument(db: Database, row: NodeRow): NodeArgument {
  const data = JSON.parse(row.data);

  const result: NodeArgument = {
    node: {
      id: row.id,
      type: row.type as any,
      content: row.content,
    },
  };

  // Add type-specific fields
  if (row.type === "statement") {
    result.node.attachments = data.attachments || [];
    result.node.source = data.source;
    result.node.verification = data.verification;

    // Find warrants that use this statement as a ground (via warrant_grounds)
    const usingWarrantRows = db.prepare(
      "SELECT n.* FROM nodes n JOIN warrant_grounds wg ON n.id = wg.warrant_id WHERE wg.ground_id = ?"
    ).all(row.id) as NodeRow[];
    result.used_in_warrants = usingWarrantRows.map(w => {
        const wData = JSON.parse(w.data);
        const claimRow = repo.getNodeById(db, wData.claim_id);
        return {
          warrant_id: w.id,
          claim_id: wData.claim_id,
          claim_content: claimRow?.content || "",
        };
      });
  }

  // Rebuttals targeting this node
  const rebuttalRows = findAllRebuttalsByTarget(db, row.id);
  if (rebuttalRows.length > 0) {
    result.rebuttals = rebuttalRows.map(r => {
      const rData = JSON.parse(r.data);
      let targetType = rData.target_type;
      if (!targetType) {
        const rtRow = db.prepare(
          "SELECT target_type FROM rebuttal_targets WHERE statement_id = ?"
        ).get(r.id) as { target_type: string } | null;
        targetType = rtRow?.target_type;
      }
      return {
        id: r.id,
        target_type: targetType,
        content: r.content,
        attachments: rData.attachments || [],
      };
    });
  }

  return result;
}

/** 搜索节点 */
export function searchNodesService(
  db: Database,
  keyword: string,
  typeFilter?: string
): ToulminNode[] {
  const like = `%${keyword}%`;

  // Virtual role filters: query relationship tables then intersect with keyword
  if (typeFilter === "ground") {
    const rows = db.prepare(
      "SELECT n.* FROM nodes n JOIN warrant_grounds wg ON wg.ground_id = n.id WHERE n.content LIKE ? ORDER BY n.id"
    ).all(like) as NodeRow[];
    return rows.map(toNode);
  }
  if (typeFilter === "backing") {
    const rows = db.prepare(
      "SELECT n.* FROM nodes n JOIN warrant_backings wb ON wb.statement_id = n.id WHERE n.content LIKE ? ORDER BY n.id"
    ).all(like) as NodeRow[];
    return rows.map(toNode);
  }
  if (typeFilter === "rebuttal") {
    const rows = db.prepare(
      "SELECT n.* FROM nodes n JOIN rebuttal_targets rt ON rt.statement_id = n.id WHERE n.content LIKE ? ORDER BY n.id"
    ).all(like) as NodeRow[];
    return rows.map(toNode);
  }

  const rows = repo.searchNodes(db, keyword, typeFilter as any);
  return rows.map(toNode);
}

/** 获取全局统计 */
export function getStats(db: Database): Stats {
  const counts = repo.countNodesByType(db);

  // Claims by status and stale count
  const claimRows = repo.listNodesByType(db, "claim");
  const byStatus: Record<string, number> = {};
  let staleCount = 0;
  for (const row of claimRows) {
    const data = JSON.parse(row.data);
    const status = data.status || "proposed";
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (data.compile_status === "stale") staleCount++;
  }

  // Grounds: all statement nodes that are used as grounds (in warrant_grounds) or have source field
  const groundIds = new Set<number>(
    (db.prepare("SELECT ground_id FROM warrant_grounds").all() as Array<{ ground_id: number }>)
      .map(r => r.ground_id)
  );
  const statementRows = repo.listNodesByType(db, "statement");
  const groundStatementRows = statementRows.filter(r => {
    const d = JSON.parse(r.data);
    return d.source !== undefined || groundIds.has(r.id);
  });

  const bySource: Record<string, number> = {};
  const byVerification: Record<string, number> = {};
  for (const row of groundStatementRows) {
    const data = JSON.parse(row.data);
    const source = data.source || "unknown";
    const verification = data.verification || "unknown";
    bySource[source] = (bySource[source] || 0) + 1;
    byVerification[verification] = (byVerification[verification] || 0) + 1;
  }

  // Rebuttals by target_type (via rebuttal_targets)
  const rebuttalRows = (db.prepare(
    "SELECT rt.target_type FROM rebuttal_targets rt"
  ).all() as Array<{ target_type: string }>);

  const byTargetType: Record<string, number> = {};
  for (const row of rebuttalRows) {
    const targetType = row.target_type || "unknown";
    byTargetType[targetType] = (byTargetType[targetType] || 0) + 1;
  }

  // Backings: statement nodes in warrant_backings
  const backingStatementCount = (db.prepare("SELECT COUNT(*) as cnt FROM warrant_backings").get() as { cnt: number }).cnt;
  // Rebuttals: statement nodes in rebuttal_targets
  const rebuttalStatementCount = (db.prepare("SELECT COUNT(*) as cnt FROM rebuttal_targets").get() as { cnt: number }).cnt;

  return {
    claims: { total: counts.claim, by_status: byStatus, stale_count: staleCount > 0 ? staleCount : undefined },
    grounds: { total: groundStatementRows.length, by_source: bySource, by_verification: byVerification },
    warrants: { total: counts.warrant },
    backings: { total: backingStatementCount },
    qualifiers: { total: 0 },
    rebuttals: { total: rebuttalStatementCount, by_target_type: byTargetType },
  };
}

// =============================================================================
// 修改操作
// =============================================================================

/** 更新节点，返回节点和警告 */
export function updateNode(
  db: Database,
  nodeId: number,
  params: UpdateNodeParams
): { node: ToulminNode; warnings: string[] } {
  const row = assertNodeExists(repo.getNodeById(db, nodeId), nodeId);
  const data = JSON.parse(row.data);
  const warnings: string[] = [];

  // 更新 content
  if (params.content !== undefined) {
    data.content = params.content;
    // G_CONTENT: verified ground 内容变更 → 退回 pending
    if (row.type === "statement" && data.verification === "verified") {
      data.verification = "pending";
      warnings.push(HINTS.groundVerificationReverted(nodeId));
    }
  }

  // 更新 attachments（Ground/Backing/Rebuttal）
  if (params.attachments !== undefined) {
    if (row.type === "claim" || row.type === "warrant") {
      throw new ValidationError(`${row.type} nodes do not have attachments`);
    }
    data.attachments = params.attachments;
  }

  // 更新 status（Claim only）
  if (params.status !== undefined) {
    if (row.type !== "claim") {
      throw new ValidationError("Only Claim nodes have status");
    }
    const validStatuses = ["proposed", "supported", "disputed", "refuted"];
    if (!validStatuses.includes(params.status)) {
      throw new ValidationError(`Invalid status: ${params.status}`);
    }

    // A0: →supported/disputed/refuted 必须已通过 compile
    if (params.status === "supported" || params.status === "disputed" || params.status === "refuted") {
      if (data.compile_status !== "passed") {
        throw new StatusTransitionError(
          `Cannot mark Claim #${nodeId} as "${params.status}": argument has not been compiled or is stale. Run compile_arguments first.`
        );
      }
    }

    // A1: →supported 需至少一个 Warrant 且其 Grounds 全部 verified
    if (params.status === "supported") {
      const warrants = repo.findWarrantsByClaim(db, nodeId);
      if (warrants.length === 0) {
        throw new StatusTransitionError(
          `Cannot mark Claim #${nodeId} as "supported": Claim has no Warrants. Create a Warrant with verified Grounds first.`
        );
      }
      let hasValidWarrant = false;
      for (const w of warrants) {
        const groundRows = repo.findGroundsByWarrant(db, w.id);
        if (groundRows.length === 0) continue;
        const allVerified = groundRows.every(gRow => {
          const gData = JSON.parse(gRow.data);
          return gData.verification === "verified";
        });
        if (allVerified) hasValidWarrant = true;
      }
      if (!hasValidWarrant) {
        throw new StatusTransitionError(
          `Cannot mark Claim #${nodeId} as "supported": no Warrant has all Grounds verified. Verify the Grounds first.`
        );
      }
    }

    // A3: →disputed 需存在 Rebuttal
    if (params.status === "disputed") {
      if (!hasRebuttals(db, nodeId)) {
        throw new StatusTransitionError(
          `Cannot mark Claim #${nodeId} as "disputed": no Rebuttals exist targeting this Claim or its Warrants. Create a Rebuttal first.`
        );
      }
    }

    // A4: →refuted 需存在 Rebuttal
    if (params.status === "refuted") {
      if (!hasRebuttals(db, nodeId)) {
        throw new StatusTransitionError(
          `Cannot mark Claim #${nodeId} as "refuted": no Rebuttals exist to justify refutation.`
        );
      }
    }

    data.status = params.status;
  }

  // 更新 source（Ground/Statement only）
  if (params.source !== undefined) {
    if (row.type !== "statement") {
      throw new ValidationError("Only Ground nodes have source");
    }
    data.source = params.source;
  }

  // 更新 verification（Ground/Statement only）
  if (params.verification !== undefined) {
    if (row.type !== "statement") {
      throw new ValidationError("Only Ground nodes have verification");
    }
    const prevVerification = data.verification;
    data.verification = params.verification;

    // H1: verified Ground 必须有 attachments
    if (params.verification === "verified") {
      const finalAttachments = data.attachments || [];
      if (finalAttachments.length === 0) {
        throw new ValidationError(
          `Cannot mark Ground #${nodeId} as "verified": verified Grounds must have attachments. Provide scripts, logs, or other evidence files via the attachments parameter.`
        );
      }
    }

    // H2: verified → 非 verified 时警告
    if (prevVerification === "verified" && params.verification !== "verified") {
      const usingWarrants = findWarrantsUsingGround(db, nodeId);
      if (usingWarrants.length > 0) {
        const wids = usingWarrants.map(w => `#${w.id}`).join(", ");
        warnings.push(WARNINGS.revertGroundVerification(nodeId, wids));
      }
    }
  }

  // 更新 ground_ids（Warrant only）
  if (params.ground_ids !== undefined) {
    if (row.type !== "warrant") {
      throw new ValidationError("Only Warrant nodes have ground_ids");
    }
    const currentIds: number[] = data.ground_ids || [];

    if (params.ground_ids.add) {
      // 校验要添加的 ground 存在且是 statement 或 claim 类型
      for (const gid of params.ground_ids.add) {
        const gRow = repo.getNodeById(db, gid);
        if (!gRow) throw new NotFoundError(gid);
        if (gRow.type !== "statement" && gRow.type !== "claim") throw new TypeMismatchError(gid, "statement", gRow.type);
      }
      data.ground_ids = [...new Set([...currentIds, ...params.ground_ids.add])];
      // Sync warrant_grounds
      for (const gid of params.ground_ids.add) {
        db.prepare("INSERT OR IGNORE INTO warrant_grounds (warrant_id, ground_id) VALUES (?, ?)").run(nodeId, gid);
      }
    }

    if (params.ground_ids.remove) {
      const removeIds = params.ground_ids.remove;
      const remaining = currentIds.filter((id: number) => !removeIds.includes(id));
      // B3: 不能清空 Warrant 的所有 Grounds
      if (remaining.length === 0) {
        throw new ValidationError(
          `Cannot remove all Grounds from Warrant #${nodeId}. A Warrant must have at least one Ground.`
        );
      }
      data.ground_ids = remaining;
      // Sync warrant_grounds
      for (const gid of removeIds) {
        db.prepare("DELETE FROM warrant_grounds WHERE warrant_id = ? AND ground_id = ?").run(nodeId, gid);
      }
    }
  }

  // 更新 backing_ids（Warrant only）
  if (params.backing_ids !== undefined) {
    if (row.type !== "warrant") {
      throw new ValidationError("Only Warrant nodes support backing_ids");
    }
    if (params.backing_ids.add) {
      for (const bid of params.backing_ids.add) {
        const bRow = repo.getNodeById(db, bid);
        if (!bRow) throw new NotFoundError(bid);
        if (bRow.type !== "statement") throw new TypeMismatchError(bid, "statement", bRow.type);
      }
      repo.addWarrantBackings(db, nodeId, params.backing_ids.add);
    }
    if (params.backing_ids.remove) {
      repo.removeWarrantBackings(db, nodeId, params.backing_ids.remove);
    }
  }

  // 更新 rebuttal_ids（Claim or Warrant）
  if (params.rebuttal_ids !== undefined) {
    if (row.type !== "claim" && row.type !== "warrant") {
      throw new ValidationError("Only Claim and Warrant nodes support rebuttal_ids");
    }
    if (params.rebuttal_ids.add) {
      for (const rid of params.rebuttal_ids.add) {
        const rRow = repo.getNodeById(db, rid);
        if (!rRow) throw new NotFoundError(rid);
        if (rRow.type !== "statement") throw new TypeMismatchError(rid, "statement", rRow.type);
        repo.insertRebuttalTarget(db, rid, nodeId, row.type);
      }
    }
    if (params.rebuttal_ids.remove) {
      for (const rid of params.rebuttal_ids.remove) {
        repo.deleteRebuttalTarget(db, rid, nodeId);
      }
    }
  }

  // 更新 qualifier（Claim only）
  if (params.qualifier !== undefined) {
    if (row.type !== "claim") {
      throw new ValidationError("Only Claim nodes have qualifier");
    }
    data.qualifier = params.qualifier;
  }

  // 执行更新
  const content = params.content !== undefined ? params.content : row.content;
  const updated = repo.updateNodeFields(db, nodeId, { content, data });
  return { node: toNode(assertNodeExists(updated, nodeId)), warnings };
}

// =============================================================================
// 删除操作
// =============================================================================

/** 删除节点，返回警告信息数组 */
export function deleteNode(
  db: Database,
  nodeId: number,
  cascade: boolean = false
): string[] {
  return db.transaction((): string[] => {
  const row = assertNodeExists(repo.getNodeById(db, nodeId), nodeId);
  const warnings: string[] = [];

  switch (row.type) {
    case "claim": {
      if (!cascade) {
        throw new CascadeRequiredError();
      }
      // 删除绑定的 Warrants（及其 Backings）
      const warrants = repo.findWarrantsByClaim(db, nodeId);
      for (const w of warrants) {
        const backings = findAllBackingsByWarrant(db, w.id);
        for (const b of backings) {
          repo.deleteNodeById(db, b.id);
        }
        const warrantRebuttals = findAllRebuttalsByTarget(db, w.id, "warrant");
        for (const r of warrantRebuttals) {
          repo.deleteNodeById(db, r.id);
        }
        repo.deleteNodeById(db, w.id);
      }
      // 删除指向 Claim 的 Rebuttals
      const rebuttals = findAllRebuttalsByTarget(db, nodeId, "claim");
      for (const r of rebuttals) {
        repo.deleteNodeById(db, r.id);
      }
      // 删除 Claim 本身（ON DELETE CASCADE 会自动清理 warrant_grounds）
      repo.deleteNodeById(db, nodeId);
      break;
    }

    case "ground":
    case "statement": {
      // D1 警告: 检查是否被 Warrant 引用
      const usingWarrants = findWarrantsUsingGround(db, nodeId);
      if (usingWarrants.length > 0) {
        const wids = usingWarrants.map(w => `#${w.id}`).join(", ");
        warnings.push(WARNINGS.deleteGroundReferencedByWarrant(nodeId, wids));
      }
      // 从所有 Warrant 的 ground_ids 中移除
      repo.removeGroundFromAllWarrants(db, nodeId);
      // 删除指向该 Ground 的 Rebuttals
      const rebuttals = findAllRebuttalsByTarget(db, nodeId);
      for (const r of rebuttals) {
        repo.deleteNodeById(db, r.id);
      }
      repo.deleteNodeById(db, nodeId);
      break;
    }

    case "warrant": {
      // D3 警告: 检查 Claim 是否非 proposed
      const wData = JSON.parse(row.data);
      const claimId = wData.claim_id;
      const claimRow = repo.getNodeById(db, claimId);
      if (claimRow) {
        const claimData = JSON.parse(claimRow.data);
        const claimStatus = claimData.status || "proposed";
        if (claimStatus !== "proposed") {
          warnings.push(WARNINGS.deleteWarrantSupportingClaim(nodeId, claimId, claimStatus));
        }
      }
      // 级联删除 Backings
      const backings = findAllBackingsByWarrant(db, nodeId);
      for (const b of backings) {
        repo.deleteNodeById(db, b.id);
      }
      // 删除指向该 Warrant 的 Rebuttals
      const warrantRebuttals = findAllRebuttalsByTarget(db, nodeId, "warrant");
      for (const r of warrantRebuttals) {
        repo.deleteNodeById(db, r.id);
      }
      repo.deleteNodeById(db, nodeId);
      break;
    }

    default:
      throw new ValidationError(`Unknown node type: ${row.type}`);
  }

  return warnings;
  })();
}

/**
 * Toulmin MCP — Service 层
 *
 * 业务逻辑：参数校验、互斥模式检查、级联删除、类型检查。
 * 所有函数接收 Database 作为首参数。
 */

import type { Database } from "bun:sqlite";
import * as repo from "./repo.ts";
import type {
  NodeRow,
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
  MutuallyExclusiveModeError,
} from "./errors.ts";

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

function toGroundNode(row: NodeRow): GroundNode {
  const data = JSON.parse(row.data);
  return {
    id: row.id,
    type: "ground",
    content: row.content,
    source: data.source,
    verification: data.verification,
    attachments: data.attachments || [],
    refClaimId: data.ref_claim_id ?? null,
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

function toBackingNode(row: NodeRow): BackingNode {
  const data = JSON.parse(row.data);
  return {
    id: row.id,
    type: "backing",
    content: row.content,
    attachments: data.attachments || [],
    warrantId: data.warrant_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toQualifierNode(row: NodeRow): QualifierNode {
  const data = JSON.parse(row.data);
  return {
    id: row.id,
    type: "qualifier",
    content: row.content,
    attachments: data.attachments || [],
    claimId: data.claim_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRebuttalNode(row: NodeRow): RebuttalNode {
  const data = JSON.parse(row.data);
  return {
    id: row.id,
    type: "rebuttal",
    content: row.content,
    attachments: data.attachments || [],
    targetId: data.target_id,
    targetType: data.target_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 根据 type 转换 NodeRow 为具体节点 */
function toNode(row: NodeRow): ToulminNode {
  switch (row.type) {
    case "claim": return toClaimNode(row);
    case "ground": return toGroundNode(row);
    case "warrant": return toWarrantNode(row);
    case "backing": return toBackingNode(row);
    case "qualifier": return toQualifierNode(row);
    case "rebuttal": return toRebuttalNode(row);
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
// 创建操作
// =============================================================================

/** 创建 Claim */
export function createClaim(db: Database, content: string): ClaimNode {
  if (!content || !content.trim()) {
    throw new ValidationError("Claim content cannot be empty");
  }
  const row = repo.insertNode(db, "claim", content.trim(), { status: "proposed" });
  return toClaimNode(row);
}

/**
 * 创建 Ground。两种模式互斥：
 * - Mode A（普通证据）：source + verification + attachments
 * - Mode B（链式推理）：refClaimId
 */
export function createGround(
  db: Database,
  opts: {
    content?: string;
    source?: GroundSource;
    verification?: VerificationStatus;
    attachments?: string[];
    refClaimId?: number | null;
  }
): GroundNode {
  const { content, source, verification, attachments, refClaimId } = opts;

  // 互斥模式检查
  const hasModeB = refClaimId !== undefined && refClaimId !== null;
  const hasModeA = source !== undefined || verification !== undefined;

  if (hasModeB && hasModeA) {
    throw new MutuallyExclusiveModeError();
  }

  if (hasModeB) {
    // Mode B: 链式推理
    const claimRow = assertNodeExists(repo.getNodeById(db, refClaimId!), refClaimId!);
    assertNodeType(claimRow, "claim");

    const row = repo.insertNode(db, "ground", `Reference to Claim #${refClaimId}`, {
      source: "hypothesis",
      verification: "pending",
      attachments: [],
      ref_claim_id: refClaimId,
    });
    return toGroundNode(row);
  }

  // Mode A: 普通证据
  if (!source) {
    throw new ValidationError("Ground source is required for Mode A");
  }
  if (!verification) {
    throw new ValidationError("Ground verification is required for Mode A");
  }
  const validSources = ["literature", "observed", "hypothesis"];
  if (!validSources.includes(source)) {
    throw new ValidationError(`Invalid ground source: ${source}. Must be one of: ${validSources.join(", ")}`);
  }
  const validVerifications = ["verified", "pending"];
  if (!validVerifications.includes(verification)) {
    throw new ValidationError(`Invalid verification: ${verification}. Must be one of: ${validVerifications.join(", ")}`);
  }

  const row = repo.insertNode(db, "ground", content || "", {
    source,
    verification,
    attachments: attachments || [],
    ref_claim_id: null,
  });
  return toGroundNode(row);
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

  // 校验 groundIds
  const gIds = groundIds || [];
  for (const gid of gIds) {
    const groundRow = assertNodeExists(repo.getNodeById(db, gid), gid);
    assertNodeType(groundRow, "ground");
  }

  const row = repo.insertNode(db, "warrant", content.trim(), {
    claim_id: claimId,
    ground_ids: gIds,
  });
  return toWarrantNode(row);
}

/** 创建 Backing */
export function createBacking(
  db: Database,
  opts: {
    content: string;
    warrantId: number;
    attachments?: string[];
  }
): BackingNode {
  const { content, warrantId, attachments } = opts;

  if (!content || !content.trim()) {
    throw new ValidationError("Backing content cannot be empty");
  }

  const warrantRow = assertNodeExists(repo.getNodeById(db, warrantId), warrantId);
  assertNodeType(warrantRow, "warrant");

  const row = repo.insertNode(db, "backing", content.trim(), {
    attachments: attachments || [],
    warrant_id: warrantId,
  });
  return toBackingNode(row);
}

/** 创建 Qualifier */
export function createQualifier(
  db: Database,
  opts: {
    content: string;
    claimId: number;
    attachments?: string[];
  }
): QualifierNode {
  const { content, claimId, attachments } = opts;

  if (!content || !content.trim()) {
    throw new ValidationError("Qualifier content cannot be empty");
  }

  const claimRow = assertNodeExists(repo.getNodeById(db, claimId), claimId);
  assertNodeType(claimRow, "claim");

  const row = repo.insertNode(db, "qualifier", content.trim(), {
    attachments: attachments || [],
    claim_id: claimId,
  });
  return toQualifierNode(row);
}

/** 创建 Rebuttal */
export function createRebuttal(
  db: Database,
  opts: {
    content: string;
    targetId: number;
    targetType: TargetType;
    attachments?: string[];
  }
): RebuttalNode {
  const { content, targetId, targetType, attachments } = opts;

  if (!content || !content.trim()) {
    throw new ValidationError("Rebuttal content cannot be empty");
  }

  const targetRow = assertNodeExists(repo.getNodeById(db, targetId), targetId);
  if (targetRow.type !== targetType) {
    throw new TypeMismatchError(targetId, targetType, targetRow.type);
  }

  const row = repo.insertNode(db, "rebuttal", content.trim(), {
    attachments: attachments || [],
    target_id: targetId,
    target_type: targetType,
  });
  return toRebuttalNode(row);
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

  // Qualifier
  const qualifierRows = repo.findQualifiersByClaim(db, claim.id);
  const qualifier = qualifierRows.length > 0
    ? { id: qualifierRows[0].id, content: qualifierRows[0].content, attachments: JSON.parse(qualifierRows[0].data).attachments || [] }
    : null;

  // Warrants + their Grounds and Backings
  const warrantRows = repo.findWarrantsByClaim(db, claim.id);
  const warrants: ArgumentWarrant[] = warrantRows.map(w => {
    const wData = JSON.parse(w.data);
    const groundIds: number[] = wData.ground_ids || [];

    const grounds: ArgumentGround[] = groundIds
      .map(gid => repo.getNodeById(db, gid))
      .filter((g): g is NodeRow => g !== null && g.type === "ground")
      .map(g => {
        const gData = JSON.parse(g.data);
        return {
          id: g.id,
          content: g.content,
          attachments: gData.attachments || [],
          source: gData.source,
          verification: gData.verification,
          ref_claim_id: gData.ref_claim_id ?? null,
        };
      });

    const backingRows = repo.findBackingsByWarrant(db, w.id);
    const backings: ArgumentBacking[] = backingRows.map(b => ({
      id: b.id,
      content: b.content,
      attachments: JSON.parse(b.data).attachments || [],
    }));

    return { id: w.id, content: w.content, grounds, backings };
  });

  // Rebuttals targeting this claim or its warrants
  const claimRebuttals = repo.findRebuttalsByTarget(db, claim.id, "claim");
  const warrantIds = warrantRows.map(w => w.id);
  const warrantRebuttals = warrantIds.flatMap(wid => repo.findRebuttalsByTarget(db, wid, "warrant"));
  const allRebuttals = [...claimRebuttals, ...warrantRebuttals];

  const rebuttals: ArgumentRebuttal[] = allRebuttals.map(r => {
    const rData = JSON.parse(r.data);
    return {
      id: r.id,
      target_type: rData.target_type,
      content: r.content,
      attachments: rData.attachments || [],
    };
  });

  return { claim: { ...claim, qualifier }, warrants, rebuttals };
}

function getWarrantArgument(db: Database, warrantRow: NodeRow): WarrantArgument {
  const wData = JSON.parse(warrantRow.data);
  const groundIds: number[] = wData.ground_ids || [];

  const grounds: ArgumentGround[] = groundIds
    .map(gid => repo.getNodeById(db, gid))
    .filter((g): g is NodeRow => g !== null && g.type === "ground")
    .map(g => {
      const gData = JSON.parse(g.data);
      return {
        id: g.id,
        content: g.content,
        attachments: gData.attachments || [],
        source: gData.source,
        verification: gData.verification,
        ref_claim_id: gData.ref_claim_id ?? null,
      };
    });

  const backingRows = repo.findBackingsByWarrant(db, warrantRow.id);
  const backings: ArgumentBacking[] = backingRows.map(b => ({
    id: b.id,
    content: b.content,
    attachments: JSON.parse(b.data).attachments || [],
  }));

  const rebuttalRows = repo.findRebuttalsByTarget(db, warrantRow.id, "warrant");
  const rebuttals: ArgumentRebuttal[] = rebuttalRows.map(r => ({
    id: r.id,
    target_type: JSON.parse(r.data).target_type,
    content: r.content,
    attachments: JSON.parse(r.data).attachments || [],
  }));

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
  if (row.type === "ground") {
    result.node.attachments = data.attachments || [];
    result.node.source = data.source;
    result.node.verification = data.verification;
    result.node.ref_claim_id = data.ref_claim_id ?? null;

    // Find warrants that use this ground
    const allWarrants = repo.listNodesByType(db, "warrant");
    result.used_in_warrants = allWarrants
      .filter(w => {
        const wData = JSON.parse(w.data);
        return (wData.ground_ids || []).includes(row.id);
      })
      .map(w => {
        const wData = JSON.parse(w.data);
        const claimRow = repo.getNodeById(db, wData.claim_id);
        return {
          warrant_id: w.id,
          claim_id: wData.claim_id,
          claim_content: claimRow?.content || "",
        };
      });
  } else if (row.type === "backing" || row.type === "qualifier" || row.type === "rebuttal") {
    result.node.attachments = data.attachments || [];
  }

  // Rebuttals targeting this node
  const rebuttalRows = repo.findRebuttalsByTarget(db, row.id);
  if (rebuttalRows.length > 0) {
    result.rebuttals = rebuttalRows.map(r => ({
      id: r.id,
      target_type: JSON.parse(r.data).target_type,
      content: r.content,
      attachments: JSON.parse(r.data).attachments || [],
    }));
  }

  return result;
}

/** 搜索节点 */
export function searchNodesService(
  db: Database,
  keyword: string,
  typeFilter?: string
): ToulminNode[] {
  const rows = repo.searchNodes(db, keyword, typeFilter as any);
  return rows.map(toNode);
}

/** 获取全局统计 */
export function getStats(db: Database): Stats {
  const counts = repo.countNodesByType(db);

  // Claims by status
  const claimRows = repo.listNodesByType(db, "claim");
  const byStatus: Record<string, number> = {};
  for (const row of claimRows) {
    const data = JSON.parse(row.data);
    const status = data.status || "proposed";
    byStatus[status] = (byStatus[status] || 0) + 1;
  }

  // Grounds by source and verification
  const groundRows = repo.listNodesByType(db, "ground");
  const bySource: Record<string, number> = {};
  const byVerification: Record<string, number> = {};
  for (const row of groundRows) {
    const data = JSON.parse(row.data);
    const source = data.source || "unknown";
    const verification = data.verification || "unknown";
    bySource[source] = (bySource[source] || 0) + 1;
    byVerification[verification] = (byVerification[verification] || 0) + 1;
  }

  // Rebuttals by target_type
  const rebuttalRows = repo.listNodesByType(db, "rebuttal");
  const byTargetType: Record<string, number> = {};
  for (const row of rebuttalRows) {
    const data = JSON.parse(row.data);
    const targetType = data.target_type || "unknown";
    byTargetType[targetType] = (byTargetType[targetType] || 0) + 1;
  }

  return {
    claims: { total: counts.claim, by_status: byStatus },
    grounds: { total: counts.ground, by_source: bySource, by_verification: byVerification },
    warrants: { total: counts.warrant },
    backings: { total: counts.backing },
    qualifiers: { total: counts.qualifier },
    rebuttals: { total: counts.rebuttal, by_target_type: byTargetType },
  };
}

// =============================================================================
// 修改操作
// =============================================================================

/** 更新节点 */
export function updateNode(
  db: Database,
  nodeId: number,
  params: UpdateNodeParams
): ToulminNode {
  const row = assertNodeExists(repo.getNodeById(db, nodeId), nodeId);
  const data = JSON.parse(row.data);

  // 更新 content
  if (params.content !== undefined) {
    data.content = params.content;
  }

  // 更新 attachments（Ground/Backing/Qualifier/Rebuttal）
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
    const validStatuses = ["proposed", "supported", "validated", "disputed", "refuted"];
    if (!validStatuses.includes(params.status)) {
      throw new ValidationError(`Invalid status: ${params.status}`);
    }
    data.status = params.status;
  }

  // 更新 source（Ground only）
  if (params.source !== undefined) {
    if (row.type !== "ground") {
      throw new ValidationError("Only Ground nodes have source");
    }
    data.source = params.source;
  }

  // 更新 verification（Ground only）
  if (params.verification !== undefined) {
    if (row.type !== "ground") {
      throw new ValidationError("Only Ground nodes have verification");
    }
    data.verification = params.verification;
  }

  // 更新 ground_ids（Warrant only）
  if (params.ground_ids !== undefined) {
    if (row.type !== "warrant") {
      throw new ValidationError("Only Warrant nodes have ground_ids");
    }
    const currentIds: number[] = data.ground_ids || [];

    if (params.ground_ids.add) {
      // 校验要添加的 ground 存在且是 ground 类型
      for (const gid of params.ground_ids.add) {
        const gRow = repo.getNodeById(db, gid);
        if (!gRow) throw new NotFoundError(gid);
        if (gRow.type !== "ground") throw new TypeMismatchError(gid, "ground", gRow.type);
      }
      data.ground_ids = [...new Set([...currentIds, ...params.ground_ids.add])];
    }

    if (params.ground_ids.remove) {
      const removeIds = params.ground_ids.remove;
      data.ground_ids = currentIds.filter((id: number) => !removeIds.includes(id));
    }
  }

  // 执行更新
  const content = params.content !== undefined ? params.content : row.content;
  const updated = repo.updateNodeFields(db, nodeId, { content, data });
  return toNode(assertNodeExists(updated, nodeId));
}

// =============================================================================
// 删除操作
// =============================================================================

/** 删除节点 */
export function deleteNode(
  db: Database,
  nodeId: number,
  cascade: boolean = false
): void {
  const row = assertNodeExists(repo.getNodeById(db, nodeId), nodeId);

  switch (row.type) {
    case "claim": {
      if (!cascade) {
        throw new CascadeRequiredError();
      }
      // 删除绑定的 Warrants（及其 Backings）
      const warrants = repo.findWarrantsByClaim(db, nodeId);
      for (const w of warrants) {
        // 删除 Warrant 的 Backings
        const backings = repo.findBackingsByWarrant(db, w.id);
        for (const b of backings) {
          repo.deleteNodeById(db, b.id);
        }
        // 删除指向 Warrant 的 Rebuttals
        const rebuttals = repo.findRebuttalsByTarget(db, w.id, "warrant");
        for (const r of rebuttals) {
          repo.deleteNodeById(db, r.id);
        }
        repo.deleteNodeById(db, w.id);
      }
      // 删除 Qualifiers
      const qualifiers = repo.findQualifiersByClaim(db, nodeId);
      for (const q of qualifiers) {
        repo.deleteNodeById(db, q.id);
      }
      // 删除指向 Claim 的 Rebuttals
      const rebuttals = repo.findRebuttalsByTarget(db, nodeId, "claim");
      for (const r of rebuttals) {
        repo.deleteNodeById(db, r.id);
      }
      // 删除 Claim 本身
      repo.deleteNodeById(db, nodeId);
      break;
    }

    case "ground": {
      // 从所有 Warrant 的 ground_ids 中移除
      repo.removeGroundFromAllWarrants(db, nodeId);
      // 删除指向该 Ground 的 Rebuttals
      const rebuttals = repo.findRebuttalsByTarget(db, nodeId);
      for (const r of rebuttals) {
        repo.deleteNodeById(db, r.id);
      }
      repo.deleteNodeById(db, nodeId);
      break;
    }

    case "warrant": {
      // 级联删除 Backings
      const backings = repo.findBackingsByWarrant(db, nodeId);
      for (const b of backings) {
        repo.deleteNodeById(db, b.id);
      }
      // 删除指向该 Warrant 的 Rebuttals
      const rebuttals = repo.findRebuttalsByTarget(db, nodeId, "warrant");
      for (const r of rebuttals) {
        repo.deleteNodeById(db, r.id);
      }
      repo.deleteNodeById(db, nodeId);
      break;
    }

    case "backing":
    case "qualifier":
    case "rebuttal": {
      repo.deleteNodeById(db, nodeId);
      break;
    }

    default:
      throw new ValidationError(`Unknown node type: ${row.type}`);
  }
}

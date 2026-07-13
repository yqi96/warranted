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
  RebuttalNode,
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
  MutuallyExclusiveModeError,
  StatusTransitionError,
} from "./errors.ts";
import { WARNINGS } from "./content.ts";

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
// 审查辅助函数
// =============================================================================

/** 查找引用某 Ground 的所有 Warrants */
export function findWarrantsUsingGround(db: Database, groundId: number): NodeRow[] {
  const allWarrants = repo.listNodesByType(db, "warrant");
  return allWarrants.filter(w => {
    const wData = JSON.parse(w.data);
    return (wData.ground_ids || []).includes(groundId);
  });
}

/** 检查 Claim 或其 Warrants 是否有 Rebuttal */
function hasRebuttals(db: Database, claimId: number): boolean {
  const claimRebuttals = repo.findRebuttalsByTarget(db, claimId, "claim");
  if (claimRebuttals.length > 0) return true;
  const warrantRows = repo.findWarrantsByClaim(db, claimId);
  for (const w of warrantRows) {
    const warrantRebuttals = repo.findRebuttalsByTarget(db, w.id, "warrant");
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
  const groundIds: number[] = wData.ground_ids || [];

  // 链路不完整：无 Ground 或无 Claim
  if (groundIds.length === 0 || !claimId) return null;

  const claimRow = repo.getNodeById(db, claimId);
  if (!claimRow || claimRow.type !== "claim") return null;

  // 验证所有 Ground 存在
  for (const gid of groundIds) {
    const gRow = repo.getNodeById(db, gid);
    if (!gRow || gRow.type !== "ground") return null;
  }

  return { claimId, warrantId, groundIds };
}

/** 检测链式推理循环：检查从 startId 出发沿现有链是否能到达 targetId */
function canReachThroughChain(db: Database, startId: number, targetId: number): boolean {
  const visited = new Set<number>();
  const queue = [startId];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    if (currentId === targetId) return true;
    const warrants = repo.findWarrantsByClaim(db, currentId);
    for (const w of warrants) {
      const wData = JSON.parse(w.data);
      const groundIds: number[] = wData.ground_ids || [];
      for (const gid of groundIds) {
        const gRow = repo.getNodeById(db, gid);
        if (!gRow || gRow.type !== "ground") continue;
        const gData = JSON.parse(gRow.data);
        const refId = gData.ref_claim_id;
        if (refId !== null && refId !== undefined && !visited.has(refId)) {
          queue.push(refId);
        }
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

  // B1: Warrant 必须有至少一个 Ground
  if (gIds.length === 0) {
    throw new ValidationError("A Warrant must link at least one Ground. Provide ground_ids.");
  }

  // E1: 循环链式推理检测
  // 检查 Warrant 的 Grounds 中是否有 ref_claim_id 能回到 claimId
  for (const gid of gIds) {
    const gRow = repo.getNodeById(db, gid);
    if (!gRow || gRow.type !== "ground") continue;
    const gData = JSON.parse(gRow.data);
    const refId = gData.ref_claim_id;
    if (refId !== null && refId !== undefined) {
      // 从 refId 出发沿链遍历，检查是否能回到 claimId
      if (canReachThroughChain(db, refId, claimId)) {
        throw new ValidationError(
          `Circular chain reasoning detected: Claim #${claimId} would reference itself through Ground #${gid}.`
        );
      }
    }
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

  // G2: 不能为 refuted Claim 的 Warrant 创建 Backing
  const wData = JSON.parse(warrantRow.data);
  const claimRow = repo.getNodeById(db, wData.claim_id);
  if (claimRow) {
    const claimData = JSON.parse(claimRow.data);
    if (claimData.status === "refuted") {
      throw new ValidationError(
        `Cannot create Backing for Warrant #${warrantId}: its Claim #${wData.claim_id} is refuted. Adding support to a refuted argument is not meaningful.`
      );
    }
  }

  const row = repo.insertNode(db, "backing", content.trim(), {
    attachments: attachments || [],
    warrant_id: warrantId,
  });
  return toBackingNode(row);
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

  // F1: 不能 rebut 已 refuted 的 Claim
  if (targetType === "claim") {
    const targetData = JSON.parse(targetRow.data);
    if (targetData.status === "refuted") {
      throw new ValidationError(
        `Cannot create Rebuttal targeting Claim #${targetId}: already refuted. No further rebuttal is needed.`
      );
    }
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

  // Qualifier (now a Claim attribute)
  const claimData = JSON.parse(claimRow.data);
  const qualifier = claimData.qualifier || null;

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

  return { claim: { ...claim, qualifier }, warrants, rebuttals } as ClaimArgument;
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
  } else if (row.type === "backing" || row.type === "rebuttal") {
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
    qualifiers: { total: 0 },
    rebuttals: { total: counts.rebuttal, by_target_type: byTargetType },
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
    const validStatuses = ["proposed", "supported", "validated", "disputed", "refuted"];
    if (!validStatuses.includes(params.status)) {
      throw new ValidationError(`Invalid status: ${params.status}`);
    }

    // A1: →supported 或 →validated 需至少一个 Warrant 且其 Grounds 全部 verified
    if (params.status === "supported" || params.status === "validated") {
      const warrants = repo.findWarrantsByClaim(db, nodeId);
      if (warrants.length === 0) {
        throw new StatusTransitionError(
          `Cannot mark Claim #${nodeId} as "supported": Claim has no Warrants. Create a Warrant with verified Grounds first.`
        );
      }
      let hasValidWarrant = false;
      for (const w of warrants) {
        const wData = JSON.parse(w.data);
        const gIds: number[] = wData.ground_ids || [];
        if (gIds.length === 0) continue;
        const allVerified = gIds.every(gid => {
          const gRow = repo.getNodeById(db, gid);
          if (!gRow) return false;
          const gData = JSON.parse(gRow.data);
          return gData.verification === "verified";
        });
        if (allVerified) hasValidWarrant = true;
      }
      if (!hasValidWarrant) {
        throw new StatusTransitionError(
          `Cannot mark Claim #${nodeId} as "${params.status}": no Warrant has all Grounds verified. Verify the Grounds first.`
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
      const remaining = currentIds.filter((id: number) => !removeIds.includes(id));
      // B3: 不能清空 Warrant 的所有 Grounds
      if (remaining.length === 0) {
        throw new ValidationError(
          `Cannot remove all Grounds from Warrant #${nodeId}. A Warrant must have at least one Ground.`
        );
      }
      data.ground_ids = remaining;
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
  const row = assertNodeExists(repo.getNodeById(db, nodeId), nodeId);
  const warnings: string[] = [];

  switch (row.type) {
    case "claim": {
      if (!cascade) {
        throw new CascadeRequiredError();
      }
      // D2 警告: 检查是否被 Ground(ref_claim_id) 链式引用
      const refGrounds = repo.findGroundsByRefClaim(db, nodeId);
      if (refGrounds.length > 0) {
        const gids = refGrounds.map(g => g.id).join(", ");
        warnings.push(WARNINGS.deleteClaimReferencedByGround(nodeId, gids));
      }
      // 删除绑定的 Warrants（及其 Backings）
      const warrants = repo.findWarrantsByClaim(db, nodeId);
      for (const w of warrants) {
        const backings = repo.findBackingsByWarrant(db, w.id);
        for (const b of backings) {
          repo.deleteNodeById(db, b.id);
        }
        const rebuttals = repo.findRebuttalsByTarget(db, w.id, "warrant");
        for (const r of rebuttals) {
          repo.deleteNodeById(db, r.id);
        }
        repo.deleteNodeById(db, w.id);
      }
      // 删除指向 Claim 的 Rebuttals
      const rebuttals = repo.findRebuttalsByTarget(db, nodeId, "claim");
      for (const r of rebuttals) {
        repo.deleteNodeById(db, r.id);
      }
      // D4: 清理链式引用 Grounds
      for (const g of refGrounds) {
        repo.removeGroundFromAllWarrants(db, g.id);
        const gRebuttals = repo.findRebuttalsByTarget(db, g.id);
        for (const r of gRebuttals) {
          repo.deleteNodeById(db, r.id);
        }
        repo.deleteNodeById(db, g.id);
      }
      // 删除 Claim 本身
      repo.deleteNodeById(db, nodeId);
      break;
    }

    case "ground": {
      // D1 警告: 检查是否被 Warrant 引用
      const usingWarrants = findWarrantsUsingGround(db, nodeId);
      if (usingWarrants.length > 0) {
        const wids = usingWarrants.map(w => `#${w.id}`).join(", ");
        warnings.push(WARNINGS.deleteGroundReferencedByWarrant(nodeId, wids));
      }
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
    case "rebuttal": {
      repo.deleteNodeById(db, nodeId);
      break;
    }

    default:
      throw new ValidationError(`Unknown node type: ${row.type}`);
  }

  return warnings;
}

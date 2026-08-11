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
  ArgumentStatement,
  ArgumentWarrant,
  ArgumentRebuttal,
  Stats,
  ScaleBlock,
  RoleCount,
  ToulminNode,
  TagRow,
  NamespaceCardinality,
} from "./types.ts";
import {
  NotFoundError,
  ValidationError,
  CascadeRequiredError,
  TypeMismatchError,
  StatusTransitionError,
} from "./errors.ts";
import { WARNINGS, HINTS } from "./content/index.ts";
import { findNearMatches } from "./tag-similarity.ts";
import { isFtsAvailable } from "./db.ts";
import { existsSync } from "fs";

// =============================================================================
// 辅助函数
// =============================================================================

const VALID_GROUND_SOURCES: string[] = ["literature", "observed"];

/** 将 NodeRow 转换为具体类型的节点对象 */
function toClaimNode(row: NodeRow, db: Database): ClaimNode {
  const data = JSON.parse(row.data);
  return {
    id: row.id,
    type: "claim",
    content: row.content,
    status: data.status || "proposed",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: repo.getNodeTags(db, row.id),
  };
}

function toWarrantNode(row: NodeRow, db: Database): WarrantNode {
  const data = JSON.parse(row.data);
  return {
    id: row.id,
    type: "warrant",
    content: row.content,
    claimId: data.claim_id,
    groundIds: repo.findGroundIdsByWarrant(db, row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: repo.getNodeTags(db, row.id),
  };
}

function toStatementNode(row: NodeRow, db: Database): StatementNode {
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
    tags: repo.getNodeTags(db, row.id),
  };
}

/** 根据 type 转换 NodeRow 为具体节点 */
function toNode(row: NodeRow, db: Database): ToulminNode {
  switch (row.type) {
    case "claim": return toClaimNode(row, db);
    case "warrant": return toWarrantNode(row, db);
    case "statement": return toStatementNode(row, db);
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

/**
 * 判断一个节点是否"已核实"，供 A1/A3/A4 门禁和 compile 阶段共用。
 * 名字不带 Ground 是因为 Ground 不是唯一的消费者：A3/A4 用同一个判据检查
 * Rebuttal（见 hasVerifiedRebuttal）。角色由关系表决定，判据只看节点本身。
 * - statement 类型：verification === "verified"
 * - claim 类型（链式推理）：该 claim 自身 status ∈ {supported, disputed}。
 *   proposed 未经确认、refuted 已被推翻，均不能作为可信 ground。
 *   disputed 包含在内是因为证据冲突本身就是一种经过审查的结论状态
 *   （A3 要求已核实的 Rebuttal，所以走到 disputed 必然经过核实），
 *   且 disputed 没有退路（无法像 refuted 那样改挂窄 Claim）。
 */
export function isClaimOrStatementVerified(nodeRow: NodeRow): boolean {
  const data = JSON.parse(nodeRow.data);
  if (nodeRow.type === "claim") return data.status === "supported" || data.status === "disputed";
  return data.verification === "verified";
}

/** 简短标注一个未通过 isClaimOrStatementVerified 的 ground，用于错误/警告文案定位具体节点。 */
export function describeUnverifiedGround(groundRow: NodeRow): string {
  if (groundRow.type === "claim") {
    const data = JSON.parse(groundRow.data);
    const status = data.status || "proposed";
    if (status === "proposed") {
      return `Ground Claim #${groundRow.id} has no verdict yet — settle it before this Claim can be`;
    }
    if (status === "refuted") {
      return `Ground Claim #${groundRow.id} is refuted — reground on what survives it`;
    }
    return `Claim #${groundRow.id} not supported`;
  }
  return `Ground #${groundRow.id} not verified`;
}

/** 查找某 Warrant 的 Backings（via warrant_backings 关系表） */
function findAllBackingsByWarrant(db: Database, warrantId: number): NodeRow[] {
  return repo.findBackingsByWarrant(db, warrantId);
}

/** 查找指向目标的 Rebuttals（via rebuttal_targets 关系表） */
function findAllRebuttalsByTarget(db: Database, targetId: number, targetType?: string): NodeRow[] {
  return repo.findRebuttalsByTarget(db, targetId, targetType);
}

/**
 * 检查 Claim 或其 Warrants 是否有**已核实**的 Rebuttal。
 *
 * 只看有没有反驳存在是不够的：那样一条 verification="pending"、零附件的
 * Statement 就足以把一个主张标成 refuted，而标成 supported 却要求整条推理
 * 下面的 Ground 全部已核实 —— 说一个主张是假的比说它是真的更省证据。
 * 判据与 Ground 共用（isClaimOrStatementVerified），避免第二份实现漂移。
 */
export function hasVerifiedRebuttal(db: Database, claimId: number): boolean {
  if (findAllRebuttalsByTarget(db, claimId, "claim").some(isClaimOrStatementVerified)) return true;
  for (const w of repo.findWarrantsByClaim(db, claimId)) {
    if (findAllRebuttalsByTarget(db, w.id, "warrant").some(isClaimOrStatementVerified)) return true;
  }
  return false;
}

/**
 * A1 的判据：该 Claim 是否有某个 Warrant，其 Grounds 全部已核实。
 *
 * 从 A1 门禁里抽出来，因为撤回核实后的复检需要同一个判据
 * （见 compile-service.ts revertUnsupportedClaimStatuses）。抽出而不是复制一份，
 * 是 PR6 §D7 的教训：同一条政策写两遍，改动一处不会传到另一处，而且两边各自的
 * 测试都会继续通过，漂移从任何一个文件里都看不出来。
 *
 * `blockers` 只服务 A1 的错误文案（要指出是哪条 Warrant 的哪个 Ground 没核实）；
 * 复检只看 `satisfied`。
 *
 * satisfied=false 时 blockers 必须非空。调用点把它拼在破折号后面，空数组会印出一句
 * 以 "— " 结尾的半句话。会漏掉原因的两种形状都不是「Ground 没核实」：一条 Warrant
 * 都没有（循环不进），以及某条 Warrant 没挂 Ground（不能算满足——「全部已核实」在空集
 * 上恒真——但也得留下原因）。今天两种都被更前面的 A0 挡着走不到，写在这里是因为
 * 「不满足就必须说出为什么」是这个返回值的约定，不该依赖调用顺序才成立。
 */
export function hasWarrantWithAllGroundsVerified(
  db: Database,
  claimId: number
): { satisfied: boolean; blockers: string[] } {
  const blockers: string[] = [];
  const warrants = repo.findWarrantsByClaim(db, claimId);
  if (warrants.length === 0) {
    return { satisfied: false, blockers: [`Claim #${claimId} has no Warrants`] };
  }
  for (const w of warrants) {
    const groundRows = repo.findGroundsByWarrant(db, w.id);
    if (groundRows.length === 0) {
      blockers.push(`Warrant #${w.id}: no Grounds attached`);
      continue;
    }
    const unverified = groundRows.filter(gRow => !isClaimOrStatementVerified(gRow));
    if (unverified.length === 0) return { satisfied: true, blockers: [] };
    blockers.push(`Warrant #${w.id}: ${unverified.map(describeUnverifiedGround).join(", ")}`);
  }
  return { satisfied: false, blockers };
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
export function createClaim(db: Database, content: string, qualifier?: string | null, tags?: string[]): ClaimNode {
  if (!content || !content.trim()) {
    throw new ValidationError("Claim content cannot be empty");
  }
  if (tags && tags.length > 0) {
    assertTagsRegistered(db, tags);
  }
  const data: ClaimData = { status: "proposed" };
  if (qualifier) data.qualifier = qualifier;
  const row = repo.insertNode(db, "claim", content.trim(), data);
  if (tags && tags.length > 0) {
    repo.addNodeTags(db, row.id, tags);
  }
  return toClaimNode(row, db);
}

/**
 * Every validation a Statement write must pass, evaluated against the result
 * state `(content, source, verification, attachments, tags)`.
 *
 * Single-item and bulk entry points call this same function so the two cannot
 * drift apart (pr3-batch.md §0.3, §4.0). It performs no writes, which is what
 * lets `create_statements` run it over every item before deciding whether to
 * write any of them (§2.2's validate-all → write-all contract).
 */
export function assertStatementWritable(
  db: Database,
  opts: {
    content: string;
    source: GroundSource;
    verification: VerificationStatus;
    attachments?: string[];
    tags?: string[];
  }
): void {
  const { content, source, verification, attachments, tags } = opts;

  if (!content || !content.trim()) {
    throw new ValidationError("Statement content cannot be empty");
  }

  if (tags && tags.length > 0) {
    assertTagsRegistered(db, tags);
  }
  const validSources = VALID_GROUND_SOURCES;
  if (!validSources.includes(source)) {
    throw new ValidationError(`Invalid source: ${source}. Must be one of: ${validSources.join(", ")}`);
  }
  const validVerifications: string[] = ["verified", "pending"];
  if (!validVerifications.includes(verification)) {
    throw new ValidationError(`Invalid verification: ${verification}. Must be one of: ${validVerifications.join(", ")}`);
  }

  // H1: verified Statement 必须有 attachments（与 updateNode 一致）
  if (verification === "verified" && (attachments || []).length === 0) {
    throw new ValidationError(
      `Cannot create statement as "verified": verified statements must have attachments. Provide scripts, logs, or other evidence files via the attachments parameter.`
    );
  }

  // §4.1: source='literature' with no attachments
  if (source === 'literature' && (!attachments || attachments.length === 0)) {
    throw new ValidationError(
      'source="literature" requires at least one attachment. Provide the reference files (e.g., paper PDF, reference document) as attachments.'
    );
  }
  // §4.3: reject URLs (path resolution needs reviewCwd and is layered on in tools.ts)
  for (const p of attachments ?? []) {
    assertNotUrl(p);
  }
}

/** §4.3: attachments must be locally readable files; a URL can never resolve. */
function assertNotUrl(p: string): void {
  if (p.startsWith("http://") || p.startsWith("https://")) {
    throw new ValidationError(`Attachment path "${p}" is a URL. Use local file paths.`);
  }
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
    tags?: string[];
  }
): StatementNode {
  const { content, source, verification, attachments, rebuttal_for, tags } = opts;

  assertStatementWritable(db, { content, source, verification, attachments, tags });

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

  if (tags && tags.length > 0) {
    repo.addNodeTags(db, row.id, tags);
  }

  return toStatementNode(row, db);
}


/** 创建 Warrant */
export function createWarrant(
  db: Database,
  opts: {
    content: string;
    claimId: number;
    groundIds?: number[];
    backingIds?: number[];
  }
): WarrantNode {
  const { content, claimId, groundIds, backingIds } = opts;

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
  });
  // warrant_grounds 是 ground 集合的唯一记录，节点 blob 不再存 ground_ids 副本。
  // INSERT OR IGNORE 顺带吸收调用方传进来的重复 id。
  for (const gid of gIds) {
    db.prepare("INSERT OR IGNORE INTO warrant_grounds (warrant_id, ground_id) VALUES (?, ?)").run(row.id, gid);
  }
  // Also populate warrant_backings relationship table
  const bIds = backingIds || [];
  for (const bid of bIds) {
    const backingRow = assertNodeExists(repo.getNodeById(db, bid), bid);
    assertNodeType(backingRow, "statement");
    db.prepare("INSERT OR IGNORE INTO warrant_backings (warrant_id, statement_id) VALUES (?, ?)").run(row.id, bid);
  }
  return toWarrantNode(row, db);
}

// =============================================================================
// 读取操作
// =============================================================================

/** 列出所有 Claim */
export function listClaims(
  db: Database,
  statusFilter?: string,
  compileStatusFilter?: string,
  tag?: string,
  limit: number = 50,
  offset: number = 0
): { rows: ClaimNode[]; total: number } {
  let sql = "SELECT n.* FROM nodes n LEFT JOIN compile_state cs ON cs.claim_id = n.id WHERE n.type = 'claim'";
  const params: (string | number)[] = [];

  const tagClause = repo.tagFilterClause(tag, false, "n");
  sql += tagClause.clause;
  params.push(...tagClause.params);

  if (statusFilter) {
    const statuses = statusFilter.split(",").map(s => s.trim());
    sql += ` AND COALESCE(json_extract(n.data, '$.status'), 'proposed') IN (${statuses.map(() => "?").join(", ")})`;
    params.push(...statuses);
  }

  if (compileStatusFilter) {
    const statuses = compileStatusFilter.split(",").map(s => s.trim());
    // compile_state 是编译状态的唯一存储；没有行 = 从未编译过，用字面量 'null' 过滤。
    // claim_id 是主键，join 走索引；原先的 json_extract 用不上索引。
    sql += ` AND COALESCE(cs.verdict, 'null') IN (${statuses.map(() => "?").join(", ")})`;
    params.push(...statuses);
  }

  const total = (db.prepare(`SELECT COUNT(*) AS cnt FROM (${sql}) AS sub`).get(...params) as { cnt: number }).cnt;

  const rows = db.prepare(`${sql} ORDER BY n.id LIMIT ? OFFSET ?`).all(...params, limit, offset) as NodeRow[];
  return { rows: rows.map(r => toClaimNode(r, db)), total };
}

/** 列出所有 Statement 节点，可按 source / verification / tag / role / without_tag 过滤，支持分页 */
export function listStatements(
  db: Database,
  sourceFilter?: string,
  verificationFilter?: string,
  tag?: string,
  without_tag?: string,
  role?: string,
  limit: number = 50,
  offset: number = 0
): { rows: StatementNode[]; total: number } {
  // Build base query
  let baseSql: string;
  let baseParams: (string | number)[] = [];

  if (role === "ground") {
    baseSql = "SELECT DISTINCT n.* FROM nodes n JOIN warrant_grounds wg ON wg.ground_id = n.id WHERE n.type = 'statement'";
  } else if (role === "backing") {
    baseSql = "SELECT DISTINCT n.* FROM nodes n JOIN warrant_backings wb ON wb.statement_id = n.id WHERE n.type = 'statement'";
  } else if (role === "rebuttal") {
    baseSql = "SELECT DISTINCT n.* FROM nodes n JOIN rebuttal_targets rt ON rt.statement_id = n.id WHERE n.type = 'statement'";
  } else {
    baseSql = "SELECT n.* FROM nodes n WHERE n.type = 'statement'";
  }

  // Build filter clauses
  let filters: string[] = [];
  let filterParams: (string | number)[] = [];

  if (sourceFilter) {
    const sources = sourceFilter.split(",").map(s => s.trim());
    filters.push(`json_extract(n.data, '$.source') IN (${sources.map(() => "?").join(", ")})`);
    filterParams.push(...sources);
  }

  if (verificationFilter) {
    const statuses = verificationFilter.split(",").map(s => s.trim());
    filters.push(`json_extract(n.data, '$.verification') IN (${statuses.map(() => "?").join(", ")})`);
    filterParams.push(...statuses);
  }

  const tagClause = repo.tagFilterClause(tag, false, "n");
  if (tagClause.clause) {
    filters.push(tagClause.clause.replace(/^ AND /, ""));
    filterParams.push(...tagClause.params);
  }

  const withoutTagClause = repo.tagFilterClause(without_tag, true, "n");
  if (withoutTagClause.clause) {
    filters.push(withoutTagClause.clause.replace(/^ AND /, ""));
    filterParams.push(...withoutTagClause.params);
  }

  // For role queries, filters use AND on the outer WHERE clause
  let dataSql: string;
  let dataParams: (string | number)[];
  let countSql: string;
  let countParams: (string | number)[];

  if (filters.length > 0) {
    const filterClause = filters.join(" AND ");
    dataSql = `${baseSql} AND ${filterClause} ORDER BY n.id LIMIT ? OFFSET ?`;
    dataParams = [...baseParams, ...filterParams, limit, offset];
    countSql = `SELECT COUNT(*) AS cnt FROM (${baseSql} AND ${filterClause}) AS sub`;
    countParams = [...baseParams, ...filterParams];
  } else {
    dataSql = `${baseSql} ORDER BY n.id LIMIT ? OFFSET ?`;
    dataParams = [...baseParams, limit, offset];
    countSql = `SELECT COUNT(*) AS cnt FROM (${baseSql}) AS sub`;
    countParams = [...baseParams];
  }

  const total = (db.prepare(countSql).get(...countParams) as { cnt: number }).cnt;
  const rows = db.prepare(dataSql).all(...dataParams) as NodeRow[];
  return { rows: rows.map(r => toStatementNode(r, db)), total };
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

/**
 * 一个 statement 节点在 get_argument 里的形状 —— Ground / Backing / Rebuttal 共用。
 *
 * 三个角色共用一个映射，是因为它们曾经各写一遍，而 Backing 和 Rebuttal 那两遍漏了
 * source 和 verification。角色由关系表决定，字段不该跟着角色变。
 */
function toArgumentStatement(row: NodeRow): ArgumentStatement {
  const data = JSON.parse(row.data);
  return {
    id: row.id,
    content: row.content,
    attachments: data.attachments || [],
    source: data.source,
    verification: data.verification,
  };
}

/** 同上，外加"攻击的是哪一条"。目标由调用方给：反驳都是按目标查出来的，那里就知道。 */
function toArgumentRebuttal(row: NodeRow, targetType: TargetType, targetId: number): ArgumentRebuttal {
  return { ...toArgumentStatement(row), target_type: targetType, target_id: targetId };
}

function getClaimArgument(db: Database, claimRow: NodeRow): ClaimArgument {
  const claim = toClaimNode(claimRow, db);

  // Qualifier (now a Claim attribute)
  const claimData = JSON.parse(claimRow.data);
  const qualifier = claimData.qualifier || null;

  // Warrants + their Grounds and Backings
  const warrantRows = repo.findWarrantsByClaim(db, claim.id);
  const warrants: ArgumentWarrant[] = warrantRows.map(w => {
    const groundRows = repo.findGroundsByWarrant(db, w.id);

    const grounds: ArgumentGround[] = groundRows
      .filter((g): g is NodeRow => g !== null && (g.type === "statement" || g.type === "claim"))
      .map(toArgumentStatement);

    const backings: ArgumentBacking[] = findAllBackingsByWarrant(db, w.id).map(toArgumentStatement);

    return { id: w.id, content: w.content, grounds, backings };
  });

  // Rebuttals targeting this claim or its warrants.
  // 目标在这里是已知的（是按目标查出来的），所以直接带上，不再回查 rebuttal_targets。
  const rebuttals: ArgumentRebuttal[] = [
    ...findAllRebuttalsByTarget(db, claim.id, "claim").map(r => toArgumentRebuttal(r, "claim", claim.id)),
    ...warrantRows.flatMap(w =>
      findAllRebuttalsByTarget(db, w.id, "warrant").map(r => toArgumentRebuttal(r, "warrant", w.id))
    ),
  ];

  return {
    claim: { ...claim, qualifier, compile_status: repo.getCompileState(db, claim.id)?.verdict ?? null },
    warrants,
    rebuttals,
  } as ClaimArgument;
}

function getWarrantArgument(db: Database, warrantRow: NodeRow): WarrantArgument {
  const wData = JSON.parse(warrantRow.data);

  const grounds: ArgumentGround[] = repo.findGroundsByWarrant(db, warrantRow.id)
    .filter((g): g is NodeRow => g !== null && (g.type === "statement" || g.type === "claim"))
    .map(toArgumentStatement);

  const backings: ArgumentBacking[] = findAllBackingsByWarrant(db, warrantRow.id).map(toArgumentStatement);

  const rebuttals: ArgumentRebuttal[] = findAllRebuttalsByTarget(db, warrantRow.id, "warrant")
    .map(r => toArgumentRebuttal(r, "warrant", warrantRow.id));

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

  // 不查"攻击这个节点的反驳"：这个分支只在节点是 statement 时走到，而反驳只能
  // 攻击 Claim 或 Warrant（createStatement 的 rebuttal_for 拦住了别的），所以结果恒为空。

  return result;
}

/** 搜索节点 */
export function searchNodesService(
  db: Database,
  keyword: string,
  typeFilter?: string,
  tag?: string,
  limit: number = 20,
  offset: number = 0
): { rows: ToulminNode[]; total: number } {
  // Virtual role filters: query relationship tables then intersect with keyword.
  // §2.7: role filtering completes before pagination, and truncation happens after it.
  const roleJoin: Record<string, string> = {
    ground: "JOIN warrant_grounds wg ON wg.ground_id = n.id",
    backing: "JOIN warrant_backings wb ON wb.statement_id = n.id",
    rebuttal: "JOIN rebuttal_targets rt ON rt.statement_id = n.id",
  };
  if (typeFilter && roleJoin[typeFilter]) {
    let sql = `SELECT DISTINCT n.* FROM nodes n ${roleJoin[typeFilter]} WHERE n.content LIKE ?`;
    const params: (string | number)[] = [`%${keyword}%`];
    const tagClause = repo.tagFilterClause(tag, false, "n");
    sql += tagClause.clause;
    params.push(...tagClause.params);

    const total = (db.prepare(`SELECT COUNT(*) AS cnt FROM (${sql}) AS sub`).get(...params) as { cnt: number }).cnt;
    const rows = db.prepare(`${sql} ORDER BY n.id LIMIT ? OFFSET ?`).all(...params, limit, offset) as NodeRow[];
    return { rows: rows.map(r => toNode(r, db)), total };
  }

  // FTS for keyword >= 3 chars, otherwise LIKE
  const ftsAvail = isFtsAvailable();
  if (keyword.length >= 3 && ftsAvail) {
    const result = repo.searchNodesFts(db, keyword, {
      type: typeFilter as any,
      tag,
      limit,
      offset,
    });
    return { rows: result.rows.map(r => toNode(r, db)), total: result.total };
  }

  const result = repo.searchNodes(db, keyword, typeFilter as any, { tag, limit, offset });
  return { rows: result.rows.map(r => toNode(r, db)), total: result.total };
}

/** 获取全局统计，含规模块 */
export function getStats(db: Database): Stats {
  const counts = repo.countNodesByType(db);

  // Claims by status
  const byStatus: Record<string, number> = {};
  for (const row of repo.listNodesByType(db, "claim")) {
    const status = JSON.parse(row.data).status || "proposed";
    byStatus[status] = (byStatus[status] || 0) + 1;
  }

  // Rebuttals by target_type（via rebuttal_targets）。角色的条数交给 scale 块的 roles，
  // 这里只保留"打在 Claim 上还是 Warrant 上"这个别处没有的分布。
  const byTargetType: Record<string, number> = {};
  for (const row of db.prepare("SELECT rt.target_type FROM rebuttal_targets rt").all() as Array<{ target_type: string }>) {
    const targetType = row.target_type || "unknown";
    byTargetType[targetType] = (byTargetType[targetType] || 0) + 1;
  }

  return {
    claims: { total: counts.claim, by_status: byStatus },
    warrants: { total: counts.warrant },
    rebuttals: { by_target_type: byTargetType },
    scale: buildScaleBlock(db),
  };
}

/** Build the scale block for get_stats output */
const GAP_MATRIX_MAX_LINES = 8;

/**
 * 一个角色有多少条、多少已核实 —— 三个角色共用这一个口径。
 *
 * 从关系表出发取出节点行，再交给 isClaimOrStatementVerified 判核实，不在 SQL 里
 * 另写一份判据。原因：Claim 也可以扮演角色，而写在 SQL 里的
 * `json_extract(data, '$.verification') != 'verified'` 对 Claim 行永远成立，
 * 于是每个 claim 型 Backing / Rebuttal 都会被永久算作未核实，而且不报错。
 * table / column 是调用处写死的字面量，不接受外部输入。
 */
function countRole(db: Database, table: string, column: string): RoleCount {
  const rows = db.prepare(
    `SELECT DISTINCT n.* FROM ${table} r JOIN nodes n ON n.id = r.${column}`
  ).all() as NodeRow[];
  const verified = rows.filter(isClaimOrStatementVerified).length;
  return { total: rows.length, verified, pending: rows.length - verified };
}

function buildScaleBlock(db: Database): ScaleBlock {
  // Tag namespace aggregates
  const allTags = repo.listTagsWithCount(db);
  const namespaceMap = new Map<string, { count: number; with_nodes: number; cardinality: string }>();

  for (const t of allTags) {
    const ns = t.name.split(":")[0];
    const existing = namespaceMap.get(ns) ?? { count: 0, with_nodes: 0, cardinality: "bounded" };
    existing.count++;
    if (t.count > 0) existing.with_nodes++;
    // Get cardinality from tag_namespaces table
    const card = repo.getNamespaceCardinality(db, ns);
    if (card) existing.cardinality = card;
    namespaceMap.set(ns, existing);
  }

  const namespaces = Array.from(namespaceMap.entries()).map(([name, info]) => ({
    name,
    ...info,
  }));

  // Statement tagging coverage (the §4.2 `Statements:` line counts statements, not tags)
  const statementTotal = (db.prepare("SELECT COUNT(*) AS cnt FROM nodes WHERE type = 'statement'").get() as { cnt: number }).cnt;
  const statementTagged = (db.prepare(
    "SELECT COUNT(DISTINCT nt.node_id) AS cnt FROM node_tags nt JOIN nodes n ON n.id = nt.node_id WHERE n.type = 'statement'"
  ).get() as { cnt: number }).cnt;

  // Namespace gap matrix: only (dense, bounded) ordered pairs
  const namespaceGaps: Array<{ from: string; to: string; count: number }> = [];
  const denseNS = namespaces.filter(n => n.cardinality === "dense").map(n => n.name);
  const boundedNS = namespaces.filter(n => n.cardinality === "bounded" && n.name !== "meta").map(n => n.name);

  for (const dense of denseNS) {
    for (const bounded of boundedNS) {
      if (dense === bounded) continue;
      const gapCount = (db.prepare(
        "SELECT COUNT(DISTINCT nt1.node_id) AS cnt FROM node_tags nt1 " +
        "WHERE nt1.tag LIKE ? AND NOT EXISTS (" +
        "  SELECT 1 FROM node_tags nt2 WHERE nt2.node_id = nt1.node_id AND nt2.tag LIKE ?" +
        ")"
      ).get(`${dense}:%`, `${bounded}:%`) as { cnt: number }).cnt;
      if (gapCount > 0) {
        namespaceGaps.push({ from: dense, to: bounded, count: gapCount });
      }
    }
  }
  // §4.2.1: sort ascending — the real signal shrinks as classification progresses,
  // so descending order would squeeze it out first. Cap at 8 lines and report the
  // omitted count, since the reader cannot otherwise know how large the matrix was.
  namespaceGaps.sort((a, b) => a.count - b.count);
  const gapsOmitted = Math.max(0, namespaceGaps.length - GAP_MATRIX_MAX_LINES);
  const shownGaps = namespaceGaps.slice(0, GAP_MATRIX_MAX_LINES);

  // Role counts
  const groundRole = countRole(db, "warrant_grounds", "ground_id");
  const backingRole = countRole(db, "warrant_backings", "statement_id");
  const rebuttalRole = countRole(db, "rebuttal_targets", "statement_id");

  // Claims detail
  const claimRows = repo.listNodesByType(db, "claim");
  const compileVerdicts = repo.getAllCompileVerdicts(db);
  const staleIds: number[] = [];
  let neverCompiled = 0;
  let passedAwaiting = 0;
  for (const row of claimRows) {
    const data = JSON.parse(row.data);
    const verdict = compileVerdicts.get(row.id);
    if (verdict === "stale") staleIds.push(row.id);
    if (verdict === undefined) neverCompiled++;
    if (verdict === "passed" && (data.status || "proposed") === "proposed") passedAwaiting++;
  }

  // Attachments: collect all attachment paths from statement nodes
  const allAttachments: Array<{ path: string; missing: boolean }> = [];
  type AttachmentRow = { attachments: string };
  const attRows = db.prepare(
    "SELECT json_extract(data, '$.attachments') AS attachments FROM nodes WHERE type = 'statement'"
  ).all() as AttachmentRow[];
  for (const ar of attRows) {
    if (!ar.attachments) continue;
    try {
      const paths = JSON.parse(ar.attachments) as string[];
      for (const p of paths) {
        const exists = existsSync(p);
        allAttachments.push({ path: p, missing: !exists });
      }
    } catch { /* skip malformed JSON */ }
  }
  // Deduplicate by path
  const seen = new Set<string>();
  const uniqueAttachments = allAttachments.filter(a => {
    if (seen.has(a.path)) return false;
    seen.add(a.path);
    return true;
  });

  return {
    tags: { total: allTags.length, namespaces },
    statements: { total: statementTotal, tagged: statementTagged, untagged: statementTotal - statementTagged },
    namespace_gaps: shownGaps,
    gaps_omitted: gapsOmitted,
    roles: {
      grounds: groundRole,
      backings: backingRole,
      rebuttals: rebuttalRole,
    },
    claims_detail: {
      never_compiled: neverCompiled,
      stale: { count: staleIds.length, ids: staleIds },
      passed_awaiting: passedAwaiting,
    },
    attachments: { total: uniqueAttachments.length, files: uniqueAttachments },
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
  return db.transaction((): { node: ToulminNode; warnings: string[] } => {
  const row = assertNodeExists(repo.getNodeById(db, nodeId), nodeId);
  const data = JSON.parse(row.data);
  const warnings: string[] = [];

  // 更新 content
  if (params.content !== undefined) {
    data.content = params.content;
    // G_CONTENT: verified ground 内容变更 → 退回 pending
    if (row.type === "statement" && data.verification === "verified") {
      data.verification = "pending";
      warnings.push(WARNINGS.verificationRevertedOnContentChange(nodeId));
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
      const cs = repo.getCompileState(db, nodeId);
      if (cs?.verdict !== "passed") {
        // 四种状态各给各自的出路 —— 尤其是 "failed"，再 compile 一百次结果不变，
        // 要改的是论证本身。原先这四种情况共用一句 "compile first"，会把 agent 引进死循环。
        const reason =
          cs === null
            ? `argument has not been compiled yet. Run compile_arguments on Claim #${nodeId} first.`
            : cs.verdict === "stale"
              ? `the argument changed after it last passed compile. Run compile_arguments on Claim #${nodeId} again.`
              : `compile rejected this argument — re-running compile will not change that. Fix the argument first. Compile said: ${cs.summary}`;
        throw new StatusTransitionError(
          `Cannot mark Claim #${nodeId} as "${params.status}": ${reason}`
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
      const { satisfied: hasValidWarrant, blockers } = hasWarrantWithAllGroundsVerified(db, nodeId);
      if (!hasValidWarrant) {
        throw new StatusTransitionError(
          `Cannot mark Claim #${nodeId} as "supported": no Warrant has all Grounds verified — ${blockers.join("; ")}`
        );
      }
    }

    // A3: →disputed 需存在已核实的 Rebuttal
    if (params.status === "disputed") {
      if (!hasVerifiedRebuttal(db, nodeId)) {
        throw new StatusTransitionError(
          `Cannot mark Claim #${nodeId} as "disputed": no verified Rebuttals target this Claim or its Warrants. A pending Rebuttal is not enough — verify it, or create one that is.`
        );
      }
    }

    // A4: →refuted 需存在已核实的 Rebuttal
    if (params.status === "refuted") {
      if (!hasVerifiedRebuttal(db, nodeId)) {
        throw new StatusTransitionError(
          `Cannot mark Claim #${nodeId} as "refuted": no verified Rebuttals exist to justify refutation. A pending Rebuttal is not enough — verify it, or create one that is.`
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
    const validSources = VALID_GROUND_SOURCES;
    if (!validSources.includes(params.source)) {
      throw new ValidationError(`Invalid source: ${params.source}. Must be one of: ${validSources.join(", ")}`);
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

    // H1: verified statement 必须有 attachments
    if (params.verification === "verified") {
      const finalAttachments = data.attachments || [];
      if (finalAttachments.length === 0) {
        throw new ValidationError(
          `Cannot mark statement #${nodeId} as "verified": verified statements must have attachments. Provide scripts, logs, or other evidence files via the attachments parameter.`
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

    if (params.ground_ids.add) {
      // 校验要添加的 ground 存在且是 statement 或 claim 类型（在任何写入前）
      for (const gid of params.ground_ids.add) {
        const gRow = repo.getNodeById(db, gid);
        if (!gRow) throw new NotFoundError(gid);
        if (gRow.type !== "statement" && gRow.type !== "claim") throw new TypeMismatchError(gid, "statement", gRow.type);
        // E1: cycle detection for claim-type grounds
        if (gRow.type === "claim") {
          if (wouldCreateCycle(db, gRow.id, data.claim_id)) {
            throw new ValidationError(
              `Circular chain reasoning detected: Claim #${data.claim_id} would reference itself through Claim #${gid}.`
            );
          }
        }
      }
      for (const gid of params.ground_ids.add) {
        repo.insertWarrantGround(db, nodeId, gid);
      }
    }

    if (params.ground_ids.remove) {
      for (const gid of params.ground_ids.remove) {
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

  // 更新 tags（任何节点类型）
  if (params.tags !== undefined) {
    if (params.tags.add && params.tags.add.length > 0) {
      assertTagsRegistered(db, params.tags.add);
      repo.addNodeTags(db, nodeId, params.tags.add);
    }
    if (params.tags.remove && params.tags.remove.length > 0) {
      repo.removeNodeTags(db, nodeId, params.tags.remove);
    }
  }

  // 更新 qualifier（Claim only）
  if (params.qualifier !== undefined) {
    if (row.type !== "claim") {
      throw new ValidationError("Only Claim nodes have qualifier");
    }
    data.qualifier = params.qualifier;
  }

  // ── Check block: evaluate result state (after all presence branches) ──
  // §4.1: source='literature' with no attachments
  if (data.source === 'literature' && (!data.attachments || data.attachments.length === 0)) {
    if (params.source !== undefined || params.attachments !== undefined) {
      throw new ValidationError(
        'source="literature" requires at least one attachment. Provide the reference files.'
      );
    }
  }
  // §4.0.2: verified with no attachments
  if (data.verification === 'verified' && (!data.attachments || data.attachments.length === 0)) {
    if (params.verification !== undefined || params.attachments !== undefined) {
      throw new ValidationError(
        `Cannot mark statement #${nodeId} as "verified": verified statements must have attachments. Provide scripts, logs, or other evidence files via the attachments parameter.`
      );
    }
  }
  // §4.3: reject URLs (path resolution is handled by the tools layer with reviewCwd)
  for (const p of data.attachments ?? []) {
    assertNotUrl(p);
  }

  // 执行更新
  const content = params.content !== undefined ? params.content : row.content;
  const updated = repo.updateNodeFields(db, nodeId, { content, data });
  return { node: toNode(assertNodeExists(updated, nodeId), db), warnings };
  })();
}

// =============================================================================
// 删除操作
// =============================================================================

/** Delete a node and ensure ground set consistency (JSON + relation table). Does NOT invalidate. */
function deleteNodeWithGroundCleanup(db: Database, nodeId: number): void {
  const row = repo.getNodeById(db, nodeId);
  // Claims occupy the Ground role too (chain reasoning), so both types need the
  // JSON half of the removal — ON DELETE CASCADE only covers warrant_grounds.
  if (row && (row.type === "statement" || row.type === "claim")) {
    repo.removeGroundFromAllWarrants(db, nodeId);
  }
  repo.deleteNodeById(db, nodeId);
}

/**
 * Collect all node IDs that will be deleted by deleteNode, without deleting them.
 * Drives both deleteNode's invalidation pass and its deletion pass.
 */
export function collectCollateralNodeIds(db: Database, nodeId: number, cascade: boolean): number[] {
  const row = repo.getNodeById(db, nodeId);
  if (!row) return [nodeId];
  const ids: number[] = [];

  switch (row.type) {
    case "claim": {
      if (!cascade) return [nodeId];
      const warrants = repo.findWarrantsByClaim(db, nodeId);
      for (const w of warrants) {
        const backings = findAllBackingsByWarrant(db, w.id);
        for (const b of backings) ids.push(b.id);
        const warrantRebuttals = findAllRebuttalsByTarget(db, w.id, "warrant");
        for (const r of warrantRebuttals) ids.push(r.id);
        ids.push(w.id);
      }
      const claimRebuttals = findAllRebuttalsByTarget(db, nodeId, "claim");
      for (const r of claimRebuttals) ids.push(r.id);
      ids.push(nodeId);
      break;
    }
    case "statement":
      ids.push(nodeId);
      break;
    case "warrant": {
      const backings = findAllBackingsByWarrant(db, nodeId);
      for (const b of backings) ids.push(b.id);
      const warrantRebuttals = findAllRebuttalsByTarget(db, nodeId, "warrant");
      for (const r of warrantRebuttals) ids.push(r.id);
      ids.push(nodeId);
      break;
    }
    default:
      ids.push(nodeId);
  }
  return ids;
}

/**
 * 删除节点，返回警告信息数组。
 *
 * `invalidate` is injected rather than imported: compile-service imports from this
 * module, so calling `invalidateCompiledClaims` directly would be circular. It runs
 * for every node in the cascade set, inside this transaction and before any row is
 * removed — the reverse lookup it depends on is unusable afterwards, and it mutates
 * (reverts Claim status, drops compile_state), so a delete that throws must take the
 * invalidation down with it.
 */
export function deleteNode(
  db: Database,
  nodeId: number,
  cascade: boolean = false,
  invalidate: (nodeId: number) => void = () => {}
): string[] {
  return db.transaction((): string[] => {
  const row = assertNodeExists(repo.getNodeById(db, nodeId), nodeId);
  const warnings: string[] = [];

  switch (row.type) {
    case "claim": {
      if (!cascade) {
        throw new CascadeRequiredError();
      }
      break;
    }

    case "statement": {
      // D1 警告: 检查是否被 Warrant 引用
      const usingWarrants = findWarrantsUsingGround(db, nodeId);
      if (usingWarrants.length > 0) {
        const wids = usingWarrants.map(w => `#${w.id}`).join(", ");
        warnings.push(WARNINGS.deleteGroundReferencedByWarrant(nodeId, wids));
      }
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
      break;
    }

    default:
      throw new ValidationError(`Unknown node type: ${row.type}`);
  }

  // One collection pass drives both invalidation and deletion — a second copy of
  // this traversal could drift and silently leave a collateral node uninvalidated.
  const collateralIds = collectCollateralNodeIds(db, nodeId, cascade);
  for (const id of collateralIds) {
    invalidate(id);
  }
  for (const id of collateralIds) {
    deleteNodeWithGroundCleanup(db, id);
  }

  return warnings;
  })();
}

// =============================================================================
// Tag operations
// =============================================================================

const TAG_NAME_REGEX = /^[a-z0-9][a-z0-9_-]*:[a-z0-9][a-z0-9_-]*$/;

/** Validate a tag name format, throwing ValidationError on failure */
function assertValidTagName(name: string): void {
  if (!TAG_NAME_REGEX.test(name)) {
    throw new ValidationError(
      `Invalid tag name: "${name}". Tag names must match the format <namespace>:<name>, ` +
      `e.g., "theme:attention-mechanism". Only lowercase letters, digits, hyphens, and underscores are allowed.`
    );
  }
}

/** Build a near-match suggestions map for finding similar tags */
function buildTagCounts(db: Database): Map<string, number> {
  const tags = repo.listTagsWithCount(db);
  const map = new Map<string, number>();
  for (const t of tags) {
    map.set(t.name, t.count);
  }
  return map;
}

/**
 * Assert that all tags in the list are registered.
 * Throws ValidationError with near-match suggestions for unregistered tags.
 *
 * Exported because the bulk entry points (`create_statements`, `tag_nodes`)
 * must produce the same suggestion quality as the single-node paths — the
 * near-match suggestion is the core of the vocabulary-consistency mechanism,
 * so a hand-rolled existence check at a bulk entry point is a regression.
 */
export function assertTagsRegistered(db: Database, tags: string[]): void {
  const allNames = repo.getAllTagNames(db);
  const allNamesSet = new Set(allNames);

  for (const tag of tags) {
    if (allNamesSet.has(tag)) continue;
    // §4.3: similarity is computed only once existence has already failed,
    // so the normal write path never pays for the count aggregation.
    const cardinalityLookup = (ns: string) => repo.getNamespaceCardinality(db, ns);
    const nearMatches = findNearMatches(tag, allNames, buildTagCounts(db), cardinalityLookup);
    const suggestion =
      nearMatches.length > 0
        ? nearMatches.map(m => `${m.name} (${m.count} nodes)`).join(", ")
        : "(none)";
    throw new ValidationError(HINTS.tagNotRegistered(tag, suggestion));
  }
}

/**
 * Register a single tag.
 * Format validation, near-match warnings, cardinality declaration handling.
 */
export function createTagService(
  db: Database,
  name: string,
  description: string,
  claimId?: number,
  namespaceCardinality?: NamespaceCardinality
): { tag: TagRow; warnings: string[] } {
  assertValidTagName(name);

  // Check if already exists
  const existing = repo.getTag(db, name);
  if (existing) {
    throw new ValidationError(`Tag "${name}" already exists.`);
  }

  // Validate claim_id if provided
  if (claimId !== undefined) {
    const claimRow = repo.getNodeById(db, claimId);
    if (!claimRow) throw new NotFoundError(claimId);
    if (claimRow.type !== "claim") {
      throw new TypeMismatchError(claimId, "claim", claimRow.type);
    }
  }

  const warnings: string[] = [];

  // Cardinality declaration handling
  const namespace = name.split(":")[0];
  const existingCardinality = repo.getNamespaceCardinality(db, namespace);
  if (namespaceCardinality !== undefined) {
    if (existingCardinality === null) {
      // Not yet declared — store it
      repo.setNamespaceCardinality(db, namespace, namespaceCardinality);
    } else if (existingCardinality !== namespaceCardinality) {
      // Already declared with a different value — warning, no overwrite
      warnings.push(
        `Namespace "${namespace}:" is already declared ${existingCardinality}; ignoring "${namespaceCardinality}". ` +
        `Use a dedicated call if you really mean to change it.`
      );
    }
  }

  // Near-match check (soft warning)
  const allTags = repo.getAllTagNames(db);
  const tagCounts = buildTagCounts(db);
  const cardinalityLookup = (ns: string) => repo.getNamespaceCardinality(db, ns);
  const nearMatches = findNearMatches(name, allTags, tagCounts, cardinalityLookup);
  for (const m of nearMatches) {
    warnings.push(`Near-existing tag \`${m.name}\` (${m.count} nodes) — is this a different category?`);
  }

  const tag = repo.insertTag(db, name, description, claimId);
  return { tag, warnings };
}

/**
 * Bulk register tags (cap 200, per-item independent).
 */
export function createTagsService(
  db: Database,
  tags: Array<{ name: string; description: string; claim_id?: number }>,
  namespaceCardinality?: NamespaceCardinality
): { registered: TagRow[]; failed: Array<{ name: string; reason: string }>; warnings: string[] } {
  const registered: TagRow[] = [];
  const failed: Array<{ name: string; reason: string }> = [];
  const warnings: string[] = [];

  const maxBatch = 200;
  if (tags.length > maxBatch) {
    throw new ValidationError(`Batch size exceeds maximum of ${maxBatch} tags.`);
  }
  const batch = tags.slice(0, maxBatch);

  for (const item of batch) {
    try {
      const result = createTagService(db, item.name, item.description, item.claim_id, namespaceCardinality);
      registered.push(result.tag);
      warnings.push(...result.warnings);
    } catch (e) {
      failed.push({ name: item.name, reason: formatServiceError(e) });
    }
  }

  return { registered, failed, warnings };
}

/** Extract error message from a thrown value */
function formatServiceError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Update a tag's description and/or claim_id.
 * `claim_id` goes through the same Claim-type guard as registration: a tag's
 * claim pointer means "the Claim that generalizes this category" (§0.4), so it
 * must not be reachable through a path that skips the type check.
 */
export function updateTagService(
  db: Database,
  name: string,
  description?: string,
  claimId?: number
): TagRow {
  const existing = repo.getTag(db, name);
  if (!existing) {
    throw new ValidationError(`Tag "${name}" does not exist.`);
  }

  if (claimId !== undefined) {
    const claimRow = repo.getNodeById(db, claimId);
    if (!claimRow) throw new NotFoundError(claimId);
    if (claimRow.type !== "claim") {
      throw new TypeMismatchError(claimId, "claim", claimRow.type);
    }
  }

  repo.updateTag(db, name, description, claimId);
  return repo.getTag(db, name)!;
}

/**
 * Rename a tag. `from` must exist; `to` must be format-legal and must not exist.
 */
export function renameTagService(db: Database, from: string, to: string): { moved: number } {
  const existing = repo.getTag(db, from);
  if (!existing) {
    throw new ValidationError(`Tag "${from}" does not exist.`);
  }
  assertValidTagName(to);
  const targetExisting = repo.getTag(db, to);
  if (targetExisting) {
    throw new ValidationError(`Tag "${to}" already exists.`);
  }

  repo.renameTag(db, from, to);
  // Count affected nodes from node_tags for the new name
  const moved = (db.prepare("SELECT COUNT(*) AS cnt FROM node_tags WHERE tag = ?").get(to) as { cnt: number }).cnt;
  return { moved };
}

/**
 * Merge tag `from` into `to`. Both must exist.
 * If `from` has a claim_id and `to` does not → warning.
 */
export function mergeTagsService(db: Database, from: string, to: string): { moved: number; warnings: string[] } {
  const fromTag = repo.getTag(db, from);
  const toTag = repo.getTag(db, to);
  if (!fromTag) throw new ValidationError(`Tag "${from}" does not exist.`);
  if (!toTag) throw new ValidationError(`Tag "${to}" does not exist.`);

  const warnings: string[] = [];
  if (fromTag.claim_id !== null && toTag.claim_id === null) {
    warnings.push(
      `Tag "${from}" has a claim_id (#${fromTag.claim_id}) but "${to}" does not. ` +
      `Consider revising the Claim to point at the merged tag.`
    );
  }

  const moved = repo.mergeTags(db, from, to);
  return { moved, warnings };
}

/**
 * Warranted — Repository 层
 *
 * 纯 SQL 操作，不含业务逻辑。所有函数接收 Database 作为首参数。
 */

import type { Database } from "bun:sqlite";
import type { NodeRow, NodeType, NodeData, CompileState, CompileStateVerdict, TagRow, NamespaceCardinality } from "./types.ts";

// =============================================================================
// 基础 CRUD
// =============================================================================

/** 插入节点，返回插入后的完整行 */
export function insertNode(
  db: Database,
  type: NodeType,
  content: string,
  data: NodeData = {} as NodeData
): NodeRow {
  const now = new Date().toISOString().slice(0, 19);
  const dataJson = JSON.stringify(data);
  const stmt = db.prepare(
    "INSERT INTO nodes (type, content, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  );
  const result = stmt.run(type, content, dataJson, now, now);
  const id = result.lastInsertRowid as number;
  return {
    id,
    type,
    content,
    data: dataJson,
    created_at: now,
    updated_at: now,
  };
}

/** 按 ID 获取节点 */
export function getNodeById(db: Database, id: number): NodeRow | null {
  const stmt = db.prepare("SELECT * FROM nodes WHERE id = ?");
  const row = stmt.get(id) as NodeRow | null;
  return row;
}

/** 更新节点字段 */
export function updateNodeFields(
  db: Database,
  id: number,
  updates: { content?: string; data?: NodeData }
): NodeRow | null {
  const existing = getNodeById(db, id);
  if (!existing) return null;

  const now = new Date().toISOString().slice(0, 19);
  const newContent = updates.content !== undefined ? updates.content : existing.content;
  const newData = updates.data !== undefined ? JSON.stringify(updates.data) : existing.data;

  const stmt = db.prepare(
    "UPDATE nodes SET content = ?, data = ?, updated_at = ? WHERE id = ?"
  );
  stmt.run(newContent, newData, now, id);

  return { ...existing, content: newContent, data: newData, updated_at: now };
}

/** 恢复已删除的节点（保留原 ID），用于回滚 */
export function restoreNode(db: Database, node: NodeRow): void {
  const stmt = db.prepare(
    "INSERT INTO nodes (id, type, content, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  stmt.run(node.id, node.type, node.content, node.data, node.created_at, node.updated_at);
}

/** 删除节点 */
export function deleteNodeById(db: Database, id: number): boolean {
  const stmt = db.prepare("DELETE FROM nodes WHERE id = ?");
  const result = stmt.run(id);
  return result.changes > 0;
}

// =============================================================================
// 查询辅助
// =============================================================================

/** 按类型列出所有节点 */
export function listNodesByType(db: Database, type: NodeType): NodeRow[] {
  const stmt = db.prepare("SELECT * FROM nodes WHERE type = ? ORDER BY id");
  return stmt.all(type) as NodeRow[];
}

/** 查找绑定到指定 Claim 的所有 Warrant */
export function findWarrantsByClaim(db: Database, claimId: number): NodeRow[] {
  const stmt = db.prepare(
    "SELECT * FROM nodes WHERE type = 'warrant' AND CAST(json_extract(data, '$.claim_id') AS INTEGER) = ? ORDER BY id"
  );
  return stmt.all(claimId) as NodeRow[];
}

/** 查找绑定到指定 Warrant 的所有 Backing（via warrant_backings 关系表） */
export function findBackingsByWarrant(db: Database, warrantId: number): NodeRow[] {
  const stmt = db.prepare(
    "SELECT n.* FROM nodes n JOIN warrant_backings wb ON n.id = wb.statement_id WHERE wb.warrant_id = ? ORDER BY n.id"
  );
  return stmt.all(warrantId) as NodeRow[];
}

/** 查找指向指定 target 的所有 Rebuttal（via rebuttal_targets 关系表） */
export function findRebuttalsByTarget(
  db: Database,
  targetId: number,
  targetType?: string
): NodeRow[] {
  let sql = "SELECT n.* FROM nodes n JOIN rebuttal_targets rt ON n.id = rt.statement_id WHERE rt.target_id = ?";
  const params: (string | number)[] = [targetId];
  if (targetType) {
    sql += " AND rt.target_type = ?";
    params.push(targetType);
  }
  sql += " ORDER BY n.id";
  const stmt = db.prepare(sql);
  return stmt.all(...params) as NodeRow[];
}

/**
 * Build tag filter SQL clause and params for EXISTS/NOT EXISTS subquery.
 * Shared between searchNodes (LIKE) and searchNodesFts (FTS) to avoid duplication.
 */
export function tagFilterClause(tag: string | undefined, negate: boolean, alias: string): { clause: string; params: string[] } {
  if (!tag) return { clause: "", params: [] };
  const op = negate ? "NOT EXISTS" : "EXISTS";
  if (tag.includes("*")) {
    return {
      clause: ` AND ${op} (SELECT 1 FROM node_tags nt WHERE nt.node_id = ${alias}.id AND nt.tag LIKE ?)`,
      params: [tag.replace(/\*/g, "%")],
    };
  }
  return {
    clause: ` AND ${op} (SELECT 1 FROM node_tags nt WHERE nt.node_id = ${alias}.id AND nt.tag = ?)`,
    params: [tag],
  };
}

/** 搜索节点（LIKE 模糊匹配，支持分页和标签过滤） */
export function searchNodes(
  db: Database,
  keyword: string,
  typeFilter?: NodeType,
  opts?: { tag?: string; without_tag?: string; limit?: number; offset?: number }
): { rows: NodeRow[]; total: number } {
  const { tag, without_tag, limit = 20, offset = 0 } = opts ?? {};
  const like = `%${keyword}%`;

  // Count query
  let countSql = "SELECT COUNT(*) AS cnt FROM nodes n WHERE n.content LIKE ?";
  const countParams: (string | number)[] = [like];

  // Data query
  let sql = "SELECT n.* FROM nodes n WHERE n.content LIKE ?";
  const params: (string | number)[] = [like];

  if (typeFilter) {
    countSql += " AND n.type = ?";
    sql += " AND n.type = ?";
    countParams.push(typeFilter);
    params.push(typeFilter);
  }

  const t1 = tagFilterClause(tag, false, "n");
  countSql += t1.clause; countParams.push(...t1.params);
  sql += t1.clause; params.push(...t1.params);

  const t2 = tagFilterClause(without_tag, true, "n");
  countSql += t2.clause; countParams.push(...t2.params);
  sql += t2.clause; params.push(...t2.params);

  const total = (db.prepare(countSql).get(...countParams) as { cnt: number }).cnt;

  sql += " ORDER BY n.id LIMIT ? OFFSET ?";
  params.push(limit, offset);
  const rows = db.prepare(sql).all(...params) as NodeRow[];

  return { rows, total };
}

/** 搜索节点（FTS5 全文检索，支持分页和标签过滤） */
export function searchNodesFts(
  db: Database,
  query: string,
  opts: { type?: string; tag?: string; without_tag?: string; limit: number; offset: number }
): { rows: NodeRow[]; total: number } {
  const { type, tag, without_tag, limit, offset } = opts;
  const escaped = `"${query.replaceAll('"', '""')}"`;

  // Count query
  let countSql = "SELECT COUNT(*) AS cnt FROM nodes_fts f JOIN nodes n ON n.id = f.rowid WHERE nodes_fts MATCH ?";
  const countParams: (string | number)[] = [escaped];

  // Data query
  let sql = "SELECT n.* FROM nodes_fts f JOIN nodes n ON n.id = f.rowid WHERE nodes_fts MATCH ?";
  const params: (string | number)[] = [escaped];

  if (type) {
    countSql += " AND n.type = ?";
    sql += " AND n.type = ?";
    countParams.push(type);
    params.push(type);
  }

  const t1 = tagFilterClause(tag, false, "n");
  countSql += t1.clause; countParams.push(...t1.params);
  sql += t1.clause; params.push(...t1.params);

  const t2 = tagFilterClause(without_tag, true, "n");
  countSql += t2.clause; countParams.push(...t2.params);
  sql += t2.clause; params.push(...t2.params);

  const total = (db.prepare(countSql).get(...countParams) as { cnt: number }).cnt;

  sql += " ORDER BY f.rank LIMIT ? OFFSET ?";
  params.push(limit, offset);
  const rows = db.prepare(sql).all(...params) as NodeRow[];

  return { rows, total };
}

/** 统计各类型节点数量 */
export function countNodesByType(db: Database): Record<string, number> {
  const stmt = db.prepare("SELECT type, COUNT(*) as count FROM nodes GROUP BY type");
  const rows = stmt.all() as Array<{ type: string; count: number }>;
  const result: Record<string, number> = {
    claim: 0,
    statement: 0,
    warrant: 0,
  };
  for (const row of rows) {
    result[row.type] = row.count;
  }
  return result;
}

// =============================================================================
// 关系表操作
// =============================================================================

/** 查找 Warrant 的所有 Ground（via warrant_grounds 关系表） */
export function findGroundsByWarrant(db: Database, warrantId: number): NodeRow[] {
  const stmt = db.prepare(
    "SELECT n.* FROM nodes n JOIN warrant_grounds wg ON n.id = wg.ground_id WHERE wg.warrant_id = ? ORDER BY n.id"
  );
  return stmt.all(warrantId) as NodeRow[];
}

/**
 * 查找 Warrant 的 Ground ID 列表 —— warrant_grounds 是这个集合的唯一记录。
 *
 * 只要 id 就走这里，不要读节点 blob 里的 ground_ids：那个字段已经删掉了。
 * 之前它和本表并存，两边各有消费者，重复的 id 只进得了 blob 一边，于是
 * 逻辑审查看到 3 条 ground 而结构审查看到 2 条。
 *
 * 返回按 id 升序，与 findGroundsByWarrant 同序。
 */
export function findGroundIdsByWarrant(db: Database, warrantId: number): number[] {
  const rows = db.prepare(
    "SELECT ground_id FROM warrant_grounds WHERE warrant_id = ? ORDER BY ground_id"
  ).all(warrantId) as Array<{ ground_id: number }>;
  return rows.map(r => r.ground_id);
}

/** 从 warrant_grounds 删除某个 Ground 的全部关系 */
export function removeGroundFromAllWarrants(db: Database, groundId: number): void {
  db.prepare("DELETE FROM warrant_grounds WHERE ground_id = ?").run(groundId);
}

/** 插入 warrant_grounds 关系 */
export function insertWarrantGround(db: Database, warrantId: number, groundId: number): void {
  db.prepare("INSERT OR IGNORE INTO warrant_grounds (warrant_id, ground_id) VALUES (?, ?)").run(warrantId, groundId);
}

/** 插入 warrant_backings 关系 */
export function insertWarrantBacking(db: Database, warrantId: number, statementId: number): void {
  db.prepare("INSERT OR IGNORE INTO warrant_backings (warrant_id, statement_id) VALUES (?, ?)").run(warrantId, statementId);
}

/** 插入 rebuttal_targets 关系 */
export function insertRebuttalTarget(db: Database, statementId: number, targetId: number, targetType: string): void {
  db.prepare("INSERT OR IGNORE INTO rebuttal_targets (statement_id, target_id, target_type) VALUES (?, ?, ?)").run(statementId, targetId, targetType);
}

/** 删除 rebuttal_targets 关系 */
export function deleteRebuttalTarget(db: Database, statementId: number, targetId?: number): void {
  if (targetId !== undefined) {
    db.prepare("DELETE FROM rebuttal_targets WHERE statement_id = ? AND target_id = ?").run(statementId, targetId);
  } else {
    db.prepare("DELETE FROM rebuttal_targets WHERE statement_id = ?").run(statementId);
  }
}

/** 批量向 warrant_backings 添加关系 */
export function addWarrantBackings(db: Database, warrantId: number, ids: number[]): void {
  for (const id of ids) {
    db.prepare("INSERT OR IGNORE INTO warrant_backings (warrant_id, statement_id) VALUES (?, ?)").run(warrantId, id);
  }
}

/** 批量从 warrant_backings 移除关系 */
export function removeWarrantBackings(db: Database, warrantId: number, ids: number[]): void {
  for (const id of ids) {
    db.prepare("DELETE FROM warrant_backings WHERE warrant_id = ? AND statement_id = ?").run(warrantId, id);
  }
}

/** 批量向 rebuttal_targets 添加关系 */
export function addRebuttalTargets(db: Database, nodeId: number, ids: number[], targetType: string): void {
  for (const id of ids) {
    db.prepare("INSERT OR IGNORE INTO rebuttal_targets (statement_id, target_id, target_type) VALUES (?, ?, ?)").run(nodeId, id, targetType);
  }
}

/** 批量从 rebuttal_targets 移除关系 */
export function removeRebuttalTargets(db: Database, nodeId: number, ids: number[]): void {
  for (const id of ids) {
    db.prepare("DELETE FROM rebuttal_targets WHERE statement_id = ? AND target_id = ?").run(nodeId, id);
  }
}

// =============================================================================
// Tag operations
// =============================================================================

/** Insert a tag */
export function insertTag(db: Database, name: string, description: string, claimId?: number): TagRow {
  const stmt = db.prepare(
    "INSERT INTO tags (name, description, claim_id) VALUES (?, ?, ?)"
  );
  stmt.run(name, description, claimId ?? null);
  return {
    name,
    description,
    claim_id: claimId ?? null,
    created_at: new Date().toISOString().slice(0, 19),
  };
}

/** Get a tag by name */
export function getTag(db: Database, name: string): TagRow | null {
  const row = db.prepare("SELECT * FROM tags WHERE name = ?").get(name) as TagRow | null;
  return row ?? null;
}

/**
 * List all tags with their node counts, with optional filtering and pagination.
 * `limit` omitted means unbounded — internal callers that aggregate over the whole
 * vocabulary must not silently see only the first page.
 */
export function listTagsWithCount(
  db: Database,
  opts?: { prefix?: string; min_count?: number; limit?: number; offset?: number }
): (TagRow & { count: number })[] {
  const { sql: filtered, params } = tagCountQuery(opts);
  let sql = `${filtered} ORDER BY t.name`;

  if (opts?.limit !== undefined) {
    sql += " LIMIT ? OFFSET ?";
    params.push(opts.limit, opts.offset ?? 0);
  }

  return db.prepare(sql).all(...params) as (TagRow & { count: number })[];
}

/** Total tags matching the same filters as listTagsWithCount, ignoring pagination. */
export function countTags(db: Database, opts?: { prefix?: string; min_count?: number }): number {
  const { sql, params } = tagCountQuery(opts);
  return (db.prepare(`SELECT COUNT(*) AS cnt FROM (${sql}) AS sub`).get(...params) as { cnt: number }).cnt;
}

function tagCountQuery(opts?: { prefix?: string; min_count?: number }): { sql: string; params: (string | number)[] } {
  let sql = "SELECT t.*, COUNT(nt.node_id) AS count FROM tags t LEFT JOIN node_tags nt ON nt.tag = t.name";
  const params: (string | number)[] = [];

  if (opts?.prefix) {
    sql += " WHERE t.name LIKE ?";
    params.push(`${opts.prefix}%`);
  }

  sql += " GROUP BY t.name";

  // min_count=0 means "registered with no node attached" (the work-queue signal),
  // not "no minimum" — an unset min_count already means that.
  if (opts?.min_count !== undefined) {
    sql += opts.min_count === 0 ? " HAVING count = 0" : " HAVING count >= ?";
    if (opts.min_count !== 0) params.push(opts.min_count);
  }

  return { sql, params };
}

/** Rename a tag (node_tags follows via ON UPDATE CASCADE) */
export function renameTag(db: Database, from: string, to: string): void {
  db.prepare("UPDATE tags SET name = ? WHERE name = ?").run(to, from);
}

/** Merge one tag into another: move all node_tags, delete the source tag */
export function mergeTags(db: Database, from: string, to: string): number {
  return db.transaction((): number => {
    // Count how many node_tags entries will be moved
    const beforeCount = (db.prepare("SELECT COUNT(*) AS cnt FROM node_tags WHERE tag = ?").get(from) as { cnt: number }).cnt;
    // Move node_tags entries (INSERT OR IGNORE for overlap)
    db.prepare(
      "INSERT OR IGNORE INTO node_tags (node_id, tag) SELECT node_id, ? FROM node_tags WHERE tag = ?"
    ).run(to, from);
    // Remove old node_tags entries
    db.prepare("DELETE FROM node_tags WHERE tag = ?").run(from);
    // Delete the source tag
    db.prepare("DELETE FROM tags WHERE name = ?").run(from);
    return beforeCount;
  })();
}

/** Add tags to a node (INSERT OR IGNORE) */
export function addNodeTags(db: Database, nodeId: number, tags: string[]): void {
  const stmt = db.prepare("INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, ?)");
  for (const tag of tags) {
    stmt.run(nodeId, tag);
  }
}

/** Remove tags from a node */
export function removeNodeTags(db: Database, nodeId: number, tags: string[]): void {
  const stmt = db.prepare("DELETE FROM node_tags WHERE node_id = ? AND tag = ?");
  for (const tag of tags) {
    stmt.run(nodeId, tag);
  }
}

/** Get all tags for a node */
export function getNodeTags(db: Database, nodeId: number): string[] {
  return (db.prepare("SELECT tag FROM node_tags WHERE node_id = ? ORDER BY tag").all(nodeId) as { tag: string }[]).map(r => r.tag);
}

/** Find nodes by tag, optionally filtered by type */
export function findNodesByTag(db: Database, tag: string, typeFilter?: string): NodeRow[] {
  let sql = "SELECT n.* FROM nodes n JOIN node_tags nt ON n.id = nt.node_id WHERE nt.tag = ?";
  const params: (string | number)[] = [tag];
  if (typeFilter) {
    sql += " AND n.type = ?";
    params.push(typeFilter);
  }
  sql += " ORDER BY n.id";
  return db.prepare(sql).all(...params) as NodeRow[];
}

/** Get all registered tag names */
export function getAllTagNames(db: Database): string[] {
  return (db.prepare("SELECT name FROM tags ORDER BY name").all() as { name: string }[]).map(r => r.name);
}

/** Update a tag's description and/or claim_id */
export function updateTag(db: Database, name: string, description?: string, claim_id?: number): void {
  const stmt = db.prepare("UPDATE tags SET description = COALESCE(?, description), claim_id = COALESCE(?, claim_id) WHERE name = ?");
  stmt.run(description ?? null, claim_id ?? null, name);
}

/** Get namespace cardinality declaration */
export function getNamespaceCardinality(db: Database, namespace: string): NamespaceCardinality | null {
  const row = db.prepare("SELECT cardinality FROM tag_namespaces WHERE namespace = ?").get(namespace) as { cardinality: NamespaceCardinality } | null;
  return row?.cardinality ?? null;
}

/** Set namespace cardinality (INSERT OR REPLACE) */
export function setNamespaceCardinality(db: Database, namespace: string, cardinality: NamespaceCardinality): void {
  db.prepare("INSERT OR REPLACE INTO tag_namespaces (namespace, cardinality) VALUES (?, ?)").run(namespace, cardinality);
}

// =============================================================================
// Compile 状态操作
//
// compile_state 是 Claim 编译状态的唯一存储。四种互斥状态：
//   没有行            = 从未编译过
//   verdict='passed'  = 编译通过，argument_hash 是通过时的结构指纹
//   verdict='failed'  = 编译未通过（argument_hash 为 NULL）
//   verdict='stale'   = 曾经通过，但通过的那个结构已被改动（argument_hash 已清空）
// =============================================================================

/** 记录一次编译结果（INSERT OR REPLACE）。argumentHash 只应在 verdict === "passed" 时传入。 */
export function saveCompileState(
  db: Database,
  claimId: number,
  verdict: CompileStateVerdict,
  summary: string,
  argumentHash?: string
): void {
  const now = new Date().toISOString().slice(0, 19);
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO compile_state (claim_id, verdict, summary, node_hashes, argument_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  stmt.run(claimId, verdict, summary, "{}", argumentHash ?? null, now);
}

/** 获取 compile 状态；null 表示从未编译过 */
export function getCompileState(db: Database, claimId: number): CompileState | null {
  const stmt = db.prepare("SELECT * FROM compile_state WHERE claim_id = ?");
  const row = stmt.get(claimId) as { claim_id: number; verdict: string; summary: string; node_hashes: string; argument_hash: string | null; created_at: string } | null;
  if (!row) return null;
  return {
    claimId: row.claim_id,
    verdict: row.verdict as CompileStateVerdict,
    summary: row.summary,
    argumentHash: row.argument_hash ?? undefined,
    createdAt: row.created_at,
  };
}

/** 批量获取 compile 状态，键为 claimId。用于避免 get_stats / list_claims 里的逐个查询。 */
export function getAllCompileVerdicts(db: Database): Map<number, CompileStateVerdict> {
  const rows = db.prepare("SELECT claim_id, verdict FROM compile_state").all() as Array<{ claim_id: number; verdict: string }>;
  return new Map(rows.map(r => [r.claim_id, r.verdict as CompileStateVerdict]));
}

/** 删除 compile 状态（回到"从未编译过"） */
export function deleteCompileState(db: Database, claimId: number): void {
  const stmt = db.prepare("DELETE FROM compile_state WHERE claim_id = ?");
  stmt.run(claimId);
}

/**
 * 把"通过"降级为"过期"，并清空结构指纹。
 *
 * 只有 passed 会被改动 —— 只有通过过的东西才谈得上过期。failed 保持 failed（信息量更大，
 * 且同样挡住状态转换）；没有行则保持没有行（从未编译过不该变成过期）。
 *
 * 清空 argument_hash 而非删掉整行：compileClaims 用 `prevState.argumentHash` 判断能否
 * 走"哈希未变就跳过"的捷径（compile-service.ts），置 NULL 即可让它正确地落到重新审查
 * 的分支；同时保留了"这个主张编译过"这一事实，不会被 get_stats 误算成从未编译过。
 *
 * 返回是否真的改动了一行。调用点报告"降级了"必须用这个返回值，不能从"走到了哪个分支"
 * 推断：同一个分支在 failed / 没有记录 的 Claim 上什么都不改（见 D26）。
 */
export function markCompileStale(db: Database, claimId: number): boolean {
  const result = db.prepare(
    "UPDATE compile_state SET verdict = 'stale', argument_hash = NULL WHERE claim_id = ? AND verdict = 'passed'"
  ).run(claimId);
  return result.changes > 0;
}

/** 设置 ClaimData 的 status 字段 */
export function setClaimStatus(db: Database, claimId: number, status: string): void {
  const row = db.prepare("SELECT data FROM nodes WHERE id = ?").get(claimId) as { data: string } | null;
  if (!row) return;
  const data = JSON.parse(row.data);
  data.status = status;
  db.prepare("UPDATE nodes SET data = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(data), new Date().toISOString().slice(0, 19), claimId);
}

// =============================================================================
// 辅助函数
// =============================================================================

/** 解析 NodeRow 的 data JSON */
export function parseNodeData(row: NodeRow): Record<string, unknown> {
  try {
    return JSON.parse(row.data);
  } catch {
    return {};
  }
}

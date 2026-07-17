/**
 * Toulmin MCP — Repository 层
 *
 * 纯 SQL 操作，不含业务逻辑。所有函数接收 Database 作为首参数。
 */

import type { Database } from "bun:sqlite";
import type { NodeRow, NodeType, NodeData, CompileState } from "./types.ts";

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

/** 查找绑定到指定 Warrant 的所有 Backing */
export function findBackingsByWarrant(db: Database, warrantId: number): NodeRow[] {
  const stmt = db.prepare(
    "SELECT * FROM nodes WHERE type = 'backing' AND CAST(json_extract(data, '$.warrant_id') AS INTEGER) = ? ORDER BY id"
  );
  return stmt.all(warrantId) as NodeRow[];
}

/** 查找指向指定 target 的所有 Rebuttal */
export function findRebuttalsByTarget(
  db: Database,
  targetId: number,
  targetType?: string
): NodeRow[] {
  let sql = "SELECT * FROM nodes WHERE type = 'rebuttal' AND CAST(json_extract(data, '$.target_id') AS INTEGER) = ?";
  const params: (string | number)[] = [targetId];
  if (targetType) {
    sql += " AND json_extract(data, '$.target_type') = ?";
    params.push(targetType);
  }
  sql += " ORDER BY id";
  const stmt = db.prepare(sql);
  return stmt.all(...params) as NodeRow[];
}

/** 查找引用指定 Claim 作为证据的 Ground（链式推理） */
export function findGroundsByRefClaim(db: Database, claimId: number): NodeRow[] {
  const stmt = db.prepare(
    "SELECT * FROM nodes WHERE type = 'ground' AND CAST(json_extract(data, '$.ref_claim_id') AS INTEGER) = ? ORDER BY id"
  );
  return stmt.all(claimId) as NodeRow[];
}

/** 搜索节点（LIKE 模糊匹配） */
export function searchNodes(
  db: Database,
  keyword: string,
  typeFilter?: NodeType
): NodeRow[] {
  let sql = "SELECT * FROM nodes WHERE content LIKE ?";
  const params: (string | number)[] = [`%${keyword}%`];
  if (typeFilter) {
    sql += " AND type = ?";
    params.push(typeFilter);
  }
  sql += " ORDER BY id";
  const stmt = db.prepare(sql);
  return stmt.all(...params) as NodeRow[];
}

/** 统计各类型节点数量 */
export function countNodesByType(db: Database): Record<string, number> {
  const stmt = db.prepare("SELECT type, COUNT(*) as count FROM nodes GROUP BY type");
  const rows = stmt.all() as Array<{ type: string; count: number }>;
  const result: Record<string, number> = {
    claim: 0,
    ground: 0,
    warrant: 0,
    backing: 0,
    rebuttal: 0,
  };
  for (const row of rows) {
    result[row.type] = row.count;
  }
  return result;
}

// =============================================================================
// JSON 数组操作（ground_ids）
// =============================================================================

/** 向 Warrant 的 ground_ids 追加 ID */
export function addGroundIds(db: Database, warrantId: number, ids: number[]): NodeRow | null {
  const row = getNodeById(db, warrantId);
  if (!row || row.type !== "warrant") return null;

  const data = JSON.parse(row.data);
  const existing: number[] = data.ground_ids || [];
  const newIds = [...new Set([...existing, ...ids])];
  data.ground_ids = newIds;

  return updateNodeFields(db, warrantId, { data });
}

/** 从 Warrant 的 ground_ids 移除 ID */
export function removeGroundIds(db: Database, warrantId: number, ids: number[]): NodeRow | null {
  const row = getNodeById(db, warrantId);
  if (!row || row.type !== "warrant") return null;

  const data = JSON.parse(row.data);
  const existing: number[] = data.ground_ids || [];
  data.ground_ids = existing.filter((id: number) => !ids.includes(id));

  return updateNodeFields(db, warrantId, { data });
}

/** 从所有 Warrant 的 ground_ids 中移除指定 Ground */
export function removeGroundFromAllWarrants(db: Database, groundId: number): void {
  const stmt = db.prepare("SELECT * FROM nodes WHERE type = 'warrant'");
  const warrants = stmt.all() as NodeRow[];

  for (const w of warrants) {
    const data = JSON.parse(w.data);
    const ids: number[] = data.ground_ids || [];
    if (ids.includes(groundId)) {
      data.ground_ids = ids.filter((id: number) => id !== groundId);
      updateNodeFields(db, w.id, { data });
    }
  }
}

// =============================================================================
// Compile 状态操作
// =============================================================================

/** 保存 compile 状态（INSERT OR REPLACE） */
export function saveCompileState(
  db: Database,
  claimId: number,
  verdict: string,
  summary: string,
  argumentHash?: string
): void {
  const now = new Date().toISOString().slice(0, 19);
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO compile_state (claim_id, verdict, summary, node_hashes, argument_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  stmt.run(claimId, verdict, summary, "{}", argumentHash ?? null, now);
}

/** 获取 compile 状态 */
export function getCompileState(db: Database, claimId: number): CompileState | null {
  const stmt = db.prepare("SELECT * FROM compile_state WHERE claim_id = ?");
  const row = stmt.get(claimId) as { claim_id: number; verdict: string; summary: string; node_hashes: string; argument_hash: string | null; created_at: string } | null;
  if (!row) return null;
  return {
    claimId: row.claim_id,
    verdict: row.verdict as "passed" | "failed",
    summary: row.summary,
    argumentHash: row.argument_hash ?? undefined,
    createdAt: row.created_at,
  };
}

/** 删除 compile 状态 */
export function deleteCompileState(db: Database, claimId: number): void {
  const stmt = db.prepare("DELETE FROM compile_state WHERE claim_id = ?");
  stmt.run(claimId);
}

/** 设置 ClaimData 的 compile_status 字段 */
export function setCompileStatus(db: Database, claimId: number, status: "passed" | "stale" | null): void {
  const row = db.prepare("SELECT data FROM nodes WHERE id = ?").get(claimId) as { data: string } | null;
  if (!row) return;
  const data = JSON.parse(row.data);
  data.compile_status = status;
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

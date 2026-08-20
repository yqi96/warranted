/**
 * Warranted — 数据访问层(repo)
 *
 * 只做**原始读写**:一次 SQL 一件事,不做校验、不算判据、不写事件。
 * 业务规则(V1–V3 硬拒、结构检查、基线单写入者、事件留痕)全在 service 层。
 *
 * 这条分层不是洁癖:结构检查要在"改完之后"跑,事件要在"同一事务内"写,
 * 两件事都得看见完整的一次操作。repo 只看得见单条 SQL,放在这里必然写歪。
 */

import type { Database } from "bun:sqlite";
import type {
  PropositionRow,
  Qualifier,
  EventRow,
  EventOp,
  EventActor,
  BaselineHead,
  BaselineRef,
  RefRole,
  Finding,
} from "./types.ts";
import { isFtsAvailable } from "./db.ts";

// =============================================================================
// 命题
// =============================================================================

export function insertProposition(
  db: Database,
  content: string,
  warrantText: string | null
): PropositionRow {
  const row = db
    .prepare(
      `INSERT INTO propositions (content, warrant_text) VALUES (?, ?) RETURNING *`
    )
    .get(content, warrantText) as PropositionRow;
  return row;
}

export function getProposition(db: Database, id: number): PropositionRow | null {
  return (db.prepare("SELECT * FROM propositions WHERE id = ?").get(id) as
    | PropositionRow
    | undefined) ?? null;
}

export function getPropositions(db: Database, ids: number[]): PropositionRow[] {
  if (ids.length === 0) return [];
  const ph = ids.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM propositions WHERE id IN (${ph}) ORDER BY id`)
    .all(...ids) as PropositionRow[];
}

export function propositionExists(db: Database, id: number): boolean {
  return db.prepare("SELECT 1 FROM propositions WHERE id = ?").get(id) !== null;
}

/**
 * 改 content / 理由槽。`updated_at` 在这里显式刷新,不用触发器——
 * 触发器会在 qualifier 变更时也刷,而"判断"与"改事实"必须在时间线上分得开。
 */
export function updatePropositionFields(
  db: Database,
  id: number,
  fields: { content?: string; warrantText?: string | null; warrantNodeId?: number | null }
): void {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (fields.content !== undefined) {
    sets.push("content = ?");
    params.push(fields.content);
  }
  if (fields.warrantText !== undefined) {
    sets.push("warrant_text = ?");
    params.push(fields.warrantText);
  }
  if (fields.warrantNodeId !== undefined) {
    sets.push("warrant_node_id = ?");
    params.push(fields.warrantNodeId);
  }
  if (sets.length === 0) return;

  sets.push("updated_at = datetime('now')");
  params.push(id);
  db.prepare(`UPDATE propositions SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

/** 只有 set_qualifier 走这里(基线单写入者的第一道落地)。 */
export function writeQualifier(db: Database, id: number, qualifier: Qualifier): void {
  db.prepare(
    "UPDATE propositions SET qualifier = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(qualifier, id);
}

/** 成员清单变了也算这条命题变了(重查触发条件①),所以增删槽位成员后要刷一次。 */
export function touchProposition(db: Database, id: number): void {
  db.prepare("UPDATE propositions SET updated_at = datetime('now') WHERE id = ?").run(id);
}

export function deleteProposition(db: Database, id: number): boolean {
  const res = db.prepare("DELETE FROM propositions WHERE id = ?").run(id);
  return res.changes > 0;
}

export function countByQualifier(db: Database): Record<string, number> {
  const rows = db
    .prepare("SELECT qualifier, COUNT(*) AS cnt FROM propositions GROUP BY qualifier")
    .all() as Array<{ qualifier: string; cnt: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.qualifier] = r.cnt;
  return out;
}

export function countPropositions(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS cnt FROM propositions").get() as { cnt: number }).cnt;
}

export function allPropositionIds(db: Database): number[] {
  return (db.prepare("SELECT id FROM propositions ORDER BY id").all() as Array<{ id: number }>)
    .map((r) => r.id);
}

// =============================================================================
// 证据槽
// =============================================================================

export function getAttachments(db: Database, nodeId: number): string[] {
  return (
    db
      .prepare("SELECT path FROM evidence_attachments WHERE node_id = ? ORDER BY path")
      .all(nodeId) as Array<{ path: string }>
  ).map((r) => r.path);
}

export function addAttachments(db: Database, nodeId: number, paths: string[]): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO evidence_attachments (node_id, path) VALUES (?, ?)"
  );
  for (const p of paths) stmt.run(nodeId, p);
}

export function removeAttachments(db: Database, nodeId: number, paths: string[]): void {
  const stmt = db.prepare(
    "DELETE FROM evidence_attachments WHERE node_id = ? AND path = ?"
  );
  for (const p of paths) stmt.run(nodeId, p);
}

export function getEvidenceNodes(db: Database, nodeId: number): number[] {
  return (
    db
      .prepare("SELECT evidence_id FROM evidence_nodes WHERE node_id = ? ORDER BY evidence_id")
      .all(nodeId) as Array<{ evidence_id: number }>
  ).map((r) => r.evidence_id);
}

export function addEvidenceNodes(db: Database, nodeId: number, ids: number[]): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO evidence_nodes (node_id, evidence_id) VALUES (?, ?)"
  );
  for (const id of ids) stmt.run(nodeId, id);
}

export function removeEvidenceNodes(db: Database, nodeId: number, ids: number[]): void {
  const stmt = db.prepare(
    "DELETE FROM evidence_nodes WHERE node_id = ? AND evidence_id = ?"
  );
  for (const id of ids) stmt.run(nodeId, id);
}

/** 谁把这条命题挂在自己的证据槽里。删除时要按它列受影响清单。 */
export function findEvidenceReferrers(db: Database, evidenceId: number): number[] {
  return (
    db
      .prepare("SELECT node_id FROM evidence_nodes WHERE evidence_id = ? ORDER BY node_id")
      .all(evidenceId) as Array<{ node_id: number }>
  ).map((r) => r.node_id);
}

// =============================================================================
// 反驳槽
// =============================================================================

export function getRebuttals(db: Database, nodeId: number): number[] {
  return (
    db
      .prepare("SELECT rebuttal_id FROM rebuttals WHERE node_id = ? ORDER BY rebuttal_id")
      .all(nodeId) as Array<{ rebuttal_id: number }>
  ).map((r) => r.rebuttal_id);
}

export function addRebuttals(db: Database, nodeId: number, ids: number[]): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO rebuttals (node_id, rebuttal_id) VALUES (?, ?)"
  );
  for (const id of ids) stmt.run(nodeId, id);
}

export function removeRebuttals(db: Database, nodeId: number, ids: number[]): void {
  const stmt = db.prepare("DELETE FROM rebuttals WHERE node_id = ? AND rebuttal_id = ?");
  for (const id of ids) stmt.run(nodeId, id);
}

/** 这条命题在攻击谁。删除它时这些目标的反驳槽会少一条,属于成员清单变化。 */
export function findRebuttalTargets(db: Database, rebuttalId: number): number[] {
  return (
    db
      .prepare("SELECT node_id FROM rebuttals WHERE rebuttal_id = ? ORDER BY node_id")
      .all(rebuttalId) as Array<{ node_id: number }>
  ).map((r) => r.node_id);
}

/** 谁把这条命题当作(晋升后的)理由。 */
export function findWarrantReferrers(db: Database, warrantNodeId: number): number[] {
  return (
    db
      .prepare("SELECT id FROM propositions WHERE warrant_node_id = ? ORDER BY id")
      .all(warrantNodeId) as Array<{ id: number }>
  ).map((r) => r.id);
}

// =============================================================================
// 事件流(I8):只 INSERT 与 SELECT,没有 UPDATE / DELETE
// =============================================================================

export function appendEvent(
  db: Database,
  ev: {
    nodeId: number | null;
    op: EventOp;
    actor: EventActor;
    payload?: unknown;
    note?: string | null;
    targetKey?: string | null;
  }
): number {
  const row = db
    .prepare(
      `INSERT INTO events (node_id, op, actor, payload, note, target_key)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(
      ev.nodeId,
      ev.op,
      ev.actor,
      JSON.stringify(ev.payload ?? {}),
      ev.note ?? null,
      ev.targetKey ?? null
    ) as { id: number };
  return row.id;
}

export function listEvents(
  db: Database,
  opts: { nodeId?: number; limit?: number; offset?: number }
): { rows: EventRow[]; total: number } {
  const { nodeId, limit = 50, offset = 0 } = opts;
  const where = nodeId === undefined ? "" : " WHERE node_id = ?";
  const params = nodeId === undefined ? [] : [nodeId];

  const total = (
    db.prepare(`SELECT COUNT(*) AS cnt FROM events${where}`).get(...params) as { cnt: number }
  ).cnt;

  const rows = db
    .prepare(`SELECT * FROM events${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as EventRow[];

  return { rows, total };
}

export function getEvent(db: Database, id: number): EventRow | null {
  return (db.prepare("SELECT * FROM events WHERE id = ?").get(id) as EventRow | undefined) ?? null;
}

/**
 * 查一批 id 的驳回记录。
 *
 * "已阅"是**算出来**的:事件流里有没有同 target_key 的 dismiss 事件。
 * 同一个 id 被驳回多次时取最后一条(理由以最新的为准)。
 */
export function findDismissals(
  db: Database,
  targetKeys: string[]
): Map<string, { reason: string; at: string }> {
  const out = new Map<string, { reason: string; at: string }>();
  if (targetKeys.length === 0) return out;

  const ph = targetKeys.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT target_key, payload, at FROM events
       WHERE op = 'dismiss' AND target_key IN (${ph}) ORDER BY id ASC`
    )
    .all(...targetKeys) as Array<{ target_key: string; payload: string; at: string }>;

  for (const r of rows) {
    let reason = "";
    try {
      reason = (JSON.parse(r.payload) as { reason?: string }).reason ?? "";
    } catch {
      reason = "";
    }
    out.set(r.target_key, { reason, at: r.at });
  }
  return out;
}

// =============================================================================
// findings(review 事件载荷的派生索引)
// =============================================================================

export interface FindingRow {
  id: string;
  review_event_id: number;
  node_id: number;
  question: "Q1" | "Q2";
  confidence: "high" | "low";
  content: string;
  citation: string;
  at: string;
}

export function insertFindings(
  db: Database,
  reviewEventId: number,
  findings: Finding[]
): void {
  const stmt = db.prepare(
    `INSERT INTO findings (id, review_event_id, node_id, question, confidence, content, citation)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const f of findings) {
    stmt.run(
      f.id,
      reviewEventId,
      f.nodeId,
      f.question,
      f.confidence,
      f.content,
      JSON.stringify(f.citation)
    );
  }
}

export function listFindingsByNode(db: Database, nodeId: number): FindingRow[] {
  return db
    .prepare("SELECT * FROM findings WHERE node_id = ? ORDER BY id")
    .all(nodeId) as FindingRow[];
}

export function listAllFindings(db: Database): FindingRow[] {
  return db.prepare("SELECT * FROM findings ORDER BY node_id, id").all() as FindingRow[];
}

// =============================================================================
// 基线
// =============================================================================

export function getBaselineHead(db: Database, nodeId: number): BaselineHead | null {
  const row = db.prepare("SELECT * FROM baseline_head WHERE node_id = ?").get(nodeId) as
    | { node_id: number; qualifier: Qualifier; self_fingerprint: string; at: string }
    | undefined;
  if (!row) return null;
  return {
    nodeId: row.node_id,
    qualifier: row.qualifier,
    selfFingerprint: row.self_fingerprint,
    at: row.at,
  };
}

export function getBaselineRefs(db: Database, nodeId: number): BaselineRef[] {
  const rows = db
    .prepare("SELECT * FROM baseline_refs WHERE node_id = ? ORDER BY ref_role, ref_id")
    .all(nodeId) as Array<{
    node_id: number;
    ref_id: number;
    ref_role: RefRole;
    content_hash: string;
    qualifier: Qualifier;
  }>;
  return rows.map((r) => ({
    nodeId: r.node_id,
    refId: r.ref_id,
    refRole: r.ref_role,
    contentHash: r.content_hash,
    qualifier: r.qualifier,
  }));
}

/**
 * 覆盖式写入一条命题的基线。**唯一的写入者是 set_qualifier**——
 * 这个函数只应被它调用,多一个调用点基线就退化成会漂移的缓存。
 */
export function writeBaseline(
  db: Database,
  head: { nodeId: number; qualifier: Qualifier; selfFingerprint: string },
  refs: Array<{ refId: number; refRole: RefRole; contentHash: string; qualifier: Qualifier }>
): void {
  db.prepare(
    `INSERT INTO baseline_head (node_id, qualifier, self_fingerprint, at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(node_id) DO UPDATE SET
       qualifier = excluded.qualifier,
       self_fingerprint = excluded.self_fingerprint,
       at = excluded.at`
  ).run(head.nodeId, head.qualifier, head.selfFingerprint);

  db.prepare("DELETE FROM baseline_refs WHERE node_id = ?").run(head.nodeId);
  const stmt = db.prepare(
    `INSERT INTO baseline_refs (node_id, ref_id, ref_role, content_hash, qualifier)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const r of refs) {
    stmt.run(head.nodeId, r.refId, r.refRole, r.contentHash, r.qualifier);
  }
}

// =============================================================================
// 检索
// =============================================================================

/**
 * 按关键词 + 档位筛命题。
 *
 * FTS5 可用时走 trigram 索引,否则退到 LIKE。两条路径的结果集不完全相同
 * (trigram 要求 ≥3 字符),这是已知取舍:检索是找 id 的入口,不是判据的一部分。
 */
export function findPropositions(
  db: Database,
  opts: { query?: string; qualifier?: Qualifier[]; limit?: number; offset?: number }
): { rows: PropositionRow[]; total: number } {
  const { query, qualifier, limit = 20, offset = 0 } = opts;

  const conds: string[] = [];
  const params: (string | number)[] = [];
  let from = "propositions p";
  let order = "p.id";

  const useFts = Boolean(query) && isFtsAvailable() && query!.length >= 3;
  if (useFts) {
    from = "propositions_fts f JOIN propositions p ON p.id = f.rowid";
    conds.push("propositions_fts MATCH ?");
    params.push(`"${query!.replaceAll('"', '""')}"`);
    order = "f.rank";
  } else if (query) {
    conds.push("p.content LIKE ?");
    params.push(`%${query}%`);
  }

  if (qualifier && qualifier.length > 0) {
    conds.push(`p.qualifier IN (${qualifier.map(() => "?").join(",")})`);
    params.push(...qualifier);
  }

  const where = conds.length > 0 ? ` WHERE ${conds.join(" AND ")}` : "";
  const total = (
    db.prepare(`SELECT COUNT(*) AS cnt FROM ${from}${where}`).get(...params) as { cnt: number }
  ).cnt;

  const rows = db
    .prepare(`SELECT p.* FROM ${from}${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as PropositionRow[];

  return { rows, total };
}

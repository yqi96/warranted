/**
 * Tier 2 断言用的图数据库查询辅助。
 * 直接读 .toulmin/argument.db(schema 见 sql/schema.sql)。
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export interface NodeRow {
  id: number;
  type: "claim" | "statement" | "warrant";
  content: string;
  data: Record<string, unknown>;
  created_at: string;
}

export function openGraph(dbPath: string): Database | null {
  if (!existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true });
}

export function allNodes(db: Database | null): NodeRow[] {
  if (!db) return [];
  const rows = db
    .query("SELECT id, type, content, data, created_at FROM nodes ORDER BY id")
    .all() as Array<Omit<NodeRow, "data"> & { data: string }>;
  return rows.map((r) => ({ ...r, data: JSON.parse(r.data) }));
}

export function nodesByType(db: Database | null, type: NodeRow["type"]): NodeRow[] {
  return allNodes(db).filter((n) => n.type === type);
}

export const claims = (db: Database | null) => nodesByType(db, "claim");
export const statements = (db: Database | null) => nodesByType(db, "statement");
export const warrants = (db: Database | null) => nodesByType(db, "warrant");

export function totalNodes(db: Database | null): number {
  return allNodes(db).length;
}

/** rebuttal_targets 关联行(附带 rebuttal Statement 的内容) */
export function rebuttals(
  db: Database | null,
): Array<{ statement_id: number; target_id: number; target_type: string; content: string }> {
  if (!db) return [];
  return db
    .query(
      `SELECT rt.statement_id, rt.target_id, rt.target_type, n.content
       FROM rebuttal_targets rt JOIN nodes n ON n.id = rt.statement_id`,
    )
    .all() as Array<{ statement_id: number; target_id: number; target_type: string; content: string }>;
}

/** warrant_grounds 关联行 */
export function warrantGrounds(
  db: Database | null,
): Array<{ warrant_id: number; ground_id: number }> {
  if (!db) return [];
  return db.query("SELECT warrant_id, ground_id FROM warrant_grounds").all() as Array<{
    warrant_id: number;
    ground_id: number;
  }>;
}

/** 便捷断言:节点总数等于 n */
export function expectTotalNodes(n: number) {
  return (ctx: { db: Database | null }): true | string => {
    const got = totalNodes(ctx.db);
    return got === n ? true : `期望节点总数 ${n},实际 ${got}`;
  };
}

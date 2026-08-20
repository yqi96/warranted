/**
 * Tier 2 断言用的图数据库查询辅助。
 *
 * 直接读 `.toulmin/graph.db`(schema 见 src/schema.ts 的 SCHEMA_SQL)。这里刻意
 * **不走 src/service.ts**:评测要断言的是"图上真的落成了什么",从服务层读会把
 * service 自己的 bug 和 agent 的行为搅在一起,一条断言挂了分不清是谁的错。
 *
 * 新本体只有 propositions 一张节点表,所以旧的 claims/statements/warrants 三组
 * 取数器整体消失 —— 区分它们的东西不再存在于数据里(design.md §1.1)。取而代之的
 * 维度是 qualifier(它有多可信)与槽位占用(它靠什么、被什么攻击)。
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { Qualifier } from "../../src/schema.ts";

export interface PropRow {
  id: number;
  content: string;
  warrant_text: string | null;
  warrant_node_id: number | null;
  qualifier: Qualifier;
  created_at: string;
}

export function openGraph(dbPath: string): Database | null {
  if (!existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true });
}

export function allPropositions(db: Database | null): PropRow[] {
  if (!db) return [];
  return db
    .query(
      `SELECT id, content, warrant_text, warrant_node_id, qualifier, created_at
       FROM propositions ORDER BY id`,
    )
    .all() as PropRow[];
}

export function totalPropositions(db: Database | null): number {
  return allPropositions(db).length;
}

/** 落在指定档位的命题。传多个档位取并集。 */
export function byQualifier(db: Database | null, ...qs: Qualifier[]): PropRow[] {
  return allPropositions(db).filter((p) => qs.includes(p.qualifier));
}

/** 判过的命题 —— qualifier 动过的那些。'unestablished' 是新建默认值,不算判断。 */
export function judged(db: Database | null): PropRow[] {
  return allPropositions(db).filter((p) => p.qualifier !== "unestablished");
}

/** 证据槽里的命题引用:node_id 靠 evidence_id 支撑。 */
export function evidenceNodes(
  db: Database | null,
): Array<{ node_id: number; evidence_id: number }> {
  if (!db) return [];
  return db.query("SELECT node_id, evidence_id FROM evidence_nodes").all() as Array<{
    node_id: number;
    evidence_id: number;
  }>;
}

/** 证据槽里的附件路径。 */
export function attachments(db: Database | null): Array<{ node_id: number; path: string }> {
  if (!db) return [];
  return db.query("SELECT node_id, path FROM evidence_attachments").all() as Array<{
    node_id: number;
    path: string;
  }>;
}

/**
 * 反驳槽:node_id 是被攻击的命题,rebuttal_id 是攻击它的那条(附带其内容,
 * 断言里要看"反驳说了什么")。
 */
export function rebuttals(
  db: Database | null,
): Array<{ node_id: number; rebuttal_id: number; content: string }> {
  if (!db) return [];
  return db
    .query(
      `SELECT r.node_id, r.rebuttal_id, p.content
       FROM rebuttals r JOIN propositions p ON p.id = r.rebuttal_id
       ORDER BY r.node_id, r.rebuttal_id`,
    )
    .all() as Array<{ node_id: number; rebuttal_id: number; content: string }>;
}

/** 事件流。判"做过什么、按什么顺序做的"要读它,不要从节点 id 猜。 */
export function events(
  db: Database | null,
): Array<{ id: number; node_id: number | null; op: string; actor: string; note: string | null }> {
  if (!db) return [];
  return db
    .query("SELECT id, node_id, op, actor, note FROM events ORDER BY id")
    .all() as Array<{
    id: number;
    node_id: number | null;
    op: string;
    actor: string;
    note: string | null;
  }>;
}

/** 未处理的 finding 条数(有没有同 id 的 dismiss 事件,算出来而不是查状态列)。 */
export function unresolvedFindings(db: Database | null): number {
  if (!db) return 0;
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM findings f
       WHERE NOT EXISTS (
         SELECT 1 FROM events e WHERE e.op = 'dismiss' AND e.target_key = f.id
       )`,
    )
    .get() as { n: number } | null;
  return row?.n ?? 0;
}

/** 便捷断言:命题总数等于 n */
export function expectTotalPropositions(n: number) {
  return (ctx: { db: Database | null }): true | string => {
    const got = totalPropositions(ctx.db);
    return got === n ? true : `期望命题总数 ${n},实际 ${got}`;
  };
}

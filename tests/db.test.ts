/**
 * Toulmin MCP — db.ts 迁移测试
 *
 * 使用文件后端 SQLite 数据库验证幂等迁移逻辑。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, initializeSchema, tightenCheckConstraint } from "../src/db.ts";

describe("migrateHypothesisSource", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("迁移 source='hypothesis' 的 statement 行为 'observed'，且二次打开幂等", () => {
    dir = mkdtempSync(join(tmpdir(), "warranted-db-test-"));
    const dbPath = join(dir, "argument.db");

    // Seed a legacy row with source='hypothesis' via a raw db handle before running migrations.
    const seedDb = new Database(dbPath, { create: true });
    seedDb.exec(`
      CREATE TABLE nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    const now = new Date().toISOString().slice(0, 19);
    seedDb.prepare(
      "INSERT INTO nodes (type, content, data, created_at, updated_at) VALUES ('statement', ?, ?, ?, ?)"
    ).run("Legacy hypothesis statement", JSON.stringify({ source: "hypothesis", verification: "pending", attachments: [] }), now, now);
    const rowId = (seedDb.prepare("SELECT id FROM nodes").get() as { id: number }).id;
    seedDb.close();

    // First open runs the migration chain, including migrateHypothesisSource.
    const db1 = openDatabase(dbPath);
    const row1 = db1.prepare("SELECT data FROM nodes WHERE id = ?").get(rowId) as { data: string };
    expect(JSON.parse(row1.data).source).toBe("observed");
    db1.close();

    // Second open on the same file must be a no-op (idempotent, no throw).
    expect(() => {
      const db2 = openDatabase(dbPath);
      const row2 = db2.prepare("SELECT data FROM nodes WHERE id = ?").get(rowId) as { data: string };
      expect(JSON.parse(row2.data).source).toBe("observed");
      db2.close();
    }).not.toThrow();
  });
});

// =============================================================================
// tightenCheckConstraint —— 重建 nodes 表这条迁移
// =============================================================================

const WIDE_CHECK = "CHECK(type IN ('claim','ground','warrant','backing','statement','rebuttal'))";
const TIGHT_CHECK = "CHECK(type IN ('claim','statement','warrant'))";

function nodesDdl(db: Database): string {
  return (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodes'").get() as {
      sql: string;
    }
  ).sql;
}

/**
 * 表是否经过 ALTER TABLE ... RENAME —— 也就是重建到底跑过没有。
 *
 * SQLite 把建表语句原样存进 sqlite_master，RENAME 只替换里面的表名 token，
 * 并且替换后的名字**带引号**。所以 `CREATE TABLE "nodes"` 只可能来自重命名，
 * 直接建出来的是 `CREATE TABLE nodes`。收紧前后的 CHECK 文本相同，
 * 单看约束无法区分"本来就是紧的"和"被重建成紧的"，只有这个痕迹能区分。
 */
function wasRebuilt(db: Database): boolean {
  return nodesDdl(db).includes('CREATE TABLE "nodes"');
}

/** 手写一个 0.5.0 之前的 nodes 表：宽 CHECK，外加一张带级联删除的子表。 */
const LEGACY_SCHEMA_SQL = `
  CREATE TABLE nodes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT    NOT NULL ${WIDE_CHECK},
    content    TEXT    NOT NULL,
    data       TEXT    NOT NULL DEFAULT '{}',
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE warrant_grounds (
    warrant_id   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    ground_id    INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    PRIMARY KEY (warrant_id, ground_id)
  );
`;

function seedLegacyRows(db: Database): void {
  db.prepare("INSERT INTO nodes (type, content) VALUES ('warrant', 'W')").run();
  db.prepare("INSERT INTO nodes (type, content) VALUES ('statement', 'G')").run();
  db.prepare("INSERT INTO warrant_grounds (warrant_id, ground_id) VALUES (1, 2)").run();
}

function nodesTables(db: Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'nodes%'").all() as Array<{ name: string }>
  ).map((t) => t.name);
}

const countOf = (db: Database, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

describe("tightenCheckConstraint", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("新库不重建 nodes 表 —— 建表时约束就已经是紧的", () => {
    const db = new Database(":memory:");
    initializeSchema(db);

    expect(nodesDdl(db)).toContain(TIGHT_CHECK);
    expect(wasRebuilt(db)).toBe(false);
    db.close();
  });

  test("旧库文件升级：约束收紧，子表关系不被级联删掉", () => {
    dir = mkdtempSync(join(tmpdir(), "warranted-tighten-"));
    const dbPath = join(dir, "legacy.db");
    const seed = new Database(dbPath, { create: true });
    seed.exec(LEGACY_SCHEMA_SQL);
    seedLegacyRows(seed);
    seed.close();

    const db = openDatabase(dbPath);

    // 重建确实跑过（只有旧库才需要）
    expect(wasRebuilt(db)).toBe(true);
    expect(nodesDdl(db)).toContain(TIGHT_CHECK);
    expect(countOf(db, "nodes")).toBe(2);

    // 重建要 DROP TABLE nodes，而 warrant_grounds 以 ON DELETE CASCADE 引用它。
    // 外键开着时那一步会把子表的行一起删掉，所以 PRAGMA foreign_keys = OFF
    // 必须在事务**外**生效（写进事务里会被静默忽略）。这条断言钉的就是那个顺序。
    expect(countOf(db, "warrant_grounds")).toBe(1);
    db.close();
  });

  test("重建中途失败：整体回滚，旧表和数据都还在，不留 nodes_new 残骸", () => {
    // 这里直接调 tightenCheckConstraint，不走 openDatabase：initializeSchema 自己
    // 就会调用它，中间没有插故障的位置 —— 而且它更早也建 idx_nodes_type，
    // 故障会在重建之前就打断，测试变成绿的却什么都没测（第一版正是这样）。
    const db = new Database(":memory:");
    db.exec(LEGACY_SCHEMA_SQL);
    seedLegacyRows(db);

    // 故障注入：占住 idx_nodes_type 这个名字。SQLite 里表和索引共用一个命名
    // 空间，所以重建收尾的 CREATE INDEX 会撞名报错 —— 而那一步在
    // DROP TABLE nodes 之后。没有事务的话，此刻 nodes 已经被换成新表了。
    db.exec("CREATE TABLE idx_nodes_type (x)");
    db.exec("PRAGMA foreign_keys = ON");

    expect(() => tightenCheckConstraint(db)).toThrow(/idx_nodes_type/);

    expect(nodesTables(db)).toEqual(["nodes"]); // 没有 nodes_new 残骸
    expect(nodesDdl(db)).toContain(WIDE_CHECK); // 还是升级前的样子
    expect(countOf(db, "nodes")).toBe(2);
    expect(countOf(db, "warrant_grounds")).toBe(1);
    db.close();
  });
});

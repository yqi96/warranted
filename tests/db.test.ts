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

// =============================================================================
// compile_state.claim_id 的外键 + 三条外键子列索引
// =============================================================================

function compileStateDdl(db: Database): string {
  return (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'compile_state'").get() as {
      sql: string;
    }
  ).sql;
}

function indexNames(db: Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

/** 旧库形态：nodes 是宽 CHECK，compile_state 没有外键 —— 也就是 0.5.0 之前的文件。 */
const LEGACY_COMPILE_STATE_SQL = `
  CREATE TABLE compile_state (
    claim_id       INTEGER PRIMARY KEY,
    verdict        TEXT    NOT NULL DEFAULT 'passed',
    summary        TEXT    NOT NULL DEFAULT '',
    node_hashes    TEXT    NOT NULL DEFAULT '{}',
    argument_hash  TEXT,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`;

describe("compile_state 外键", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("新库：删掉 claim，它的 compile 记录跟着消失", () => {
    const db = new Database(":memory:");
    initializeSchema(db);
    db.exec("PRAGMA foreign_keys = ON"); // openDatabase 会开，这里是裸 Database

    expect(compileStateDdl(db)).toContain("REFERENCES nodes(id) ON DELETE CASCADE");

    const claimId = (db.prepare("INSERT INTO nodes (type, content) VALUES ('claim', 'C') RETURNING id").get() as { id: number }).id;
    db.prepare("INSERT INTO compile_state (claim_id, verdict) VALUES (?, 'passed')").run(claimId);
    db.prepare("DELETE FROM nodes WHERE id = ?").run(claimId);

    // 留下这一行的后果不是多一行垃圾：nodes 重建后 id 会重用，
    // 新 claim 会读到这条 passed，而 A0 门只比 verdict。
    expect(countOf(db, "compile_state")).toBe(0);
    db.close();
  });

  test("旧库文件升级：补上外键，指向已消失 claim 的孤儿行被清掉，正常行留着", () => {
    dir = mkdtempSync(join(tmpdir(), "warranted-cs-fk-"));
    const dbPath = join(dir, "legacy.db");
    const seed = new Database(dbPath, { create: true });
    seed.exec(LEGACY_SCHEMA_SQL);
    seed.exec(LEGACY_COMPILE_STATE_SQL);
    seedLegacyRows(seed); // #1 warrant, #2 statement
    seed.prepare("INSERT INTO nodes (type, content) VALUES ('claim', 'C')").run(); // #3
    seed.prepare("INSERT INTO compile_state (claim_id, verdict) VALUES (3, 'passed')").run();
    seed.prepare("INSERT INTO compile_state (claim_id, verdict) VALUES (99, 'passed')").run(); // #99 不存在
    seed.close();

    const db = openDatabase(dbPath);

    expect(compileStateDdl(db)).toContain("REFERENCES nodes(id) ON DELETE CASCADE");
    expect(
      (db.prepare("SELECT claim_id FROM compile_state").all() as Array<{ claim_id: number }>).map((r) => r.claim_id)
    ).toEqual([3]);

    // 外键补上之后必须真的在管事，而不只是写在建表语句里
    db.prepare("DELETE FROM nodes WHERE id = 3").run();
    expect(countOf(db, "compile_state")).toBe(0);
    db.close();

    // 二次打开幂等：不再重建，也不报错
    const db2 = openDatabase(dbPath);
    expect(compileStateDdl(db2)).toContain("REFERENCES nodes(id)");
    expect(
      (db2.prepare("SELECT name FROM sqlite_master WHERE name = 'compile_state_new'").all() as unknown[]).length
    ).toBe(0);
    db2.close();
  });

  test("升级中途失败：整体回滚，旧表还在，连接没被卡在未关闭的事务里", () => {
    dir = mkdtempSync(join(tmpdir(), "warranted-cs-fail-"));
    const dbPath = join(dir, "legacy.db");
    const seed = new Database(dbPath, { create: true });
    seed.exec(LEGACY_SCHEMA_SQL);
    seed.exec(LEGACY_COMPILE_STATE_SQL);
    seed.prepare("INSERT INTO nodes (type, content) VALUES ('claim', 'C')").run();
    seed.prepare("INSERT INTO compile_state (claim_id, verdict) VALUES (1, 'passed')").run();
    // 故障注入：占住 compile_state_new 这个名字，让重建的第一步就撞名。
    seed.exec("CREATE TABLE compile_state_new (x)");
    seed.close();

    expect(() => openDatabase(dbPath)).toThrow(/compile_state_new/);

    // 迁移失败若不 ROLLBACK，BEGIN IMMEDIATE 就一直开着，别的连接会拿到
    // "database is locked" —— 这正是被删掉的 migrateWarrantGroundsColumn 的毛病。
    const probe = new Database(dbPath);
    expect(() => probe.exec("INSERT INTO nodes (type, content) VALUES ('claim', 'D')")).not.toThrow();
    expect(compileStateDdl(probe)).not.toContain("REFERENCES nodes"); // 还是升级前的样子
    expect(countOf(probe, "compile_state")).toBe(1);
    probe.close();
  });
});

describe("外键子列索引", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const REQUIRED = ["idx_tags_claim", "idx_warrant_backings_statement", "idx_warrant_grounds_ground"];

  test("新库三条都建上，且反查 ground 真的走索引而不是扫全表", () => {
    const db = new Database(":memory:");
    initializeSchema(db);

    for (const name of REQUIRED) expect(indexNames(db)).toContain(name);

    // 光断言索引存在不够 —— 索引建了但查询用不上是常见情形。
    const plan = (
      db.prepare("EXPLAIN QUERY PLAN SELECT warrant_id FROM warrant_grounds WHERE ground_id = 1").all() as Array<{
        detail: string;
      }>
    )
      .map((r) => r.detail)
      .join(" ");
    expect(plan).toContain("idx_warrant_grounds_ground");
    expect(plan).not.toContain("SCAN");
    db.close();
  });

  test("旧库文件打开一次就补齐 —— CREATE INDEX IF NOT EXISTS 每次打开都跑，不需要迁移", () => {
    dir = mkdtempSync(join(tmpdir(), "warranted-idx-"));
    const dbPath = join(dir, "legacy.db");
    const seed = new Database(dbPath, { create: true });
    seed.exec(LEGACY_SCHEMA_SQL); // 只有 nodes 和 warrant_grounds，没有任何 idx_
    seedLegacyRows(seed);
    seed.close();

    const db = openDatabase(dbPath);
    for (const name of REQUIRED) expect(indexNames(db)).toContain(name);
    db.close();
  });
});

// =============================================================================
// migrateDropGroundIdsBlob —— 把 ground 集合的第二份记录从节点 blob 里删掉
// =============================================================================

describe("migrateDropGroundIdsBlob", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const groundIdsOf = (db: Database, warrantId: number): number[] =>
    (
      db
        .prepare("SELECT ground_id FROM warrant_grounds WHERE warrant_id = ? ORDER BY ground_id")
        .all(warrantId) as Array<{ ground_id: number }>
    ).map((r) => r.ground_id);

  const blobGroundIdsOf = (db: Database, warrantId: number): unknown =>
    JSON.parse((db.prepare("SELECT data FROM nodes WHERE id = ?").get(warrantId) as { data: string }).data).ground_ids;

  test("删掉 blob 键，补进只在 blob 里的边并报警，跳过已消失的节点，二次打开幂等", () => {
    dir = mkdtempSync(join(tmpdir(), "warranted-groundblob-"));
    const dbPath = join(dir, "legacy.db");

    const seed = new Database(dbPath, { create: true });
    seed.exec(LEGACY_SCHEMA_SQL);
    // 节点类型全是新的（claim/statement/warrant），migrateToStatementSchema 会因为
    // "没有旧类型节点"整段跳过 —— 排空 blob 的责任因此完全落在被测的那一步上。
    seed.prepare("INSERT INTO nodes (type, content, data) VALUES ('claim', 'C', ?)").run(JSON.stringify({ status: "proposed" }));
    seed.prepare("INSERT INTO nodes (type, content, data) VALUES ('statement', 'GA', ?)").run(JSON.stringify({ source: "observed", verification: "verified", attachments: [] }));
    seed.prepare("INSERT INTO nodes (type, content, data) VALUES ('statement', 'GB', ?)").run(JSON.stringify({ source: "observed", verification: "verified", attachments: [] }));
    // #2 已经在关系表里；#3 只在 blob 里（该被补进去）；#3 写两遍（重复该被吞掉）；
    // #999 的节点不存在（该被跳过，补也会撞外键）。
    seed.prepare("INSERT INTO nodes (type, content, data) VALUES ('warrant', 'W', ?)").run(JSON.stringify({ claim_id: 1, ground_ids: [2, 3, 3, 999] }));
    seed.prepare("INSERT INTO warrant_grounds (warrant_id, ground_id) VALUES (4, 2)").run();
    seed.close();

    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };

    let db1: Database;
    try {
      db1 = openDatabase(dbPath);
    } finally {
      console.warn = realWarn;
    }

    expect(blobGroundIdsOf(db1, 4)).toBeUndefined();
    expect(groundIdsOf(db1, 4)).toEqual([2, 3]);
    // 补边这件事本身值得知道 —— 旧库里真有偏差才会走到这里
    expect(warnings.join("\n")).toContain("#4->#3");
    db1.close();

    // 二次打开：没有 warrant 还带这个键，整段跳过，数据不变
    const db2 = openDatabase(dbPath);
    expect(blobGroundIdsOf(db2, 4)).toBeUndefined();
    expect(groundIdsOf(db2, 4)).toEqual([2, 3]);
    db2.close();
  });

  test("blob 与关系表本来一致时不报补边的警告", () => {
    dir = mkdtempSync(join(tmpdir(), "warranted-groundblob-clean-"));
    const dbPath = join(dir, "legacy.db");

    const seed = new Database(dbPath, { create: true });
    seed.exec(LEGACY_SCHEMA_SQL);
    seed.prepare("INSERT INTO nodes (type, content, data) VALUES ('claim', 'C', ?)").run(JSON.stringify({ status: "proposed" }));
    seed.prepare("INSERT INTO nodes (type, content, data) VALUES ('statement', 'GA', ?)").run(JSON.stringify({ source: "observed", verification: "verified", attachments: [] }));
    seed.prepare("INSERT INTO nodes (type, content, data) VALUES ('warrant', 'W', ?)").run(JSON.stringify({ claim_id: 1, ground_ids: [2] }));
    seed.prepare("INSERT INTO warrant_grounds (warrant_id, ground_id) VALUES (3, 2)").run();
    seed.close();

    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };

    let db: Database;
    try {
      db = openDatabase(dbPath);
    } finally {
      console.warn = realWarn;
    }

    expect(blobGroundIdsOf(db, 3)).toBeUndefined();
    expect(groundIdsOf(db, 3)).toEqual([2]);
    expect(warnings.join("\n")).not.toContain("existed only in the node blob");
    db.close();
  });
});

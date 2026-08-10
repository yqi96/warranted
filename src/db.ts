/**
 * Warranted — 数据库连接与 Schema 初始化
 *
 * 使用 bun:sqlite（同步 API），零配置嵌入式 SQLite。
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { resolve } from "path";

// FTS5 availability flag — set once at startup
let _ftsAttempted = false;
let _ftsAvailable = false;

/** Whether FTS5 is available at runtime */
export function isFtsAvailable(): boolean {
  return _ftsAvailable;
}

/**
 * 打开数据库并初始化 Schema。
 * @param dbPath - 数据库文件路径，默认 ":memory:"（内存数据库，适合测试）
 */
export function openDatabase(dbPath: string = ":memory:"): Database {
  const db = new Database(dbPath, { create: true });

  // 设置 WAL 模式（内存数据库不需要）
  if (dbPath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
  }

  // 启用外键约束
  db.exec("PRAGMA foreign_keys = ON;");

  // 初始化 Schema
  initializeSchema(db);

  return db;
}

/**
 * 执行 Schema SQL 创建表。
 * 使用 CREATE TABLE IF NOT EXISTS，可安全重复调用。
 */
export function initializeSchema(db: Database): void {
  // 内联 Schema（避免文件路径解析问题）
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      type       TEXT    NOT NULL CHECK(type IN ('claim','ground','warrant','backing','statement','rebuttal')),
      content    TEXT    NOT NULL,
      data       TEXT    NOT NULL DEFAULT '{}',
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);

    CREATE INDEX IF NOT EXISTS idx_nodes_warrant_claim ON nodes(
      CAST(json_extract(data, '$.claim_id') AS INTEGER)
    ) WHERE type = 'warrant';

    CREATE TABLE IF NOT EXISTS compile_state (
      claim_id       INTEGER PRIMARY KEY,
      verdict        TEXT    NOT NULL DEFAULT 'passed',
      summary        TEXT    NOT NULL DEFAULT '',
      node_hashes    TEXT    NOT NULL DEFAULT '{}',
      argument_hash  TEXT,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS warrant_grounds (
      warrant_id   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      ground_id    INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, -- accepts claim or statement nodes
      PRIMARY KEY (warrant_id, ground_id)
    );

    CREATE TABLE IF NOT EXISTS warrant_backings (
      warrant_id   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      statement_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      PRIMARY KEY (warrant_id, statement_id)
    );

    CREATE TABLE IF NOT EXISTS rebuttal_targets (
      statement_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target_id    INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target_type  TEXT    NOT NULL CHECK(target_type IN ('claim','warrant')),
      PRIMARY KEY (statement_id, target_id, target_type)
    );

    CREATE INDEX IF NOT EXISTS idx_rebuttal_targets_target ON rebuttal_targets(target_id, target_type);

    CREATE TABLE IF NOT EXISTS tags (
      name        TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      claim_id    INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS node_tags (
      node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      tag     TEXT    NOT NULL REFERENCES tags(name) ON UPDATE CASCADE ON DELETE CASCADE,
      PRIMARY KEY (node_id, tag)
    );

    CREATE INDEX IF NOT EXISTS idx_node_tags_tag ON node_tags(tag);

    CREATE TABLE IF NOT EXISTS tag_namespaces (
      namespace   TEXT PRIMARY KEY,
      cardinality TEXT NOT NULL CHECK (cardinality IN ('dense', 'bounded')),
      declared_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT OR IGNORE INTO tag_namespaces (namespace, cardinality) VALUES ('paper', 'dense');
  `);

  // FTS5 virtual table + triggers
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
        content, content='nodes', content_rowid='id', tokenize='trigram'
      );
    `);
    _ftsAttempted = true;
    _ftsAvailable = true;

    // Check if triggers already exist
    const existingTriggers = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'nodes_fts_%'"
    ).all() as Array<{ name: string }>;
    const existingNames = new Set(existingTriggers.map(t => t.name));

    if (!existingNames.has("nodes_fts_ai")) {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS nodes_fts_ai AFTER INSERT ON nodes BEGIN
          INSERT INTO nodes_fts(rowid, content) VALUES (new.id, new.content);
        END;
      `);
    }
    if (!existingNames.has("nodes_fts_ad")) {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS nodes_fts_ad AFTER DELETE ON nodes BEGIN
          INSERT INTO nodes_fts(nodes_fts, rowid, content) VALUES ('delete', old.id, old.content);
        END;
      `);
    }
    if (!existingNames.has("nodes_fts_au")) {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS nodes_fts_au AFTER UPDATE OF content ON nodes BEGIN
          INSERT INTO nodes_fts(nodes_fts, rowid, content) VALUES ('delete', old.id, old.content);
          INSERT INTO nodes_fts(rowid, content) VALUES (new.id, new.content);
        END;
      `);
    }

    // Rebuild index if it's empty but nodes exist
    const nodeCount = (db.prepare("SELECT COUNT(*) AS cnt FROM nodes").get() as { cnt: number }).cnt;
    const ftsCount = (db.prepare("SELECT COUNT(*) AS cnt FROM nodes_fts").get() as { cnt: number }).cnt;
    if (nodeCount > 0 && ftsCount === 0) {
      db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES ('rebuild')");
    }
  } catch (e) {
    _ftsAttempted = true;
    _ftsAvailable = false;
    console.warn("[warranted] FTS5 not available — search will use LIKE only.");
  }

  // Migration: 为已有数据库添加 argument_hash 列
  const columns = db.prepare("PRAGMA table_info(compile_state)").all() as Array<{ name: string }>;
  if (columns.length > 0 && !columns.some(c => c.name === "argument_hash")) {
    db.exec("ALTER TABLE compile_state ADD COLUMN argument_hash TEXT");
  }

  migrateToStatementSchema(db);
  migrateHypothesisSource(db);
  tightenCheckConstraint(db);
  migrateWarrantGroundsColumn(db);
  migrateRefClaimIdData(db);

}

/**
 * 将旧版 source='hypothesis' 的 statement 节点迁移为 source='observed'。
 * 幂等：若已无 hypothesis 节点则跳过。
 */
export function migrateHypothesisSource(db: Database): void {
  const rows = db.prepare(
    "SELECT id FROM nodes WHERE type = 'statement' AND json_extract(data, '$.source') = 'hypothesis'"
  ).all() as Array<{ id: number }>;

  if (rows.length === 0) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "UPDATE nodes SET data = json_set(data, '$.source', 'observed') WHERE type = 'statement' AND json_extract(data, '$.source') = 'hypothesis'"
    ).run();
    console.warn(`[warranted] Migrated ${rows.length} statement row(s) from source="hypothesis" to source="observed": [${rows.map(r => `#${r.id}`).join(", ")}]`);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * 将旧版 ref_claim_id proxy statement 节点迁移为直接的 Claim-type ground 引用。
 *
 * 旧模式：warrant_grounds 中有一个 statement 节点，其 data JSON 含 ref_claim_id=N，
 *          表示"Claim #N 是这个 Warrant 的 Ground"。
 * 新模式：warrant_grounds 直接引用 Claim 节点（ground_id = claimId）。
 *
 * 此函数：
 * 1. 找出所有 data JSON 含 ref_claim_id 的 statement 节点。
 * 2. 对每个这样的节点，找到其在 warrant_grounds 中的关联 warrant。
 * 3. 将 warrant_grounds 中对该 proxy statement 的引用替换为对 ref_claim_id 指向的 Claim 的引用。
 * 4. 删除 proxy statement 节点（若它不再被任何 warrant_grounds 引用）。
 * 5. 幂等：若已无 ref_claim_id 节点则跳过。
 */
export function migrateRefClaimIdData(db: Database): void {
  // Find all proxy statement nodes with ref_claim_id in their data
  const proxyRows = db.prepare(
    "SELECT id, data FROM nodes WHERE type = 'statement' AND json_extract(data, '$.ref_claim_id') IS NOT NULL"
  ).all() as Array<{ id: number; data: string }>;

  if (proxyRows.length === 0) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const proxy of proxyRows) {
      const data = JSON.parse(proxy.data);
      const refClaimId = data.ref_claim_id as number | null;
      if (refClaimId == null) continue;

      // Verify the referenced claim exists
      const claimRow = db.prepare("SELECT id FROM nodes WHERE id = ? AND type = 'claim'").get(refClaimId) as { id: number } | null;
      if (!claimRow) continue;

      // Find all warrants that reference this proxy statement in warrant_grounds
      const usages = db.prepare(
        "SELECT warrant_id FROM warrant_grounds WHERE ground_id = ?"
      ).all(proxy.id) as Array<{ warrant_id: number }>;

      for (const { warrant_id } of usages) {
        // Replace proxy reference with direct claim reference
        db.prepare("DELETE FROM warrant_grounds WHERE warrant_id = ? AND ground_id = ?").run(warrant_id, proxy.id);
        db.prepare("INSERT OR IGNORE INTO warrant_grounds (warrant_id, ground_id) VALUES (?, ?)").run(warrant_id, refClaimId);

        // Update warrant's ground_ids JSON
        const wRow = db.prepare("SELECT data FROM nodes WHERE id = ?").get(warrant_id) as { data: string } | null;
        if (wRow) {
          const wData = JSON.parse(wRow.data);
          const gIds: number[] = wData.ground_ids || [];
          const newIds = gIds.map((id: number) => id === proxy.id ? refClaimId : id);
          const deduped = [...new Set(newIds)];
          wData.ground_ids = deduped;
          db.prepare("UPDATE nodes SET data = ? WHERE id = ?").run(JSON.stringify(wData), warrant_id);
        }
      }

      // Delete proxy statement node (no longer referenced)
      db.prepare("DELETE FROM nodes WHERE id = ?").run(proxy.id);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * 将旧版 ground/backing/rebuttal/qualifier 节点迁移为 statement 类型，
 * 并填充关系表 warrant_grounds / warrant_backings / rebuttal_targets。
 * 幂等：若无旧类型节点则跳过。
 */
export function migrateToStatementSchema(db: Database): void {
  const legacyCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM nodes WHERE type IN ('ground', 'backing', 'rebuttal', 'qualifier')"
  ).get() as { cnt: number }).cnt;

  if (legacyCount === 0) return;

  db.transaction(() => {
    // a. qualifier → statement
    const qualifierRows = db.prepare("SELECT id, content FROM nodes WHERE type = 'qualifier'").all() as Array<{ id: number; content: string }>;
    for (const row of qualifierRows) {
      console.warn(`[warranted] Migrating qualifier node #${row.id} to statement`);
    }
    if (qualifierRows.length > 0) {
      db.prepare("UPDATE nodes SET type = 'statement' WHERE type = 'qualifier'").run();
    }

    // b. backing → statement + warrant_backings
    const backingRows = db.prepare("SELECT id, data FROM nodes WHERE type = 'backing'").all() as Array<{ id: number; data: string }>;
    for (const row of backingRows) {
      const data = JSON.parse(row.data);
      const warrantId: number | undefined = data.warrant_id;
      if (warrantId == null) {
        console.warn(`[warranted] Backing #${row.id} has no warrant_id — skipping relationship insert`);
      } else {
        const wRow = db.prepare("SELECT id FROM nodes WHERE id = ?").get(warrantId) as { id: number } | null;
        if (!wRow) {
          console.warn(`[warranted] Backing #${row.id}: warrant #${warrantId} not found — skipping relationship insert`);
        } else {
          db.prepare("INSERT OR IGNORE INTO warrant_backings (warrant_id, statement_id) VALUES (?, ?)").run(warrantId, row.id);
        }
      }
      // Remove warrant_id from data JSON
      delete data.warrant_id;
      db.prepare("UPDATE nodes SET type = 'statement', data = ? WHERE id = ?").run(JSON.stringify(data), row.id);
    }

    // c. rebuttal → statement + rebuttal_targets
    const rebuttalRows = db.prepare("SELECT id, data FROM nodes WHERE type = 'rebuttal'").all() as Array<{ id: number; data: string }>;
    for (const row of rebuttalRows) {
      const data = JSON.parse(row.data);
      const targetId: number | undefined = data.target_id;
      const targetType: string | undefined = data.target_type;
      if (targetId == null || targetType == null) {
        console.warn(`[warranted] Rebuttal #${row.id} has no target_id/target_type — skipping relationship insert`);
      } else {
        const targetRow = db.prepare("SELECT id FROM nodes WHERE id = ?").get(targetId) as { id: number } | null;
        if (!targetRow) {
          console.warn(`[warranted] Rebuttal #${row.id}: target #${targetId} not found — skipping relationship insert`);
        } else {
          db.prepare("INSERT OR IGNORE INTO rebuttal_targets (statement_id, target_id, target_type) VALUES (?, ?, ?)").run(row.id, targetId, targetType);
        }
      }
      // Remove target_id / target_type from data JSON
      delete data.target_id;
      delete data.target_type;
      db.prepare("UPDATE nodes SET type = 'statement', data = ? WHERE id = ?").run(JSON.stringify(data), row.id);
    }

    // d. ground → statement (keep data JSON as-is)
    db.prepare("UPDATE nodes SET type = 'statement' WHERE type = 'ground'").run();

    // e. warrant: populate warrant_grounds from ground_ids JSON
    const warrantRows = db.prepare("SELECT id, data FROM nodes WHERE type = 'warrant'").all() as Array<{ id: number; data: string }>;
    for (const row of warrantRows) {
      const data = JSON.parse(row.data);
      const groundIds: number[] = data.ground_ids || [];
      for (const gid of groundIds) {
        const gRow = db.prepare("SELECT id FROM nodes WHERE id = ?").get(gid) as { id: number } | null;
        if (!gRow) {
          console.warn(`[warranted] Warrant #${row.id}: ground #${gid} not found — skipping warrant_grounds insert`);
        } else {
          db.prepare("INSERT OR IGNORE INTO warrant_grounds (warrant_id, ground_id) VALUES (?, ?)").run(row.id, gid);
        }
      }
    }
  })();
}

function needsCheckTightening(db: Database): boolean {
  try {
    db.prepare("SAVEPOINT check_test").run();
    db.prepare("INSERT INTO nodes (type, content, data) VALUES ('ground', 'test', '{}')").run();
    db.prepare("ROLLBACK TO SAVEPOINT check_test").run();
    db.prepare("RELEASE SAVEPOINT check_test").run();
    return true; // insert succeeded = constraint is still wide
  } catch {
    try { db.exec("ROLLBACK TO SAVEPOINT check_test"); db.exec("RELEASE SAVEPOINT check_test"); } catch {}
    return false; // insert failed = already tight
  }
}

/**
 * 收紧 nodes 表的 CHECK 约束，仅允许 ('claim','statement','warrant')。
 * 在 migration 之后调用，确保所有旧类型已迁移完毕。
 */
export function tightenCheckConstraint(db: Database): void {
  if (!needsCheckTightening(db)) return;

  // DDL 必须在事务外执行（SQLite 限制）
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`CREATE TABLE nodes_new (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT    NOT NULL CHECK(type IN ('claim','statement','warrant')),
    content    TEXT    NOT NULL,
    data       TEXT    NOT NULL DEFAULT '{}',
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec("INSERT INTO nodes_new SELECT id, type, content, data, created_at, updated_at FROM nodes WHERE type IN ('claim','statement','warrant')");
  db.exec("DROP TABLE nodes");
  db.exec("ALTER TABLE nodes_new RENAME TO nodes");
  db.exec("PRAGMA foreign_keys = ON");
  // Recreate indexes
  db.exec("CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_nodes_warrant_claim ON nodes(CAST(json_extract(data,'$.claim_id') AS INTEGER)) WHERE type='warrant'");

  // Recreate FTS triggers and rebuild index if FTS5 is available
  if (_ftsAvailable) {
    db.exec("DROP TRIGGER IF EXISTS nodes_fts_ai");
    db.exec("DROP TRIGGER IF EXISTS nodes_fts_ad");
    db.exec("DROP TRIGGER IF EXISTS nodes_fts_au");
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS nodes_fts_ai AFTER INSERT ON nodes BEGIN
        INSERT INTO nodes_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS nodes_fts_ad AFTER DELETE ON nodes BEGIN
        INSERT INTO nodes_fts(nodes_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END;
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS nodes_fts_au AFTER UPDATE OF content ON nodes BEGIN
        INSERT INTO nodes_fts(nodes_fts, rowid, content) VALUES ('delete', old.id, old.content);
        INSERT INTO nodes_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
    // Rebuild FTS index after table rebuild
    db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES ('rebuild')");
  }
}

/**
 * 从 SQL 文件初始化 Schema（用于文档/参考目的）。
 */
export function initializeSchemaFromFile(db: Database, sqlPath?: string): void {
  const path = sqlPath ?? resolve(process.cwd(), "sql/schema.sql");
  const sql = readFileSync(path, "utf-8");
  db.exec(sql);
}

/**
 * 将 warrant_grounds 表的 statement_id 列重命名为 ground_id。
 * 幂等：若列已命名 ground_id 则跳过。
 * 操作包裹在 BEGIN IMMEDIATE...COMMIT 事务中，确保原子性。
 */
function migrateWarrantGroundsColumn(db: Database): void {
  // Check if column is already named ground_id
  const cols = db.prepare("PRAGMA table_info(warrant_grounds)").all() as Array<{ name: string }>;
  if (cols.some(c => c.name === "ground_id")) return; // already migrated

  // Recreate with renamed column, wrapped in transaction
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE warrant_grounds_new (
      warrant_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      ground_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      PRIMARY KEY (warrant_id, ground_id)
    );
    INSERT INTO warrant_grounds_new (warrant_id, ground_id)
      SELECT warrant_id, statement_id FROM warrant_grounds;
    DROP TABLE warrant_grounds;
    ALTER TABLE warrant_grounds_new RENAME TO warrant_grounds;
    COMMIT;
  `);
}

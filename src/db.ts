/**
 * Warranted — 数据库连接与 Schema 初始化
 *
 * 使用 bun:sqlite(同步 API),零配置嵌入式 SQLite。
 * Schema 本身在 `src/schema.ts`,本文件只负责连接、建表、FTS 探测与旧库识别。
 */

import { Database } from "bun:sqlite";
import {
  SCHEMA_SQL,
  FTS_TABLE_SQL,
  FTS_TRIGGERS_SQL,
  LEGACY_TABLES,
  ONTOLOGY_VERSION,
} from "./schema.ts";

/**
 * 新本体的库文件名。旧本体用的是 `.toulmin/argument.db`,新库另起一个名字,
 * 于是"断代"在文件系统上是可见的:旧库还在原地,只是没人再写它(design.md §5.2)。
 */
export const DEFAULT_DB_PATH = ".toulmin/graph.db";

// FTS5 availability flag — set once at startup
let _ftsAvailable = false;

/** Whether FTS5 is available at runtime */
export function isFtsAvailable(): boolean {
  return _ftsAvailable;
}

/** 旧本体的库文件被当成新库打开时抛这个,信息里带迁移方针。 */
export class LegacyDatabaseError extends Error {
  constructor(public readonly dbPath: string, public readonly tables: string[]) {
    super(
      `${dbPath} 是旧本体(3 节点 + compile)的库,含 ${tables.join(", ")}。\n` +
        `新本体不迁移旧库(docs/design.md §5.2 断代):status × verification × compile_state ` +
        `到 qualifier 的映射需要语义判断,机械迁移会造出"看着有档位、其实没人判过"的命题。\n` +
        `处置:旧库原地保留、只读归档,新图用新库文件(默认 .toulmin/graph.db);` +
        `需要延续的旧结论由 agent 在新图里重新立。`
    );
    this.name = "LegacyDatabaseError";
  }
}

/**
 * 打开数据库并初始化 Schema。
 * @param dbPath - 数据库文件路径,默认 ":memory:"(内存数据库,适合测试)
 */
export function openDatabase(dbPath: string = ":memory:"): Database {
  const db = new Database(dbPath, { create: true });

  // 设置 WAL 模式(内存数据库不需要)
  if (dbPath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
  }

  // 启用外键约束。**必须在事务外发**——在事务内 SQLite 静默忽略这条 pragma,
  // 于是 FK 看起来配了、实际没生效。
  db.exec("PRAGMA foreign_keys = ON;");

  assertNotLegacy(db, dbPath);
  initializeSchema(db);

  return db;
}

/**
 * 旧库识别:命中任意一张旧表就拒绝继续。
 *
 * 不做迁移(design.md §5.2),但也不能默默在旧库上建新表——那会得到一个半新半旧、
 * 谁也读不对的文件。宁可在开库这一刻用一条带方针的错误把人拦住。
 */
export function assertNotLegacy(db: Database, dbPath: string): void {
  const placeholders = LEGACY_TABLES.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`
    )
    .all(...LEGACY_TABLES) as Array<{ name: string }>;

  if (rows.length > 0) {
    throw new LegacyDatabaseError(dbPath, rows.map((r) => r.name));
  }
}

/**
 * 执行 Schema SQL 创建表。
 * 全部 CREATE ... IF NOT EXISTS,可安全重复调用。
 *
 * 没有 migration 函数,这是设计而非欠账:新本体是断代重建的第一版,旧库只读归档。
 * 日后真需要演进时再引入版本号驱动的迁移,不要复活按列名探测的那套。
 */
export function initializeSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('ontology', ?)").run(
    ONTOLOGY_VERSION
  );

  setupFts(db);
}

/**
 * FTS5 虚表与触发器。FTS5 不是所有 SQLite 构建都带,缺了降级到 LIKE 检索,
 * 不是致命错误——所以整段包在 try 里,失败只落一个 flag。
 */
function setupFts(db: Database): void {
  try {
    db.exec(FTS_TABLE_SQL);
    db.exec(FTS_TRIGGERS_SQL);
    _ftsAvailable = true;

    // 索引空但表里有行 = 索引是在建表之后才补上的(或触发器曾缺失),重建一次。
    const nodeCount = (
      db.prepare("SELECT COUNT(*) AS cnt FROM propositions").get() as { cnt: number }
    ).cnt;
    const ftsCount = (
      db.prepare("SELECT COUNT(*) AS cnt FROM propositions_fts").get() as { cnt: number }
    ).cnt;
    if (nodeCount > 0 && ftsCount === 0) {
      db.exec("INSERT INTO propositions_fts(propositions_fts) VALUES ('rebuild')");
    }
  } catch {
    _ftsAvailable = false;
    console.warn("[warranted] FTS5 not available — search will use LIKE only.");
  }
}

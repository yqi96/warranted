/**
 * Toulmin MCP — 数据库连接与 Schema 初始化
 *
 * 使用 bun:sqlite（同步 API），零配置嵌入式 SQLite。
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { resolve } from "path";

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
      type       TEXT    NOT NULL CHECK(type IN ('claim','ground','warrant','backing','qualifier','rebuttal')),
      content    TEXT    NOT NULL,
      data       TEXT    NOT NULL DEFAULT '{}',
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);

    CREATE INDEX IF NOT EXISTS idx_nodes_warrant_claim ON nodes(
      CAST(json_extract(data, '$.claim_id') AS INTEGER)
    ) WHERE type = 'warrant';

    CREATE INDEX IF NOT EXISTS idx_nodes_backing_warrant ON nodes(
      CAST(json_extract(data, '$.warrant_id') AS INTEGER)
    ) WHERE type = 'backing';

    CREATE INDEX IF NOT EXISTS idx_nodes_qualifier_claim ON nodes(
      CAST(json_extract(data, '$.claim_id') AS INTEGER)
    ) WHERE type = 'qualifier';

    CREATE INDEX IF NOT EXISTS idx_nodes_rebuttal_target ON nodes(
      CAST(json_extract(data, '$.target_id') AS INTEGER)
    ) WHERE type = 'rebuttal';

    CREATE INDEX IF NOT EXISTS idx_nodes_ground_ref_claim ON nodes(
      CAST(json_extract(data, '$.ref_claim_id') AS INTEGER)
    ) WHERE type = 'ground' AND json_extract(data, '$.ref_claim_id') IS NOT NULL;

    CREATE TABLE IF NOT EXISTS compile_state (
      claim_id       INTEGER PRIMARY KEY,
      verdict        TEXT    NOT NULL DEFAULT 'passed',
      summary        TEXT    NOT NULL DEFAULT '',
      node_hashes    TEXT    NOT NULL DEFAULT '{}',
      argument_hash  TEXT,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migration: 为已有数据库添加 argument_hash 列
  const columns = db.prepare("PRAGMA table_info(compile_state)").all() as Array<{ name: string }>;
  if (columns.length > 0 && !columns.some(c => c.name === "argument_hash")) {
    db.exec("ALTER TABLE compile_state ADD COLUMN argument_hash TEXT");
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

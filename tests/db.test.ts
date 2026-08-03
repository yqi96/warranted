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
import { openDatabase } from "../src/db.ts";

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

import type { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDatabase } from "../../../src/db.ts";
import { checkContext, type CheckContext } from "../../../src/structural-check.ts";

export interface FixtureDatabase {
  db: Database;
  dbPath: string;
  ctx: CheckContext;
}

/**
 * Open the product database at the same path used in a real Warranted project.
 * Fixture builders deliberately go through the production schema and service
 * layer; a benchmark-local SQL schema would silently drift from the product.
 */
export function openFixtureDatabase(projectDir: string): FixtureDatabase {
  const dbPath = join(projectDir, ".toulmin", "graph.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  return { db: openDatabase(dbPath), dbPath, ctx: checkContext(dbPath) };
}

/** Flush WAL state before a fixture is copied or archived. */
export function closeFixtureDatabase(db: Database, dbPath?: string): void {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.close();
  if (dbPath) {
    // The checkpoint makes these disposable; retaining empty sidecars makes a
    // fixture look like an open, potentially incomplete SQLite snapshot.
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }
}

/**
 * Copy an immutable fixture into a fresh project directory for one review run.
 * review appends events and findings, so reusing the source DB would make runs
 * order-dependent.
 */
export function copyFixtureProject(source: string, destination: string): void {
  if (!existsSync(source)) throw new Error(`Fixture project does not exist: ${source}`);
  if (existsSync(destination)) throw new Error(`Copy destination already exists: ${destination}`);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
}

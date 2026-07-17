/**
 * Tests for compile state enrichment in /viz/graph response.
 *
 * buildGraph() cannot be imported directly (server.ts has top-level side effects),
 * so these tests validate the SQL + data-shaping logic using an in-memory DB
 * that matches the real schema.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as repo from "../src/repo.ts";
import type { NodeRow } from "../src/types.ts";
import { makeClaim, makeGround, makeWarrant, createTestDb, cleanupDb } from "./helpers.ts";

// Replicate the enrichment logic from buildGraph() — single batch query + per-claim lookup
function enrichNodesWithCompileState(db: Database, rows: NodeRow[]) {
  interface CompileStateRow {
    claim_id: number;
    verdict: string;
    summary: string;
    created_at: string;
  }
  const compileStateRows = db.prepare(
    "SELECT claim_id, verdict, summary, created_at FROM compile_state"
  ).all() as CompileStateRow[];
  const compileStateMap = new Map(compileStateRows.map(s => [s.claim_id, s]));

  return rows.map(r => {
    const data = repo.parseNodeData(r) as Record<string, unknown>;
    if (r.type === "claim") {
      const cs = compileStateMap.get(r.id);
      data.compile_verdict = cs?.verdict ?? null;
      data.compile_summary = cs?.summary ?? null;
      data.compile_created_at = cs?.created_at ?? null;
    }
    return { id: r.id, type: r.type, content: r.content, data };
  });
}

describe("buildGraph compile state enrichment", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    cleanupDb(db);
  });

  it("scenario 1: compile passed — compile_verdict='passed', compile_summary non-null", () => {
    const claim = makeClaim(db, "Passed claim");
    const now = new Date().toISOString().slice(0, 19);
    // Mark compiled in node data
    const nodeData = JSON.parse((db.prepare("SELECT data FROM nodes WHERE id=?").get(claim.id) as {data: string}).data);
    nodeData.compiled = true;
    nodeData.stale = false;
    db.prepare("UPDATE nodes SET data=? WHERE id=?").run(JSON.stringify(nodeData), claim.id);
    // Insert compile_state with passed verdict
    db.prepare("INSERT INTO compile_state (claim_id, verdict, summary, node_hashes, argument_hash, created_at) VALUES (?,?,?,?,?,?)")
      .run(claim.id, "passed", "All checks passed.", "{}", "abc123", now);

    const rows = db.prepare("SELECT * FROM nodes WHERE id=?").all(claim.id) as NodeRow[];
    const enriched = enrichNodesWithCompileState(db, rows);
    const node = enriched[0];

    expect(node.data.compile_verdict).toBe("passed");
    expect(typeof node.data.compile_summary).toBe("string");
    expect((node.data.compile_summary as string).length).toBeGreaterThan(0);
    expect(node.data.compile_created_at).toBe(now);
  });

  it("scenario 2: compile failed — compile_verdict='failed', compile_summary non-null", () => {
    const claim = makeClaim(db, "Failed claim");
    const now = new Date().toISOString().slice(0, 19);
    // Mark stale=true, compiled=false in node data
    const nodeData = JSON.parse((db.prepare("SELECT data FROM nodes WHERE id=?").get(claim.id) as {data: string}).data);
    nodeData.compiled = false;
    nodeData.stale = true;
    db.prepare("UPDATE nodes SET data=? WHERE id=?").run(JSON.stringify(nodeData), claim.id);
    // Insert compile_state with failed verdict
    db.prepare("INSERT INTO compile_state (claim_id, verdict, summary, node_hashes, argument_hash, created_at) VALUES (?,?,?,?,?,?)")
      .run(claim.id, "failed", "Structural pre-check failed: no warrants.", "{}", null, now);

    const rows = db.prepare("SELECT * FROM nodes WHERE id=?").all(claim.id) as NodeRow[];
    const enriched = enrichNodesWithCompileState(db, rows);
    const node = enriched[0];

    expect(node.data.compile_verdict).toBe("failed");
    expect(typeof node.data.compile_summary).toBe("string");
    expect((node.data.compile_summary as string).length).toBeGreaterThan(0);
  });

  it("scenario 3: stale + compile_state deleted (post-invalidation) — compile_verdict=null, compile_summary=null", () => {
    const claim = makeClaim(db, "Stale invalidated claim");
    // Mark stale in node data — compile_state row does NOT exist
    const nodeData = JSON.parse((db.prepare("SELECT data FROM nodes WHERE id=?").get(claim.id) as {data: string}).data);
    nodeData.stale = true;
    nodeData.compiled = false;
    db.prepare("UPDATE nodes SET data=? WHERE id=?").run(JSON.stringify(nodeData), claim.id);
    // No compile_state row inserted

    const rows = db.prepare("SELECT * FROM nodes WHERE id=?").all(claim.id) as NodeRow[];
    const enriched = enrichNodesWithCompileState(db, rows);
    const node = enriched[0];

    expect(node.data.compile_verdict).toBeNull();
    expect(node.data.compile_summary).toBeNull();
    expect(node.data.compile_created_at).toBeNull();
  });

  it("scenario 4: never compiled — compile_verdict=null, compile_summary=null", () => {
    const claim = makeClaim(db, "Never compiled claim");
    // Default node data: no compiled, no stale, no compile_state row

    const rows = db.prepare("SELECT * FROM nodes WHERE id=?").all(claim.id) as NodeRow[];
    const enriched = enrichNodesWithCompileState(db, rows);
    const node = enriched[0];

    expect(node.data.compile_verdict).toBeNull();
    expect(node.data.compile_summary).toBeNull();
    expect(node.data.compile_created_at).toBeNull();
    // compiled flag not set
    expect(node.data.compiled).toBeUndefined();
  });

  it("scenario 5: non-claim nodes do not get compile_verdict field", () => {
    const claim = makeClaim(db, "Parent claim");
    const ground = makeGround(db, { content: "Test ground" });
    const warrant = makeWarrant(db, claim.id, [ground.id]);

    const rows = db.prepare("SELECT * FROM nodes ORDER BY id").all() as NodeRow[];
    const enriched = enrichNodesWithCompileState(db, rows);

    for (const node of enriched) {
      if (node.type === "claim") {
        expect("compile_verdict" in node.data).toBe(true);
      } else {
        expect("compile_verdict" in node.data).toBe(false);
      }
    }
  });

  it("single batch query covers multiple claims", () => {
    const c1 = makeClaim(db, "Claim 1");
    const c2 = makeClaim(db, "Claim 2");
    const now = new Date().toISOString().slice(0, 19);

    db.prepare("INSERT INTO compile_state (claim_id, verdict, summary, node_hashes, argument_hash, created_at) VALUES (?,?,?,?,?,?)")
      .run(c1.id, "passed", "Passed.", "{}", null, now);
    // c2 has no compile_state

    const rows = db.prepare("SELECT * FROM nodes ORDER BY id").all() as NodeRow[];
    const enriched = enrichNodesWithCompileState(db, rows);

    const n1 = enriched.find(n => n.id === c1.id)!;
    const n2 = enriched.find(n => n.id === c2.id)!;

    expect(n1.data.compile_verdict).toBe("passed");
    expect(n2.data.compile_verdict).toBeNull();
  });
});

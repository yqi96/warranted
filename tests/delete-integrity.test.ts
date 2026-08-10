/**
 * Warranted — PR5 Write-Path Integrity Tests
 *
 * Tests for D1 (collateral deletion invalidation + ground set consistency),
 * D2 (cycle detection in update_node ground_ids.add),
 * and D4/D5 (dead branches removed).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb, cleanupDb, makeClaim, makeGround, makeWarrant, makeBacking, makeRebuttal, makeCompiledClaim } from "./helpers.ts";
import * as service from "../src/service.ts";
import * as repo from "../src/repo.ts";
import { WARNINGS } from "../src/content/warnings.ts";
import { registerTools } from "../src/tools.ts";
import type { ReviewConfig } from "../src/review-config.ts";

let db: Database;
let tools: Record<string, { schema: any; handler: Function }>;

function createMockServer() {
  const registered: Record<string, { schema: any; handler: Function }> = {};
  return {
    registerTool(name: string, config: any, handler: Function) {
      registered[name] = { schema: config.inputSchema, handler };
    },
    _tools: registered,
  };
}

beforeEach(() => {
  db = createTestDb();
  const server = createMockServer();
  registerTools(server, db);
  tools = server._tools;
});

afterEach(() => {
  cleanupDb(db);
});

// =============================================================================
// P1: Collateral deletion invalidates dependent Claims
// =============================================================================

// P1/P3 go through the delete_node tool handler on purpose: the invalidation of
// collateral nodes lives at the tool layer, so a test that re-implements that loop
// itself passes even if the handler stops invalidating anything.
async function callDeleteNode(node_id: number, cascade?: boolean) {
  return await tools.delete_node.handler({ node_id, cascade });
}

describe("P1: Collateral deletion invalidates dependent Claims", () => {
  test("Statement S is Backing of W1 and Ground of W2; deleting W1's Claim leaves W2's Claim not 'passed'", async () => {
    const claim1 = makeClaim(db, "Claim 1");
    const claim2 = makeClaim(db, "Claim 2");

    // S is both a backing of W1 and a ground of W2
    const S = makeGround(db, { content: "Shared statement", source: "observed", verification: "verified" });
    const W1 = makeWarrant(db, claim1.id, [S.id]);
    db.prepare("INSERT OR IGNORE INTO warrant_backings (warrant_id, statement_id) VALUES (?, ?)").run(W1.id, S.id);
    const W2 = makeWarrant(db, claim2.id, [S.id]);

    repo.setCompileStatus(db, claim2.id, "passed");
    repo.setClaimStatus(db, claim2.id, "supported");
    expect(JSON.parse(repo.getNodeById(db, claim2.id)!.data).compile_status).toBe("passed");

    const res = await callDeleteNode(claim1.id, true);
    expect(res.isError).toBeUndefined();

    const c2After = JSON.parse(repo.getNodeById(db, claim2.id)!.data);
    expect(c2After.compile_status).not.toBe("passed");
    expect(c2After.status).toBe("proposed");
  });
});

// =============================================================================
// P2: data.ground_ids and warrant_grounds agree after collateral deletion
// =============================================================================

describe("P2: data.ground_ids and warrant_grounds agree after deletion", () => {
  test("After deleting shared ground from collateral, W2's data.ground_ids and warrant_grounds agree", () => {
    const claim1 = makeClaim(db, "Claim 1");
    const claim2 = makeClaim(db, "Claim 2");
    const S = makeGround(db, { content: "Shared statement", source: "observed", verification: "verified" });
    const W1 = makeWarrant(db, claim1.id, [S.id]);
    db.prepare("INSERT OR IGNORE INTO warrant_backings (warrant_id, statement_id) VALUES (?, ?)").run(W1.id, S.id);
    const W2 = makeWarrant(db, claim2.id, [S.id]);

    // Delete claim1 (cascade). S is a backing of W1, so it gets deleted as collateral.
    service.deleteNode(db, claim1.id, true);

    // Check W2's data.ground_ids
    const w2Row = repo.getNodeById(db, W2.id)!;
    const w2Data = JSON.parse(w2Row.data);
    const groundIdsFromJson: number[] = w2Data.ground_ids || [];

    // Check warrant_grounds for W2
    const wgRows = db.prepare("SELECT ground_id FROM warrant_grounds WHERE warrant_id = ?").all(W2.id) as Array<{ ground_id: number }>;
    const groundIdsFromTable = wgRows.map(r => r.ground_id);

    // Both should agree (S was deleted, so it should be removed from both)
    expect(groundIdsFromJson).toEqual(groundIdsFromTable);
    // S should NOT appear in either (since it was deleted as collateral)
    expect(groundIdsFromJson).not.toContain(S.id);
    expect(groundIdsFromTable).not.toContain(S.id);
  });
});

// =============================================================================
// P3: Delete returns warnings naming collaterally invalidated Claims
// =============================================================================

describe("P3: Delete returns warnings naming collaterally invalidated Claims", () => {
  test("Delete returns warning naming every collaterally invalidated Claim", async () => {
    const claim1 = makeClaim(db, "Claim 1");
    const claim2 = makeClaim(db, "Claim 2");
    const claim3 = makeClaim(db, "Claim 3");
    const S = makeGround(db, { content: "Shared statement", source: "observed", verification: "verified" });
    const W1 = makeWarrant(db, claim1.id, [S.id]);
    db.prepare("INSERT OR IGNORE INTO warrant_backings (warrant_id, statement_id) VALUES (?, ?)").run(W1.id, S.id);
    makeWarrant(db, claim2.id, [S.id]);
    makeWarrant(db, claim3.id, [S.id]);

    repo.setCompileStatus(db, claim2.id, "passed");
    repo.setCompileStatus(db, claim3.id, "passed");

    const res = await callDeleteNode(claim1.id, true);
    const text = res.content[0].text;

    // Both dependent Claims must be named — "which three" is the user-visible half of D1
    expect(text).toContain(WARNINGS.compileInvalidated(claim2.id, S.id));
    expect(text).toContain(WARNINGS.compileInvalidated(claim3.id, S.id));
  });

  test("Invalidation warnings are not printed twice", async () => {
    const claim1 = makeClaim(db, "Claim 1");
    const claim2 = makeClaim(db, "Claim 2");
    const S = makeGround(db, { content: "Shared statement", source: "observed", verification: "verified" });
    const W1 = makeWarrant(db, claim1.id, [S.id]);
    db.prepare("INSERT OR IGNORE INTO warrant_backings (warrant_id, statement_id) VALUES (?, ?)").run(W1.id, S.id);
    makeWarrant(db, claim2.id, [S.id]);
    repo.setCompileStatus(db, claim2.id, "passed");

    const res = await callDeleteNode(claim1.id, true);
    const warning = WARNINGS.compileInvalidated(claim2.id, S.id);
    const occurrences = res.content[0].text.split(warning).length - 1;
    expect(occurrences).toBe(1);
  });

  test("A Statement reachable twice in the cascade set is only invalidated once", async () => {
    const claim1 = makeClaim(db, "Claim 1");
    const claim2 = makeClaim(db, "Claim 2");
    const W1 = makeWarrant(db, claim1.id, []);
    // S is a backing of W1 AND a rebuttal against W1 — two paths to the same collateral id
    const S = makeGround(db, { content: "Doubly reachable", source: "observed", verification: "verified" });
    db.prepare("INSERT OR IGNORE INTO warrant_backings (warrant_id, statement_id) VALUES (?, ?)").run(W1.id, S.id);
    db.prepare("INSERT OR IGNORE INTO rebuttal_targets (statement_id, target_id, target_type) VALUES (?, ?, 'warrant')").run(S.id, W1.id);
    makeWarrant(db, claim2.id, [S.id]);
    repo.setCompileStatus(db, claim2.id, "passed");

    const res = await callDeleteNode(claim1.id, true);
    const warning = WARNINGS.compileInvalidated(claim2.id, S.id);
    const occurrences = res.content[0].text.split(warning).length - 1;
    expect(occurrences).toBe(1);
  });
});

// =============================================================================
// P7: A failed delete must not leave invalidation mutations behind
// =============================================================================

describe("P7: Failed delete is atomic with its invalidation", () => {
  test("delete_node(claim, cascade=false) fails without reverting the Claim's status or compile state", async () => {
    const claim = makeClaim(db, "Guarded claim");
    const g = makeGround(db, { content: "G", source: "observed", verification: "verified" });
    makeWarrant(db, claim.id, [g.id]);
    repo.setCompileStatus(db, claim.id, "passed");
    repo.setClaimStatus(db, claim.id, "supported");
    db.prepare(
      "INSERT OR REPLACE INTO compile_state (claim_id, verdict, summary, node_hashes, argument_hash) VALUES (?, 'passed', '', '{}', 'h1')"
    ).run(claim.id);

    const res = await callDeleteNode(claim.id, false);
    expect(res.isError).toBe(true);

    // The node is still there, and so is everything the invalidation would have stripped
    const after = JSON.parse(repo.getNodeById(db, claim.id)!.data);
    expect(after.status).toBe("supported");
    expect(after.compile_status).toBe("passed");
    expect(repo.getCompileState(db, claim.id)).not.toBeNull();
  });
});

// =============================================================================
// P8: Claim-as-Ground deletion keeps JSON and relation table in agreement
// =============================================================================

describe("P8: Deleting a Claim used as a Ground cleans both stores", () => {
  test("W2's data.ground_ids drops the deleted Claim, matching warrant_grounds", async () => {
    const parent = makeClaim(db, "Parent claim");
    const sub = makeClaim(db, "Sub-claim used as ground");
    // sub is a ground of parent's warrant (chain reasoning)
    const W2 = makeWarrant(db, parent.id, [sub.id]);
    const other = makeGround(db, { content: "Plain ground", source: "observed" });
    db.prepare("INSERT OR IGNORE INTO warrant_grounds (warrant_id, ground_id) VALUES (?, ?)").run(W2.id, other.id);
    const w2Data0 = JSON.parse(repo.getNodeById(db, W2.id)!.data);
    w2Data0.ground_ids = [sub.id, other.id];
    db.prepare("UPDATE nodes SET data = ? WHERE id = ?").run(JSON.stringify(w2Data0), W2.id);

    const res = await callDeleteNode(sub.id, true);
    expect(res.isError).toBeUndefined();

    const fromJson: number[] = JSON.parse(repo.getNodeById(db, W2.id)!.data).ground_ids || [];
    const fromTable = (db.prepare("SELECT ground_id FROM warrant_grounds WHERE warrant_id = ?").all(W2.id) as Array<{ ground_id: number }>)
      .map(r => r.ground_id);

    expect(fromJson).not.toContain(sub.id);
    expect(fromJson.slice().sort()).toEqual(fromTable.slice().sort());
  });
});

// =============================================================================
// P4: Deleting a Statement directly still behaves as before
// =============================================================================

describe("P4: Direct statement deletion regression", () => {
  test("Deleting a Statement directly still warns and removes ground", () => {
    const claim = makeClaim(db);
    const g1 = makeGround(db, { content: "G1" });
    const g2 = makeGround(db, { content: "G2" });
    const warrant = makeWarrant(db, claim.id, [g1.id, g2.id]);

    const result = service.deleteNode(db, g1.id);
    expect(result.length).toBe(1);
    expect(result[0]).toContain("Warrant");

    // Ground removed from warrant
    const updated = repo.findGroundsByWarrant(db, warrant.id);
    const updatedIds = updated.map(r => r.id);
    expect(updatedIds).not.toContain(g1.id);
    expect(updatedIds).toContain(g2.id);
  });

  test("Deleting a Statement not referenced by any Warrant has no warning", () => {
    const g = makeGround(db, { content: "Isolated" });
    const result = service.deleteNode(db, g.id);
    expect(result.length).toBe(0);
  });
});

// =============================================================================
// P5: Cycle detection in update_node ground_ids.add
// =============================================================================

describe("P5: Cycle detection in update_node ground_ids.add", () => {
  test("A support cycle rejected by create_warrant is also rejected by update_node(ground_ids={add})", () => {
    // Create a chain: Claim A → Warrant → Claim B (as ground)
    const claimA = makeClaim(db, "Parent claim");
    const claimB = makeClaim(db, "Sub-claim");
    // Claim B is a ground of Claim A via warrant
    const warrant = makeWarrant(db, claimA.id, [claimB.id]);

    // Now try to add Claim A as a ground of Claim B's warrant via update_node
    // This would create a cycle: A → B → A
    // First create a warrant for claimB
    const warrantB = makeWarrant(db, claimB.id, []);

    // Try to add claimA as a ground of warrantB (which would create A → B → A cycle)
    expect(() => {
      service.updateNode(db, warrantB.id, {
        ground_ids: { add: [claimA.id] },
      });
    }).toThrow(/circular|cycle/i);
  });

  test("A legal (non-cyclic) ground add through update_node still succeeds", () => {
    const claimA = makeClaim(db, "Parent claim");
    const claimB = makeClaim(db, "Sub-claim");
    // claimB is a ground of claimA
    const warrant = makeWarrant(db, claimA.id, [claimB.id]);

    // Create a third claim C that is not in the chain
    const claimC = makeClaim(db, "Independent claim");
    // Add claimC as a ground of an existing warrant — no cycle
    const result = service.updateNode(db, warrant.id, {
      ground_ids: { add: [claimC.id] },
    });
    // Should succeed
    const updatedWarrant = repo.findGroundsByWarrant(db, warrant.id);
    const updatedIds = updatedWarrant.map(r => r.id);
    expect(updatedIds).toContain(claimC.id);
  });
});
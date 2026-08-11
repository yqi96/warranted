/**
 * Warranted — PR5 Write-Path Integrity Tests
 *
 * Tests for D1 (collateral deletion invalidation + ground set consistency),
 * D2 (cycle detection in update_node ground_ids.add),
 * and D4/D5 (dead branches removed).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb, cleanupDb, makeClaim, makeGround, makeWarrant, makeBacking, makeRebuttal, makeCompiledClaim, compileVerdictOf } from "./helpers.ts";
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

    repo.saveCompileState(db, claim2.id, "passed", "");
    repo.setClaimStatus(db, claim2.id, "supported");
    expect(compileVerdictOf(db, claim2.id)).toBe("passed");

    const res = await callDeleteNode(claim1.id, true);
    expect(res.isError).toBeUndefined();

    expect(compileVerdictOf(db, claim2.id)).not.toBe("passed");
    expect(JSON.parse(repo.getNodeById(db, claim2.id)!.data).status).toBe("proposed");
  });
});

// =============================================================================
// P2: a collaterally deleted ground leaves no dangling edge behind
//
// 原来这条叫 "data.ground_ids and warrant_grounds agree"：ground 集合曾经存两份，
// 删除路径要同时清两边，漏一边就不一致。现在只有 warrant_grounds 一份，
// "两边一致"无从谈起，剩下的真问题是删除有没有真的把边清掉。
// =============================================================================

describe("P2: 被连带删除的 ground 不留下悬空关系", () => {
  test("共享 ground 被连带删除后，另一个 Warrant 的 ground 集合里没有它", () => {
    const claim1 = makeClaim(db, "Claim 1");
    const claim2 = makeClaim(db, "Claim 2");
    const S = makeGround(db, { content: "Shared statement", source: "observed", verification: "verified" });
    const W1 = makeWarrant(db, claim1.id, [S.id]);
    db.prepare("INSERT OR IGNORE INTO warrant_backings (warrant_id, statement_id) VALUES (?, ?)").run(W1.id, S.id);
    const W2 = makeWarrant(db, claim2.id, [S.id]);

    // Delete claim1 (cascade). S is a backing of W1, so it gets deleted as collateral.
    service.deleteNode(db, claim1.id, true);

    expect(repo.findGroundIdsByWarrant(db, W2.id)).not.toContain(S.id);
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

    repo.saveCompileState(db, claim2.id, "passed", "");
    repo.saveCompileState(db, claim3.id, "passed", "");

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
    repo.saveCompileState(db, claim2.id, "passed", "");

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
    repo.saveCompileState(db, claim2.id, "passed", "");

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
    repo.saveCompileState(db, claim.id, "passed", "");
    repo.setClaimStatus(db, claim.id, "supported");
    db.prepare(
      "INSERT OR REPLACE INTO compile_state (claim_id, verdict, summary, node_hashes, argument_hash) VALUES (?, 'passed', '', '{}', 'h1')"
    ).run(claim.id);

    const res = await callDeleteNode(claim.id, false);
    expect(res.isError).toBe(true);

    // The node is still there, and so is everything the invalidation would have stripped
    expect(JSON.parse(repo.getNodeById(db, claim.id)!.data).status).toBe("supported");
    expect(compileVerdictOf(db, claim.id)).toBe("passed");
  });
});

// =============================================================================
// P8: Claim-as-Ground deletion removes the warrant->ground edge
// =============================================================================

describe("P8: 删除被当作 Ground 的 Claim 会清掉那条关系", () => {
  test("W2 的 ground 集合丢掉被删的 Claim，保留另一个 ground", async () => {
    const parent = makeClaim(db, "Parent claim");
    const sub = makeClaim(db, "Sub-claim used as ground");
    // sub is a ground of parent's warrant (chain reasoning)
    const other = makeGround(db, { content: "Plain ground", source: "observed" });
    const W2 = makeWarrant(db, parent.id, [sub.id, other.id]);

    const res = await callDeleteNode(sub.id, true);
    expect(res.isError).toBeUndefined();

    expect(repo.findGroundIdsByWarrant(db, W2.id)).toEqual([other.id]);
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
/**
 * structuralQualityCheck 综合测试
 *
 * 覆盖18条规则：A1-A2, B1-B6, C1-C6, D1-D4
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestDb,
  cleanupDb,
  makeClaim,
  makeGround,
  makeWarrant,
  makeBacking,
  makeRebuttal,
  seedBasicArgument,
} from "./helpers.ts";
import { structuralQualityCheck } from "../src/compile-service.ts";
import * as repo from "../src/repo.ts";
import type { Database } from "bun:sqlite";

let db: Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  cleanupDb(db);
});

// =============================================================================
// Helpers
// =============================================================================

function setClaimStatus(db: Database, claimId: number, status: string) {
  const row = repo.getNodeById(db, claimId)!;
  const data = JSON.parse(row.data);
  data.status = status;
  repo.updateNodeFields(db, claimId, { data });
}

function setClaimData(db: Database, claimId: number, patch: Record<string, unknown>) {
  const row = repo.getNodeById(db, claimId)!;
  const data = JSON.parse(row.data);
  Object.assign(data, patch);
  repo.updateNodeFields(db, claimId, { data });
}

// =============================================================================
// Baseline: clean argument produces empty structure result
// =============================================================================

describe("baseline", () => {
  test("clean argument → errors=[], warnings=[], reviewer=structure", () => {
    const { claim } = seedBasicArgument(db);
    const result = structuralQualityCheck(db, claim.id);
    expect(result.reviewer).toBe("structure");
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("non-existent claim → empty result (pre-check concern)", () => {
    const result = structuralQualityCheck(db, 9999);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

// =============================================================================
// Category A: Referential Integrity
// =============================================================================

describe("Category A — Referential Integrity", () => {
  test("A1: ref_claim_id points to non-existent node → error", () => {
    const claim = makeClaim(db, "Claim");
    const ground = makeGround(db, { refClaimId: 9999 });
    makeWarrant(db, claim.id, [ground.id]);

    const result = structuralQualityCheck(db, claim.id);
    expect(result.errors.some(e => e.includes("non-existent") && e.includes(`${ground.id}`))).toBe(true);
  });

  test("A2: ref_claim_id points to non-Claim node → error", () => {
    const claim = makeClaim(db, "Claim");
    const otherWarrant = makeWarrant(db, claim.id, []);
    const ground = makeGround(db, { refClaimId: otherWarrant.id });
    const warrant = makeWarrant(db, claim.id, [ground.id]);

    const result = structuralQualityCheck(db, claim.id);
    expect(result.errors.some(e => e.includes("not a Claim") && e.includes(`${ground.id}`))).toBe(true);
  });

  test("A: valid ref_claim_id to actual Claim → no A error", () => {
    const claim = makeClaim(db, "Parent claim");
    const subClaim = makeClaim(db, "Sub claim");
    const ground = makeGround(db, { refClaimId: subClaim.id });
    makeWarrant(db, claim.id, [ground.id]);

    const result = structuralQualityCheck(db, claim.id);
    expect(result.errors.filter(e => e.includes("ref_claim_id"))).toHaveLength(0);
  });
});

// =============================================================================
// Category B: Individual Quality
// =============================================================================

describe("Category B — Individual Quality", () => {
  test("B1: ground verification=pending → warning", () => {
    const claim = makeClaim(db, "Claim");
    const ground = makeGround(db, { source: "observed", verification: "pending" });
    makeWarrant(db, claim.id, [ground.id]);

    const result = structuralQualityCheck(db, claim.id);
    expect(result.warnings.some(w => w.includes("pending") && w.includes(`${ground.id}`))).toBe(true);
    // B6 should NOT fire (not hypothesis)
    expect(result.warnings.some(w => w.includes("both hypothesis") && w.includes(`${ground.id}`))).toBe(false);
  });

  test("B2: ground source=hypothesis, ref_claim_id=null → warning", () => {
    const claim = makeClaim(db, "Claim");
    const ground = makeGround(db, { source: "hypothesis", verification: "verified", refClaimId: null });
    makeWarrant(db, claim.id, [ground.id]);

    const result = structuralQualityCheck(db, claim.id);
    expect(result.warnings.some(w => w.includes("hypothesis") && w.includes(`${ground.id}`))).toBe(true);
  });

  test("B2: suppressed when ref_claim_id is non-null (chain reasoning)", () => {
    const claim = makeClaim(db, "Parent claim");
    const subClaim = makeClaim(db, "Sub claim");
    const ground = makeGround(db, { source: "hypothesis", verification: "verified", refClaimId: subClaim.id });
    makeWarrant(db, claim.id, [ground.id]);

    const result = structuralQualityCheck(db, claim.id);
    // No B2 warning for chain-reasoning ground with ref_claim_id set
    expect(result.warnings.filter(w => w.includes("hypothesis") && w.includes(`${ground.id}`))).toHaveLength(0);
  });

  test("B3: warrant without backing → warning", () => {
    const claim = makeClaim(db, "Claim");
    const ground = makeGround(db, { verification: "verified" });
    const warrant = makeWarrant(db, claim.id, [ground.id]);
    // No backing created

    const result = structuralQualityCheck(db, claim.id);
    expect(result.warnings.some(w => w.includes("no Backing") && w.includes(`${warrant.id}`))).toBe(true);
  });

  test("B3: warrant with backing → no B3 warning", () => {
    const { claim, warrant } = seedBasicArgument(db);
    const result = structuralQualityCheck(db, claim.id);
    expect(result.warnings.filter(w => w.includes("no Backing") && w.includes(`${warrant.id}`))).toHaveLength(0);
  });

  test("B4: claim has rebuttal → warning", () => {
    const claim = makeClaim(db, "Claim");
    const ground = makeGround(db);
    makeWarrant(db, claim.id, [ground.id]);
    makeRebuttal(db, claim.id, "claim", "Counter argument");

    const result = structuralQualityCheck(db, claim.id);
    expect(result.warnings.some(w => w.includes("rebuttal") && w.includes(`#${claim.id}`))).toBe(true);
  });

  test("B5: warrant has rebuttal → warning", () => {
    const claim = makeClaim(db, "Claim");
    const ground = makeGround(db);
    const warrant = makeWarrant(db, claim.id, [ground.id]);
    makeBacking(db, warrant.id);
    makeRebuttal(db, warrant.id, "warrant", "Counter warrant");

    const result = structuralQualityCheck(db, claim.id);
    expect(result.warnings.some(w => w.includes("rebuttal") && w.includes(`#${warrant.id}`))).toBe(true);
  });

  test("B6: hypothesis+pending ground → B6 emitted, NOT B1+B2 separately", () => {
    const claim = makeClaim(db, "Claim");
    const ground = makeGround(db, { source: "hypothesis", verification: "pending", refClaimId: null });
    makeWarrant(db, claim.id, [ground.id]);

    const result = structuralQualityCheck(db, claim.id);

    // B6 fires
    const b6Warnings = result.warnings.filter(w => w.includes("both hypothesis and unverified"));
    expect(b6Warnings.length).toBeGreaterThanOrEqual(1);

    // B1 (verification=pending) should NOT be emitted separately
    const b1Warnings = result.warnings.filter(w => w.includes("verification=pending") && w.includes(`${ground.id}`));
    expect(b1Warnings).toHaveLength(0);

    // B2 (source=hypothesis without chain reasoning) should NOT be emitted separately
    const b2Warnings = result.warnings.filter(w => w.includes("source=hypothesis without chain") && w.includes(`${ground.id}`));
    expect(b2Warnings).toHaveLength(0);
  });

  test("B6 suppressed by ref_claim_id (chain-reasoning hypothesis+pending)", () => {
    const parentClaim = makeClaim(db, "Parent");
    const subClaim = makeClaim(db, "Sub");
    // hypothesis+pending but has ref_claim_id → chain reasoning, neither B6 nor B2 fires
    const ground = makeGround(db, { source: "hypothesis", verification: "pending", refClaimId: subClaim.id });
    makeWarrant(db, parentClaim.id, [ground.id]);

    const result = structuralQualityCheck(db, parentClaim.id);
    // No B6 warning
    expect(result.warnings.filter(w => w.includes("both hypothesis") && w.includes(`${ground.id}`))).toHaveLength(0);
    // No B2 warning
    expect(result.warnings.filter(w => w.includes("hypothesis without chain") && w.includes(`${ground.id}`))).toHaveLength(0);
    // B1 (pending) still fires — ref_claim_id doesn't suppress verification check
    expect(result.warnings.some(w => w.includes("pending") && w.includes(`${ground.id}`))).toBe(true);
  });
});

// =============================================================================
// Category C: Aggregate Quality
// =============================================================================

describe("Category C — Aggregate Quality", () => {
  test("C1: all grounds in warrant are pending → warning", () => {
    const claim = makeClaim(db, "Claim");
    const g1 = makeGround(db, { source: "observed", verification: "pending" });
    const g2 = makeGround(db, { source: "literature", verification: "pending" });
    const warrant = makeWarrant(db, claim.id, [g1.id, g2.id]);
    makeBacking(db, warrant.id);

    const result = structuralQualityCheck(db, claim.id);
    expect(result.warnings.some(w => w.includes(`Warrant #${warrant.id}`) && w.includes("all grounds") && w.includes("pending"))).toBe(true);
  });

  test("C2: all grounds in warrant are hypothesis (no ref) → warning", () => {
    const claim = makeClaim(db, "Claim");
    const g1 = makeGround(db, { source: "hypothesis", verification: "verified", refClaimId: null });
    const g2 = makeGround(db, { source: "hypothesis", verification: "verified", refClaimId: null });
    const warrant = makeWarrant(db, claim.id, [g1.id, g2.id]);
    makeBacking(db, warrant.id);

    const result = structuralQualityCheck(db, claim.id);
    expect(result.warnings.some(w => w.includes(`Warrant #${warrant.id}`) && w.includes("hypothesis without chain"))).toBe(true);
  });

  test("C3: all grounds hypothesis+pending → only C3, not C1+C2", () => {
    const claim = makeClaim(db, "Claim");
    const g1 = makeGround(db, { source: "hypothesis", verification: "pending", refClaimId: null });
    const g2 = makeGround(db, { source: "hypothesis", verification: "pending", refClaimId: null });
    const warrant = makeWarrant(db, claim.id, [g1.id, g2.id]);
    makeBacking(db, warrant.id);

    const result = structuralQualityCheck(db, claim.id);

    // C3 emitted
    expect(result.warnings.some(w => w.includes("fully speculative") && w.includes(`${warrant.id}`))).toBe(true);

    // C1 NOT emitted for the same warrant (C1-specific message contains "all grounds have verification=pending")
    expect(result.warnings.filter(w => w.includes(`Warrant #${warrant.id}`) && w.includes("all grounds have verification=pending"))).toHaveLength(0);

    // C2 NOT emitted for the same warrant (C2-specific message contains "all grounds are hypothesis without chain")
    expect(result.warnings.filter(w => w.includes(`Warrant #${warrant.id}`) && w.includes("all grounds are hypothesis without chain"))).toHaveLength(0);
  });

  test("C4 WARNING: no verified warrant but claim status=proposed", () => {
    const claim = makeClaim(db, "Claim", "proposed");
    const ground = makeGround(db, { verification: "pending" });
    makeWarrant(db, claim.id, [ground.id]);

    const result = structuralQualityCheck(db, claim.id);
    expect(result.errors.filter(e => e.includes("no warrant"))).toHaveLength(0);
    expect(result.warnings.some(w => w.includes("no warrant where all grounds are verified"))).toBe(true);
  });

  test("C4 ERROR: status=supported but no verified warrant (post-transition revert)", () => {
    const claim = makeClaim(db, "Claim", "proposed");
    setClaimStatus(db, claim.id, "supported");

    const g1 = makeGround(db, { verification: "verified" });
    const g2 = makeGround(db, { verification: "pending" }); // simulates revert
    makeWarrant(db, claim.id, [g1.id, g2.id]);

    const result = structuralQualityCheck(db, claim.id);
    expect(result.errors.some(e => e.includes(`"supported"`) && e.includes("no warrant has all grounds verified"))).toBe(true);
  });

  test("C4 PASS: supported claim with at least one fully-verified warrant", () => {
    const claim = makeClaim(db, "Claim", "proposed");
    setClaimStatus(db, claim.id, "supported");

    // Warrant 1: mixed verification
    const g1 = makeGround(db, { verification: "pending" });
    const g2 = makeGround(db, { verification: "verified" });
    makeWarrant(db, claim.id, [g1.id, g2.id]);

    // Warrant 2: all verified → satisfies C4
    const g3 = makeGround(db, { verification: "verified" });
    const g4 = makeGround(db, { verification: "verified" });
    makeWarrant(db, claim.id, [g3.id, g4.id]);

    const result = structuralQualityCheck(db, claim.id);
    // No C4 error or warning
    expect(result.errors.filter(e => e.includes("no warrant"))).toHaveLength(0);
    expect(result.warnings.filter(w => w.includes("no warrant where all grounds are verified"))).toHaveLength(0);
  });

  test("C5: total rebuttals >= 4 → info", () => {
    const claim = makeClaim(db, "Claim");
    const ground = makeGround(db);
    const warrant = makeWarrant(db, claim.id, [ground.id]);

    // 3 rebuttals on claim + 2 on warrant = 5 total
    makeRebuttal(db, claim.id, "claim", "R1");
    makeRebuttal(db, claim.id, "claim", "R2");
    makeRebuttal(db, claim.id, "claim", "R3");
    makeRebuttal(db, warrant.id, "warrant", "R4");
    makeRebuttal(db, warrant.id, "warrant", "R5");

    const result = structuralQualityCheck(db, claim.id);
    expect(result.infos?.some(i => i.includes("rebuttal") && i.includes("5"))).toBe(true);
  });

  test("C5: rebuttals below threshold → no info", () => {
    const { claim } = seedBasicArgument(db);
    // Add 3 rebuttals (below threshold of 4)
    makeRebuttal(db, claim.id, "claim", "R1");
    makeRebuttal(db, claim.id, "claim", "R2");
    makeRebuttal(db, claim.id, "claim", "R3");

    const result = structuralQualityCheck(db, claim.id);
    expect(result.infos?.filter(i => i.includes("rebuttal") && i.includes("3"))).toHaveLength(0);
  });

  test("C6: associated orphan ground (ref_claim_id=claimId but not in warrant) → warning", () => {
    const claim = makeClaim(db, "Claim");
    const ground1 = makeGround(db, { verification: "verified" });
    makeWarrant(db, claim.id, [ground1.id]);

    // Ground that references the claim but is NOT in any warrant
    const orphanGround = makeGround(db, { refClaimId: claim.id, content: "Orphan associated ground" });

    const result = structuralQualityCheck(db, claim.id);
    expect(result.warnings.some(w => w.includes(`Ground #${orphanGround.id}`) && w.includes("not attached to any warrant"))).toBe(true);
  });

  test("C6: associated ground that IS in a warrant → no C6 warning", () => {
    const claim = makeClaim(db, "Claim");
    const subClaim = makeClaim(db, "Sub claim");
    const ground = makeGround(db, { refClaimId: subClaim.id });
    makeWarrant(db, claim.id, [ground.id]);

    // ground references subClaim (not claimId), no orphan issue
    const result = structuralQualityCheck(db, claim.id);
    expect(result.warnings.filter(w => w.includes("not attached to any warrant") && w.includes(`Ground #${ground.id}`))).toHaveLength(0);
  });
});

// =============================================================================
// Category D: Cross-Node Consistency
// =============================================================================

describe("Category D — Cross-Node Consistency", () => {
  test("D1: chain target is stale → info", () => {
    const parentClaim = makeClaim(db, "Parent");
    const subClaim = makeClaim(db, "Sub");
    setClaimData(db, subClaim.id, { compile_status: "stale" });

    const ground = makeGround(db, { refClaimId: subClaim.id });
    makeWarrant(db, parentClaim.id, [ground.id]);

    const result = structuralQualityCheck(db, parentClaim.id);
    expect(result.infos?.some(i => i.includes("stale") && i.includes(`${subClaim.id}`))).toBe(true);
  });

  test("D2: chain target has status=disputed → info", () => {
    const parentClaim = makeClaim(db, "Parent");
    const subClaim = makeClaim(db, "Sub", "disputed");

    const ground = makeGround(db, { refClaimId: subClaim.id });
    makeWarrant(db, parentClaim.id, [ground.id]);

    const result = structuralQualityCheck(db, parentClaim.id);
    expect(result.infos?.some(i => i.includes("disputed") && i.includes(`${subClaim.id}`))).toBe(true);
  });

  test("D3: chain target has status=refuted → warning", () => {
    const parentClaim = makeClaim(db, "Parent");
    const subClaim = makeClaim(db, "Sub", "refuted");

    const ground = makeGround(db, { refClaimId: subClaim.id });
    makeWarrant(db, parentClaim.id, [ground.id]);

    const result = structuralQualityCheck(db, parentClaim.id);
    expect(result.warnings.some(w => w.includes("refuted") && w.includes(`${subClaim.id}`))).toBe(true);
    // refuted is WARNING not INFO
    expect(result.infos?.filter(i => i.includes("refuted"))).toHaveLength(0);
  });

  test("D4: chain target has never been compiled → info", () => {
    const parentClaim = makeClaim(db, "Parent");
    const subClaim = makeClaim(db, "Sub", "proposed");
    // No compile_state and compile_status != "passed" (default)

    const ground = makeGround(db, { refClaimId: subClaim.id });
    makeWarrant(db, parentClaim.id, [ground.id]);

    const result = structuralQualityCheck(db, parentClaim.id);
    expect(result.infos?.some(i => i.includes("never been compiled") && i.includes(`${subClaim.id}`))).toBe(true);
  });

  test("D4: compiled chain target → no D4 info", () => {
    const parentClaim = makeClaim(db, "Parent");
    const subClaim = makeClaim(db, "Sub", "supported");
    // Mark as compile_status = "passed"
    setClaimData(db, subClaim.id, { compile_status: "passed" });
    repo.saveCompileState(db, subClaim.id, "passed", "OK");

    const ground = makeGround(db, { refClaimId: subClaim.id });
    makeWarrant(db, parentClaim.id, [ground.id]);

    const result = structuralQualityCheck(db, parentClaim.id);
    expect(result.infos?.filter(i => i.includes("never been compiled") && i.includes(`${subClaim.id}`))).toHaveLength(0);
  });
});

// =============================================================================
// Case Study Integration Test (Warrant-57 pattern)
// =============================================================================

describe("Case Study — Warrant-57 pattern", () => {
  test("fully speculative warrant detected: C3 + B4 + B5", () => {
    const claim = makeClaim(db, "Method A outperforms Method B", "supported");

    // Warrant A: fully speculative (Warrant-57 pattern)
    const gA1 = makeGround(db, { source: "hypothesis", verification: "pending", content: "Future result A" });
    const gA2 = makeGround(db, { source: "hypothesis", verification: "pending", content: "Future result B" });
    const warrantA = makeWarrant(db, claim.id, [gA1.id, gA2.id], "Speculative warrant");
    makeBacking(db, warrantA.id, "Theoretical framework");

    // Warrant B: clean path (like Warrant-20)
    const gB1 = makeGround(db, { source: "observed", verification: "verified", content: "Experimental data 95%" });
    const gB2 = makeGround(db, { source: "literature", verification: "verified", content: "Literature data 85%" });
    const warrantB = makeWarrant(db, claim.id, [gB1.id, gB2.id], "Empirical warrant");
    makeBacking(db, warrantB.id, "Cross-dataset validation");

    // 4 rebuttals on claim
    makeRebuttal(db, claim.id, "claim", "Challenge 1");
    makeRebuttal(db, claim.id, "claim", "Challenge 2");
    makeRebuttal(db, claim.id, "claim", "Challenge 3");
    makeRebuttal(db, claim.id, "claim", "Challenge 4");
    // 3 rebuttals on Warrant A
    makeRebuttal(db, warrantA.id, "warrant", "Warrant challenge 1");
    makeRebuttal(db, warrantA.id, "warrant", "Warrant challenge 2");
    makeRebuttal(db, warrantA.id, "warrant", "Warrant challenge 3");

    const result = structuralQualityCheck(db, claim.id);

    // No errors (Warrant B provides clean path, so C4 passes)
    expect(result.errors).toHaveLength(0);

    // C3 on Warrant A
    expect(result.warnings.some(w => w.includes("fully speculative") && w.includes(`${warrantA.id}`))).toBe(true);

    // B4: claim has 4 rebuttals
    expect(result.warnings.some(w => w.includes(`#${claim.id}`) && w.includes("rebuttal"))).toBe(true);

    // B5: warrantA has 3 rebuttals
    expect(result.warnings.some(w => w.includes(`#${warrantA.id}`) && w.includes("rebuttal"))).toBe(true);

    // C5: 7 total rebuttals → info
    expect(result.infos?.some(i => i.includes("7") && i.includes("rebuttal"))).toBe(true);
  });
});

// =============================================================================
// Multiple conditions accumulate
// =============================================================================

describe("accumulation", () => {
  test("multiple conditions → multiple warnings", () => {
    const claim = makeClaim(db, "Claim");
    const g1 = makeGround(db, { source: "observed", verification: "pending" }); // B1
    const g2 = makeGround(db, { source: "hypothesis", verification: "verified", refClaimId: null }); // B2
    const warrant = makeWarrant(db, claim.id, [g1.id, g2.id]); // B3 (no backing)
    makeRebuttal(db, claim.id, "claim", "Counter"); // B4

    const result = structuralQualityCheck(db, claim.id);
    expect(result.warnings.length).toBeGreaterThanOrEqual(3); // B1, B2, B3, B4
  });
});

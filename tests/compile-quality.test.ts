/**
 * structuralQualityCheck 综合测试
 *
 * 覆盖规则：B1, B3-B5, C1, C4-C5
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
// Category B: Individual Quality
// =============================================================================

describe("Category B — Individual Quality", () => {
  test("B1: ground verification=pending → warning", () => {
    const claim = makeClaim(db, "Claim");
    const ground = makeGround(db, { source: "observed", verification: "pending" });
    makeWarrant(db, claim.id, [ground.id]);

    const result = structuralQualityCheck(db, claim.id);
    expect(result.warnings.some(w => w.includes("pending") && w.includes(`${ground.id}`))).toBe(true);
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

});

// =============================================================================
// Chain reasoning: claim used directly as ground
// =============================================================================

describe("chain reasoning — claim used directly as ground", () => {
  test("warrant with only claim-type grounds → no B1, no C1 (not spuriously 'all pending')", () => {
    const parentClaim = makeClaim(db, "Parent claim");
    const subClaim = makeClaim(db, "Sub claim");
    const warrant = makeWarrant(db, parentClaim.id, [subClaim.id]);
    makeBacking(db, warrant.id);

    const result = structuralQualityCheck(db, parentClaim.id);
    expect(result.warnings.filter(w => w.includes(`Ground #${subClaim.id}`))).toHaveLength(0);
    expect(result.warnings.filter(w => w.includes(`Warrant #${warrant.id}: all grounds have verification=pending`))).toHaveLength(0);
  });
});

// =============================================================================
// Case Study Integration Test (Warrant-57 pattern)
// =============================================================================

describe("Case Study — Warrant-57 pattern", () => {
  test("all-pending warrant detected: C1 + B4 + B5", () => {
    const claim = makeClaim(db, "Method A outperforms Method B", "supported");

    // Warrant A: all grounds pending (Warrant-57 pattern)
    const gA1 = makeGround(db, { source: "observed", verification: "pending", content: "Future result A" });
    const gA2 = makeGround(db, { source: "observed", verification: "pending", content: "Future result B" });
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

    // C1 on Warrant A
    expect(result.warnings.some(w => w.includes(`Warrant #${warrantA.id}`) && w.includes("all grounds have verification=pending"))).toBe(true);

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
    const g2 = makeGround(db, { source: "literature", verification: "pending" }); // B1
    const warrant = makeWarrant(db, claim.id, [g1.id, g2.id]); // B3 (no backing), C1 (all pending)
    makeRebuttal(db, claim.id, "claim", "Counter"); // B4

    const result = structuralQualityCheck(db, claim.id);
    expect(result.warnings.length).toBeGreaterThanOrEqual(4); // B1 x2, B3, B4 (+ C1)
  });
});

// =============================================================================
// Table-driven: all (source, verification) combinations
// =============================================================================

describe("source x verification combination matrix", () => {
  const sources = ["literature", "observed"] as const;
  const verifications = ["pending", "verified"] as const;

  for (const source of sources) {
    for (const verification of verifications) {
      test(`per-ground: source=${source}, verification=${verification}`, () => {
        const claim = makeClaim(db, "Claim");
        const ground = makeGround(db, { source, verification });
        makeWarrant(db, claim.id, [ground.id]);

        const result = structuralQualityCheck(db, claim.id);
        const b1Fired = result.warnings.some(w => w.includes(`Ground #${ground.id} has verification=pending`));
        expect(b1Fired).toBe(verification === "pending");
      });
    }
  }

  for (const source of sources) {
    for (const verification of verifications) {
      test(`per-warrant (homogeneous): both grounds source=${source}, verification=${verification}`, () => {
        const claim = makeClaim(db, "Claim");
        const g1 = makeGround(db, { source, verification });
        const g2 = makeGround(db, { source, verification });
        const warrant = makeWarrant(db, claim.id, [g1.id, g2.id]);
        makeBacking(db, warrant.id);

        const result = structuralQualityCheck(db, claim.id);
        const c1Message = `Warrant #${warrant.id}: all grounds have verification=pending`;
        const c1Warnings = result.warnings.filter(w => w === c1Message);
        expect(c1Warnings).toEqual(verification === "pending" ? [c1Message] : []);
      });
    }
  }

  test("per-warrant: all pending → C1 fires regardless of source mix", () => {
    const claim = makeClaim(db, "Claim");
    const g1 = makeGround(db, { source: "literature", verification: "pending" });
    const g2 = makeGround(db, { source: "observed", verification: "pending" });
    const warrant = makeWarrant(db, claim.id, [g1.id, g2.id]);
    makeBacking(db, warrant.id);

    const result = structuralQualityCheck(db, claim.id);
    const expectedWarnings = [
      `Ground #${g1.id} has verification=pending`,
      `Ground #${g2.id} has verification=pending`,
      `Warrant #${warrant.id}: all grounds have verification=pending`,
      `Claim #${claim.id} has no warrant where all grounds are verified`,
    ];
    expect(result.warnings).toEqual(expectedWarnings);
  });

  test("per-warrant: mixed pending/verified → C1 does not fire", () => {
    const claim = makeClaim(db, "Claim");
    const g1 = makeGround(db, { source: "literature", verification: "pending" });
    const g2 = makeGround(db, { source: "observed", verification: "verified" });
    const warrant = makeWarrant(db, claim.id, [g1.id, g2.id]);
    makeBacking(db, warrant.id);

    const result = structuralQualityCheck(db, claim.id);
    expect(result.warnings).toEqual([
      `Ground #${g1.id} has verification=pending`,
      `Claim #${claim.id} has no warrant where all grounds are verified`,
    ]);
  });

  test("per-warrant: all verified, any source mix → C1 does not fire, C4 satisfied", () => {
    const claim = makeClaim(db, "Claim", "proposed");
    const g1 = makeGround(db, { source: "literature", verification: "verified" });
    const g2 = makeGround(db, { source: "observed", verification: "verified" });
    const warrant = makeWarrant(db, claim.id, [g1.id, g2.id]);
    makeBacking(db, warrant.id);

    const result = structuralQualityCheck(db, claim.id);
    expect(result.warnings.filter(w => w.includes("all grounds have verification=pending"))).toHaveLength(0);
    expect(result.warnings.filter(w => w.includes("no warrant where all grounds are verified"))).toHaveLength(0);
  });
});

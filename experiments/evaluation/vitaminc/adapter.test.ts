import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildNaturalDirectionReplays,
  buildNaturalDirectionReplaysWithAudit,
  loadNaturalDirectionReplays,
  sampleReplayCases,
} from "./adapter.ts";
import type {
  ReplayDirection,
  VitaminCLabel,
  VitaminCRow,
} from "./types.ts";

function row(
  caseId: string,
  suffix: 1 | 2 | 3 | 4,
  label: string,
  overrides: Partial<VitaminCRow> = {},
): VitaminCRow {
  return {
    unique_id: `${caseId}_${suffix}`,
    case_id: caseId,
    wiki_revision_id: `revision-${caseId}`,
    label,
    claim: `claim-${caseId}-${suffix <= 2 ? "a" : "b"}`,
    evidence: `evidence-${caseId}-${suffix}`,
    page: `page-${caseId}`,
    revision_type: "real",
    ...overrides,
  };
}

function flipPair(
  caseId: string,
  start: 1 | 3,
  direction: ReplayDirection,
  overrides: {
    before?: Partial<VitaminCRow>;
    after?: Partial<VitaminCRow>;
  } = {},
): VitaminCRow[] {
  const beforeLabel: VitaminCLabel =
    direction === "SUP_TO_REF" ? "SUPPORTS" : "REFUTES";
  const afterLabel: VitaminCLabel =
    direction === "SUP_TO_REF" ? "REFUTES" : "SUPPORTS";
  const claim = `claim-${caseId}-${start}`;
  return [
    row(caseId, start, beforeLabel, { claim, ...overrides.before }),
    row(caseId, (start + 1) as 2 | 4, afterLabel, {
      claim,
      ...overrides.after,
    }),
  ];
}

describe("VitaminC natural-direction adapter", () => {
  test("uses only the original 1->2 and 3->4 temporal directions", () => {
    const rows = [
      ...flipPair("revision-a", 1, "SUP_TO_REF"),
      ...flipPair("revision-a", 3, "REF_TO_SUP"),
      ...flipPair("non-flip", 1, "SUP_TO_REF").map((item) => ({
        ...item,
        label: "NOT ENOUGH INFO",
      })),
    ].reverse();

    const cases = buildNaturalDirectionReplays(rows);

    expect(cases).toHaveLength(2);
    expect(cases.map((item) => item.direction)).toEqual([
      "SUP_TO_REF",
      "REF_TO_SUP",
    ]);
    expect(cases[0]!.sourceIds).toEqual(["revision-a_1", "revision-a_2"]);
    expect(cases[0]!.e0).toBe("evidence-revision-a-1");
    expect(cases[0]!.e1).toBe("evidence-revision-a-2");
    expect(cases[1]!.sourceIds).toEqual(["revision-a_3", "revision-a_4"]);
    expect(cases[1]!.e0).toBe("evidence-revision-a-3");
    expect(cases[1]!.e1).toBe("evidence-revision-a-4");
    expect(cases.every((item) => item.sourceCaseId === "revision-a")).toBe(true);
    expect(cases.every((item) => !item.id.includes("sup-to-ref"))).toBe(true);
  });

  test("accepts synthetic revisions keyed by FEVER_id", () => {
    const rows = flipPair("synthetic-a", 1, "SUP_TO_REF").map((item) => ({
      ...item,
      wiki_revision_id: undefined,
      FEVER_id: "fever-42",
      revision_type: "synthetic",
    }));
    const cases = buildNaturalDirectionReplays(rows);
    expect(cases).toHaveLength(1);
    expect(cases[0]!.wikiRevisionId).toBe("fever-42");
    expect(cases[0]!.revisionType).toBe("synthetic");
  });

  test("drops unchanged, inconsistent, duplicated, and ambiguous pairs", () => {
    const valid = flipPair("valid", 1, "SUP_TO_REF");
    const unchanged = flipPair("unchanged", 1, "SUP_TO_REF", {
      before: { evidence: "same evidence" },
      after: { evidence: " same   evidence " },
    });
    const claimMismatch = flipPair("claim-mismatch", 1, "SUP_TO_REF", {
      after: { claim: "a different claim" },
    });
    const pageMismatch = flipPair("page-mismatch", 1, "SUP_TO_REF", {
      after: { page: "another page" },
    });
    const revisionMismatch = flipPair("revision-mismatch", 1, "SUP_TO_REF", {
      after: { wiki_revision_id: "another revision" },
    });
    const nonFlip = flipPair("non-flip", 1, "SUP_TO_REF").map((item) => ({
      ...item,
      label: "SUPPORTS",
    }));
    const duplicatedSlot = flipPair("duplicated-slot", 1, "SUP_TO_REF");
    duplicatedSlot.push({ ...duplicatedSlot[0]! });
    const ambiguousSlot = flipPair("ambiguous-slot", 1, "SUP_TO_REF");
    ambiguousSlot.push({
      ...ambiguousSlot[0]!,
      evidence: "conflicting duplicate content",
    });
    const duplicateTupleA = flipPair("duplicate-a", 1, "REF_TO_SUP", {
      before: { claim: "duplicate claim", evidence: "duplicate before" },
      after: { claim: "duplicate claim", evidence: "duplicate after" },
    });
    const duplicateTupleB = flipPair("duplicate-b", 1, "REF_TO_SUP", {
      before: { claim: "duplicate claim", evidence: "duplicate before" },
      after: { claim: "duplicate claim", evidence: "duplicate after" },
    });
    const malformedStem = flipPair("malformed", 1, "SUP_TO_REF").map(
      (item, index) => ({ ...item, unique_id: `another-case_${index + 1}` }),
    );

    const result = buildNaturalDirectionReplaysWithAudit([
      ...valid,
      ...unchanged,
      ...claimMismatch,
      ...pageMismatch,
      ...revisionMismatch,
      ...nonFlip,
      ...duplicatedSlot,
      ...ambiguousSlot,
      ...duplicateTupleA,
      ...duplicateTupleB,
      ...malformedStem,
    ]);
    const cases = result.cases;

    expect(cases).toHaveLength(1);
    expect(cases[0]!.sourceCaseId).toBe("valid");
    expect(result.audit).toEqual({
      inputRows: 24,
      recognizedTemporalRows: 22,
      expectedTemporalPairs: 20,
      completeUniqueSlotPairs: 8,
      slotPairDrops: {
        missing: 10,
        duplicated: 2,
      },
      candidateBuildRejects: {
        nonFlip: 1,
        metadataInconsistency: 2,
        contentInconsistency: 2,
      },
      candidatesBeforeSemanticDedup: 3,
      duplicateSemanticTupleGroups: 1,
      duplicateSemanticTupleCandidatesDropped: 2,
      emittedCandidates: 1,
    });
  });

  test("samples reproducibly with independent direction quotas", () => {
    const rows: VitaminCRow[] = [];
    for (let index = 0; index < 12; index += 1) {
      rows.push(...flipPair(`sup-${index}`, 1, "SUP_TO_REF"));
      rows.push(...flipPair(`ref-${index}`, 3, "REF_TO_SUP"));
    }
    const cases = buildNaturalDirectionReplays(rows);

    const first = sampleReplayCases(cases, {
      seed: 20260901,
      perDirection: { SUP_TO_REF: 3, REF_TO_SUP: 4 },
    });
    const reordered = sampleReplayCases(cases.toReversed(), {
      seed: 20260901,
      perDirection: { SUP_TO_REF: 3, REF_TO_SUP: 4 },
    });
    const anotherSeed = sampleReplayCases(cases, {
      seed: 20260902,
      perDirection: { SUP_TO_REF: 3, REF_TO_SUP: 4 },
    });

    expect(first.map((item) => item.id)).toEqual(
      reordered.map((item) => item.id),
    );
    expect(first.filter((item) => item.direction === "SUP_TO_REF")).toHaveLength(3);
    expect(first.filter((item) => item.direction === "REF_TO_SUP")).toHaveLength(4);
    expect(first.map((item) => item.id)).not.toEqual(
      anotherSeed.map((item) => item.id),
    );
  });
});

const realDevPath = resolve(
  import.meta.dir,
  "../../benchmarks/vitaminc/data/vitaminc/dev.jsonl",
);
const realDataTest = existsSync(realDevPath) ? test : test.skip;

realDataTest("official dev data preserves a known natural two-direction revision", async () => {
  const cases = await loadNaturalDirectionReplays(realDevPath);
  const known = cases.filter(
    (item) => item.sourceCaseId === "5ee3932dc9e77c0008ccb4a5",
  );

  expect(known).toHaveLength(2);
  expect(known.map((item) => item.direction)).toEqual([
    "SUP_TO_REF",
    "REF_TO_SUP",
  ]);
  expect(known[0]!.sourceIds).toEqual([
    "5ee3932dc9e77c0008ccb4a5_1",
    "5ee3932dc9e77c0008ccb4a5_2",
  ]);
  expect(known[1]!.sourceIds).toEqual([
    "5ee3932dc9e77c0008ccb4a5_3",
    "5ee3932dc9e77c0008ccb4a5_4",
  ]);
  expect(cases.filter((item) => item.direction === "SUP_TO_REF").length).toBeGreaterThan(5_000);
  expect(cases.filter((item) => item.direction === "REF_TO_SUP").length).toBeGreaterThan(5_000);
}, 30_000);

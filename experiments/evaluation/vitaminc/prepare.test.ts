import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { sha256File } from "../common/manifest.ts";
import {
  canonicalTokenSignature,
  prepareVitaminC,
  selectDirectionalCases,
  validateNaturalRealCandidates,
  validateSplitPaths,
} from "./prepare.ts";
import type {
  ReplayCase,
  ReplayDirection,
  VitaminCFlaggingRow,
  VitaminCRow,
} from "./types.ts";

function replay(
  id: string,
  direction: ReplayDirection,
  sourceCaseId: string = id,
  overrides: Partial<ReplayCase> = {},
): ReplayCase {
  return {
    id,
    pairId: id,
    direction,
    claim: `claim ${id}`,
    e0: `before evidence ${id}`,
    y0: direction === "SUP_TO_REF" ? "SUPPORTS" : "REFUTES",
    e1: `after evidence ${id}`,
    y1: direction === "SUP_TO_REF" ? "REFUTES" : "SUPPORTS",
    sourceIds: [`${sourceCaseId}_1`, `${sourceCaseId}_2`],
    sourceCaseId,
    wikiRevisionId: `revision-${sourceCaseId}`,
    page: `page-${sourceCaseId}`,
    revisionType: "real",
    ...overrides,
  };
}

function flagging(
  item: ReplayCase,
  overrides: Partial<VitaminCFlaggingRow> = {},
): VitaminCFlaggingRow {
  return {
    case_id: item.sourceCaseId,
    wiki_revision_id: item.wikiRevisionId!,
    label: "factual",
    sent_a: item.e0,
    sent_b: item.e1,
    page: item.page!,
    ...overrides,
  };
}

function factRow(
  caseId: string,
  suffix: 1 | 2 | 3 | 4,
  label: string,
  claim: string,
  evidence: string,
): VitaminCRow {
  return {
    unique_id: `${caseId}_${suffix}`,
    case_id: caseId,
    wiki_revision_id: `revision-${caseId}`,
    label,
    claim,
    evidence,
    page: `page-${caseId}`,
    revision_type: "real",
  };
}

function writeJsonl(path: string, rows: readonly unknown[]): void {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

describe("VitaminC formal preparation", () => {
  test("canonical token comparison bridges dataset tokenizer punctuation", () => {
    expect(canonicalTokenSignature("Carter 's score was 70.33 % .")).toBe(
      canonicalTokenSignature("Carter's score was 70.33%."),
    );
    expect(canonicalTokenSignature("It was n't revised .")).toBe(
      canonicalTokenSignature("It wasn't revised."),
    );
    expect(canonicalTokenSignature("value 100")).not.toBe(
      canonicalTokenSignature("value 101"),
    );
    expect(canonicalTokenSignature("The rate is 11%.")).not.toBe(
      canonicalTokenSignature("The rate is 11."),
    );
    expect(canonicalTokenSignature("The change is -5.")).not.toBe(
      canonicalTokenSignature("The change is 5."),
    );
    expect(canonicalTokenSignature("It uses C++.")).not.toBe(
      canonicalTokenSignature("It uses C."),
    );
    for (const symbol of [
      "%",
      "$",
      "£",
      "€",
      "¥",
      "+",
      "-",
      "−",
      "<",
      ">",
      "≤",
      "≥",
      "=",
      "°",
    ]) {
      expect(canonicalTokenSignature(`left ${symbol} right`)).not.toBe(
        canonicalTokenSignature("left right"),
      );
    }
  });

  test("requires one matching factual flagging record and audits each exclusion", () => {
    const valid = replay("valid", "SUP_TO_REF", "valid", {
      e0: "Carter 's score was 70.33 % .",
      e1: "Carter 's score was 71.00 % .",
    });
    const nonReal = replay("non-real", "SUP_TO_REF", "non-real", {
      revisionType: "synthetic",
    });
    const missing = replay("missing", "SUP_TO_REF");
    const duplicate = replay("duplicate", "SUP_TO_REF");
    const nonFactual = replay("non-factual", "SUP_TO_REF");
    const badRevision = replay("bad-revision", "SUP_TO_REF");
    const badPage = replay("bad-page", "SUP_TO_REF");
    const badA = replay("bad-a", "SUP_TO_REF");
    const badB = replay("bad-b", "SUP_TO_REF");

    const result = validateNaturalRealCandidates(
      [
        valid,
        nonReal,
        missing,
        duplicate,
        nonFactual,
        badRevision,
        badPage,
        badA,
        badB,
      ],
      [
        flagging(valid, {
          sent_a: "Carter's score was 70.33%.",
          sent_b: "Carter's score was 71.00%.",
        }),
        flagging(duplicate),
        flagging(duplicate),
        flagging(nonFactual, { label: "not factual" }),
        flagging(badRevision, { wiki_revision_id: "another-revision" }),
        flagging(badPage, { page: "another-page" }),
        flagging(badA, { sent_a: "different before content" }),
        flagging(badB, { sent_b: "different after content" }),
      ],
    );

    expect(result.eligible.map((item) => item.id)).toEqual(["valid"]);
    expect(result.audit.eligibleCandidates).toBe(1);
    expect(result.audit.excluded).toEqual({
      non_real_revision: 1,
      missing_flagging_case: 1,
      non_unique_flagging_case: 1,
      non_factual_flagging_case: 1,
      revision_mismatch: 1,
      page_mismatch: 1,
      sent_a_mismatch: 1,
      sent_b_mismatch: 1,
    });
  });

  test("samples equal directions reproducibly with globally disjoint clusters", () => {
    const candidates: ReplayCase[] = [];
    for (let index = 0; index < 8; index += 1) {
      const cluster = `shared-${index}`;
      candidates.push(replay(`sup-${index}-a`, "SUP_TO_REF", cluster));
      candidates.push(replay(`ref-${index}`, "REF_TO_SUP", cluster));
    }
    candidates.push(replay("sup-duplicate", "SUP_TO_REF", "shared-0"));
    candidates.push(replay("sup-exclusive", "SUP_TO_REF", "sup-exclusive"));
    candidates.push(replay("ref-exclusive", "REF_TO_SUP", "ref-exclusive"));

    const first = selectDirectionalCases(candidates, 4, 20260901);
    const reordered = selectDirectionalCases(
      candidates.toReversed(),
      4,
      20260901,
    );

    expect(first.map((item) => item.id)).toEqual(
      reordered.map((item) => item.id),
    );
    expect(first.filter((item) => item.direction === "SUP_TO_REF")).toHaveLength(4);
    expect(first.filter((item) => item.direction === "REF_TO_SUP")).toHaveLength(4);
    expect(new Set(first.map((item) => item.sourceCaseId)).size).toBe(8);
    expect(
      first.filter((item) => item.sourceCaseId === "shared-0"),
    ).toHaveLength(1);
  });

  test("fails instead of reusing clusters when disjoint quotas are impossible", () => {
    const candidates = [
      replay("sup-a", "SUP_TO_REF", "shared-a"),
      replay("ref-a", "REF_TO_SUP", "shared-a"),
      replay("sup-b", "SUP_TO_REF", "shared-b"),
      replay("ref-b", "REF_TO_SUP", "shared-b"),
    ];
    expect(() => selectDirectionalCases(candidates, 2, 7)).toThrow(
      "Cannot select globally disjoint sourceCaseIds",
    );
  });

  test("rejects a split label that does not match both input filenames", () => {
    expect(() =>
      validateSplitPaths(
        "test",
        "/assets/vitaminc/dev.jsonl",
        "/assets/vitaminc_flagging/dev.jsonl",
      ),
    ).toThrow("Split/path mismatch");
  });

  test("writes blinded public metadata and protected evaluator provenance", async () => {
    const root = mkdtempSync(join(tmpdir(), "vitaminc-prepare-test-"));
    try {
      const assetRoot = join(root, "assets");
      const factDir = join(assetRoot, "vitaminc");
      const flagDir = join(assetRoot, "vitaminc_flagging");
      mkdirSync(factDir, { recursive: true });
      mkdirSync(flagDir, { recursive: true });
      const inputPath = join(factDir, "dev.jsonl");
      const flaggingPath = join(flagDir, "dev.jsonl");
      const outputDir = join(root, "prepared");

      const supCase = "source-sup";
      const refCase = "source-ref";
      writeJsonl(inputPath, [
        factRow(
          supCase,
          1,
          "SUPPORTS",
          "The count is below 10.",
          "The count was 9 .",
        ),
        factRow(
          supCase,
          2,
          "REFUTES",
          "The count is below 10.",
          "The count was 11 .",
        ),
        factRow(
          refCase,
          3,
          "REFUTES",
          "The count is above 10.",
          "The count was 9 .",
        ),
        factRow(
          refCase,
          4,
          "SUPPORTS",
          "The count is above 10.",
          "The count was 11 .",
        ),
      ]);
      writeJsonl(flaggingPath, [
        {
          case_id: supCase,
          wiki_revision_id: `revision-${supCase}`,
          label: "factual",
          sent_a: "The count was 9.",
          sent_b: "The count was 11.",
          page: `page-${supCase}`,
        },
        {
          case_id: refCase,
          wiki_revision_id: `revision-${refCase}`,
          label: "factual",
          sent_a: "The count was 9.",
          sent_b: "The count was 11.",
          page: `page-${refCase}`,
        },
      ]);

      const manifest = await prepareVitaminC({
        inputPath,
        flaggingPath,
        split: "dev",
        perDirection: 1,
        seed: 20260901,
        outputDir,
      });

      expect(manifest.design.population).toBe("real-natural-factual-revisions");
      expect(manifest.adapterAudit).toEqual({
        inputRows: 4,
        recognizedTemporalRows: 4,
        expectedTemporalPairs: 4,
        completeUniqueSlotPairs: 2,
        slotPairDrops: {
          missing: 2,
          duplicated: 0,
        },
        candidateBuildRejects: {
          nonFlip: 0,
          metadataInconsistency: 0,
          contentInconsistency: 0,
        },
        candidatesBeforeSemanticDedup: 2,
        duplicateSemanticTupleGroups: 0,
        duplicateSemanticTupleCandidatesDropped: 0,
        emittedCandidates: 2,
      });
      expect(manifest.adapterAudit.emittedCandidates).toBe(
        manifest.candidates.adapterCandidates,
      );
      expect(manifest.selectedCounts.byDirection).toEqual({
        SUP_TO_REF: 1,
        REF_TO_SUP: 1,
      });
      expect(manifest.selectedCounts.uniqueSourceCaseIds).toBe(2);
      expect(manifest.implementationFiles.length).toBeGreaterThan(5);
      expect(
        manifest.implementationFiles.every((item) => /^[0-9a-f]{64}$/.test(item.sha256)),
      ).toBe(true);
      expect(manifest.publicCases.map((item) => item.publicCaseId)).toEqual(
        manifest.publicCases
          .map((item) => item.publicCaseId)
          .toSorted(),
      );

      const publicText = readFileSync(
        join(outputDir, "public", "public-manifest.json"),
        "utf8",
      );
      const fixtureManifest = JSON.parse(
        readFileSync(join(outputDir, "fixture-manifest.json"), "utf8"),
      );
      const publicManifestPath = join(outputDir, manifest.publicManifestFile);
      expect(manifest.publicManifestFile).toBe("public/public-manifest.json");
      expect(manifest.publicManifestSha256).toBe(
        sha256File(publicManifestPath),
      );
      expect(JSON.parse(publicText)).toEqual({
        schemaVersion: 2,
        cases: manifest.publicCases,
      });
      expect(fixtureManifest.publicManifestFile).toBe(
        manifest.publicManifestFile,
      );
      expect(fixtureManifest.publicManifestSha256).toBe(
        manifest.publicManifestSha256,
      );
      expect(fixtureManifest.publicCases).toEqual(
        JSON.parse(publicText).cases,
      );
      const privatePath = join(outputDir, "private", "cases.jsonl");
      const privateText = readFileSync(privatePath, "utf8");
      expect(publicText).not.toContain("SUP_TO_REF");
      expect(publicText).not.toContain("REF_TO_SUP");
      expect(publicText).not.toContain(supCase);
      expect(publicText).not.toContain(refCase);
      expect(privateText).toContain("SUP_TO_REF");
      expect(privateText).toContain("REF_TO_SUP");
      expect(statSync(join(outputDir, "private")).mode & 0o777).toBe(0o700);
      expect(statSync(privatePath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

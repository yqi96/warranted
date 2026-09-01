import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { writeAuditRecord } from "../src/review-audit.ts";
import type { ReviewConfig } from "../src/review-config.ts";
import { reviewCwd } from "../src/review-config.ts";
import { buildInput } from "../src/review-run.ts";
import * as service from "../src/service.ts";
import { copyFixtureProject } from "../experiments/evaluation/common/graph-fixture.ts";
import {
  readJson,
  sha256File,
  sha256Text,
  writeJson,
  writeJsonl,
} from "../experiments/evaluation/common/manifest.ts";
import {
  requireSelectedVoteBlindness,
  validateSolUltraInputProvenance,
} from "../experiments/evaluation/scifact/adjudication-provenance.ts";
import { validateAdjudicationBundle } from "../experiments/evaluation/scifact/adjudication-bundle.ts";
import { applyAdjudicationBundle } from "../experiments/evaluation/scifact/audit-labels.ts";
import {
  Q1_WARRANT,
  buildFixtureCase,
  enumerateCandidatePairs,
  groupCandidateClaims,
  selectCandidates,
} from "../experiments/evaluation/scifact/build-fixtures.ts";
import {
  buildProvisionalGraphVerdictOverlay,
  deriveMechanicalGraphVerdict,
} from "../experiments/evaluation/scifact/graph-verdict.ts";
import {
  executeCase,
  validateFixtureFiles,
} from "../experiments/evaluation/scifact/run-reviews.ts";
import {
  assessQuote,
  scoreReviewCases,
  validateGraphVerdictOverlay,
  validateFixtureManifest,
  writeScoreArtifacts,
} from "../experiments/evaluation/scifact/score-reviews.ts";
import type {
  CandidatePair,
  FailedReviewCaseResult,
  FixtureCase,
  FixtureManifest,
  GraphExpectedVerdict,
  GraphVerdictAdjudicationBundle,
  GraphVerdictOverlay,
  ReviewCaseResult,
  ScoreManifest,
  ScoreSummary,
  SciFactClaim,
  SciFactDocument,
  SuccessfulReviewCaseResult,
} from "../experiments/evaluation/scifact/types.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scifact-eval-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const documents: SciFactDocument[] = [
  {
    doc_id: 10,
    title: "Treatment study",
    abstract: ["The treatment reduces disease incidence.", "The effect replicated in cohort B."],
    structured: false,
  },
  {
    doc_id: 11,
    title: "Unrelated study",
    abstract: ["The study measured an unrelated biomarker."],
    structured: false,
  },
  {
    doc_id: 12,
    title: "Reversal study",
    abstract: ["The treatment increases disease incidence."],
    structured: false,
  },
  {
    doc_id: 13,
    title: "Replication study",
    abstract: ["A second trial found that the treatment reduces disease incidence."],
    structured: false,
  },
  {
    doc_id: 14,
    title: "Another unrelated study",
    abstract: ["This paper studies an unrelated cell marker."],
    structured: false,
  },
];

const claims: SciFactClaim[] = [
  {
    id: 1,
    claim: "The treatment reduces disease incidence.",
    evidence: {
      "10": [
        { label: "SUPPORT", sentences: [0] },
        { label: "SUPPORT", sentences: [1] },
      ],
      "13": [{ label: "SUPPORT", sentences: [0] }],
    },
    cited_doc_ids: [10, 11, 13, 13],
  },
  {
    id: 2,
    claim: "The treatment reduces disease incidence.",
    evidence: { "12": [{ label: "CONTRADICT", sentences: [0] }] },
    cited_doc_ids: [12],
  },
  {
    id: 3,
    claim: "The treatment changes an unrelated cell marker.",
    evidence: {},
    cited_doc_ids: [11, 14],
  },
  {
    id: 4,
    claim: "A second trial found that the treatment reduces disease incidence.",
    evidence: { "13": [{ label: "SUPPORT", sentences: [0] }] },
    cited_doc_ids: [13],
  },
];

function pairs(): CandidatePair[] {
  return enumerateCandidatePairs("dev", claims, documents);
}

function reviewCount(dbPath: string, targetId: number): number {
  const db = openDatabase(dbPath);
  try {
    const row = db
      .query("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND op = 'review'")
      .get(targetId) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

function fakeConfig(): ReviewConfig {
  return {
    enabled: true,
    provider: "anthropic",
    model: "test-reviewer",
    fallbackModel: "test-fallback",
    apiKey: "not-used",
    maxTurns: 2,
    maxConcurrency: 1,
    auditDir: null,
    dbPath: "not-used",
  };
}

function fixtureManifest(cases: FixtureCase[]): FixtureManifest {
  const counts: FixtureManifest["counts"] = {
    primary: { SUPPORT: 0, CONTRADICT: 0, NOINFO: 0 },
    "q2-oracle": { SUPPORT: 0, CONTRADICT: 0, NOINFO: 0 },
  };
  for (const fixture of cases) counts[fixture.mode][fixture.goldLabel]++;
  return {
    schemaVersion: 2,
    createdAt: new Date(0).toISOString(),
    adapter: {
      version: "scifact-review/v2",
      primaryUnit: "claim",
      attachmentPolicy: "all-cited-and-evidence-abstracts",
      positiveLabel: "SUPPORT",
      negativeLabels: ["CONTRADICT", "NOINFO"],
      warrant: Q1_WARRANT,
      warrantSha256: sha256Text(Q1_WARRANT),
      repositoryCommit: null,
      repositoryDirty: null,
    },
    dataset: {
      name: "SciFact",
      split: "dev",
      corpusPath: "unused",
      claimsPath: "unused",
      corpusSha256: "unused",
      claimsSha256: "unused",
    },
    selection: {
      modes: [...new Set(cases.map((fixture) => fixture.mode))],
      seed: 7,
      perLabel: null,
    },
    counts,
    cases,
  };
}

function testLabeling(): ScoreSummary["labeling"] {
  return {
    sourceGoldLabel: "fixture.goldLabel",
    graphExpectedVerdict: "adjudicated-overlay",
    fixtureManifestSha256: "a".repeat(64),
    graphVerdictOverlaySha256: "b".repeat(64),
    adjudicationMethod: "test semantic adjudication",
    adjudicationBundleSha256: "c".repeat(64),
    adjudicationsSha256: "d".repeat(64),
    consensusSha256: "e".repeat(64),
    mechanicalPolicyVersion: "scifact-materialized-graph-mechanical/v1",
    allCasesAdjudicated: true,
  };
}

function mechanicalVerdicts(cases: FixtureCase[]): Map<string, GraphExpectedVerdict> {
  return new Map(
    cases.map((fixture) => [fixture.caseId, deriveMechanicalGraphVerdict(fixture).verdict]),
  );
}

let chainSequence = 0;

function fullyAdjudicatedOverlay(
  manifest: FixtureManifest,
  manifestSha256 = "a".repeat(64),
  verdictOverrides: ReadonlyMap<string, GraphExpectedVerdict> = new Map(),
): {
  overlay: GraphVerdictOverlay;
  overlayPath: string;
  bundlePath: string;
  adjudicationsPath: string;
  consensusPath: string;
} {
  const chainDir = join(root, `label-chain-${++chainSequence}`);
  mkdirSync(chainDir, { recursive: true });
  const overlay = buildProvisionalGraphVerdictOverlay(
    manifest,
    manifestSha256,
    new Date(0).toISOString(),
  );
  const reason = "The test attachment text was semantically checked against the claim.";
  const rows = overlay.cases.map((item) => ({
    caseId: item.caseId,
    graphExpectedVerdict: verdictOverrides.get(item.caseId) ?? item.mechanicalGraphVerdict,
    adjudicationReason: reason,
  }));
  const adjudicationsPath = join(chainDir, "adjudications.jsonl");
  writeJsonl(adjudicationsPath, rows);
  const pass = rows.filter((item) => item.graphExpectedVerdict === "pass").length;
  const consensusPath = join(chainDir, "consensus.json");
  writeJson(consensusPath, {
    schemaVersion: 2,
    method: "test semantic adjudication",
    frozenArtifacts: { fixtureManifest: { sha256: manifestSha256 } },
    counts: { total: rows.length, finalVerdict: { pass, fail: rows.length - pass } },
    cases: rows.map((row) => ({
      caseId: row.caseId,
      final: { verdict: row.graphExpectedVerdict, reason: row.adjudicationReason },
    })),
  });
  const bundlePath = join(chainDir, "bundle.json");
  const bundle: GraphVerdictAdjudicationBundle = {
    schemaVersion: 1,
    createdAt: new Date(0).toISOString(),
    fixtureManifestSha256: manifestSha256,
    policy: { ...overlay.policy },
    adjudications: {
      path: basename(adjudicationsPath),
      sha256: sha256File(adjudicationsPath),
      cases: rows.length,
    },
    consensus: {
      path: basename(consensusPath),
      sha256: sha256File(consensusPath),
      cases: rows.length,
      method: "test semantic adjudication",
    },
  };
  writeJson(bundlePath, bundle);
  const validated = validateAdjudicationBundle(
    bundlePath,
    manifestSha256,
    manifest.cases.map((fixture) => fixture.caseId),
  );
  applyAdjudicationBundle(overlay, validated, basename(bundlePath));
  const overlayPath = join(chainDir, "overlay.json");
  writeJson(overlayPath, overlay);
  return { overlay, overlayPath, bundlePath, adjudicationsPath, consensusPath };
}

describe("SciFact adapter", () => {
  test("enumerates unique labeled and cited-document NOINFO pairs", () => {
    expect(pairs().map((item) => [item.claimId, item.docId, item.label])).toEqual([
      [1, 10, "SUPPORT"],
      [1, 11, "NOINFO"],
      [1, 13, "SUPPORT"],
      [2, 12, "CONTRADICT"],
      [3, 11, "NOINFO"],
      [3, 14, "NOINFO"],
      [4, 13, "SUPPORT"],
    ]);
  });

  test("groups primary by claim, includes NOINFO, and keeps q2 rationale alternatives", () => {
    expect(groupCandidateClaims(pairs()).map((item) => [item.claimId, item.label])).toEqual([
      [1, "SUPPORT"],
      [2, "CONTRADICT"],
      [3, "NOINFO"],
      [4, "SUPPORT"],
    ]);
    const selected = selectCandidates(pairs(), ["primary", "q2-oracle"], null, 7);
    const primary = selected.filter((item) => item.mode === "primary");
    const q2 = selected.filter((item) => item.mode === "q2-oracle");
    expect(primary.map((item) => item.claim.label).sort()).toEqual([
      "CONTRADICT",
      "NOINFO",
      "SUPPORT",
      "SUPPORT",
    ]);
    expect(new Set(primary.map((item) => item.claim.claimId)).size).toBe(4);
    expect(q2.map((item) => [item.pair!.docId, item.rationaleSetIndex])).toEqual([
      [10, 0],
      [10, 1],
      [13, 0],
      [12, 0],
      [13, 0],
    ]);
  });
});

describe("graph fixtures and runner", () => {
  test("builds production-format primary and source-grounded q2-oracle graphs", () => {
    const candidates = selectCandidates(pairs(), ["primary", "q2-oracle"], null, 7);
    const primaryCandidate = candidates.find(
      (item) => item.mode === "primary" && item.claim.label === "SUPPORT",
    )!;
    const q2Candidate = candidates.find(
      (item) =>
        item.mode === "q2-oracle" && item.pair.docId === 10 && item.rationaleSetIndex === 0,
    )!;
    const primary = buildFixtureCase(root, primaryCandidate, "primary-000001");
    const q2 = buildFixtureCase(root, q2Candidate, "q2-oracle-000001");

    const primaryDb = openDatabase(join(root, primary.projectDir, ".toulmin", "graph.db"));
    const q2Db = openDatabase(join(root, q2.projectDir, ".toulmin", "graph.db"));
    try {
      const primaryInput = buildInput(primaryDb, primary.targetId);
      expect(primaryInput.attachments).toEqual([
        "evidence/10.md",
        "evidence/11.md",
        "evidence/13.md",
      ]);
      expect(primaryInput.evidenceNodes).toEqual([]);
      expect(Object.keys(primaryInput)).not.toContain("qualifier");

      const q2Input = buildInput(q2Db, q2.targetId);
      expect(q2Input.attachments).toEqual([]);
      expect(q2Input.evidenceNodes).toHaveLength(1);
      expect(q2Input.evidenceNodes[0]!.qualifier).toBe("certainly");
      expect(q2Input.evidenceNodes[0]!.content).toContain("The abstract");
      expect(q2Input.evidenceNodes[0]!.content).toContain(documents[0]!.abstract[0]);
    } finally {
      primaryDb.close();
      q2Db.close();
    }

    expect(primary.docIds).toEqual([10, 11, 13]);
    expect(primary.attachments.map((item) => item.goldLabel)).toEqual([
      "SUPPORT",
      "NOINFO",
      "SUPPORT",
    ]);
    expect(primary.goldLabel).toBe("SUPPORT");
    expect(primary.expected.verdict).toBe("pass");
    expect(deriveMechanicalGraphVerdict(primary).reasonCode).toBe(
      "target-has-non-supporting-attachment",
    );
    const firstAttachment = primary.attachments[0]!;
    const attachment = join(root, primary.projectDir, firstAttachment.path);
    const visible = readFileSync(attachment, "utf8");
    expect(visible).not.toContain("SUPPORT");
    expect(visible).not.toContain("CONTRADICT");
    expect(primary.caseId).not.toMatch(/support|contradict|noinfo/i);
    expect(firstAttachment.sha256).toBe(sha256File(attachment));
    expect(primary.graphSha256).toBe(
      sha256File(join(root, primary.projectDir, ".toulmin", "graph.db")),
    );
  });

  test("copy isolation prevents review events from mutating templates or sibling runs", () => {
    const candidate = selectCandidates(pairs(), ["primary"], null, 7)[0]!;
    const fixture = buildFixtureCase(root, candidate, "primary-000001");
    const source = join(root, fixture.projectDir);
    const copyA = join(root, "copy-a");
    const copyB = join(root, "copy-b");
    copyFixtureProject(source, copyA);
    copyFixtureProject(source, copyB);

    const dbAPath = join(copyA, ".toulmin", "graph.db");
    const dbA = openDatabase(dbAPath);
    service.recordReview(dbA, {
      nodeId: fixture.targetId,
      Q1: "pass",
      Q2: "pass",
      findings: [],
      model: "test",
      protocolHash: "protocol",
    });
    dbA.close();

    expect(reviewCount(dbAPath, fixture.targetId)).toBe(1);
    expect(reviewCount(join(copyB, ".toulmin", "graph.db"), fixture.targetId)).toBe(0);
    expect(reviewCount(join(source, ".toulmin", "graph.db"), fixture.targetId)).toBe(0);
  });

  test("fixture hashes fail closed after attachment tampering", () => {
    const candidate = selectCandidates(pairs(), ["primary"], null, 7)[0]!;
    const fixture = buildFixtureCase(root, candidate, "primary-000001");
    const lastAttachment = fixture.attachments.at(-1)!;
    writeFileSync(join(root, fixture.projectDir, lastAttachment.path), "tampered\n", "utf8");
    expect(() => validateFixtureFiles([fixture], root)).toThrow("attachment hash mismatch");
  });

  test("runner records reviewer failure without fabricating a review event", async () => {
    const candidate = selectCandidates(pairs(), ["primary"], null, 7)[0]!;
    const fixtureRoot = join(root, "fixtures");
    mkdirSync(fixtureRoot, { recursive: true });
    const fixture = buildFixtureCase(fixtureRoot, candidate, "primary-000001");
    const runDir = join(root, "run");
    mkdirSync(runDir, { recursive: true });
    const result = await executeCase({
      fixture,
      fixtureManifestDir: fixtureRoot,
      runDir,
      baseConfig: fakeConfig(),
      reviewFn: async () => {
        throw new Error("review unavailable");
      },
    });
    expect(result.status).toBe("error");
    expect(result.reviewEventsAdded).toBe(0);
    expect(
      reviewCount(join(fixtureRoot, fixture.projectDir, ".toulmin", "graph.db"), fixture.targetId),
    ).toBe(0);
  });

  test("runner rejects a result whose audit read only part of a multi-abstract target", async () => {
    const candidate = selectCandidates(pairs(), ["primary"], null, 7)[0]!;
    const fixtureRoot = join(root, "fixtures");
    mkdirSync(fixtureRoot, { recursive: true });
    const fixture = buildFixtureCase(fixtureRoot, candidate, "primary-000001");
    expect(fixture.attachments.length).toBeGreaterThan(1);
    const runDir = join(root, "run");
    mkdirSync(runDir, { recursive: true });
    const result = await executeCase({
      fixture,
      fixtureManifestDir: fixtureRoot,
      runDir,
      baseConfig: fakeConfig(),
      reviewFn: async (config, db, nodeId) => {
        const onlyRead = join(reviewCwd(config!), fixture.attachments[0]!.path);
        writeAuditRecord(config!.auditDir!, {
          timestamp: "2026-09-01T00:00:00.000Z",
          requestId: "22222222-2222-2222-2222-222222222222",
          model: "test-reviewer",
          maxTurns: config!.maxTurns,
          input: {
            prompt: "test",
            attachmentPaths: fixture.attachments.map((item) => item.path),
            cwd: reviewCwd(config!),
          },
          output: {
            raw: '{"Q1":"pass","Q2":"pass","findings":[]}',
            durationMs: 1,
            successfulReads: [onlyRead],
          },
        });
        const recorded = service.recordReview(db, {
          nodeId,
          Q1: "pass",
          Q2: "pass",
          findings: [],
          model: "test-reviewer",
          protocolHash: "protocol",
        });
        return {
          ...recorded,
          Q1: "pass",
          Q2: "pass",
          rejected: [],
          actualModel: "test-reviewer",
          attachmentsRead: [onlyRead],
        };
      },
    });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected runner failure");
    expect(result.error).toContain("did not auditably read fixture attachment");
  });

  test("successful runner locks audit, actual model, attachment Read, event, and archived DB", async () => {
    const candidate = selectCandidates(pairs(), ["primary"], null, 7)[0]!;
    const fixtureRoot = join(root, "fixtures");
    mkdirSync(fixtureRoot, { recursive: true });
    const fixture = buildFixtureCase(fixtureRoot, candidate, "primary-000001");
    const runDir = join(root, "run");
    mkdirSync(runDir, { recursive: true });
    const result = await executeCase({
      fixture,
      fixtureManifestDir: fixtureRoot,
      runDir,
      baseConfig: fakeConfig(),
      reviewFn: async (config, db, nodeId) => {
        const actualModel = "test-fallback";
        const attachmentPaths = fixture.attachments.map((item) => item.path);
        const successfulReads = attachmentPaths.map((path) => join(reviewCwd(config!), path));
        writeAuditRecord(config!.auditDir!, {
          timestamp: "2026-09-01T00:00:00.000Z",
          requestId: "11111111-1111-1111-1111-111111111111",
          model: actualModel,
          maxTurns: config!.maxTurns,
          input: {
            prompt: "test",
            attachmentPaths,
            cwd: reviewCwd(config!),
          },
          output: {
            raw: '{"Q1":"pass","Q2":"pass","findings":[]}',
            durationMs: 1,
            successfulReads,
          },
        });
        const recorded = service.recordReview(db, {
          nodeId,
          Q1: "pass",
          Q2: "pass",
          findings: [],
          model: actualModel,
          protocolHash: "protocol",
        });
        return {
          ...recorded,
          Q1: "pass",
          Q2: "pass",
          rejected: [],
          actualModel,
          attachmentsRead: successfulReads,
        };
      },
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected success");
    expect(result.actualModel).toBe("test-fallback");
    expect(result.auditAttempts).toHaveLength(1);
    expect(result.attachmentsRead).toEqual(fixture.attachments.map((item) => item.path));
    expect(result.graphSha256).toBe(sha256File(join(runDir, result.graphPath)));
    expect(reviewCount(join(runDir, result.graphPath), fixture.targetId)).toBe(1);
    expect(
      reviewCount(join(fixtureRoot, fixture.projectDir, ".toulmin", "graph.db"), fixture.targetId),
    ).toBe(0);
  });
});

describe("scoring", () => {
  function ok(
    caseId: string,
    Q1: "pass" | "fail" | "n/a",
    Q2: "pass" | "fail",
    findings: SuccessfulReviewCaseResult["findings"] = [],
  ): SuccessfulReviewCaseResult {
    return {
      schemaVersion: 1,
      caseId,
      status: "ok",
      durationMs: 10,
      eventId: 2,
      model: "test-reviewer",
      actualModel: "test-reviewer",
      fallbackModel: null,
      protocolHash: "hash",
      Q1,
      Q2,
      findings,
      rejected: [],
      graphPath: `${caseId}.db`,
      graphSha256: "unused",
      auditDir: null,
      auditFiles: 1,
      auditAttempts: [
        {
          model: "test-reviewer",
          durationMs: 10,
          rawSha256: "unused",
          successfulReads: [],
          file: "unused",
        },
      ],
      attachmentsRead: [],
      reviewEventsAdded: 1,
      attachmentUnchanged: true,
    };
  }

  function failed(caseId: string): FailedReviewCaseResult {
    return {
      schemaVersion: 1,
      caseId,
      status: "error",
      durationMs: 0,
      error: "not run",
      graphPath: null,
      graphSha256: null,
      auditDir: null,
      auditFiles: 0,
      auditAttempts: [],
      reviewEventsAdded: 0,
    };
  }

  function primaryFixtures(): FixtureCase[] {
    return selectCandidates(pairs(), ["primary"], null, 7).map((candidate, index) =>
      buildFixtureCase(root, candidate, `primary-${String(index + 1).padStart(6, "0")}`),
    );
  }

  test("requires a complete semantic overlay and keeps source and graph labels separate", () => {
    const fixtures = primaryFixtures();
    const manifest = fixtureManifest(fixtures);
    const manifestSha256 = "a".repeat(64);
    const provisional = buildProvisionalGraphVerdictOverlay(
      manifest,
      manifestSha256,
      new Date(0).toISOString(),
    );
    expect(provisional.counts.mechanicalGraphVerdict).toEqual({ pass: 1, fail: 3 });
    const mixedSupport = provisional.cases.find((item) => item.claimId === 1)!;
    expect(mixedSupport.sourceGoldLabel).toBe("SUPPORT");
    expect(mixedSupport.mechanicalGraphVerdict).toBe("fail");
    expect(mixedSupport.graphExpectedVerdict).toBeNull();
    expect(() =>
      validateGraphVerdictOverlay(
        manifest,
        provisional,
        manifestSha256,
        join(root, "provisional-overlay.json"),
      ),
    ).toThrow("invalid adjudication provenance");

    const adjudicated = fullyAdjudicatedOverlay(manifest, manifestSha256);
    const validated = validateGraphVerdictOverlay(
      manifest,
      adjudicated.overlay,
      manifestSha256,
      adjudicated.overlayPath,
    );
    expect(validated.verdicts.get(mixedSupport.caseId)).toBe("fail");

    adjudicated.overlay.cases[0]!.sourceGoldLabel = "NOINFO";
    expect(() =>
      validateGraphVerdictOverlay(
        manifest,
        adjudicated.overlay,
        manifestSha256,
        adjudicated.overlayPath,
      ),
    ).toThrow("mechanical audit disagrees");
  });

  test("binds an adjudication bundle to fixture, policy, JSONL, and consensus hashes", () => {
    const fixtures = primaryFixtures();
    const manifest = fixtureManifest(fixtures);
    const manifestSha256 = "a".repeat(64);
    const valid = fullyAdjudicatedOverlay(manifest, manifestSha256);
    expect(
      validateAdjudicationBundle(
        valid.bundlePath,
        manifestSha256,
        fixtures.map((fixture) => fixture.caseId),
      ).rows,
    ).toHaveLength(fixtures.length);
    expect(() =>
      validateAdjudicationBundle(
        valid.bundlePath,
        "f".repeat(64),
        fixtures.map((fixture) => fixture.caseId),
      ),
    ).toThrow("does not lock the selected fixture manifest");

    const tamperedJsonl = fullyAdjudicatedOverlay(manifest, manifestSha256);
    writeFileSync(tamperedJsonl.adjudicationsPath, "{}\n", "utf8");
    expect(() =>
      validateAdjudicationBundle(
        tamperedJsonl.bundlePath,
        manifestSha256,
        fixtures.map((fixture) => fixture.caseId),
      ),
    ).toThrow("Adjudications file hash");

    const tamperedConsensus = fullyAdjudicatedOverlay(manifest, manifestSha256);
    writeFileSync(tamperedConsensus.consensusPath, "{}\n", "utf8");
    expect(() =>
      validateAdjudicationBundle(
        tamperedConsensus.bundlePath,
        manifestSha256,
        fixtures.map((fixture) => fixture.caseId),
      ),
    ).toThrow("Consensus file hash");

    const tamperedPolicy = fullyAdjudicatedOverlay(manifest, manifestSha256);
    const bundle = readJson<GraphVerdictAdjudicationBundle>(tamperedPolicy.bundlePath);
    bundle.policy.adjudicationRule = "different policy";
    writeJson(tamperedPolicy.bundlePath, bundle);
    expect(() =>
      validateAdjudicationBundle(
        tamperedPolicy.bundlePath,
        manifestSha256,
        fixtures.map((fixture) => fixture.caseId),
      ),
    ).toThrow("unsupported labeling policy");
  });

  test("rejects overlay omissions, order changes, duplicates, bad counts, and provenance", () => {
    const fixtures = primaryFixtures();
    const manifest = fixtureManifest(fixtures);
    const manifestSha256 = "a".repeat(64);
    const chain = fullyAdjudicatedOverlay(manifest, manifestSha256);
    const validate = (overlay: GraphVerdictOverlay) =>
      validateGraphVerdictOverlay(manifest, overlay, manifestSha256, chain.overlayPath);

    const missing = structuredClone(chain.overlay);
    missing.cases.pop();
    expect(() => validate(missing)).toThrow("every fixture exactly once in manifest order");

    const disordered = structuredClone(chain.overlay);
    [disordered.cases[0], disordered.cases[1]] = [
      disordered.cases[1]!,
      disordered.cases[0]!,
    ];
    expect(() => validate(disordered)).toThrow("every fixture exactly once in manifest order");

    const duplicate = structuredClone(chain.overlay);
    duplicate.cases[1]!.caseId = duplicate.cases[0]!.caseId;
    expect(() => validate(duplicate)).toThrow("Duplicate overlay case id");

    const badCounts = structuredClone(chain.overlay);
    badCounts.counts.total++;
    expect(() => validate(badCounts)).toThrow("counts do not match");

    const badProvenance = structuredClone(chain.overlay);
    badProvenance.adjudication.bundleSha256 = "0".repeat(64);
    expect(() => validate(badProvenance)).toThrow("does not match its adjudication bundle");

    const escapingBundle = structuredClone(chain.overlay);
    escapingBundle.adjudication.bundlePath = "../bundle.json";
    expect(() => validate(escapingBundle)).toThrow("must stay inside its directory");
  });

  test("scores the adjudicated graph verdict, not the SciFact source label", () => {
    const cleanSupport = primaryFixtures().find((fixture) => fixture.claimId === 4)!;
    expect(cleanSupport.goldLabel).toBe("SUPPORT");
    expect(cleanSupport.expected.verdict).toBe("pass");
    const summary = scoreReviewCases(
      fixtureManifest([cleanSupport]),
      [ok(cleanSupport.caseId, "fail", "pass")],
      documents,
      new Map<string, GraphExpectedVerdict>([[cleanSupport.caseId, "fail"]]),
      testLabeling(),
      root,
    );
    expect(summary.schemaVersion).toBe(3);
    expect(summary.cases[0]!.sourceGoldLabel).toBe("SUPPORT");
    expect(summary.cases[0]!.graphExpectedVerdict).toBe("fail");
    expect(summary.cases[0]!.correct).toBe(true);
    expect(summary.byMode.primary.positiveCases).toBe(0);
    expect(summary.byMode.primary.negativeCases).toBe(1);
    expect(summary.byModeAndSourceGoldLabel.primary.SUPPORT.accuracy).toBe(1);
  });

  test("uses a q2 overlay graph pass for a negative source label without source fallback", () => {
    const candidate = selectCandidates(pairs(), ["q2-oracle"], null, 7).find(
      (item) => item.mode === "q2-oracle" && item.claim.label === "CONTRADICT",
    )!;
    const fixture = buildFixtureCase(root, candidate, "q2-oracle-000001");
    expect(fixture.goldLabel).toBe("CONTRADICT");
    expect(fixture.expected.verdict).toBe("fail");
    const manifest = fixtureManifest([fixture]);
    const manifestSha256 = "a".repeat(64);
    const chain = fullyAdjudicatedOverlay(
      manifest,
      manifestSha256,
      new Map([[fixture.caseId, "pass"]]),
    );
    const validated = validateGraphVerdictOverlay(
      manifest,
      chain.overlay,
      manifestSha256,
      chain.overlayPath,
    );
    const summary = scoreReviewCases(
      manifest,
      [ok(fixture.caseId, "n/a", "pass")],
      documents,
      validated.verdicts,
      testLabeling(),
      root,
    );
    expect(summary.cases[0]!.sourceGoldLabel).toBe("CONTRADICT");
    expect(summary.cases[0]!.graphExpectedVerdict).toBe("pass");
    expect(summary.cases[0]!.correct).toBe(true);
    expect(summary.byMode["q2-oracle"].positiveCases).toBe(1);
    expect(summary.byMode["q2-oracle"].contradictGraphFailRecall).toBeNull();
  });

  test("uses the combined endpoint and checks numbered quotes against the real attachment", () => {
    const fixtures = primaryFixtures();
    const byLabel = new Map(fixtures.map((fixture) => [fixture.goldLabel, fixture]));
    const support = byLabel.get("SUPPORT")!;
    const contradict = byLabel.get("CONTRADICT")!;
    const noInfo = byLabel.get("NOINFO")!;
    const results: ReviewCaseResult[] = [
      ok(support.caseId, "pass", "pass"),
      ok(contradict.caseId, "fail", "pass", [
        {
          id: "f_2_1",
          nodeId: contradict.targetId,
          question: "Q1",
          confidence: "high",
          content: "The source reports the opposite direction.",
          citation: {
            attachment: contradict.attachments[0]!.path,
            locator: "[0]",
            quote: "[0] The treatment increases disease incidence.",
          },
        },
      ]),
      ok(noInfo.caseId, "fail", "pass", [
        {
          id: "f_3_1",
          nodeId: noInfo.targetId,
          question: "Q1",
          confidence: "high",
          content: "The cited source does not address the claimed outcome.",
          citation: {
            attachment: noInfo.attachments[0]!.path,
            locator: "[0]",
            quote: "[0] The study measured an unrelated biomarker.",
          },
        },
      ]),
    ];
    const summary = scoreReviewCases(
      fixtureManifest(fixtures),
      results,
      documents,
      mechanicalVerdicts(fixtures),
      testLabeling(),
      root,
    );
    expect(summary.byMode.primary.accuracy).toBe(1);
    expect(summary.byMode.primary.macroF1).toBe(1);
    expect(summary.byMode.primary.falsePasses).toBe(0);
    expect(summary.byMode.primary.graphFailRecall).toBe(1);
    expect(summary.byMode.primary.contradictGraphFailRecall).toBe(1);
    expect(summary.byMode.primary.noInfoGraphFailRecall).toBe(1);
    expect(summary.q1CitationChecks.verbatimRate).toBe(1);
    expect(summary.q1CitationChecks.validCitationRate).toBe(1);
    expect(summary.q1CitationChecks.contradictRationaleHitRate).toBe(1);
    expect(summary.q1CitationChecks.failedCasesEligibleForGoldRationaleHit).toBe(1);
    expect(summary.cases.find((item) => item.caseId === noInfo.caseId)?.rationaleHit).toBeNull();
    expect(summary.primaryClaimClusterBootstrap?.clusters).toBe(3);
    expect(summary.protocol.failWithoutFinding).toBe(0);
  });

  test("maps every non-pass/pass combination to not-supported and reports invalid Q1 n/a", () => {
    const fixtures = primaryFixtures();
    const byLabel = new Map(fixtures.map((fixture) => [fixture.goldLabel, fixture]));
    const support = byLabel.get("SUPPORT")!;
    const contradict = byLabel.get("CONTRADICT")!;
    const noInfo = byLabel.get("NOINFO")!;
    const summary = scoreReviewCases(
      fixtureManifest(fixtures),
      [
        ok(support.caseId, "pass", "fail"),
        ok(contradict.caseId, "n/a", "pass"),
        ok(noInfo.caseId, "fail", "pass"),
      ],
      documents,
      mechanicalVerdicts(fixtures),
      testLabeling(),
      root,
    );
    expect(summary.cases.find((item) => item.caseId === support.caseId)?.actual).toBe("fail");
    expect(summary.cases.find((item) => item.caseId === contradict.caseId)?.actual).toBe("fail");
    expect(summary.byMode.primary.invalidVerdicts).toBe(1);
  });

  test("routes each citation to its own abstract and requires a matching locator", () => {
    const fixtures = primaryFixtures();
    const support = fixtures.find((fixture) => fixture.goldLabel === "SUPPORT")!;
    const secondSupport = support.attachments.find((item) => item.docId === 13)!;
    const correctFinding: SuccessfulReviewCaseResult["findings"][number] = {
      id: "f_1_1",
      nodeId: support.targetId,
      question: "Q1",
      confidence: "high",
      content: "The second study supports the direction.",
      citation: {
        attachment: secondSupport.path,
        locator: "[0]",
        quote: "[0] A second trial found that the treatment reduces disease incidence.",
      },
    };
    const correct = scoreReviewCases(
      fixtureManifest([support]),
      [ok(support.caseId, "fail", "pass", [correctFinding])],
      documents,
      mechanicalVerdicts([support]),
      testLabeling(),
      root,
    );
    expect(correct.q1CitationChecks.validCitationRate).toBe(1);
    expect(correct.cases[0]!.rationaleHit).toBe(true);

    const wrongPath = support.attachments.find((item) => item.docId === 11)!.path;
    const misrouted = scoreReviewCases(
      fixtureManifest([support]),
      [
        ok(support.caseId, "fail", "pass", [
          { ...correctFinding, citation: { ...correctFinding.citation, attachment: wrongPath } },
        ]),
      ],
      documents,
      mechanicalVerdicts([support]),
      testLabeling(),
      root,
    );
    expect(misrouted.q1CitationChecks.validCitationRate).toBe(0);
    expect(misrouted.cases[0]!.rationaleHit).toBe(false);

    const wrongLocator = scoreReviewCases(
      fixtureManifest([support]),
      [
        ok(support.caseId, "fail", "pass", [
          { ...correctFinding, citation: { ...correctFinding.citation, locator: "[99]" } },
        ]),
      ],
      documents,
      mechanicalVerdicts([support]),
      testLabeling(),
      root,
    );
    expect(wrongLocator.q1CitationChecks.verbatimRate).toBe(1);
    expect(wrongLocator.q1CitationChecks.validCitationRate).toBe(0);
    expect(wrongLocator.cases[0]!.rationaleHit).toBe(false);
  });

  test("keeps CONTRADICT and NOINFO separate inside the combined negative metric", () => {
    const fixtures = primaryFixtures();
    const byLabel = new Map(fixtures.map((fixture) => [fixture.goldLabel, fixture]));
    const support = byLabel.get("SUPPORT")!;
    const contradict = byLabel.get("CONTRADICT")!;
    const noInfo = byLabel.get("NOINFO")!;
    const summary = scoreReviewCases(
      fixtureManifest(fixtures),
      [
        ok(support.caseId, "pass", "pass"),
        ok(contradict.caseId, "fail", "pass"),
        ok(noInfo.caseId, "pass", "pass"),
      ],
      documents,
      mechanicalVerdicts(fixtures),
      testLabeling(),
      root,
    );
    expect(summary.byMode.primary.contradictGraphFailRecall).toBe(1);
    expect(summary.byMode.primary.noInfoGraphFailRecall).toBe(0);
    expect(summary.byMode.primary.graphFailRecall).toBe(0.5);
    expect(summary.byMode.primary.falsePassRate).toBe(0.5);
  });

  test("keeps run errors in the end-to-end denominator", () => {
    const fixtures = primaryFixtures();
    const byLabel = new Map(fixtures.map((fixture) => [fixture.goldLabel, fixture]));
    const support = byLabel.get("SUPPORT")!;
    const contradict = byLabel.get("CONTRADICT")!;
    const noInfo = byLabel.get("NOINFO")!;
    const summary = scoreReviewCases(
      fixtureManifest(fixtures),
      [
        ok(support.caseId, "pass", "pass"),
        failed(contradict.caseId),
        ok(noInfo.caseId, "fail", "pass"),
      ],
      documents,
      mechanicalVerdicts(fixtures),
      testLabeling(),
      root,
    );
    expect(summary.byMode.primary.accuracy).toBe(1);
    expect(summary.byMode.primary.endToEndAccuracy).toBe(2 / 3);
    expect(summary.byMode.primary.coverage).toBe(2 / 3);
    expect(summary.runtime.reviewerFailureRate).toBe(1 / 3);
    expect(summary.primaryClaimClusterBootstrap).toBeNull();
  });

  test("writes summary, dual-label CSV, and a fully locked score manifest", () => {
    const fixture = primaryFixtures().find((item) => item.claimId === 4)!;
    const manifest = fixtureManifest([fixture]);
    const chain = fullyAdjudicatedOverlay(manifest);
    const labeling: ScoreSummary["labeling"] = {
      ...testLabeling(),
      graphVerdictOverlaySha256: sha256File(chain.overlayPath),
      adjudicationBundleSha256: sha256File(chain.bundlePath),
      adjudicationsSha256: sha256File(chain.adjudicationsPath),
      consensusSha256: sha256File(chain.consensusPath),
    };
    const summary = scoreReviewCases(
      manifest,
      [ok(fixture.caseId, "pass", "pass")],
      documents,
      new Map([[fixture.caseId, "pass"]]),
      labeling,
      root,
    );
    const sourceDir = join(root, "score-sources");
    mkdirSync(sourceDir, { recursive: true });
    const runManifestPath = join(sourceDir, "run-manifest.json");
    const resultsPath = join(sourceDir, "results.jsonl");
    const recoveryPath = join(sourceDir, "recovery-provenance.json");
    const fixturePath = join(sourceDir, "fixture-manifest.json");
    writeJson(runManifestPath, { frozen: true });
    writeFileSync(resultsPath, "{}\n", "utf8");
    writeJson(recoveryPath, { recovered: true });
    writeJson(fixturePath, manifest);
    const outputDir = join(root, "score-release");
    const written = writeScoreArtifacts({
      outputDir,
      summary,
      runManifestPath,
      resultsPath,
      recoveryProvenancePath: recoveryPath,
      fixtureManifestPath: fixturePath,
      graphVerdictOverlayPath: chain.overlayPath,
      adjudicationBundlePath: chain.bundlePath,
    });
    const scoreManifest = readJson<ScoreManifest>(join(outputDir, "score-manifest.json"));
    expect(scoreManifest).toEqual(written);
    expect(scoreManifest.artifacts.summary.sha256).toBe(
      sha256File(join(outputDir, "summary.json")),
    );
    expect(scoreManifest.artifacts.casesCsv.sha256).toBe(
      sha256File(join(outputDir, "cases.csv")),
    );
    expect(scoreManifest.artifacts.recoveryProvenance?.sha256).toBe(
      sha256File(recoveryPath),
    );
    for (const artifact of Object.values(scoreManifest.artifacts)) {
      if (artifact !== null) expect(artifact.sha256).toBe(sha256File(artifact.path));
    }
    const csvHeader = readFileSync(join(outputDir, "cases.csv"), "utf8").split("\n")[0]!;
    expect(csvHeader).toContain("sourceGoldLabel");
    expect(csvHeader).toContain("graphExpectedVerdict");
    const persistedSummary = readJson<ScoreSummary>(join(outputDir, "summary.json"));
    expect(persistedSummary.labeling.adjudicationBundleSha256).toBe(
      sha256File(chain.bundlePath),
    );
    expect(persistedSummary.schemaVersion).toBe(3);
  });

  test("rejects invalid primary manifests and fabricated quote suffixes", () => {
    const fixtures = primaryFixtures();
    const invalid = fixtureManifest(structuredClone(fixtures));
    invalid.cases[0]!.expected.question = "Q2";
    expect(() => validateFixtureManifest(invalid)).toThrow("combined Q1/Q2 endpoint");

    const invalidLegacyExpected = fixtureManifest(structuredClone(fixtures));
    invalidLegacyExpected.cases.find(
      (fixture) => fixture.goldLabel === "CONTRADICT",
    )!.expected.verdict = "pass";
    expect(() => validateFixtureManifest(invalidLegacyExpected)).toThrow(
      "legacy v2 source-label expected verdict mapping",
    );

    const assessment = assessQuote(
      "The treatment increases disease incidence. fabricated suffix",
      documents[2]!,
      [[0]],
    );
    expect(assessment.inSource).toBe(false);
    expect(assessment.hitsGoldRationale).toBe(false);
  });
});

describe("Sol Ultra adjudication provenance", () => {
  test("requires exact top-level model and ultra effort", () => {
    expect(
      validateSolUltraInputProvenance(
        { model: "gpt-5.6-sol", reasoningEffort: "ultra" },
        "input.json",
      ),
    ).toEqual({ model: "gpt-5.6-sol", reasoningEffort: "ultra" });
    expect(() =>
      validateSolUltraInputProvenance(
        { model: null, reasoningEffort: "ultra" },
        "input.json",
      ),
    ).toThrow("model=gpt-5.6-sol");
    expect(() =>
      validateSolUltraInputProvenance(
        { model: "gpt-5.6-sol", reasoningEffort: null },
        "input.json",
      ),
    ).toThrow("reasoningEffort=ultra");
    expect(() =>
      validateSolUltraInputProvenance(
        { model: "gpt-5.6-terra", reasoningEffort: "ultra" },
        "input.json",
      ),
    ).toThrow("model=gpt-5.6-sol");
  });

  test("rejects null or false selected-vote blindness", () => {
    expect(() => requireSelectedVoteBlindness(null, true, "vote")).toThrow(
      "blindedToRunResults=true",
    );
    expect(() => requireSelectedVoteBlindness(true, null, "vote")).toThrow(
      "blindedToPriorAdjudication=true",
    );
    expect(() => requireSelectedVoteBlindness(true, false, "vote")).toThrow(
      "blindedToPriorAdjudication=true",
    );
    expect(() => requireSelectedVoteBlindness(true, true, "vote")).not.toThrow();
  });
});

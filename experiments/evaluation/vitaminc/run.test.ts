import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  readJson,
  readJsonl,
  sha256File,
  writeJson,
  writeJsonl,
} from "../common/manifest.ts";
import { EVIDENCE_ATTACHMENT, seedPostUpdateGraph } from "./graph.ts";
import { prepareVitaminC } from "./prepare.ts";
import {
  assertExpectedExecutableSha256,
  normalizeRuntimeTrace,
  FORMAL_PILOT_PER_DIRECTION,
  FORMAL_PILOT_SEED,
  OFFICIAL_VITAMINC_DEV_SHA256,
  formalProvider,
  resultAnalysisDisposition,
  selectValidatedFixtures,
  validateOfficialSourceContract,
  validatePreparedFixtures,
} from "./run.ts";
import type {
  PreparedManifest,
  PreparedPrivateCase,
  ReplayCase,
} from "./types.ts";

const roots: string[] = [];
const officialFactVerificationPath = resolve(
  import.meta.dir,
  "../../benchmarks/vitaminc/data/vitaminc/dev.jsonl",
);
const officialFlaggingPath = resolve(
  import.meta.dir,
  "../../benchmarks/vitaminc/data/vitaminc_flagging/dev.jsonl",
);
const officialSourceTest =
  existsSync(officialFactVerificationPath) && existsSync(officialFlaggingPath)
    ? test
    : test.skip;
const requiredFixtureImplementationPaths = [
  "experiments/evaluation/common/manifest.ts",
  "experiments/evaluation/vitaminc/adapter.ts",
  "experiments/evaluation/vitaminc/graph.ts",
  "experiments/evaluation/vitaminc/prepare.ts",
  "experiments/evaluation/vitaminc/types.ts",
  "src/db.ts",
  "src/hash.ts",
  "src/schema.ts",
  "src/service.ts",
  "src/structural-check.ts",
] as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("formal provider provenance", () => {
  test("labels Claude Platform on AWS separately and rejects selector conflicts", () => {
    expect(formalProvider({ ANTHROPIC_API_KEY: "test" })).toBe("anthropic-direct");
    expect(formalProvider({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe("bedrock");
    expect(formalProvider({ CLAUDE_CODE_USE_ANTHROPIC_AWS: "1" })).toBe("anthropic-aws");
    expect(() =>
      formalProvider({
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
      }),
    ).toThrow("mutually exclusive");
  });

  test("requires an exact pre-registered Claude executable digest", () => {
    const digest = "a".repeat(64);
    expect(() => assertExpectedExecutableSha256(digest, digest)).not.toThrow();
    expect(() => assertExpectedExecutableSha256(digest, "b".repeat(64))).toThrow(
      "SHA-256 mismatch",
    );
    expect(() => assertExpectedExecutableSha256(digest, "A".repeat(64))).toThrow(
      "64 lowercase hexadecimal",
    );
  });
});

function fixture(): { root: string; manifestPath: string; manifest: PreparedManifest } {
  const root = mkdtempSync(join(tmpdir(), "vitaminc-run-test-"));
  roots.push(root);
  const specs: Array<{ publicCaseId: string; item: ReplayCase }> = [
    {
      publicCaseId: "case-0123456789abcdefabcd",
      item: {
        id: "evaluator-only-sup-ref",
        pairId: "evaluator-only-sup-ref",
        direction: "SUP_TO_REF",
        claim: "The city had more than 540,000 residents in 2017.",
        e0: "The source reported 545,500 residents in 2017.",
        y0: "SUPPORTS",
        e1: "The corrected source reported 534,982 residents in 2017.",
        y1: "REFUTES",
        sourceIds: ["source-a_1", "source-a_2"],
        sourceCaseId: "source-a",
        revisionType: "real",
      },
    },
    {
      publicCaseId: "case-fedcba9876543210abcd",
      item: {
        id: "evaluator-only-ref-sup",
        pairId: "evaluator-only-ref-sup",
        direction: "REF_TO_SUP",
        claim: "The city had more than 540,000 residents in 2017.",
        e0: "The source reported 534,982 residents in 2017.",
        y0: "REFUTES",
        e1: "The corrected source reported 545,500 residents in 2017.",
        y1: "SUPPORTS",
        sourceIds: ["source-b_3", "source-b_4"],
        sourceCaseId: "source-b",
        revisionType: "real",
      },
    },
  ];
  const publicCases = [];
  const privateRecords: PreparedPrivateCase[] = [];
  for (const { publicCaseId, item } of specs) {
    const projectDir = join(root, "public", publicCaseId, "project");
    const graphPath = join(projectDir, ".toulmin", "graph.db");
    const seed = seedPostUpdateGraph(graphPath, item, publicCaseId);
    seed.graphSha256 = sha256File(graphPath);
    publicCases.push({
      schemaVersion: 2 as const,
      publicCaseId,
      projectDir: relative(root, projectDir),
      graphSha256: seed.graphSha256,
      evidenceSha256: sha256File(join(projectDir, EVIDENCE_ATTACHMENT)),
    });
    privateRecords.push({ schemaVersion: 2, publicCaseId, replay: item, seed });
  }
  const privatePath = join(root, "private", "cases.jsonl");
  mkdirSync(join(root, "private"), { recursive: true });
  writeJsonl(privatePath, privateRecords);
  const publicManifestPath = join(root, "public", "public-manifest.json");
  writeJson(publicManifestPath, { schemaVersion: 2, cases: publicCases });
  const manifest = {
    schemaVersion: 2,
    createdAt: new Date(0).toISOString(),
    adapterVersion: "vitaminc-replay/v2",
    dataset: {
      split: "dev",
      factVerificationPath: resolve(
        import.meta.dir,
        "../../benchmarks/vitaminc/data/vitaminc/dev.jsonl",
      ),
      factVerificationSha256: OFFICIAL_VITAMINC_DEV_SHA256.factVerification,
      flaggingPath: resolve(
        import.meta.dir,
        "../../benchmarks/vitaminc/data/vitaminc_flagging/dev.jsonl",
      ),
      flaggingSha256: OFFICIAL_VITAMINC_DEV_SHA256.flagging,
    },
    design: {
      population: "real-natural-factual-revisions",
      directions: ["SUP_TO_REF", "REF_TO_SUP"],
      clusterUnit: "sourceCaseId",
      globallyDisjointSourceCaseIds: true,
      flaggingValidationRequired: true,
    },
    sampler: {
      version: "vitaminc-cluster-sha256/v1",
      method: "seeded-sha256-cluster-partition",
      withinCluster: "minimum-seeded-sha256",
      publicOrder: "seeded-sha256",
    },
    selection: { seed: 1, perDirection: 1 },
    adapterAudit: {
      inputRows: 4,
      recognizedTemporalRows: 4,
      expectedTemporalPairs: 4,
      completeUniqueSlotPairs: 2,
      slotPairDrops: { missing: 2, duplicated: 0 },
      candidateBuildRejects: {
        nonFlip: 0,
        metadataInconsistency: 0,
        contentInconsistency: 0,
      },
      candidatesBeforeSemanticDedup: 2,
      duplicateSemanticTupleGroups: 0,
      duplicateSemanticTupleCandidatesDropped: 0,
      emittedCandidates: 2,
    },
    candidates: {
      adapterCandidates: 2,
      flaggingRows: 2,
      flaggingUniqueCaseIds: 2,
      eligibleCandidates: 2,
      eligibleSourceCaseIds: 2,
      eligibleByDirection: { SUP_TO_REF: 1, REF_TO_SUP: 1 },
      excluded: {
        non_real_revision: 0,
        missing_flagging_case: 0,
        non_unique_flagging_case: 0,
        non_factual_flagging_case: 0,
        revision_mismatch: 0,
        page_mismatch: 0,
        sent_a_mismatch: 0,
        sent_b_mismatch: 0,
      },
    },
    selectedCounts: {
      total: 2,
      uniqueSourceCaseIds: 2,
      byDirection: { SUP_TO_REF: 1, REF_TO_SUP: 1 },
      byRevisionType: { real: 2 },
    },
    implementationFiles: requiredFixtureImplementationPaths.map((path) => ({
      path,
      sha256: sha256File(resolve(import.meta.dir, "../../..", path)),
    })),
    repository: { commit: null, dirty: true },
    publicCases,
    publicManifestFile: relative(root, publicManifestPath),
    publicManifestSha256: sha256File(publicManifestPath),
    privateCasesFile: relative(root, privatePath),
    privateCasesSha256: sha256File(privatePath),
  } as unknown as PreparedManifest;
  const manifestPath = join(root, "fixture-manifest.json");
  writeJson(manifestPath, manifest);
  return { root, manifestPath, manifest };
}

function fakeSuccessfulAgent(
  root: string,
  mutateFixturePath?: string,
  blockFinalManifestPath?: string,
  reportedCostUsd: number | null = 0,
  reportedNumTurns: number | null = 4,
): string {
  const path = join(root, "fake-cleanroom-agent.ts");
  writeFileSync(
    path,
    `#!/usr/bin/env bun
import { join, dirname, resolve } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const configIndex = args.indexOf("--mcp-config");
const config = JSON.parse(args[configIndex + 1]);
const serverEntrypoint = config.mcpServers.toulmin.args[0];
const repoRoot = resolve(dirname(serverEntrypoint), "../../..");
const { openDatabase } = await import(pathToFileURL(join(repoRoot, "src/db.ts")).href);
const { checkContext } = await import(pathToFileURL(join(repoRoot, "src/structural-check.ts")).href);
const service = await import(pathToFileURL(join(repoRoot, "src/service.ts")).href);
const dbPath = join(process.cwd(), ".toulmin", "graph.db");
const db = openDatabase(dbPath);
const rows = db.query("SELECT id FROM propositions ORDER BY id").all();
const evidenceId = rows[0].id;
const claimId = rows[1].id;
const ctx = checkContext(dbPath);
const initiallySupports = Boolean(db.query("SELECT 1 AS hit FROM evidence_nodes WHERE node_id = ? AND evidence_id = ?").get(claimId, evidenceId));
const relationUpdate = initiallySupports
  ? { id: claimId, evidence: { remove_nodes: [evidenceId] }, rebuttals: { add: [evidenceId] }, note: "revalidated relation" }
  : { id: claimId, rebuttals: { remove: [evidenceId] }, evidence: { add_nodes: [evidenceId] }, note: "revalidated relation" };
const finalQualifier = initiallySupports ? "refuted" : "probably";
service.updateProposition(db, ctx, relationUpdate);
service.setQualifier(db, ctx, [{
  id: claimId,
  qualifier: finalQualifier,
  note: "revalidated current evidence",
}]);
db.close();

const mutateFixturePath = ${JSON.stringify(mutateFixturePath ?? null)};
if (mutateFixturePath) {
  const original = await Bun.file(mutateFixturePath).text();
  await Bun.write(mutateFixturePath, original + "\\n");
}
const blockFinalManifestPath = ${JSON.stringify(blockFinalManifestPath ?? null)};
if (blockFinalManifestPath) {
  rmSync(blockFinalManifestPath, { force: true });
  mkdirSync(blockFinalManifestPath);
}

const tools = [
  "get_stats", "find_propositions", "get_argument", "get_history",
  "update_proposition", "set_qualifier", "dismiss",
].map((name) => "mcp__toulmin__" + name);
const resultEvent = {
  type: "result", subtype: "success", is_error: false, result: "结论已更新。",
  duration_ms: 20,
  usage: { input_tokens: 10, output_tokens: 5 },
  modelUsage: { "claude-opus-4-6": {} },
};
const reportedCostUsd = ${JSON.stringify(reportedCostUsd)};
if (reportedCostUsd !== null) resultEvent.total_cost_usd = reportedCostUsd;
const reportedNumTurns = ${JSON.stringify(reportedNumTurns)};
if (reportedNumTurns !== null) resultEvent.num_turns = reportedNumTurns;
const events = [
  { type: "system", subtype: "init", model: "claude-opus-4-6", claude_code_version: "fake-test", tools, mcp_servers: [{ name: "toulmin", status: "connected" }] },
  { type: "assistant", message: { model: "claude-opus-4-6", content: [{ type: "tool_use", id: "read", name: "mcp__toulmin__get_argument", input: { id: claimId, depth: 1 } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read", content: [], is_error: false }] } },
  { type: "assistant", message: { model: "claude-opus-4-6", content: [{ type: "tool_use", id: "relation", name: "mcp__toulmin__update_proposition", input: { id: claimId } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "relation", content: [], is_error: false }] } },
  { type: "assistant", message: { model: "claude-opus-4-6", content: [{ type: "tool_use", id: "judge", name: "mcp__toulmin__set_qualifier", input: { updates: [{ id: claimId, qualifier: finalQualifier }] } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "judge", content: [], is_error: false }] } },
  { type: "assistant", message: { model: "claude-opus-4-6", content: [{ type: "text", text: "结论已更新。" }] } },
  resultEvent,
];
for (const event of events) process.stdout.write(JSON.stringify(event) + "\\n");
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function fakeUnexpectedToolAgent(root: string): string {
  const path = join(root, "fake-unexpected-tool-agent.ts");
  writeFileSync(
    path,
    `#!/usr/bin/env bun
const events = [
  { type: "system", subtype: "init", model: "claude-opus-4-6", tools: ["Bash"], mcp_servers: [{ name: "toulmin", status: "connected" }] },
  { type: "result", subtype: "success", is_error: false, result: "done", modelUsage: { "claude-opus-4-6": {} } },
];
for (const event of events) process.stdout.write(JSON.stringify(event) + "\\n");
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function fakeMaxTurnsAgent(
  root: string,
  suffix: string,
  reportedCostUsd: unknown,
  reportedNumTurns: unknown,
): string {
  const path = join(root, `fake-max-turns-${suffix}.ts`);
  writeFileSync(
    path,
    `#!/usr/bin/env bun
const tools = [
  "get_stats", "find_propositions", "get_argument", "get_history",
  "update_proposition", "set_qualifier", "dismiss",
].map((name) => "mcp__toulmin__" + name);
const events = [
  { type: "system", subtype: "init", model: "claude-opus-4-6", claude_code_version: "fake-test", tools, mcp_servers: [{ name: "toulmin", status: "connected" }] },
  { type: "result", subtype: "error_max_turns", is_error: true, result: "stopped", duration_ms: 20,
    total_cost_usd: ${JSON.stringify(reportedCostUsd)}, num_turns: ${JSON.stringify(reportedNumTurns)},
    modelUsage: { "claude-opus-4-6": {} } },
];
for (const event of events) process.stdout.write(JSON.stringify(event) + "\\n");
`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe("VitaminC sealed runner", () => {
  test("only a complete full-corpus formal live run exposes primary estimates", () => {
    expect(
      resultAnalysisDisposition({
        live: true,
        testHarness: false,
        status: "complete",
        fullFormalSelection: false,
      }),
    ).toMatchObject({
      primaryResultsAvailable: false,
      partialLiveDiagnosticsAvailable: true,
      analysisStatus: "partial-live-not-for-primary-analysis",
    });
    expect(
      resultAnalysisDisposition({
        live: true,
        testHarness: false,
        status: "complete_with_failures",
        fullFormalSelection: true,
      }),
    ).toMatchObject({
      primaryResultsAvailable: true,
      partialLiveDiagnosticsAvailable: false,
      analysisStatus: "complete-live-with-process-failures",
    });
  });

  test("pairs traces; omitted is_error is success while missing or explicit errors fail", () => {
    const normalized = normalizeRuntimeTrace([
      { streamIndex: 1, kind: "call", toolUseId: "a", toolName: "mcp__toulmin__get_stats", input: {} },
      { streamIndex: 2, kind: "result", toolUseId: "a", isError: false },
      { streamIndex: 3, kind: "call", toolUseId: "b", toolName: "mcp__toulmin__set_qualifier", input: {} },
      { streamIndex: 4, kind: "result", toolUseId: "b", isError: true },
      { streamIndex: 5, kind: "call", toolUseId: "c", toolName: "mcp__toulmin__update_proposition", input: {} },
      { streamIndex: 6, kind: "call", toolUseId: "d", toolName: "mcp__toulmin__get_argument", input: { id: 2 } },
      { streamIndex: 7, kind: "result", toolUseId: "d" },
    ]);
    expect(normalized).toEqual([
      { name: "mcp__toulmin__get_stats", input: {}, streamIndex: 1, success: true },
      { name: "mcp__toulmin__set_qualifier", input: {}, streamIndex: 3, success: false },
      { name: "mcp__toulmin__update_proposition", input: {}, streamIndex: 5, success: false },
      { name: "mcp__toulmin__get_argument", input: { id: 2 }, streamIndex: 6, success: true },
    ]);
  });

  test("rejects a fixture whose public evidence changed after preparation", () => {
    const f = fixture();
    const fixtureRoot = f.root;
    expect(validatePreparedFixtures(f.manifest, fixtureRoot)).toHaveLength(2);
    const evidence = join(
      fixtureRoot,
      f.manifest.publicCases[0]!.projectDir,
      EVIDENCE_ATTACHMENT,
    );
    writeFileSync(evidence, "tampered\n");
    expect(() => validatePreparedFixtures(f.manifest, fixtureRoot)).toThrow(
      "evidence hash mismatch",
    );
  });

  test("rejects self-resealed evidence that is not exactly the current revision", () => {
    const f = fixture();
    const publicCase = f.manifest.publicCases[0]!;
    const evidence = join(f.root, publicCase.projectDir, EVIDENCE_ATTACHMENT);
    writeFileSync(evidence, `${f.manifest.publicCases[0]!.publicCaseId}\nGold label: REFUTES\n`);
    publicCase.evidenceSha256 = sha256File(evidence);
    const publicManifestPath = join(f.root, f.manifest.publicManifestFile);
    writeJson(publicManifestPath, {
      schemaVersion: 2,
      cases: f.manifest.publicCases,
    });
    f.manifest.publicManifestSha256 = sha256File(publicManifestPath);

    expect(() => validatePreparedFixtures(f.manifest, f.root)).toThrow(
      "does not exactly match the sealed current revision",
    );
  });

  test("rejects a changed or structurally expanded public manifest", () => {
    const f = fixture();
    const publicManifestPath = join(f.root, f.manifest.publicManifestFile);
    writeJson(publicManifestPath, {
      schemaVersion: 2,
      cases: f.manifest.publicCases,
      direction: "SUP_TO_REF",
    });
    expect(() => validatePreparedFixtures(f.manifest, f.root)).toThrow(
      "Public manifest hash mismatch",
    );
    f.manifest.publicManifestSha256 = sha256File(publicManifestPath);
    expect(() => validatePreparedFixtures(f.manifest, f.root)).toThrow(
      "does not exactly match",
    );
  });

  test("rejects incomplete implementation provenance and inconsistent audit totals", () => {
    const f = fixture();
    const missingImplementation = structuredClone(f.manifest);
    missingImplementation.implementationFiles.pop();
    expect(() => validatePreparedFixtures(missingImplementation, f.root)).toThrow(
      "implementation hash set",
    );

    const badCandidateAudit = structuredClone(f.manifest);
    badCandidateAudit.candidates.adapterCandidates += 1;
    expect(() => validatePreparedFixtures(badCandidateAudit, f.root)).toThrow(
      "candidate audit totals",
    );

    const badAdapterAudit = structuredClone(f.manifest);
    badAdapterAudit.adapterAudit.completeUniqueSlotPairs += 1;
    expect(() => validatePreparedFixtures(badAdapterAudit, f.root)).toThrow(
      "adapter audit totals",
    );

    const badDataset = structuredClone(f.manifest);
    badDataset.dataset.split = "train";
    expect(() => validatePreparedFixtures(badDataset, f.root)).toThrow(
      "pinned official VitaminC dev",
    );

    const badDirectionCount = structuredClone(f.manifest);
    badDirectionCount.selectedCounts.byDirection.SUP_TO_REF = 2;
    expect(() => validatePreparedFixtures(badDirectionCount, f.root)).toThrow(
      "selectedCounts",
    );

    const impossibleEligibleClusters = structuredClone(f.manifest);
    impossibleEligibleClusters.candidates.eligibleSourceCaseIds = 1;
    expect(() => validatePreparedFixtures(impossibleEligibleClusters, f.root)).toThrow(
      "selectedCounts",
    );
  });

  test("rejects any unmanifested SQLite WAL/SHM next to a public graph", () => {
    const f = fixture();
    const graph = join(f.root, f.manifest.publicCases[0]!.projectDir, ".toulmin", "graph.db");
    writeFileSync(`${graph}-wal`, "unsealed state");
    expect(() => validatePreparedFixtures(f.manifest, f.root)).toThrow(
      "unexpected SQLite sidecar",
    );
  });

  test("fixture validation is read-only, sidecar-free, and repeatable", () => {
    const f = fixture();
    const before = f.manifest.publicCases.map((publicCase) => {
      const graph = join(f.root, publicCase.projectDir, ".toulmin", "graph.db");
      return { graph, sha256: sha256File(graph) };
    });

    expect(validatePreparedFixtures(f.manifest, f.root)).toHaveLength(2);
    expect(validatePreparedFixtures(f.manifest, f.root)).toHaveLength(2);

    for (const { graph, sha256 } of before) {
      expect(sha256File(graph)).toBe(sha256);
      expect(existsSync(`${graph}-wal`)).toBe(false);
      expect(existsSync(`${graph}-shm`)).toBe(false);
    }
  });

  officialSourceTest(
    "formal source verification rebuilds audits and the exact seeded official selection",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "vitaminc-official-contract-test-"));
      roots.push(root);
      const preparedRoot = join(root, "prepared");
      const manifest = await prepareVitaminC({
        inputPath: officialFactVerificationPath,
        flaggingPath: officialFlaggingPath,
        split: "dev",
        perDirection: FORMAL_PILOT_PER_DIRECTION,
        seed: FORMAL_PILOT_SEED,
        outputDir: preparedRoot,
      });

      await expect(
        validateOfficialSourceContract(manifest, preparedRoot),
      ).resolves.toBeUndefined();

      const unregisteredSelection = structuredClone(manifest);
      unregisteredSelection.selection.seed += 1;
      await expect(
        validateOfficialSourceContract(unregisteredSelection, preparedRoot),
      ).rejects.toThrow("selection is pinned");

      const badAdapterAudit = structuredClone(manifest);
      badAdapterAudit.adapterAudit.inputRows += 100;
      await expect(
        validateOfficialSourceContract(badAdapterAudit, preparedRoot),
      ).rejects.toThrow("adapter audit does not match");

      const badCandidateAudit = structuredClone(manifest);
      badCandidateAudit.candidates.flaggingRows += 1;
      badCandidateAudit.candidates.flaggingUniqueCaseIds += 1;
      await expect(
        validateOfficialSourceContract(badCandidateAudit, preparedRoot),
      ).rejects.toThrow("candidate audit does not match");

      const privatePath = join(preparedRoot, manifest.privateCasesFile);
      const privateCases = readJsonl<PreparedPrivateCase>(privatePath);
      const remappedPrivateCases = structuredClone(privateCases);
      const firstPublicId = remappedPrivateCases[0]!.publicCaseId;
      remappedPrivateCases[0]!.publicCaseId = remappedPrivateCases[1]!.publicCaseId;
      remappedPrivateCases[1]!.publicCaseId = firstPublicId;
      writeJsonl(privatePath, remappedPrivateCases);
      const badMappingManifest = structuredClone(manifest);
      badMappingManifest.privateCasesSha256 = sha256File(privatePath);
      await expect(
        validateOfficialSourceContract(badMappingManifest, preparedRoot),
      ).rejects.toThrow("replay/public-id mapping");

      const badReplayManifest = structuredClone(manifest);
      privateCases[0]!.replay.page = "not-the-official-page";
      writeJsonl(privatePath, privateCases);
      badReplayManifest.privateCasesSha256 = sha256File(privatePath);
      await expect(
        validateOfficialSourceContract(badReplayManifest, preparedRoot),
      ).rejects.toThrow("not an exact eligible official row");
    },
    30_000,
  );

  officialSourceTest(
    "formal source verification rejects a self-resealed graph-history gold leak",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "vitaminc-official-graph-contract-test-"));
      roots.push(root);
      const preparedRoot = join(root, "prepared");
      const manifest = await prepareVitaminC({
        inputPath: officialFactVerificationPath,
        flaggingPath: officialFlaggingPath,
        split: "dev",
        perDirection: FORMAL_PILOT_PER_DIRECTION,
        seed: FORMAL_PILOT_SEED,
        outputDir: preparedRoot,
      });
      const publicCase = manifest.publicCases[0]!;
      const privatePath = join(preparedRoot, manifest.privateCasesFile);
      const privateCases = readJsonl<PreparedPrivateCase>(privatePath);
      const privateCase = privateCases.find(
        (record) => record.publicCaseId === publicCase.publicCaseId,
      )!;
      const graphPath = join(preparedRoot, publicCase.projectDir, ".toulmin", "graph.db");
      const db = new Database(graphPath);
      db.query("UPDATE events SET note = ? WHERE id = 1").run(
        `Gold label: ${privateCase.replay.y1}`,
      );
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      db.close();
      rmSync(`${graphPath}-wal`, { force: true });
      rmSync(`${graphPath}-shm`, { force: true });

      publicCase.graphSha256 = sha256File(graphPath);
      privateCase.seed.graphSha256 = publicCase.graphSha256;
      writeJsonl(privatePath, privateCases);
      manifest.privateCasesSha256 = sha256File(privatePath);
      const publicManifestPath = join(preparedRoot, manifest.publicManifestFile);
      writeJson(publicManifestPath, { schemaVersion: 2, cases: manifest.publicCases });
      manifest.publicManifestSha256 = sha256File(publicManifestPath);

      expect(validatePreparedFixtures(manifest, preparedRoot)).toHaveLength(
        FORMAL_PILOT_PER_DIRECTION * 2,
      );
      await expect(
        validateOfficialSourceContract(manifest, preparedRoot),
      ).rejects.toThrow("not the exact seeded semantic fixture");
    },
    30_000,
  );

  test("automatic partial pilots cannot silently use an odd, direction-skewed limit", () => {
    const f = fixture();
    const validated = validatePreparedFixtures(f.manifest, f.root);
    expect(() => selectValidatedFixtures(validated, [], 1)).toThrow(
      "--limit must be even",
    );
    expect(selectValidatedFixtures(validated, [], 2)).toHaveLength(2);
  });

  test("dry-run makes no agent call and materializes the stale boundary baseline", () => {
    const f = fixture();
    const runDir = join(f.root, "run");
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        resolve(import.meta.dir, "run.ts"),
        "--fixtures",
        f.manifestPath,
        "--run-dir",
        runDir,
      ],
      cwd: resolve(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
    const summary = readJson<{
      overall: null;
      dryRunValidation: { observedFrozenState: Record<string, number | null> };
      noMaintenanceBaseline: { overall: Record<string, number | null> };
    }>(join(runDir, "summary.json"));
    expect(summary.overall).toBeNull();
    expect(summary.dryRunValidation.observedFrozenState.processAttemptRate).toBe(0);
    expect(summary.dryRunValidation.observedFrozenState.processCompletionRate).toBeNull();
    expect(summary.dryRunValidation.observedFrozenState.autonomousSuccessRate).toBe(0);
    expect(summary.dryRunValidation.observedFrozenState.labelAccuracy).toBe(0);
    expect(summary.dryRunValidation.observedFrozenState.staleUseRate).toBe(1);
    expect(summary.noMaintenanceBaseline.overall.labelAccuracy).toBe(0);
    expect(readJson<{
      status: string;
      requestedModel: string | null;
      processedCases: number;
      agentCompletedCases: number;
    }>(
      join(runDir, "run-manifest.json"),
    )).toMatchObject({
      status: "complete",
      requestedModel: null,
      processedCases: 2,
      agentCompletedCases: 0,
    });
  });

  test("live integration can score a fully traced repair without a network call", () => {
    const f = fixture();
    const runDir = join(f.root, "live-run");
    const executable = fakeSuccessfulAgent(f.root);
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        resolve(import.meta.dir, "run.ts"),
        "--fixtures",
        f.manifestPath,
        "--run-dir",
        runDir,
        "--live",
        "--all",
        "--model",
        "claude-opus-4-6",
        "--effort",
        "max",
        "--test-executable",
        executable,
      ],
      cwd: resolve(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VITAMINC_TEST_MODE: "1" },
    });
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
    const summary = readJson<{
      mode: string;
      testHarness: boolean;
      analysisStatus: string;
      overall: null;
      testHarnessValidation: { observedState: {
        processCompletionRate: number;
        autonomousSuccessRate: number;
        labelAccuracy: number;
        staleUseRate: number;
      } };
    }>(join(runDir, "summary.json"));
    expect(summary).toMatchObject({
      mode: "test-harness",
      testHarness: true,
      analysisStatus: "test-harness-not-for-primary-analysis",
      overall: null,
    });
    expect(summary.testHarnessValidation.observedState).toMatchObject({
      processCompletionRate: 1,
      autonomousSuccessRate: 1,
      labelAccuracy: 1,
      staleUseRate: 0,
    });
    const [caseResult] = readJsonl<{
      artifacts: {
        agentRuntime: Record<string, { path: string; sha256: string }>;
        graphBefore: string;
        graphBeforeSha256: string;
        graphAfter: string;
        graphAfterSha256: string;
        score: string;
        scoreSha256: string;
      };
    }>(join(runDir, "results.jsonl"));
    expect(caseResult).toBeDefined();
    for (const artifact of Object.values(caseResult!.artifacts.agentRuntime)) {
      expect(sha256File(join(runDir, artifact.path))).toBe(artifact.sha256);
    }
    expect(
      sha256File(join(runDir, caseResult!.artifacts.graphBefore)),
    ).toBe(caseResult!.artifacts.graphBeforeSha256);
    expect(
      sha256File(join(runDir, caseResult!.artifacts.graphAfter)),
    ).toBe(caseResult!.artifacts.graphAfterSha256);
    expect(sha256File(join(runDir, caseResult!.artifacts.score))).toBe(
      caseResult!.artifacts.scoreSha256,
    );
  });

  test("a systemic first-case failure aborts the remaining paid batch", () => {
    const f = fixture();
    const runDir = join(f.root, "failed-live-run");
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        resolve(import.meta.dir, "run.ts"),
        "--fixtures",
        f.manifestPath,
        "--run-dir",
        runDir,
        "--live",
        "--all",
        "--model",
        "claude-opus-4-6",
        "--test-executable",
        fakeUnexpectedToolAgent(f.root),
      ],
      cwd: resolve(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VITAMINC_TEST_MODE: "1" },
    });
    expect(result.exitCode).toBe(1);
    const manifest = readJson<{
      status: string;
      processedCases: number;
      unstartedCases: number;
      abortedReason: string;
    }>(join(runDir, "run-manifest.json"));
    expect(manifest).toMatchObject({ status: "aborted", processedCases: 1, unstartedCases: 1 });
    expect(manifest.abortedReason).toContain("unexpected tool surface");
    const summary = readJson<{
      status: string;
      analysisStatus: string;
      requestedN: number;
      processedN: number;
      unstartedN: number;
      overall: null;
      partialObservedResults: null;
      testHarnessValidation: { observedState: { n: number } };
      noMaintenanceBaseline: null;
      partialNoMaintenanceBaseline: { overall: { n: number } };
    }>(join(runDir, "summary.json"));
    expect(summary).toMatchObject({
      status: "aborted",
      analysisStatus: "incomplete-not-for-primary-analysis",
      requestedN: 2,
      processedN: 1,
      unstartedN: 1,
      overall: null,
      noMaintenanceBaseline: null,
    });
    expect(summary.testHarnessValidation.observedState.n).toBe(1);
    expect(summary.partialNoMaintenanceBaseline.overall.n).toBe(1);
  });

  test("seals a post-start integrity exception as aborted instead of leaving running", () => {
    const f = fixture();
    const runDir = join(f.root, "integrity-failed-run");
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        resolve(import.meta.dir, "run.ts"),
        "--fixtures",
        f.manifestPath,
        "--case",
        f.manifest.publicCases[0]!.publicCaseId,
        "--run-dir",
        runDir,
        "--live",
        "--model",
        "claude-opus-4-6",
        "--test-executable",
        fakeSuccessfulAgent(f.root, f.manifestPath),
      ],
      cwd: resolve(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VITAMINC_TEST_MODE: "1" },
    });
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain(
      "Fixture manifest changed during the run",
    );
    const manifest = readJson<{
      status: string;
      processedCases: number;
      unstartedCases: number;
      integrityChecksPassed: boolean;
      abortedReason: string;
    }>(join(runDir, "run-manifest.json"));
    expect(manifest).toMatchObject({
      status: "aborted",
      processedCases: 1,
      unstartedCases: 0,
      integrityChecksPassed: false,
    });
    expect(manifest.abortedReason).toContain("Fixture manifest changed during the run");
    const summary = readJson<{ overall: null; analysisStatus: string }>(
      join(runDir, "summary.json"),
    );
    expect(summary.overall).toBeNull();
    expect(summary.analysisStatus).toBe("incomplete-not-for-primary-analysis");
  });

  test("invalidates a primary summary if final manifest sealing fails", () => {
    const f = fixture();
    const runDir = join(f.root, "manifest-seal-failed-run");
    const manifestPath = join(runDir, "run-manifest.json");
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        resolve(import.meta.dir, "run.ts"),
        "--fixtures",
        f.manifestPath,
        "--case",
        f.manifest.publicCases[0]!.publicCaseId,
        "--run-dir",
        runDir,
        "--live",
        "--model",
        "claude-opus-4-6",
        "--test-executable",
        fakeSuccessfulAgent(f.root, undefined, manifestPath),
      ],
      cwd: resolve(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VITAMINC_TEST_MODE: "1" },
    });
    expect(result.exitCode).toBe(1);
    const summary = readJson<{
      status: string;
      analysisStatus: string;
      overall: null;
      finalizationFailure: string;
    }>(join(runDir, "summary.json"));
    expect(summary).toMatchObject({
      status: "aborted",
      analysisStatus: "incomplete-not-for-primary-analysis",
      overall: null,
    });
    expect(summary.finalizationFailure).toContain("result finalization failed");
  });

  test("selecting every fixture with a large limit still requires --all", () => {
    const f = fixture();
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        resolve(import.meta.dir, "run.ts"),
        "--fixtures",
        f.manifestPath,
        "--run-dir",
        join(f.root, "should-not-run"),
        "--live",
        "--limit",
        "999999",
        "--model",
        "claude-opus-4-6",
        "--test-executable",
        fakeSuccessfulAgent(f.root),
      ],
      cwd: resolve(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VITAMINC_TEST_MODE: "1" },
    });
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain("requires --all");
  });

  test("enforces hard per-case and authorized worst-case batch budgets", () => {
    const f = fixture();
    const executable = fakeSuccessfulAgent(f.root);
    for (const budgetArgs of [
      ["--max-budget-usd", "2.01"],
      ["--max-total-budget-usd", "3"],
    ]) {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          resolve(import.meta.dir, "run.ts"),
          "--fixtures",
          f.manifestPath,
          "--run-dir",
          join(f.root, `budget-${budgetArgs[0]!.slice(2)}`),
          "--live",
          "--all",
          "--model",
          "claude-opus-4-6",
          "--test-executable",
          executable,
          ...budgetArgs,
        ],
        cwd: resolve(import.meta.dir, "../../.."),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, VITAMINC_TEST_MODE: "1" },
      });
      expect(result.exitCode).toBe(1);
      const stderr = new TextDecoder().decode(result.stderr);
      expect(stderr).toMatch(/hard cap|Worst-case batch spend/);
    }
  });

  test("missing reported cost invalidates and stops a formal-shaped live process", () => {
    const f = fixture();
    const runDir = join(f.root, "missing-cost-run");
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        resolve(import.meta.dir, "run.ts"),
        "--fixtures",
        f.manifestPath,
        "--case",
        f.manifest.publicCases[0]!.publicCaseId,
        "--run-dir",
        runDir,
        "--live",
        "--model",
        "claude-opus-4-6",
        "--test-executable",
        fakeSuccessfulAgent(f.root, undefined, undefined, null),
      ],
      cwd: resolve(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VITAMINC_TEST_MODE: "1" },
    });
    expect(result.exitCode).toBe(1);
    const manifest = readJson<{ status: string; abortedReason: string }>(
      join(runDir, "run-manifest.json"),
    );
    expect(manifest.status).toBe("aborted");
    expect(manifest.abortedReason).toContain("invalid or over-budget reported cost");
    expect(readJson<{ overall: null }>(join(runDir, "summary.json")).overall).toBeNull();
  });

  test("missing, invalid, or over-limit reported turns invalidate the treatment", () => {
    const f = fixture();
    for (const [index, reportedTurns] of [null, 0, -1, 1.5, 13].entries()) {
      const runDir = join(f.root, `invalid-turns-${index}`);
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          resolve(import.meta.dir, "run.ts"),
          "--fixtures",
          f.manifestPath,
          "--case",
          f.manifest.publicCases[0]!.publicCaseId,
          "--run-dir",
          runDir,
          "--live",
          "--model",
          "claude-opus-4-6",
          "--test-executable",
          fakeSuccessfulAgent(f.root, undefined, undefined, 0, reportedTurns),
        ],
        cwd: resolve(import.meta.dir, "../../.."),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, VITAMINC_TEST_MODE: "1" },
      });
      expect(result.exitCode).toBe(1);
      const manifest = readJson<{ status: string; abortedReason: string }>(
        join(runDir, "run-manifest.json"),
      );
      expect(manifest.status).toBe("aborted");
      expect(manifest.abortedReason).toContain("reported turn count");
    }
  });

  test("invalid usage on failed runs is fail-closed and excluded from aggregates", () => {
    const cases = [
      { label: "negative-cost", cost: -1, turns: 0, invalid: "cost" },
      { label: "over-cost", cost: 2.01, turns: 0, invalid: "cost" },
      { label: "string-cost", cost: "1", turns: 0, invalid: "cost" },
      { label: "negative-turns", cost: 0, turns: -1, invalid: "turns" },
      { label: "fractional-turns", cost: 0, turns: 1.5, invalid: "turns" },
      { label: "over-turns", cost: 0, turns: 13, invalid: "turns" },
      { label: "string-turns", cost: 0, turns: "1", invalid: "turns" },
    ] as const;

    for (const item of cases) {
      const f = fixture();
      const publicCaseId = f.manifest.publicCases[0]!.publicCaseId;
      const runDir = join(f.root, `failed-usage-${item.label}`);
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          resolve(import.meta.dir, "run.ts"),
          "--fixtures",
          f.manifestPath,
          "--case",
          publicCaseId,
          "--run-dir",
          runDir,
          "--live",
          "--model",
          "claude-opus-4-6",
          "--test-executable",
          fakeMaxTurnsAgent(f.root, item.label, item.cost, item.turns),
        ],
        cwd: resolve(import.meta.dir, "../../.."),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, VITAMINC_TEST_MODE: "1" },
      });
      expect(result.exitCode).toBe(1);

      const [caseResult] = readJsonl<{
        process: {
          status: string;
          completed: boolean;
          failure: { kind: string; message: string };
          totalCostUsd: number | null;
          numTurns: number | null;
        };
      }>(join(runDir, "results.jsonl"));
      expect(caseResult!.process).toMatchObject({
        status: "invalid_output",
        completed: false,
        failure: { kind: "invalid_output" },
      });
      if (item.invalid === "cost") expect(caseResult!.process.totalCostUsd).toBeNull();
      else expect(caseResult!.process.numTurns).toBeNull();

      const summary = readJson<{
        status: string;
        testHarnessValidation: { observedState: { totalCostUsd: number | null } };
      }>(join(runDir, "summary.json"));
      expect(summary.status).toBe("aborted");
      if (item.invalid === "cost") {
        expect(summary.testHarnessValidation.observedState.totalCostUsd).toBeNull();
      }

      const rawProcess = readJson<{
        usage: { totalCostUsd: number | null; numTurns: number | null };
        rawReportedUsage: {
          totalCostUsd: { present: boolean; value: unknown };
          numTurns: { present: boolean; value: unknown };
        };
      }>(join(runDir, "cases", publicCaseId, "process.json"));
      expect(rawProcess.rawReportedUsage.totalCostUsd).toEqual({
        present: true,
        value: item.cost,
      });
      expect(rawProcess.rawReportedUsage.numTurns).toEqual({
        present: true,
        value: item.turns,
      });
    }
  });

  test("a full-corpus live selection cannot reorder the sealed case sequence", () => {
    const f = fixture();
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        resolve(import.meta.dir, "run.ts"),
        "--fixtures",
        f.manifestPath,
        "--case",
        f.manifest.publicCases[1]!.publicCaseId,
        "--case",
        f.manifest.publicCases[0]!.publicCaseId,
        "--run-dir",
        join(f.root, "reordered-full-corpus"),
        "--live",
        "--all",
        "--model",
        "claude-opus-4-6",
        "--test-executable",
        fakeSuccessfulAgent(f.root),
      ],
      cwd: resolve(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VITAMINC_TEST_MODE: "1" },
    });
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain(
      "must preserve the sealed public-manifest case order",
    );
  });

  test("a residual test-mode environment cannot bypass production clean-repo checks", () => {
    const f = fixture();
    const runDir = join(f.root, "not-a-test-harness");
    const localFacts = join(f.root, "synthetic-facts.jsonl");
    const localFlagging = join(f.root, "synthetic-flagging.jsonl");
    writeJsonl(localFacts, [{ claim: "Synthetic fixture for the repository guard" }]);
    writeJsonl(localFlagging, [{ case_id: "synthetic-repository-guard" }]);
    f.manifest.dataset.factVerificationPath = localFacts;
    f.manifest.dataset.flaggingPath = localFlagging;
    writeJson(f.manifestPath, f.manifest);

    // Dataset bytes are not this test's subject. Mock only these two local hashes
    // in the child; all graph, attachment and implementation checks remain real.
    // No --test-executable is passed, so the production repository guard must run.
    const preload = join(f.root, "local-dataset-hashes.ts");
    const manifestModule = resolve(import.meta.dir, "../common/manifest.ts");
    writeFileSync(preload, `
import { mock } from "bun:test";
import * as manifest from ${JSON.stringify(manifestModule)};
const original = { ...manifest };
const localHashes = new Map(${JSON.stringify([
      [localFacts, OFFICIAL_VITAMINC_DEV_SHA256.factVerification],
      [localFlagging, OFFICIAL_VITAMINC_DEV_SHA256.flagging],
    ])});
mock.module(${JSON.stringify(manifestModule)}, () => ({
  ...original,
  sha256File: (path: string) => localHashes.get(path) ?? original.sha256File(path),
}));
`);
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--preload",
        preload,
        resolve(import.meta.dir, "run.ts"),
        "--fixtures",
        f.manifestPath,
        "--run-dir",
        runDir,
        "--live",
        "--case",
        f.manifest.publicCases[0]!.publicCaseId,
        "--model",
        "claude-opus-4-6",
        "--claude-path",
        join(f.root, "must-not-start-claude"),
      ],
      cwd: resolve(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VITAMINC_TEST_MODE: "1" },
    });
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain(
      "clean, committed repository",
    );
    expect(existsSync(runDir)).toBe(false);
  });
});

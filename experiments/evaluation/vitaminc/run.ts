#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import {
  accessSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import {
  DEFAULT_TOULMIN_TOOL_ALLOWLIST,
  VITAMINC_CHILD_ENV_ALLOWLIST,
  VITAMINC_AGENT_PROMPT,
  buildVitaminCChildEnvironment,
  classifyVitaminCProviderSelection,
  runVitaminCAgent,
  type AgentToolTraceEntry,
  type AgentRunStatus,
  type ClaudeEffort,
  type VitaminCProvider,
  type VitaminCAgentRunResult,
} from "./agent-runtime.ts";
import { loadNaturalDirectionReplaysWithAudit } from "./adapter.ts";
import { readJson, readJsonl, sha256File, sha256Text, writeJson, writeJsonAtomic, writeJsonl } from "../common/manifest.ts";
import { dumpGraph, EVIDENCE_ATTACHMENT, seedPostUpdateGraph } from "./graph.ts";
import {
  loadFlaggingRows,
  opaqueCaseId,
  selectDirectionalCases,
  validateNaturalRealCandidates,
} from "./prepare.ts";
import {
  scoreVitaminCCase,
  type ProcessFailure,
  type ProcessFailureKind,
  type RecordedToolCall,
  type ScoringSeed,
  type VitaminCScorerResult,
} from "./scorer.ts";
import type {
  PreparedManifest,
  PreparedPrivateCase,
  PreparedPublicCase,
  ReplayCase,
  ReplayDirection,
} from "./types.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const DEFAULT_RUN_ROOT = join(
  REPO_ROOT,
  "experiments/evaluation/outputs/vitaminc/runs",
);
const RUNNER_VERSION = "vitaminc-agent/v2";
const DEFAULT_MAX_BUDGET_USD = 2;
const MAX_PER_CASE_BUDGET_USD = 2;
const DEFAULT_MAX_TOTAL_BUDGET_USD = 20;
const MAX_UNCONFIRMED_LIVE_CASES = 20;
export const FORMAL_PILOT_SEED = 20260901;
export const FORMAL_PILOT_PER_DIRECTION = 2;
export const OFFICIAL_VITAMINC_DEV_SHA256 = {
  factVerification: "a3258bc959754c84bade150d3bf447fd9c91a529d93bb676f034fdafda5f26e5",
  flagging: "fd1e6a3c15d53b7529e5c04533619c1ffa6091435aa6864842fe2f0e47363733",
} as const;
const EFFORTS = new Set<ClaudeEffort>(["low", "medium", "high", "xhigh", "max"]);
const REQUIRED_FIXTURE_IMPLEMENTATION_PATHS = [
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
const CANDIDATE_EXCLUSION_KEYS = [
  "non_real_revision",
  "missing_flagging_case",
  "non_unique_flagging_case",
  "non_factual_flagging_case",
  "revision_mismatch",
  "page_mismatch",
  "sent_a_mismatch",
  "sent_b_mismatch",
] as const;
const FORBIDDEN_FORMAL_ROUTING_ENV = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

interface ValidatedFixture {
  publicCase: PreparedPublicCase;
  privateCase: PreparedPrivateCase;
  projectDir: string;
  graphPath: string;
  evidencePath: string;
}

interface CaseProcessRecord {
  attempted: boolean;
  status: AgentRunStatus | "not_attempted" | "runner_error";
  completed: boolean;
  exitCode: number | null;
  failure: ProcessFailure | null;
  requestedModel: string | null;
  actualModel: string | null;
  actualModels: string[];
  claudeCodeVersion: string | null;
  effort: ClaudeEffort | null;
  durationMs: number;
  totalCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
}

interface VitaminCCaseResult {
  schemaVersion: 2;
  publicCaseId: string;
  evaluatorCaseId: string;
  pairId: string;
  direction: ReplayDirection;
  transition: string;
  revisionType: string | null;
  process: CaseProcessRecord;
  score: VitaminCScorerResult;
  artifacts: {
    caseDir: string;
    graphBefore: string;
    graphAfter: string;
    finalDatabase: string;
    finalDatabaseSha256: string;
    evidenceSha256: string;
    score: string;
    scoreSha256: string;
    graphBeforeSha256: string;
    graphAfterSha256: string;
    agentRuntime: null | Record<
      "stdout" | "stderr" | "toolTrace" | "answer" | "process",
      { path: string; sha256: string } | null
    >;
  };
}

interface RunOptions {
  fixtureManifestPath: string;
  selectedIds: string[];
  limit: number | null;
  live: boolean;
  all: boolean;
  model: string | null;
  effort: ClaudeEffort;
  maxTurns: number;
  timeoutMs: number;
  maxBudgetUsd: number;
  maxTotalBudgetUsd: number;
  runDir: string;
  executable: string;
  expectedClaudeCliSha256: string | null;
  testHarness: boolean;
  externalProviderDiagnostic: boolean;
  diagnosticSettingsPath: string | null;
  diagnosticSettingsFingerprintSha256: string | null;
  diagnosticEndpointOrigin: string | null;
  diagnosticEnvironment: Record<string, string | undefined> | null;
  diagnosticEnvironmentKeys: string[];
  diagnosticIgnoredTopLevelKeys: string[];
  diagnosticIgnoredEnvironmentKeys: string[];
  diagnosticAcceptedModelIds: string[];
}

interface ExternalProviderDiagnosticSettings {
  path: string;
  sha256: string;
  model: string;
  endpointOrigin: string;
  environment: Record<string, string | undefined>;
  environmentKeys: string[];
  ignoredTopLevelKeys: string[];
  ignoredEnvironmentKeys: string[];
  acceptedModelIds: string[];
}

type EvaluationMode =
  | "dry-run"
  | "live"
  | "test-harness"
  | "external-provider-diagnostic";

function evaluationMode(options: RunOptions): EvaluationMode {
  if (options.testHarness) return "test-harness";
  if (options.externalProviderDiagnostic) return "external-provider-diagnostic";
  return options.live ? "live" : "dry-run";
}

const DIAGNOSTIC_SETTINGS_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
]);

const DIAGNOSTIC_MODEL_ID = /^[a-z0-9][a-z0-9._:+/\[\]-]{0,127}$/i;

function usage(): string {
  return `Run the autonomous VitaminC temporal-revalidation evaluation.

Dry-run is the default. It validates sealed fixtures and scores the deterministic
no-maintenance state without invoking Claude.

Usage:
  bun experiments/evaluation/vitaminc/run.ts --fixtures <manifest> [options]

Options:
  --fixtures <path>       Required prepared fixture-manifest.json
  --case <opaque-id>      Select a public case id; repeatable
  --limit <n>             Select an automatic balanced pilot of n cases
  --run-dir <path>        New output directory
  --live                  Invoke the agent (may incur cost)
  --all                   Authorize a full or >20-case live run
  --model <full-id>       Required with --live; aliases are rejected by runtime
  --diagnostic-settings <path>
                          Use only model/env from an Anthropic-compatible settings JSON;
                          marks all output external-provider diagnostic, never primary
  --claude-path <path>    Claude executable to pin (default: first claude on PATH)
  --claude-sha256 <hex>   Required for formal live; pre-registered binary digest
  --effort <level>        low|medium|high|xhigh|max (default: max)
  --max-turns <n>         Agent turn cap (default: 12)
  --timeout <seconds>     Per-case wall-clock timeout (default: 600)
  --max-budget-usd <n>    Hard per-case Claude spend cap (default: 2)
  --max-total-budget-usd <n>
                          Maximum authorized worst-case batch spend (default: 20)
  --help                  Show this help
`;
}

function timestampId(): string {
  return new Date().toISOString().replace(/[-:.]/g, "");
}

function positiveInteger(name: string, value: string | undefined, fallback?: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (parsed === undefined || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function positiveNumber(name: string, value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be positive, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function safeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function assertExpectedExecutableSha256(
  actual: string,
  expected: string,
): void {
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error("--claude-sha256 must be exactly 64 lowercase hexadecimal characters");
  }
  if (actual !== expected) {
    throw new Error(`Claude CLI SHA-256 mismatch: expected=${expected}, actual=${actual}`);
  }
}

function executableVersion(executable: string): string | null {
  try {
    const result = Bun.spawnSync({
      cmd: [executable, "--version"],
      env: buildVitaminCChildEnvironment(undefined),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) return null;
    return new TextDecoder().decode(result.stdout).trim() || null;
  } catch {
    return null;
  }
}

function resolveExecutablePath(
  executable: string,
  env: Readonly<Record<string, string>>,
): string | null {
  const candidates = executable.includes("/")
    ? [resolve(executable)]
    : (env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, executable));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (lstatSync(candidate).isFile() || lstatSync(candidate).isSymbolicLink()) {
        return realpathSync(candidate);
      }
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

export function formalProvider(env: Readonly<Record<string, string>>): VitaminCProvider {
  const provider = classifyVitaminCProviderSelection(env);
  const forbidden = FORBIDDEN_FORMAL_ROUTING_ENV.filter((key) => Boolean(env[key]));
  if (forbidden.length > 0) {
    throw new Error(
      `Formal live runs reject custom endpoints, headers, and proxies: ${forbidden.join(",")}`,
    );
  }
  if (provider === "anthropic-direct") {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error(
        "Clean-room live mode requires ANTHROPIC_API_KEY or one explicit Bedrock/Anthropic-AWS/Vertex/Foundry provider",
      );
    }
  }
  return provider;
}

function currentRepositoryState(): { commit: string | null; dirty: boolean | null } {
  const commit = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: REPO_ROOT });
  const status = Bun.spawnSync({ cmd: ["git", "status", "--porcelain"], cwd: REPO_ROOT });
  return {
    commit:
      commit.exitCode === 0
        ? new TextDecoder().decode(commit.stdout).trim() || null
        : null,
    dirty:
      status.exitCode === 0
        ? new TextDecoder().decode(status.stdout).trim().length > 0
        : null,
  };
}

function implementationHashes(): Record<string, string> {
  const paths = [
    "experiments/evaluation/vitaminc/run.ts",
    "experiments/evaluation/vitaminc/agent-runtime.ts",
    "experiments/evaluation/vitaminc/mcp-server.ts",
    "experiments/evaluation/vitaminc/scorer.ts",
    "experiments/evaluation/vitaminc/graph.ts",
    "agents/toulmin-researcher.md",
    ".claude-plugin/plugin.json",
    "src/index.ts",
    "src/tools.ts",
    "src/service.ts",
    "src/structural-check.ts",
    "src/db.ts",
    "src/repo.ts",
    "src/schema.ts",
    "src/hash.ts",
    "src/types.ts",
  ];
  return Object.fromEntries(paths.map((path) => [path, sha256File(join(REPO_ROOT, path))]));
}

function isInside(root: string, path: string): boolean {
  const back = relative(root, path);
  return back === "" || (!back.startsWith("..") && !isAbsolute(back));
}

function resolveFixturePath(root: string, path: string, label: string): string {
  if (isAbsolute(path)) throw new Error(`${label} must be relative to the fixture root: ${path}`);
  const resolved = resolve(root, path);
  if (!isInside(root, resolved)) throw new Error(`${label} escapes the fixture root: ${path}`);
  return resolved;
}

function assertRegularFile(path: string, label: string): void {
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    throw new Error(`${label} is missing or not a regular file: ${path}`);
  }
}

/**
 * Read only the model and narrowly allowlisted environment entries from a
 * Claude settings file. Hooks, plugins, permissions, and every other setting
 * are deliberately ignored, and credential values never enter run artifacts.
 */
export function loadExternalProviderDiagnosticSettings(
  settingsPath: string,
): ExternalProviderDiagnosticSettings {
  const path = resolve(settingsPath);
  assertRegularFile(path, "diagnostic settings");
  if ((lstatSync(path).mode & 0o077) !== 0) {
    throw new Error("diagnostic settings must not be readable or writable by group/other");
  }
  const raw = readJson<unknown>(path);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("diagnostic settings must be a JSON object");
  }
  const record = raw as Record<string, unknown>;
  const rawEnvironment = record.env;
  if (
    rawEnvironment === null ||
    typeof rawEnvironment !== "object" ||
    Array.isArray(rawEnvironment)
  ) {
    throw new Error("diagnostic settings must contain an env object");
  }
  const environmentRecord = rawEnvironment as Record<string, unknown>;
  const selectedEnvironment: Record<string, string> = {};
  for (const key of DIAGNOSTIC_SETTINGS_ENV_KEYS) {
    const value = environmentRecord[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value) {
      throw new Error(`diagnostic settings env.${key} must be a non-empty string`);
    }
    selectedEnvironment[key] = value;
  }
  if (!selectedEnvironment.ANTHROPIC_AUTH_TOKEN && !selectedEnvironment.ANTHROPIC_API_KEY) {
    throw new Error(
      "diagnostic settings require ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY",
    );
  }
  const baseUrl = selectedEnvironment.ANTHROPIC_BASE_URL;
  if (!baseUrl) throw new Error("diagnostic settings require ANTHROPIC_BASE_URL");
  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw new Error("diagnostic settings ANTHROPIC_BASE_URL must be a valid URL");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(
      "diagnostic settings ANTHROPIC_BASE_URL must use HTTPS without credentials, query, or fragment",
    );
  }
  const model =
    typeof record.model === "string" && record.model
      ? record.model
      : selectedEnvironment.ANTHROPIC_MODEL;
  if (!model || !DIAGNOSTIC_MODEL_ID.test(model)) {
    throw new Error(`invalid diagnostic model id: ${String(model)}`);
  }

  // Remove any ambient provider credential/route before inserting the explicit
  // diagnostic configuration. Execution/locale/TLS variables remain inherited.
  const environment: Record<string, string | undefined> = {};
  for (const key of VITAMINC_CHILD_ENV_ALLOWLIST) {
    if (
      /^(?:ANTHROPIC_|CLAUDE_CODE_USE_|AWS_|GOOGLE_|CLOUD_ML_|AZURE_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|http_proxy$|https_proxy$|all_proxy$)/.test(
        key,
      )
    ) {
      environment[key] = undefined;
    }
  }
  Object.assign(environment, selectedEnvironment);

  const environmentKeys = Object.keys(selectedEnvironment).sort();
  const ignoredTopLevelKeys = Object.keys(record)
    .filter((key) => key !== "env" && key !== "model")
    .sort();
  const ignoredEnvironmentKeys = Object.keys(environmentRecord)
    .filter((key) => !DIAGNOSTIC_SETTINGS_ENV_KEYS.has(key))
    .sort();
  const acceptedModelIds = [
    model,
    selectedEnvironment.ANTHROPIC_MODEL,
    selectedEnvironment.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    selectedEnvironment.ANTHROPIC_DEFAULT_OPUS_MODEL,
    selectedEnvironment.ANTHROPIC_DEFAULT_SONNET_MODEL,
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
  const redactedFingerprint = sha256Text(
    JSON.stringify({
      model,
      endpointOrigin: endpoint.origin,
      environmentKeys,
      ignoredTopLevelKeys,
      ignoredEnvironmentKeys,
      acceptedModelIds,
    }),
  );

  return {
    path,
    sha256: redactedFingerprint,
    model,
    endpointOrigin: endpoint.origin,
    environment,
    environmentKeys,
    ignoredTopLevelKeys,
    ignoredEnvironmentKeys,
    acceptedModelIds,
  };
}

function optionalSealedArtifact(
  path: string,
  runDir: string,
): { path: string; sha256: string } | null {
  if (!existsSync(path) || !lstatSync(path).isFile()) return null;
  return { path: relative(runDir, path), sha256: sha256File(path) };
}

function assertRecordedArtifact(
  runDir: string,
  record: { path: string; sha256: string },
  label: string,
): void {
  const path = resolveFixturePath(runDir, record.path, label);
  assertRegularFile(path, label);
  if (sha256File(path) !== record.sha256) {
    throw new Error(`${label} changed before run sealing`);
  }
}

function verifyResultArtifacts(results: readonly VitaminCCaseResult[], runDir: string): void {
  for (const result of results) {
    assertRecordedArtifact(
      runDir,
      { path: result.artifacts.graphBefore, sha256: result.artifacts.graphBeforeSha256 },
      `${result.publicCaseId} graph-before artifact`,
    );
    assertRecordedArtifact(
      runDir,
      { path: result.artifacts.graphAfter, sha256: result.artifacts.graphAfterSha256 },
      `${result.publicCaseId} graph-after artifact`,
    );
    assertRecordedArtifact(
      runDir,
      { path: result.artifacts.finalDatabase, sha256: result.artifacts.finalDatabaseSha256 },
      `${result.publicCaseId} final database`,
    );
    assertRecordedArtifact(
      runDir,
      { path: result.artifacts.score, sha256: result.artifacts.scoreSha256 },
      `${result.publicCaseId} score artifact`,
    );
    const evidencePath = join(
      resolveFixturePath(runDir, result.artifacts.caseDir, "caseDir"),
      EVIDENCE_ATTACHMENT,
    );
    assertRegularFile(evidencePath, `${result.publicCaseId} evidence artifact`);
    if (sha256File(evidencePath) !== result.artifacts.evidenceSha256) {
      throw new Error(`${result.publicCaseId} evidence artifact changed before run sealing`);
    }
    for (const [name, artifact] of Object.entries(result.artifacts.agentRuntime ?? {})) {
      if (artifact) {
        assertRecordedArtifact(
          runDir,
          artifact,
          `${result.publicCaseId} agent ${name} artifact`,
        );
      }
    }
  }
}

function scoreFrozenFixture(
  graphPath: string,
  evidencePath: string,
  item: ReplayCase,
  seed: ScoringSeed,
): VitaminCScorerResult {
  const inspectionDir = mkdtempSync(join(tmpdir(), "vitaminc-fixture-inspection-"));
  const inspectionGraph = join(inspectionDir, ".toulmin", "graph.db");
  const inspectionEvidence = join(inspectionDir, EVIDENCE_ATTACHMENT);
  try {
    mkdirSync(dirname(inspectionGraph), { recursive: true });
    mkdirSync(dirname(inspectionEvidence), { recursive: true });
    copyFileSync(graphPath, inspectionGraph);
    copyFileSync(evidencePath, inspectionEvidence);
    return scoreVitaminCCase({
      dbPath: inspectionGraph,
      item,
      seed,
      process: { attempted: false },
      trace: { toolCalls: [] },
    });
  } finally {
    rmSync(inspectionDir, { recursive: true, force: true });
  }
}

function semanticSnapshotOfSealedFixture(
  graphPath: string,
  evidencePath: string,
): Record<string, unknown> {
  const inspectionDir = mkdtempSync(join(tmpdir(), "vitaminc-graph-snapshot-"));
  const inspectionGraph = join(inspectionDir, ".toulmin", "graph.db");
  const inspectionEvidence = join(inspectionDir, EVIDENCE_ATTACHMENT);
  try {
    mkdirSync(dirname(inspectionGraph), { recursive: true });
    mkdirSync(dirname(inspectionEvidence), { recursive: true });
    copyFileSync(graphPath, inspectionGraph);
    copyFileSync(evidencePath, inspectionEvidence);
    return dumpGraph(inspectionGraph);
  } finally {
    rmSync(inspectionDir, { recursive: true, force: true });
  }
}

function reconstructExpectedFixture(
  item: ReplayCase,
  publicCaseId: string,
): { graph: Record<string, unknown>; seed: ScoringSeed; evidence: string } {
  const reconstructionDir = mkdtempSync(join(tmpdir(), "vitaminc-graph-reconstruction-"));
  const graphPath = join(reconstructionDir, ".toulmin", "graph.db");
  try {
    const seed = seedPostUpdateGraph(graphPath, item, publicCaseId) as ScoringSeed;
    return {
      graph: dumpGraph(graphPath),
      seed,
      evidence: readFileSync(join(reconstructionDir, EVIDENCE_ATTACHMENT), "utf8"),
    };
  } finally {
    rmSync(reconstructionDir, { recursive: true, force: true });
  }
}

function requireScoringSeed(record: PreparedPrivateCase): ScoringSeed {
  const { seed, replay } = record;
  if (
    !Number.isInteger(seed.lastSeedEventId) ||
    seed.lastSeedEventId! < 0 ||
    typeof seed.initialClaimContent !== "string" ||
    typeof seed.initialQualifier !== "string" ||
    (seed.initialRelation !== "evidence" && seed.initialRelation !== "rebuttal")
  ) {
    throw new Error(`Fixture ${record.publicCaseId} has incomplete v2 scoring metadata`);
  }
  if (seed.initialClaimContent !== replay.claim) {
    throw new Error(`Fixture ${record.publicCaseId} claim does not match its sealed seed`);
  }
  const expectedRelation = replay.y0 === "SUPPORTS" ? "evidence" : "rebuttal";
  if (seed.initialRelation !== expectedRelation || seed.direction !== replay.direction) {
    throw new Error(`Fixture ${record.publicCaseId} initial state conflicts with its replay`);
  }
  if (seed.pendingWarningCodes?.join(",") !== "R2") {
    throw new Error(`Fixture ${record.publicCaseId} must start with exactly one pending R2`);
  }
  return seed as ScoringSeed;
}

function assertPinnedOfficialDataset(
  manifest: PreparedManifest,
  requireFiles: boolean,
): void {
  if (
    manifest.dataset?.split !== "dev" ||
    typeof manifest.dataset.factVerificationPath !== "string" ||
    !manifest.dataset.factVerificationPath ||
    typeof manifest.dataset.flaggingPath !== "string" ||
    !manifest.dataset.flaggingPath ||
    manifest.dataset.factVerificationSha256 !==
      OFFICIAL_VITAMINC_DEV_SHA256.factVerification ||
    manifest.dataset.flaggingSha256 !== OFFICIAL_VITAMINC_DEV_SHA256.flagging
  ) {
    throw new Error("Fixture dataset provenance is not the pinned official VitaminC dev data");
  }
  if (!requireFiles) return;
  for (const [label, path, expected] of [
    [
      "fact-verification dataset",
      manifest.dataset.factVerificationPath,
      manifest.dataset.factVerificationSha256,
    ],
    ["flagging dataset", manifest.dataset.flaggingPath, manifest.dataset.flaggingSha256],
  ] as const) {
    assertRegularFile(path, label);
    if (sha256File(path) !== expected) {
      throw new Error(`${label} no longer matches its pinned official hash`);
    }
  }
}

export function validatePreparedFixtures(
  manifest: PreparedManifest,
  fixtureRoot: string,
  options: { requireDatasetFiles?: boolean } = {},
): ValidatedFixture[] {
  if (manifest.schemaVersion !== 2 || manifest.adapterVersion !== "vitaminc-replay/v2") {
    throw new Error(`Unsupported VitaminC fixture manifest schema/adapter`);
  }
  if (
    manifest.design?.population !== "real-natural-factual-revisions" ||
    JSON.stringify(manifest.design.directions) !==
      JSON.stringify(["SUP_TO_REF", "REF_TO_SUP"]) ||
    manifest.design.clusterUnit !== "sourceCaseId" ||
    manifest.design.globallyDisjointSourceCaseIds !== true ||
    manifest.design.flaggingValidationRequired !== true ||
    manifest.sampler?.version !== "vitaminc-cluster-sha256/v1" ||
    manifest.sampler.method !== "seeded-sha256-cluster-partition" ||
    manifest.sampler.withinCluster !== "minimum-seeded-sha256" ||
    manifest.sampler.publicOrder !== "seeded-sha256"
  ) {
    throw new Error("Fixture was not built with the formal real-only, flagging-validated design");
  }
  if (
    !Number.isSafeInteger(manifest.selection?.seed) ||
    !Number.isSafeInteger(manifest.selection?.perDirection) ||
    manifest.selection.perDirection <= 0
  ) {
    throw new Error("Fixture selection seed/perDirection is invalid");
  }
  assertPinnedOfficialDataset(manifest, options.requireDatasetFiles === true);
  const implementationFiles = manifest.implementationFiles ?? [];
  const implementationPaths = implementationFiles.map((item) => item.path);
  if (
    implementationPaths.length !== REQUIRED_FIXTURE_IMPLEMENTATION_PATHS.length ||
    new Set(implementationPaths).size !== implementationPaths.length ||
    REQUIRED_FIXTURE_IMPLEMENTATION_PATHS.some((path) => !implementationPaths.includes(path))
  ) {
    throw new Error("Fixture implementation hash set is incomplete, duplicated, or unexpected");
  }
  for (const implementation of implementationFiles) {
    if (!/^[0-9a-f]{64}$/.test(implementation.sha256)) {
      throw new Error(`Malformed fixture implementation hash: ${implementation.path}`);
    }
    const path = resolveFixturePath(REPO_ROOT, implementation.path, "implementation file");
    assertRegularFile(path, "fixture implementation file");
    if (sha256File(path) !== implementation.sha256) {
      throw new Error(`Fixture implementation drift: ${implementation.path}`);
    }
  }
  const auditNumbers = [
    manifest.candidates?.adapterCandidates,
    manifest.candidates?.flaggingRows,
    manifest.candidates?.flaggingUniqueCaseIds,
    manifest.candidates?.eligibleCandidates,
    manifest.candidates?.eligibleSourceCaseIds,
    manifest.candidates?.eligibleByDirection?.SUP_TO_REF,
    manifest.candidates?.eligibleByDirection?.REF_TO_SUP,
    ...CANDIDATE_EXCLUSION_KEYS.map((key) => manifest.candidates?.excluded?.[key]),
  ];
  if (auditNumbers.some((value) => !Number.isSafeInteger(value) || value! < 0)) {
    throw new Error("Fixture candidate audit contains invalid counts");
  }
  const excludedKeys = Object.keys(manifest.candidates.excluded).sort();
  if (
    JSON.stringify(excludedKeys) !== JSON.stringify([...CANDIDATE_EXCLUSION_KEYS].sort())
  ) {
    throw new Error("Fixture candidate audit exclusion keys are incomplete or unexpected");
  }
  const excludedTotal = CANDIDATE_EXCLUSION_KEYS.reduce(
    (sum, key) => sum + manifest.candidates.excluded[key],
    0,
  );
  if (
    manifest.candidates.adapterCandidates !==
      manifest.candidates.eligibleCandidates + excludedTotal ||
    manifest.candidates.eligibleCandidates !==
      manifest.candidates.eligibleByDirection.SUP_TO_REF +
        manifest.candidates.eligibleByDirection.REF_TO_SUP ||
    manifest.candidates.eligibleSourceCaseIds > manifest.candidates.eligibleCandidates ||
    manifest.candidates.flaggingUniqueCaseIds > manifest.candidates.flaggingRows
  ) {
    throw new Error("Fixture candidate audit totals are inconsistent");
  }
  const adapterAudit = manifest.adapterAudit;
  const adapterAuditKeys = [
    "candidateBuildRejects",
    "candidatesBeforeSemanticDedup",
    "completeUniqueSlotPairs",
    "duplicateSemanticTupleCandidatesDropped",
    "duplicateSemanticTupleGroups",
    "emittedCandidates",
    "expectedTemporalPairs",
    "inputRows",
    "recognizedTemporalRows",
    "slotPairDrops",
  ];
  if (
    !adapterAudit ||
    JSON.stringify(Object.keys(adapterAudit).sort()) !== JSON.stringify(adapterAuditKeys) ||
    JSON.stringify(Object.keys(adapterAudit.slotPairDrops ?? {}).sort()) !==
      JSON.stringify(["duplicated", "missing"]) ||
    JSON.stringify(Object.keys(adapterAudit.candidateBuildRejects ?? {}).sort()) !==
      JSON.stringify(["contentInconsistency", "metadataInconsistency", "nonFlip"])
  ) {
    throw new Error("Fixture adapter audit shape is incomplete or unexpected");
  }
  const adapterAuditNumbers = [
    adapterAudit.inputRows,
    adapterAudit.recognizedTemporalRows,
    adapterAudit.expectedTemporalPairs,
    adapterAudit.completeUniqueSlotPairs,
    adapterAudit.slotPairDrops.missing,
    adapterAudit.slotPairDrops.duplicated,
    adapterAudit.candidateBuildRejects.nonFlip,
    adapterAudit.candidateBuildRejects.metadataInconsistency,
    adapterAudit.candidateBuildRejects.contentInconsistency,
    adapterAudit.candidatesBeforeSemanticDedup,
    adapterAudit.duplicateSemanticTupleGroups,
    adapterAudit.duplicateSemanticTupleCandidatesDropped,
    adapterAudit.emittedCandidates,
  ];
  const buildRejectTotal = Object.values(adapterAudit.candidateBuildRejects).reduce(
    (sum, value) => sum + value,
    0,
  );
  if (
    adapterAuditNumbers.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    adapterAudit.recognizedTemporalRows > adapterAudit.inputRows ||
    adapterAudit.completeUniqueSlotPairs * 2 > adapterAudit.recognizedTemporalRows ||
    adapterAudit.expectedTemporalPairs % 2 !== 0 ||
    adapterAudit.completeUniqueSlotPairs +
      adapterAudit.slotPairDrops.missing +
      adapterAudit.slotPairDrops.duplicated !==
      adapterAudit.expectedTemporalPairs ||
    adapterAudit.candidatesBeforeSemanticDedup + buildRejectTotal !==
      adapterAudit.completeUniqueSlotPairs ||
    adapterAudit.emittedCandidates +
      adapterAudit.duplicateSemanticTupleCandidatesDropped !==
      adapterAudit.candidatesBeforeSemanticDedup ||
    adapterAudit.duplicateSemanticTupleCandidatesDropped <
      adapterAudit.duplicateSemanticTupleGroups * 2 ||
    ((adapterAudit.duplicateSemanticTupleGroups === 0) !==
      (adapterAudit.duplicateSemanticTupleCandidatesDropped === 0)) ||
    adapterAudit.emittedCandidates !== manifest.candidates.adapterCandidates
  ) {
    throw new Error("Fixture adapter audit totals are inconsistent");
  }
  if (manifest.publicCases.length === 0) throw new Error("Fixture manifest contains no cases");

  if (manifest.publicManifestFile !== "public/public-manifest.json") {
    throw new Error("Fixture public manifest must use public/public-manifest.json");
  }
  if (!/^[0-9a-f]{64}$/.test(manifest.publicManifestSha256)) {
    throw new Error("Fixture public manifest hash is malformed");
  }
  const publicManifestPath = resolveFixturePath(
    fixtureRoot,
    manifest.publicManifestFile,
    "publicManifestFile",
  );
  assertRegularFile(publicManifestPath, "public manifest");
  if (sha256File(publicManifestPath) !== manifest.publicManifestSha256) {
    throw new Error("Public manifest hash mismatch");
  }
  const publicManifest = readJson<{ schemaVersion: number; cases: unknown }>(
    publicManifestPath,
  );
  if (
    JSON.stringify(Object.keys(publicManifest).sort()) !==
      JSON.stringify(["cases", "schemaVersion"]) ||
    publicManifest.schemaVersion !== 2 ||
    JSON.stringify(publicManifest.cases) !== JSON.stringify(manifest.publicCases)
  ) {
    throw new Error("Public manifest content does not exactly match the sealed public cases");
  }
  const expectedPublicCaseKeys = [
    "evidenceSha256",
    "graphSha256",
    "projectDir",
    "publicCaseId",
    "schemaVersion",
  ];
  const publicCaseIds = manifest.publicCases.map((item) => item.publicCaseId);
  if (JSON.stringify(publicCaseIds) !== JSON.stringify(publicCaseIds.toSorted())) {
    throw new Error("Public fixture cases are not in their canonical opaque-id order");
  }
  for (const publicCase of manifest.publicCases) {
    if (
      JSON.stringify(Object.keys(publicCase).sort()) !==
      JSON.stringify(expectedPublicCaseKeys)
    ) {
      throw new Error(`Public fixture case contains unexpected fields: ${publicCase.publicCaseId}`);
    }
  }

  const privatePath = resolveFixturePath(
    fixtureRoot,
    manifest.privateCasesFile,
    "privateCasesFile",
  );
  assertRegularFile(privatePath, "private cases file");
  if (sha256File(privatePath) !== manifest.privateCasesSha256) {
    throw new Error("Private cases hash mismatch");
  }
  const privateCases = readJsonl<PreparedPrivateCase>(privatePath);
  const privateById = new Map<string, PreparedPrivateCase>();
  const evaluatorIds = new Set<string>();
  const pairIds = new Set<string>();
  for (const record of privateCases) {
    if (record.schemaVersion !== 2 || !/^case-[a-f0-9]{20}$/.test(record.publicCaseId)) {
      throw new Error(`Malformed private fixture id: ${record.publicCaseId}`);
    }
    if (privateById.has(record.publicCaseId)) {
      throw new Error(`Duplicate private fixture id: ${record.publicCaseId}`);
    }
    if (record.seed.publicCaseId !== record.publicCaseId) {
      throw new Error(`Private/public seed id mismatch: ${record.publicCaseId}`);
    }
    if (record.seed.caseId !== record.replay.id || record.seed.pairId !== record.replay.pairId) {
      throw new Error(`Evaluator replay metadata mismatch: ${record.publicCaseId}`);
    }
    const expectedTransition =
      record.replay.direction === "SUP_TO_REF"
        ? (["SUPPORTS", "REFUTES"] as const)
        : (["REFUTES", "SUPPORTS"] as const);
    const beforeId = /^(.*)_([13])$/.exec(record.replay.sourceIds?.[0] ?? "");
    const afterId = /^(.*)_([24])$/.exec(record.replay.sourceIds?.[1] ?? "");
    if (
      !record.replay.id ||
      record.replay.id !== record.replay.pairId ||
      evaluatorIds.has(record.replay.id) ||
      pairIds.has(record.replay.pairId) ||
      !record.replay.claim.trim() ||
      !record.replay.e0.trim() ||
      !record.replay.e1.trim() ||
      record.replay.e0.trim() === record.replay.e1.trim() ||
      record.replay.y0 !== expectedTransition[0] ||
      record.replay.y1 !== expectedTransition[1] ||
      !beforeId ||
      !afterId ||
      beforeId[1] !== record.replay.sourceCaseId ||
      afterId[1] !== record.replay.sourceCaseId ||
      Number(afterId[2]) !== Number(beforeId[2]) + 1
    ) {
      throw new Error(`Malformed or non-natural evaluator replay: ${record.publicCaseId}`);
    }
    evaluatorIds.add(record.replay.id);
    pairIds.add(record.replay.pairId);
    requireScoringSeed(record);
    privateById.set(record.publicCaseId, record);
  }

  const seenPublic = new Set<string>();
  const validated = manifest.publicCases.map((publicCase) => {
    if (publicCase.schemaVersion !== 2 || !/^case-[a-f0-9]{20}$/.test(publicCase.publicCaseId)) {
      throw new Error(`Malformed public fixture id: ${publicCase.publicCaseId}`);
    }
    if (seenPublic.has(publicCase.publicCaseId)) {
      throw new Error(`Duplicate public fixture id: ${publicCase.publicCaseId}`);
    }
    if (publicCase.projectDir !== join("public", publicCase.publicCaseId, "project")) {
      throw new Error(`Unexpected public project path: ${publicCase.publicCaseId}`);
    }
    seenPublic.add(publicCase.publicCaseId);
    const privateCase = privateById.get(publicCase.publicCaseId);
    if (!privateCase) throw new Error(`Missing private record: ${publicCase.publicCaseId}`);

    const projectDir = resolveFixturePath(fixtureRoot, publicCase.projectDir, "projectDir");
    if (!existsSync(projectDir) || !lstatSync(projectDir).isDirectory()) {
      throw new Error(`Fixture project is missing: ${publicCase.publicCaseId}`);
    }
    const graphPath = join(projectDir, ".toulmin", "graph.db");
    const evidencePath = join(projectDir, EVIDENCE_ATTACHMENT);
    assertRegularFile(graphPath, "fixture graph");
    assertRegularFile(evidencePath, "fixture evidence");
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${graphPath}${suffix}`)) {
        throw new Error(
          `Fixture graph is not sealed; unexpected SQLite sidecar ${suffix}: ${publicCase.publicCaseId}`,
        );
      }
    }
    if (sha256File(graphPath) !== publicCase.graphSha256) {
      throw new Error(`Fixture graph hash mismatch: ${publicCase.publicCaseId}`);
    }
    if (sha256File(evidencePath) !== publicCase.evidenceSha256) {
      throw new Error(`Fixture evidence hash mismatch: ${publicCase.publicCaseId}`);
    }
    if (readFileSync(evidencePath, "utf8") !== `${privateCase.replay.e1}\n`) {
      throw new Error(
        `Fixture evidence does not exactly match the sealed current revision: ${publicCase.publicCaseId}`,
      );
    }
    if (privateCase.seed.graphSha256 !== publicCase.graphSha256) {
      throw new Error(`Public/private graph hash mismatch: ${publicCase.publicCaseId}`);
    }
    const frozenScore = scoreFrozenFixture(
      graphPath,
      evidencePath,
      privateCase.replay,
      requireScoringSeed(privateCase),
    );
    if (
      frozenScore.agentEventIds.length !== 0 ||
      frozenScore.predictedLabel !== privateCase.replay.y0 ||
      !frozenScore.staleUse ||
      frozenScore.relationCorrect ||
      frozenScore.pendingRecheckWarningCodes.join(",") !== "R2" ||
      frozenScore.currentWarnings.filter((warning) => warning.state === "pending").length !== 1 ||
      !frozenScore.protocolValid
    ) {
      throw new Error(`Fixture graph is not at the sealed stale-boundary state: ${publicCase.publicCaseId}`);
    }
    return { publicCase, privateCase, projectDir, graphPath, evidencePath };
  });

  if (privateById.size !== seenPublic.size) {
    const extra = [...privateById.keys()].find((id) => !seenPublic.has(id));
    throw new Error(`Private fixture has no public counterpart: ${String(extra)}`);
  }
  const replays = [...privateById.values()].map((record) => record.replay);
  const uniqueClusters = new Set(replays.map((item) => item.sourceCaseId));
  const selectedSup = replays.filter((item) => item.direction === "SUP_TO_REF").length;
  const selectedRef = replays.filter((item) => item.direction === "REF_TO_SUP").length;
  if (
    replays.some((item) => item.revisionType !== "real") ||
    uniqueClusters.size !== replays.length ||
    selectedSup !== manifest.selection.perDirection ||
    selectedRef !== manifest.selection.perDirection
  ) {
    throw new Error("Fixture cases violate the formal population, balance, or cluster contract");
  }
  if (
    manifest.selectedCounts.total !== replays.length ||
    manifest.selectedCounts.uniqueSourceCaseIds !== replays.length ||
    manifest.selectedCounts.byDirection.SUP_TO_REF !== selectedSup ||
    manifest.selectedCounts.byDirection.REF_TO_SUP !== selectedRef ||
    Object.keys(manifest.selectedCounts.byRevisionType).length !== 1 ||
    manifest.selectedCounts.byRevisionType.real !== replays.length ||
    manifest.selectedCounts.total !== manifest.selection.perDirection * 2 ||
    manifest.candidates.eligibleSourceCaseIds <
      manifest.selectedCounts.uniqueSourceCaseIds ||
    manifest.candidates.eligibleByDirection.SUP_TO_REF < selectedSup ||
    manifest.candidates.eligibleByDirection.REF_TO_SUP < selectedRef
  ) {
    throw new Error("Fixture selectedCounts do not match the sealed private cases");
  }
  return validated;
}

/**
 * Rebuild the formal population from the pinned source files. This is kept
 * outside the synchronous fixture validator so portable dry-runs and the test
 * harness do not need access to the original evaluator-only datasets.
 */
export async function validateOfficialSourceContract(
  manifest: PreparedManifest,
  fixtureRoot: string,
): Promise<void> {
  if (
    manifest.selection.seed !== FORMAL_PILOT_SEED ||
    manifest.selection.perDirection !== FORMAL_PILOT_PER_DIRECTION
  ) {
    throw new Error(
      `Formal VitaminC pilot selection is pinned to seed=${FORMAL_PILOT_SEED} ` +
        `and perDirection=${FORMAL_PILOT_PER_DIRECTION}`,
    );
  }
  assertPinnedOfficialDataset(manifest, true);
  const adapterResult = await loadNaturalDirectionReplaysWithAudit(
    manifest.dataset.factVerificationPath,
  );
  const flaggingRows = await loadFlaggingRows(manifest.dataset.flaggingPath);
  const validation = validateNaturalRealCandidates(
    adapterResult.cases,
    flaggingRows,
  );

  if (!isDeepStrictEqual(manifest.adapterAudit, adapterResult.audit)) {
    throw new Error("Fixture adapter audit does not match the pinned official source");
  }
  if (!isDeepStrictEqual(manifest.candidates, validation.audit)) {
    throw new Error("Fixture candidate audit does not match the pinned official source");
  }

  const eligibleById = new Map<string, ReplayCase>();
  for (const item of validation.eligible) {
    if (eligibleById.has(item.id)) {
      throw new Error(`Pinned official source produced a duplicate replay id: ${item.id}`);
    }
    eligibleById.set(item.id, item);
  }
  const expectedSelected = selectDirectionalCases(
    validation.eligible,
    manifest.selection.perDirection,
    manifest.selection.seed,
  );
  const expectedRecords = expectedSelected
    .map((replay, index) => ({
      publicCaseId: opaqueCaseId(manifest.selection.seed, index, replay),
      replay,
    }))
    .toSorted((left, right) =>
      left.publicCaseId < right.publicCaseId
        ? -1
        : left.publicCaseId > right.publicCaseId
          ? 1
          : 0,
    );
  if (
    new Set(expectedRecords.map((record) => record.publicCaseId)).size !==
    expectedRecords.length
  ) {
    throw new Error("Pinned official selection produced duplicate opaque ids");
  }
  if (
    !isDeepStrictEqual(
      manifest.publicCases.map((item) => item.publicCaseId),
      expectedRecords.map((item) => item.publicCaseId),
    )
  ) {
    throw new Error("Public opaque ids do not match the pinned seeded selection");
  }

  const privatePath = resolveFixturePath(
    fixtureRoot,
    manifest.privateCasesFile,
    "privateCasesFile",
  );
  assertRegularFile(privatePath, "private cases file");
  if (sha256File(privatePath) !== manifest.privateCasesSha256) {
    throw new Error("Private cases hash mismatch during official-source verification");
  }
  const privateCases = readJsonl<PreparedPrivateCase>(privatePath);
  if (privateCases.length !== expectedRecords.length) {
    throw new Error(
      "Sealed private replay count does not match the pinned official selection",
    );
  }
  for (const [index, record] of privateCases.entries()) {
    const eligible = eligibleById.get(record.replay.id);
    if (!eligible || !isDeepStrictEqual(record.replay, eligible)) {
      throw new Error(
        `Sealed replay is not an exact eligible official row: ${record.publicCaseId}`,
      );
    }
    const expected = expectedRecords[index]!;
    if (
      record.publicCaseId !== expected.publicCaseId ||
      !isDeepStrictEqual(record.replay, expected.replay)
    ) {
      throw new Error(
        `Sealed replay/public-id mapping is not the pinned seeded selection: ${record.publicCaseId}`,
      );
    }

    const publicCase = manifest.publicCases[index]!;
    const projectDir = resolveFixturePath(
      fixtureRoot,
      publicCase.projectDir,
      "official fixture projectDir",
    );
    const graphPath = join(projectDir, ".toulmin", "graph.db");
    const evidencePath = join(projectDir, EVIDENCE_ATTACHMENT);
    const reconstructed = reconstructExpectedFixture(
      expected.replay,
      expected.publicCaseId,
    );
    if (readFileSync(evidencePath, "utf8") !== reconstructed.evidence) {
      throw new Error(
        `Public evidence is not the exact pinned current revision: ${record.publicCaseId}`,
      );
    }
    if (
      !isDeepStrictEqual(
        semanticSnapshotOfSealedFixture(graphPath, evidencePath),
        reconstructed.graph,
      )
    ) {
      throw new Error(
        `Public graph is not the exact seeded semantic fixture: ${record.publicCaseId}`,
      );
    }
    const { graphSha256: _sealedGraphSha256, ...sealedSeed } = record.seed;
    if (!isDeepStrictEqual(sealedSeed, reconstructed.seed)) {
      throw new Error(
        `Private scoring seed is not the exact reconstructed seed: ${record.publicCaseId}`,
      );
    }
  }

  // Detect a source rewrite racing the streaming reconstruction above.
  assertPinnedOfficialDataset(manifest, true);
}

export function selectValidatedFixtures(
  fixtures: ValidatedFixture[],
  selectedIds: readonly string[],
  limit: number | null,
): ValidatedFixture[] {
  const duplicates = selectedIds.filter((id, index) => selectedIds.indexOf(id) !== index);
  if (duplicates.length > 0) throw new Error(`Duplicate --case id: ${duplicates[0]}`);
  const byId = new Map(fixtures.map((fixture) => [fixture.publicCase.publicCaseId, fixture]));
  const selected = selectedIds.length > 0
    ? selectedIds.map((id) => {
        const fixture = byId.get(id);
        if (!fixture) throw new Error(`Unknown fixture case: ${id}`);
        return fixture;
      })
    : [...fixtures];
  if (limit === null || limit >= selected.length) return selected;
  if (selectedIds.length > 0) return selected.slice(0, limit);
  if (limit % 2 !== 0) {
    throw new Error(
      "--limit must be even so an automatic pilot remains balanced by direction; use explicit --case for a one-case smoke test",
    );
  }
  const perDirection = limit / 2;
  const counts: Record<ReplayDirection, number> = {
    SUP_TO_REF: 0,
    REF_TO_SUP: 0,
  };
  const balanced = selected.filter((fixture) => {
    const direction = fixture.privateCase.replay.direction;
    if (counts[direction] >= perDirection) return false;
    counts[direction] += 1;
    return true;
  });
  if (balanced.length !== limit) {
    throw new Error(
      `Cannot build a balanced --limit ${limit} pilot from the selected fixtures`,
    );
  }
  return balanced;
}

function sealDatabase(path: string): void {
  const db = new Database(path);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    db.close();
  }
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

function copyPreparedDatabase(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${source}${suffix}`)) {
      throw new Error(`Refusing unsealed source database sidecar: ${source}${suffix}`);
    }
    rmSync(`${destination}${suffix}`, { force: true });
  }
  copyFileSync(source, destination);
  sealDatabase(destination);
}

/** Pair stream-json call/result records. Missing or explicitly errored results fail. */
export function normalizeRuntimeTrace(trace: readonly AgentToolTraceEntry[]): RecordedToolCall[] {
  const results = new Map<string, AgentToolTraceEntry[]>();
  const callCounts = new Map<string, number>();
  for (const entry of trace) {
    if (entry.kind === "result") {
      const values = results.get(entry.toolUseId) ?? [];
      values.push(entry);
      results.set(entry.toolUseId, values);
    } else {
      callCounts.set(entry.toolUseId, (callCounts.get(entry.toolUseId) ?? 0) + 1);
    }
  }
  return trace
    .filter((entry) => entry.kind === "call" && typeof entry.toolName === "string")
    .map((entry) => {
      const matched = results.get(entry.toolUseId) ?? [];
      const result = matched[0];
      return {
        name: entry.toolName!,
        input: entry.input,
        streamIndex: entry.streamIndex,
        success:
          callCounts.get(entry.toolUseId) === 1 &&
          matched.length === 1 &&
          result!.streamIndex > entry.streamIndex &&
          result!.isError !== true,
      };
    });
}

function versionToken(value: string | null): string | null {
  return value?.match(/\b\d+(?:\.\d+){1,3}(?:[-+][a-z0-9.-]+)?\b/i)?.[0] ?? null;
}

function validOptionalReportedCost(value: number | null, maxBudgetUsd: number): boolean {
  return value === null || (Number.isFinite(value) && value >= 0 && value <= maxBudgetUsd);
}

function validOptionalReportedTurns(value: number | null, maxTurns: number): boolean {
  return value === null || (Number.isSafeInteger(value) && value >= 0 && value <= maxTurns);
}

function malformedRawReportedNumber(field: { present: boolean; value: unknown }): boolean {
  return (
    field.present &&
    field.value !== null &&
    (typeof field.value !== "number" || !Number.isFinite(field.value))
  );
}

function sanitizedReportedCost(value: number | null, maxBudgetUsd: number): number | null {
  return value !== null && validOptionalReportedCost(value, maxBudgetUsd) ? value : null;
}

function sanitizedReportedTurns(value: number | null, maxTurns: number): number | null {
  return value !== null && validOptionalReportedTurns(value, maxTurns) ? value : null;
}

function runtimeFailure(
  result: VitaminCAgentRunResult,
  expectedClaudeCliVersion: string | null,
  maxBudgetUsd: number,
  maxTurns: number,
  acceptedModelIds?: readonly string[],
): ProcessFailure | null {
  if (malformedRawReportedNumber(result.rawReportedUsage.totalCostUsd)) {
    return {
      kind: "invalid_output",
      message: `invalid reported cost type/value: ${String(result.rawReportedUsage.totalCostUsd.value)}`,
    };
  }
  if (malformedRawReportedNumber(result.rawReportedUsage.numTurns)) {
    return {
      kind: "invalid_output",
      message: `invalid reported turn count type/value: ${String(result.rawReportedUsage.numTurns.value)}`,
    };
  }
  if (!validOptionalReportedCost(result.usage.totalCostUsd, maxBudgetUsd)) {
    return {
      kind: "invalid_output",
      message:
        `invalid or over-budget reported cost: ${String(result.usage.totalCostUsd)} ` +
        `(cap=${maxBudgetUsd})`,
    };
  }
  if (!validOptionalReportedTurns(result.usage.numTurns, maxTurns)) {
    return {
      kind: "invalid_output",
      message:
        `invalid or over-limit reported turn count: ${String(result.usage.numTurns)} ` +
        `(allowed=0..${maxTurns} for failed runs)`,
    };
  }
  if (result.status === "success") {
    const acceptedModels = new Set(
      acceptedModelIds && acceptedModelIds.length > 0
        ? acceptedModelIds
        : [result.requestedModel],
    );
    const allowCompatibleFamilyAlias = Boolean(
      acceptedModelIds && acceptedModelIds.length > 0,
    );
    const modelAccepted = (actual: string): boolean =>
      acceptedModels.has(actual) ||
      (allowCompatibleFamilyAlias &&
        [...acceptedModels].some(
          (configured) =>
            !configured.includes("[") &&
            actual.startsWith(`${configured}-`) &&
            /^[a-z0-9][a-z0-9-]{0,63}$/i.test(actual.slice(configured.length + 1)),
        ));
    if (
      result.actualModels.length === 0 ||
      result.actualModels.some((model) => !modelAccepted(model))
    ) {
      return {
        kind: "invalid_output",
        message:
          `model provenance mismatch: requested=${result.requestedModel}, ` +
          `accepted=${[...acceptedModels].join(",")}, ` +
          `actual=${result.actualModels.join(",") || "missing"}`,
      };
    }
    if (result.usage.totalCostUsd === null) {
      return {
        kind: "invalid_output",
        message:
          `invalid or over-budget reported cost: ${String(result.usage.totalCostUsd)} ` +
          `(cap=${maxBudgetUsd})`,
      };
    }
    if (result.usage.numTurns === null || result.usage.numTurns < 1) {
      return {
        kind: "invalid_output",
        message:
          `invalid or over-limit reported turn count: ${String(result.usage.numTurns)} ` +
          `(cap=${maxTurns})`,
      };
    }
    if (
      expectedClaudeCliVersion !== null &&
      (versionToken(result.claudeCodeVersion) === null ||
        versionToken(result.claudeCodeVersion) !== versionToken(expectedClaudeCliVersion))
    ) {
      return {
        kind: "invalid_output",
        message:
          `Claude Code version mismatch: startup=${expectedClaudeCliVersion}, ` +
          `stream=${result.claudeCodeVersion ?? "missing"}`,
      };
    }
    return null;
  }
  const direct: Partial<Record<AgentRunStatus, ProcessFailureKind>> = {
    spawn_failure: "spawn_failure",
    timeout: "timeout",
    max_turns: "max_turns",
    invalid_output: "invalid_output",
    artifact_failure: "artifact_failure",
    agent_error: "agent_error",
    nonzero_exit: "nonzero_exit",
  };
  const detail = result.failureDetail ?? "";
  let kind: ProcessFailureKind;
  if (/auth|login|credential|api.?key|unauthorized|forbidden/i.test(detail)) {
    kind = "auth_failure";
  } else if (/mcp|server.*(?:failed|error|disconnect)|unexpected tool surface/i.test(detail)) {
    kind = "mcp_failure";
  } else {
    kind = direct[result.status] ?? "unknown";
  }
  return { kind, ...(detail ? { message: detail } : {}) };
}

function caseProcess(
  live: boolean,
  effort: ClaudeEffort,
  model: string | null,
  runtime: VitaminCAgentRunResult | null,
  runnerError: string | null,
  expectedClaudeCliVersion: string | null,
  maxBudgetUsd: number,
  maxTurns: number,
  acceptedModelIds?: readonly string[],
): CaseProcessRecord {
  if (!live) {
    return {
      attempted: false,
      status: "not_attempted",
      completed: false,
      exitCode: null,
      failure: null,
      requestedModel: null,
      actualModel: null,
      actualModels: [],
      claudeCodeVersion: null,
      effort: null,
      durationMs: 0,
      totalCostUsd: null,
      inputTokens: null,
      outputTokens: null,
      numTurns: null,
    };
  }
  if (!runtime) {
    return {
      attempted: true,
      status: "runner_error",
      completed: false,
      exitCode: null,
      failure: { kind: "unknown", ...(runnerError ? { message: runnerError } : {}) },
      requestedModel: model,
      actualModel: null,
      actualModels: [],
      claudeCodeVersion: null,
      effort,
      durationMs: 0,
      totalCostUsd: null,
      inputTokens: null,
      outputTokens: null,
      numTurns: null,
    };
  }
  const totalCostUsd = sanitizedReportedCost(runtime.usage.totalCostUsd, maxBudgetUsd);
  const numTurns = sanitizedReportedTurns(runtime.usage.numTurns, maxTurns);
  if (runnerError) {
    return {
      attempted: true,
      status: "runner_error",
      completed: false,
      exitCode: runtime.exitCode,
      failure: { kind: "unknown", message: runnerError },
      requestedModel: runtime.requestedModel,
      actualModel: runtime.actualModel,
      actualModels: runtime.actualModels,
      claudeCodeVersion: runtime.claudeCodeVersion,
      effort: runtime.effort,
      durationMs: runtime.durationMs,
      totalCostUsd,
      inputTokens: runtime.usage.inputTokens,
      outputTokens: runtime.usage.outputTokens,
      numTurns,
    };
  }
  const failure = runtimeFailure(
    runtime,
    expectedClaudeCliVersion,
    maxBudgetUsd,
    maxTurns,
    acceptedModelIds,
  );
  return {
    attempted: true,
    status: failure?.kind === "invalid_output" ? "invalid_output" : runtime.status,
    completed: failure === null,
    exitCode: runtime.exitCode,
    failure,
    requestedModel: runtime.requestedModel,
    actualModel: runtime.actualModel,
    actualModels: runtime.actualModels,
    claudeCodeVersion: runtime.claudeCodeVersion,
    effort: runtime.effort,
    durationMs: runtime.durationMs,
    totalCostUsd,
    inputTokens: runtime.usage.inputTokens,
    outputTokens: runtime.usage.outputTokens,
    numTurns,
  };
}

function rate<T>(rows: readonly T[], predicate: (row: T) => boolean): number | null {
  if (rows.length === 0) return null;
  return rows.filter(predicate).length / rows.length;
}

type RunCompletionStatus = "aborted" | "complete_with_failures" | "complete";

export function resultAnalysisDisposition(input: {
  live: boolean;
  testHarness: boolean;
  externalProviderDiagnostic?: boolean;
  status: RunCompletionStatus;
  fullFormalSelection: boolean;
}): {
  primaryResultsAvailable: boolean;
  partialLiveDiagnosticsAvailable: boolean;
  analysisStatus:
    | "incomplete-not-for-primary-analysis"
    | "test-harness-not-for-primary-analysis"
    | "external-provider-diagnostic-not-for-primary-analysis"
    | "dry-run-only"
    | "partial-live-not-for-primary-analysis"
    | "complete-live-with-process-failures"
    | "complete-live";
} {
  const {
    live,
    testHarness,
    externalProviderDiagnostic = false,
    status,
    fullFormalSelection,
  } = input;
  const primaryResultsAvailable =
    live &&
    !testHarness &&
    !externalProviderDiagnostic &&
    status !== "aborted" &&
    fullFormalSelection;
  const partialLiveDiagnosticsAvailable =
    live &&
    !testHarness &&
    (externalProviderDiagnostic || status === "aborted" || !fullFormalSelection);
  const analysisStatus =
    status === "aborted"
      ? "incomplete-not-for-primary-analysis"
      : testHarness
        ? "test-harness-not-for-primary-analysis"
        : externalProviderDiagnostic
          ? "external-provider-diagnostic-not-for-primary-analysis"
        : !live
          ? "dry-run-only"
          : !fullFormalSelection
            ? "partial-live-not-for-primary-analysis"
            : status === "complete_with_failures"
              ? "complete-live-with-process-failures"
              : "complete-live";
  return { primaryResultsAvailable, partialLiveDiagnosticsAvailable, analysisStatus };
}

function sumKnown(rows: readonly CaseProcessRecord[], key: "totalCostUsd" | "inputTokens" | "outputTokens"): number | null {
  const values = rows.map((row) => row[key]).filter((value): value is number => value !== null);
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
}

function summarizeRows(rows: readonly VitaminCCaseResult[]) {
  const processes = rows.map((row) => row.process);
  const attempted = rows.filter((row) => row.process.attempted);
  const completed = rows.filter((row) => row.process.completed);
  const failureKinds: Record<string, number> = {};
  for (const row of rows) {
    const kind = row.process.failure?.kind;
    if (kind) failureKinds[kind] = (failureKinds[kind] ?? 0) + 1;
  }
  return {
    n: rows.length,
    attemptedN: attempted.length,
    completedN: completed.length,
    processAttemptRate: rate(rows, (row) => row.process.attempted),
    processCompletionRate: rate(attempted, (row) => row.process.completed),
    autonomousSuccessRate: rate(rows, (row) => row.score.autonomousSuccess),
    labelAccuracy: rate(rows, (row) => row.score.labelCorrect),
    staleUseRate: rate(rows, (row) => row.score.staleUse),
    relationAccuracy: rate(rows, (row) => row.score.relationCorrect),
    qualifierRebaselineRate: rate(rows, (row) => row.score.rebaselined),
    warningReadRate: rate(rows, (row) => row.score.warningReadTraceObserved),
    contextReadBeforeWriteRate: rate(rows, (row) => row.score.contextReadBeforeFirstWrite),
    warningsHandledRate: rate(rows, (row) => row.score.recheckWarningsHandled),
    structuralWarningsHandledRate: rate(rows, (row) => row.score.structuralWarningsHandled),
    pendingWarningRate: rate(rows, (row) => row.score.warningPendingAfterAgent),
    protocolViolationRate: rate(rows, (row) => !row.score.protocolValid),
    completedRuns: {
      n: completed.length,
      autonomousSuccessRate: rate(completed, (row) => row.score.autonomousSuccess),
      labelAccuracy: rate(completed, (row) => row.score.labelCorrect),
      staleUseRate: rate(completed, (row) => row.score.staleUse),
      relationAccuracy: rate(completed, (row) => row.score.relationCorrect),
      structuralWarningsHandledRate: rate(
        completed,
        (row) => row.score.structuralWarningsHandled,
      ),
    },
    durationMs: processes.reduce((sum, row) => sum + row.durationMs, 0),
    totalCostUsd: sumKnown(processes, "totalCostUsd"),
    inputTokens: sumKnown(processes, "inputTokens"),
    outputTokens: sumKnown(processes, "outputTokens"),
    usageCoverage: {
      costKnownN: processes.filter((row) => row.totalCostUsd !== null).length,
      inputTokensKnownN: processes.filter((row) => row.inputTokens !== null).length,
      outputTokensKnownN: processes.filter((row) => row.outputTokens !== null).length,
    },
    failures: failureKinds,
  };
}

function noMaintenanceBaseline(items: readonly ReplayCase[]) {
  const groups = Object.fromEntries(
    (["SUP_TO_REF", "REF_TO_SUP"] as const).map((direction) => {
      const rows = items.filter((item) => item.direction === direction);
      return [direction, {
        n: rows.length,
        labelAccuracy: rate(rows, (item) => item.y0 === item.y1),
        staleUseRate: rate(rows, (item) => item.y0 !== item.y1),
        relationAccuracy: rate(rows, (item) => item.y0 === item.y1),
        pendingWarningRate: rows.length === 0 ? null : 1,
      }];
    }),
  );
  return { overall: {
    n: items.length,
    labelAccuracy: rate(items, (item) => item.y0 === item.y1),
    staleUseRate: rate(items, (item) => item.y0 !== item.y1),
    relationAccuracy: rate(items, (item) => item.y0 === item.y1),
    pendingWarningRate: items.length === 0 ? null : 1,
  }, byDirection: groups };
}

function systemicFailure(result: VitaminCCaseResult, index: number): boolean {
  if (!result.process.attempted || result.process.completed) return false;
  if (index === 0) return true;
  return new Set<ProcessFailureKind>([
    "spawn_failure",
    "auth_failure",
    "invalid_output",
    "mcp_failure",
    "artifact_failure",
    "agent_error",
    "nonzero_exit",
    "unknown",
  ]).has(result.process.failure?.kind ?? "unknown");
}

async function executeCase(
  fixture: ValidatedFixture,
  options: RunOptions,
  expectedClaudeCliVersion: string | null,
): Promise<VitaminCCaseResult> {
  const publicId = fixture.publicCase.publicCaseId;
  // Revalidate immutable inputs immediately before every process start.
  if (sha256File(fixture.graphPath) !== fixture.publicCase.graphSha256) {
    throw new Error(`Fixture graph changed before execution: ${publicId}`);
  }
  if (sha256File(fixture.evidencePath) !== fixture.publicCase.evidenceSha256) {
    throw new Error(`Fixture evidence changed before execution: ${publicId}`);
  }

  const caseDir = join(options.runDir, "cases", publicId);
  mkdirSync(caseDir, { recursive: true });
  const beforePath = join(caseDir, "graph-before-agent.json");
  const afterPath = join(caseDir, "graph-after-agent.json");
  const scorePath = join(caseDir, "score.json");
  const stagedGraph = join(caseDir, "sealed-input", "graph.db");
  const evidenceOut = join(caseDir, EVIDENCE_ATTACHMENT);
  mkdirSync(dirname(stagedGraph), { recursive: true });
  mkdirSync(dirname(evidenceOut), { recursive: true });
  copyFileSync(fixture.graphPath, stagedGraph);
  copyFileSync(fixture.evidencePath, evidenceOut);
  if (sha256File(stagedGraph) !== fixture.publicCase.graphSha256) {
    throw new Error(`Staged graph hash mismatch: ${publicId}`);
  }
  if (sha256File(evidenceOut) !== fixture.publicCase.evidenceSha256) {
    throw new Error(`Staged evidence hash mismatch: ${publicId}`);
  }
  const inspectionDir = join(caseDir, ".sealed-input-inspection");
  const inspectionGraph = join(inspectionDir, "graph.db");
  mkdirSync(inspectionDir, { recursive: true });
  copyFileSync(stagedGraph, inspectionGraph);
  try {
    writeJson(beforePath, dumpGraph(inspectionGraph));
  } finally {
    rmSync(inspectionDir, { recursive: true, force: true });
  }

  let runtime: VitaminCAgentRunResult | null = null;
  let runnerError: string | null = null;
  const finalDatabase = join(caseDir, ".toulmin", "graph.db");
  if (options.live) {
    try {
      runtime = await runVitaminCAgent({
        preparedDatabasePath: stagedGraph,
        artifactDir: caseDir,
        pluginRoot: REPO_ROOT,
        model: options.model!,
        effort: options.effort,
        maxTurns: options.maxTurns,
        timeoutMs: options.timeoutMs,
        maxBudgetUsd: options.maxBudgetUsd,
        executable: options.executable,
        env: options.diagnosticEnvironment ?? undefined,
        allowCompatibleModel: options.externalProviderDiagnostic,
        attachments: [{ sourcePath: evidenceOut, relativePath: EVIDENCE_ATTACHMENT }],
      });
    } catch (error) {
      runnerError = safeError(error);
      if (!existsSync(finalDatabase)) copyPreparedDatabase(stagedGraph, finalDatabase);
    }
  } else {
    copyPreparedDatabase(stagedGraph, finalDatabase);
  }
  if (!existsSync(finalDatabase)) {
    copyPreparedDatabase(stagedGraph, finalDatabase);
  } else {
    try {
      sealDatabase(finalDatabase);
    } catch (error) {
      const preserved = join(caseDir, "agent-output-unreadable", "graph.db");
      mkdirSync(dirname(preserved), { recursive: true });
      copyFileSync(finalDatabase, preserved);
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(`${finalDatabase}${suffix}`)) {
          copyFileSync(`${finalDatabase}${suffix}`, `${preserved}${suffix}`);
        }
      }
      runnerError = [runnerError, `unreadable agent database preserved: ${safeError(error)}`]
        .filter(Boolean)
        .join("; ");
      copyPreparedDatabase(stagedGraph, finalDatabase);
    }
  }

  const processRecord = caseProcess(
    options.live,
    options.effort,
    options.model,
    runtime,
    runnerError,
    expectedClaudeCliVersion,
    options.maxBudgetUsd,
    options.maxTurns,
    options.externalProviderDiagnostic ? options.diagnosticAcceptedModelIds : undefined,
  );
  const seed = requireScoringSeed(fixture.privateCase);
  const score = scoreVitaminCCase({
    dbPath: finalDatabase,
    item: fixture.privateCase.replay,
    seed,
    process: {
      attempted: processRecord.attempted,
      exitCode: processRecord.exitCode,
      failure: processRecord.failure,
    },
    trace: { toolCalls: normalizeRuntimeTrace(runtime?.toolTrace ?? []) },
  });
  writeJson(afterPath, dumpGraph(finalDatabase));
  writeJson(scorePath, score);
  sealDatabase(finalDatabase);
  const agentRuntimeArtifacts = runtime
    ? {
        stdout: optionalSealedArtifact(runtime.artifacts.stdoutPath, options.runDir),
        stderr: optionalSealedArtifact(runtime.artifacts.stderrPath, options.runDir),
        toolTrace: optionalSealedArtifact(runtime.artifacts.toolTracePath, options.runDir),
        answer: optionalSealedArtifact(runtime.artifacts.answerPath, options.runDir),
        process: optionalSealedArtifact(runtime.artifacts.processPath, options.runDir),
      }
    : null;
  if (
    processRecord.completed &&
    (!agentRuntimeArtifacts || Object.values(agentRuntimeArtifacts).some((item) => item === null))
  ) {
    throw new Error(`Completed agent run has an incomplete raw artifact set: ${publicId}`);
  }

  return {
    schemaVersion: 2,
    publicCaseId: publicId,
    evaluatorCaseId: fixture.privateCase.replay.id,
    pairId: fixture.privateCase.replay.pairId,
    direction: fixture.privateCase.replay.direction,
    transition: score.transition,
    revisionType: fixture.privateCase.replay.revisionType ?? null,
    process: processRecord,
    score,
    artifacts: {
      caseDir: relative(options.runDir, caseDir),
      graphBefore: relative(options.runDir, beforePath),
      graphAfter: relative(options.runDir, afterPath),
      finalDatabase: relative(options.runDir, finalDatabase),
      finalDatabaseSha256: sha256File(finalDatabase),
      evidenceSha256: sha256File(evidenceOut),
      score: relative(options.runDir, scorePath),
      scoreSha256: sha256File(scorePath),
      graphBeforeSha256: sha256File(beforePath),
      graphAfterSha256: sha256File(afterPath),
      agentRuntime: agentRuntimeArtifacts,
    },
  };
}

function parseOptions(argv: string[]): { help: boolean; options?: RunOptions } {
  const { values } = parseArgs({
    args: argv,
    options: {
      fixtures: { type: "string" },
      case: { type: "string", multiple: true, default: [] },
      limit: { type: "string" },
      "run-dir": { type: "string" },
      live: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      model: { type: "string" },
      effort: { type: "string", default: "max" },
      "max-turns": { type: "string", default: "12" },
      timeout: { type: "string", default: "600" },
      "max-budget-usd": { type: "string", default: String(DEFAULT_MAX_BUDGET_USD) },
      "max-total-budget-usd": {
        type: "string",
        default: String(DEFAULT_MAX_TOTAL_BUDGET_USD),
      },
      "claude-path": { type: "string" },
      "claude-sha256": { type: "string" },
      "diagnostic-settings": { type: "string" },
      "test-executable": { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) return { help: true };
  if (!values.fixtures) throw new Error("--fixtures is required");
  if (!EFFORTS.has(values.effort as ClaudeEffort)) {
    throw new Error(`--effort must be one of ${[...EFFORTS].join(", ")}`);
  }
  const live = values.live;
  const diagnosticSettings = values["diagnostic-settings"]
    ? loadExternalProviderDiagnosticSettings(values["diagnostic-settings"])
    : null;
  if (diagnosticSettings && !live) {
    throw new Error("--diagnostic-settings requires --live");
  }
  if (diagnosticSettings && values.model) {
    throw new Error("--model is read from --diagnostic-settings and must not be supplied separately");
  }
  if (live && !values.model && !diagnosticSettings) {
    throw new Error("--model is required with --live");
  }
  if (values["test-executable"] && process.env.VITAMINC_TEST_MODE !== "1") {
    throw new Error("--test-executable is available only to the deterministic test harness");
  }
  if (values["test-executable"] && !live) {
    throw new Error("--test-executable requires --live");
  }
  if (values["test-executable"] && basename(values["test-executable"]) === "claude") {
    throw new Error("The deterministic test executable must not be named claude");
  }
  if (values["test-executable"] && values["claude-path"]) {
    throw new Error("--test-executable and --claude-path are mutually exclusive");
  }
  if (values["test-executable"] && diagnosticSettings) {
    throw new Error("--test-executable and --diagnostic-settings are mutually exclusive");
  }
  if (values["claude-sha256"] !== undefined && !/^[0-9a-f]{64}$/.test(values["claude-sha256"])) {
    throw new Error("--claude-sha256 must be exactly 64 lowercase hexadecimal characters");
  }
  const limit = values.limit === undefined ? null : positiveInteger("--limit", values.limit);
  const runDir = resolve(
    values["run-dir"] ?? join(DEFAULT_RUN_ROOT, `run-${timestampId()}`),
  );
  const maxBudgetUsd = positiveNumber(
    "--max-budget-usd",
    values["max-budget-usd"],
    DEFAULT_MAX_BUDGET_USD,
  );
  if (maxBudgetUsd > MAX_PER_CASE_BUDGET_USD) {
    throw new Error(
      `--max-budget-usd cannot exceed the production hard cap of ${MAX_PER_CASE_BUDGET_USD}`,
    );
  }
  return {
    help: false,
    options: {
      fixtureManifestPath: resolve(values.fixtures),
      selectedIds: values.case,
      limit,
      live,
      all: values.all,
      model: diagnosticSettings?.model ?? values.model ?? null,
      effort: values.effort as ClaudeEffort,
      maxTurns: positiveInteger("--max-turns", values["max-turns"], 12),
      timeoutMs: positiveInteger("--timeout", values.timeout, 600) * 1000,
      maxBudgetUsd,
      maxTotalBudgetUsd: positiveNumber(
        "--max-total-budget-usd",
        values["max-total-budget-usd"],
        DEFAULT_MAX_TOTAL_BUDGET_USD,
      ),
      runDir,
      executable: values["test-executable"] ?? values["claude-path"] ?? "claude",
      expectedClaudeCliSha256: values["claude-sha256"] ?? null,
      testHarness: Boolean(values["test-executable"]),
      externalProviderDiagnostic: diagnosticSettings !== null,
      diagnosticSettingsPath: diagnosticSettings?.path ?? null,
      diagnosticSettingsFingerprintSha256: diagnosticSettings?.sha256 ?? null,
      diagnosticEndpointOrigin: diagnosticSettings?.endpointOrigin ?? null,
      diagnosticEnvironment: diagnosticSettings?.environment ?? null,
      diagnosticEnvironmentKeys: diagnosticSettings?.environmentKeys ?? [],
      diagnosticIgnoredTopLevelKeys: diagnosticSettings?.ignoredTopLevelKeys ?? [],
      diagnosticIgnoredEnvironmentKeys: diagnosticSettings?.ignoredEnvironmentKeys ?? [],
      diagnosticAcceptedModelIds: diagnosticSettings?.acceptedModelIds ?? [],
    },
  };
}

async function main(argv = Bun.argv.slice(2)): Promise<void> {
  const parsed = parseOptions(argv);
  if (parsed.help) {
    console.log(usage());
    return;
  }
  const options = parsed.options!;
  assertRegularFile(options.fixtureManifestPath, "fixture manifest");
  const fixtureManifestSha256 = sha256File(options.fixtureManifestPath);
  const fixtureManifest = readJson<PreparedManifest>(options.fixtureManifestPath);
  const fixtureRoot = dirname(options.fixtureManifestPath);
  const formalLive =
    options.live && !options.testHarness && !options.externalProviderDiagnostic;
  const fixtures = validatePreparedFixtures(fixtureManifest, fixtureRoot, {
    requireDatasetFiles: formalLive,
  });
  const selected = selectValidatedFixtures(fixtures, options.selectedIds, options.limit);
  if (selected.length === 0) throw new Error("No fixture cases selected");
  if (
    options.live &&
    selected.length * options.maxBudgetUsd > options.maxTotalBudgetUsd
  ) {
    throw new Error(
      `Worst-case batch spend $${(selected.length * options.maxBudgetUsd).toFixed(2)} ` +
        `exceeds --max-total-budget-usd $${options.maxTotalBudgetUsd.toFixed(2)}`,
    );
  }
  const currentRepository = currentRepositoryState();
  if (
    options.live &&
    !options.testHarness &&
    !options.externalProviderDiagnostic &&
    (fixtureManifest.repository.commit === null ||
      fixtureManifest.repository.dirty !== false ||
      currentRepository.dirty !== false ||
      currentRepository.commit !== fixtureManifest.repository.commit)
  ) {
    throw new Error(
      "Live evaluation requires fixtures prepared from a clean, committed repository; commit the implementation and prepare the fixtures again",
    );
  }
  if (formalLive && options.expectedClaudeCliSha256 === null) {
    throw new Error(
      "Formal live evaluation requires a pre-registered --claude-sha256 digest",
    );
  }
  if (formalLive) {
    await validateOfficialSourceContract(fixtureManifest, fixtureRoot);
  }
  const selectsAllFixtures = selected.length === fixtures.length;
  const fullFormalSelection =
    selectsAllFixtures &&
    selected.every(
      (fixture, index) =>
        fixture.publicCase.publicCaseId === fixtures[index]!.publicCase.publicCaseId,
    );
  if (
    options.live &&
    !options.all &&
    (selectsAllFixtures || selected.length > MAX_UNCONFIRMED_LIVE_CASES)
  ) {
    throw new Error(
      `A live run selecting all fixtures or more than ${MAX_UNCONFIRMED_LIVE_CASES} cases requires --all`,
    );
  }
  if (options.live && selectsAllFixtures && !fullFormalSelection) {
    throw new Error(
      "A full-corpus live run must preserve the sealed public-manifest case order",
    );
  }
  const childEnvironment = buildVitaminCChildEnvironment(
    options.diagnosticEnvironment ?? undefined,
  );
  const provider =
    options.live && !options.testHarness
      ? options.externalProviderDiagnostic
        ? "anthropic-compatible-diagnostic"
        : formalProvider(childEnvironment)
      : null;
  const claudeCliPath = options.live && !options.testHarness
    ? resolveExecutablePath(options.executable, childEnvironment)
    : null;
  if (options.live && !options.testHarness && !claudeCliPath) {
    throw new Error("Claude CLI is unavailable on the sanitized PATH");
  }
  const claudeCliVersion =
    claudeCliPath ? executableVersion(claudeCliPath) : null;
  if (options.live && !options.testHarness && !claudeCliVersion) {
    throw new Error("Claude CLI is unavailable or did not report a version");
  }
  const claudeCliSha256 = claudeCliPath ? sha256File(claudeCliPath) : null;
  if (
    formalLive ||
    (options.externalProviderDiagnostic && options.expectedClaudeCliSha256 !== null)
  ) {
    assertExpectedExecutableSha256(
      claudeCliSha256!,
      options.expectedClaudeCliSha256!,
    );
  }
  const executionOptions: RunOptions = {
    ...options,
    executable: claudeCliPath ?? options.executable,
  };
  if (existsSync(options.runDir)) throw new Error(`Run directory already exists: ${options.runDir}`);
  mkdirSync(options.runDir, { recursive: true });

  const privatePath = resolveFixturePath(
    fixtureRoot,
    fixtureManifest.privateCasesFile,
    "privateCasesFile",
  );
  const privateCasesSha256 = sha256File(privatePath);
  const publicManifestPath = resolveFixturePath(
    fixtureRoot,
    fixtureManifest.publicManifestFile,
    "publicManifestFile",
  );
  const publicManifestSha256 = sha256File(publicManifestPath);
  const implementationSha256 = implementationHashes();
  const startedAt = new Date().toISOString();
  const selectedPublicCaseIds = selected.map((fixture) => fixture.publicCase.publicCaseId);
  const runManifestPath = join(options.runDir, "run-manifest.json");
  const baseManifest = {
    schemaVersion: 2,
    runnerVersion: RUNNER_VERSION,
    status: "running",
    startedAt,
    mode: evaluationMode(options),
    testHarness: options.testHarness,
    fixtureManifest: options.fixtureManifestPath,
    fixtureManifestSha256,
    publicManifestSha256,
    privateCasesSha256,
    fixtureAdapterVersion: fixtureManifest.adapterVersion,
    fixtureRepository: fixtureManifest.repository,
    currentRepository,
    runtime: {
      bunVersion: Bun.version,
      claudeCliVersion,
      claudeCliPath,
      claudeCliSha256,
      expectedClaudeCliSha256: options.expectedClaudeCliSha256,
      provider,
      childEnvironmentKeys: Object.keys(childEnvironment).sort(),
      authIsolation: "claude --bare; OAuth, keychain, auto-memory, hooks, and CLAUDE.md discovery disabled",
      implementationSha256,
    },
    externalProviderDiagnostic: options.externalProviderDiagnostic
      ? {
          settingsFingerprintSha256: options.diagnosticSettingsFingerprintSha256,
          endpointOrigin: options.diagnosticEndpointOrigin,
          environmentKeys: options.diagnosticEnvironmentKeys,
          acceptedModelIds: options.diagnosticAcceptedModelIds,
          ignoredTopLevelKeys: options.diagnosticIgnoredTopLevelKeys,
          ignoredEnvironmentKeys: options.diagnosticIgnoredEnvironmentKeys,
          note: "Only allowlisted model/env fields were loaded; settings hooks, plugins, permissions, and credential values were not recorded.",
        }
      : null,
    prompt: VITAMINC_AGENT_PROMPT,
    promptSha256: sha256Text(VITAMINC_AGENT_PROMPT),
    requestedModel: options.model,
    effort: options.live ? options.effort : null,
    maxTurns: options.maxTurns,
    timeoutMs: options.timeoutMs,
    maxBudgetUsd: options.live ? options.maxBudgetUsd : null,
    maxTotalBudgetUsd: options.live ? options.maxTotalBudgetUsd : null,
    executable: basename(options.executable),
    allowedToulminTools: [...DEFAULT_TOULMIN_TOOL_ALLOWLIST],
    selectedPublicCaseIds,
    requestedCases: selected.length,
  };
  writeJson(runManifestPath, baseManifest);

  console.log(
    `${evaluationMode(options).toUpperCase()}: ` +
      `${selected.length} sealed case(s)`,
  );
  console.log(`prompt: ${VITAMINC_AGENT_PROMPT}`);
  if (!options.live) console.log("model/credentials: not loaded; expected paid calls: 0");

  const results: VitaminCCaseResult[] = [];
  let abortedReason: string | null = null;
  let fatalError: unknown = null;
  let integrityChecksPassed = false;
  let consecutiveTimeoutOrMaxTurns = 0;
  let reportedCostUsd = 0;
  try {
    for (const [index, fixture] of selected.entries()) {
      console.log(`[${index + 1}/${selected.length}] ${fixture.publicCase.publicCaseId}`);
      const result = await executeCase(fixture, executionOptions, claudeCliVersion);
      results.push(result);
      const failureKind = result.process.failure?.kind;
      consecutiveTimeoutOrMaxTurns =
        failureKind === "timeout" || failureKind === "max_turns"
          ? consecutiveTimeoutOrMaxTurns + 1
          : 0;
      if (result.process.totalCostUsd !== null) {
        reportedCostUsd += result.process.totalCostUsd;
      }
      const systemic = options.live && systemicFailure(result, index);
      const transientCircuitOpen =
        options.live && consecutiveTimeoutOrMaxTurns >= 2;
      const budgetCircuitOpen =
        options.live && reportedCostUsd > options.maxTotalBudgetUsd;
      if (systemic || transientCircuitOpen || budgetCircuitOpen) {
        abortedReason =
          budgetCircuitOpen
            ? `batch budget circuit opened after ${result.publicCaseId}: reported cost ` +
              `$${reportedCostUsd.toFixed(4)} exceeds $${options.maxTotalBudgetUsd.toFixed(2)}`
            : transientCircuitOpen
              ? `fail-fast after ${result.publicCaseId}: two consecutive timeout/max-turns failures`
              : `fail-fast after ${result.publicCaseId}: ` +
                (result.process.failure?.message ??
                  result.process.failure?.kind ??
                  result.process.status);
        console.error(abortedReason);
        break;
      }
    }

    if (sha256File(options.fixtureManifestPath) !== fixtureManifestSha256) {
      throw new Error("Fixture manifest changed during the run; refusing to seal results");
    }
    if (sha256File(privatePath) !== privateCasesSha256) {
      throw new Error("Private cases changed during the run; refusing to seal results");
    }
    if (sha256File(publicManifestPath) !== publicManifestSha256) {
      throw new Error("Public manifest changed during the run; refusing to seal results");
    }
    if (claudeCliPath && sha256File(claudeCliPath) !== claudeCliSha256) {
      throw new Error("Claude CLI binary changed during the run; refusing to seal results");
    }
    verifyResultArtifacts(results, options.runDir);
    if (JSON.stringify(implementationHashes()) !== JSON.stringify(implementationSha256)) {
      throw new Error("Runtime implementation changed during the run; refusing to seal results");
    }
    integrityChecksPassed = true;
  } catch (error) {
    fatalError = error;
    abortedReason ??= `runner exception: ${safeError(error)}`;
    console.error(abortedReason);
  }

  const resultsPath = join(options.runDir, "results.jsonl");
  const observedFrozenState = summarizeRows(results);
  const directionSummary = Object.fromEntries(
    (["SUP_TO_REF", "REF_TO_SUP"] as const).map((direction) => [
      direction,
      summarizeRows(results.filter((result) => result.direction === direction)),
    ]),
  );
  const revisionTypeSummary = Object.fromEntries(
    [...new Set(results.map((result) => result.revisionType ?? "unknown"))]
      .sort()
      .map((kind) => [kind, summarizeRows(results.filter((result) => (result.revisionType ?? "unknown") === kind))]),
  );
  const processFailures = results.filter(
    (result) => !result.process.completed && result.process.attempted,
  ).length;
  const status: RunCompletionStatus = abortedReason
    ? "aborted"
    : options.live && processFailures > 0
      ? "complete_with_failures"
      : "complete";
  const {
    primaryResultsAvailable,
    partialLiveDiagnosticsAvailable,
    analysisStatus,
  } = resultAnalysisDisposition({
    live: options.live,
    testHarness: options.testHarness,
    externalProviderDiagnostic: options.externalProviderDiagnostic,
    status,
    fullFormalSelection,
  });
  const processedIds = new Set(results.map((result) => result.publicCaseId));
  const processedItems = selected
    .filter((fixture) => processedIds.has(fixture.publicCase.publicCaseId))
    .map((fixture) => fixture.privateCase.replay);
  const summary = {
    schemaVersion: 2,
    status,
    mode: evaluationMode(options),
    testHarness: options.testHarness,
    analysisStatus,
    fullFormalSelection,
    requestedN: selected.length,
    processedN: results.length,
    agentCompletedN: results.filter((result) => result.process.completed).length,
    unstartedN: selected.length - results.length,
    integrityChecksPassed,
    primaryEstimand: "intention-to-treat autonomousSuccessRate",
    overall: primaryResultsAvailable ? observedFrozenState : null,
    byDirection: primaryResultsAvailable ? directionSummary : null,
    byRevisionType: primaryResultsAvailable ? revisionTypeSummary : null,
    partialObservedResults:
      partialLiveDiagnosticsAvailable
        ? {
            note:
              options.externalProviderDiagnostic
                ? "External Anthropic-compatible provider diagnostic only; never interpret as the prespecified Claude ITT estimand."
                : status === "aborted"
                ? "Incomplete diagnostic subset only; do not interpret as the prespecified ITT estimand."
                : "Partial pilot/smoke-test observations only; not the prespecified full-corpus ITT estimand.",
            overall: observedFrozenState,
            byDirection: directionSummary,
            byRevisionType: revisionTypeSummary,
          }
        : null,
    testHarnessValidation:
      options.testHarness
        ? {
            note: "Deterministic fake-agent integration output; never a primary evaluation result.",
            observedState: observedFrozenState,
            byDirection: directionSummary,
            byRevisionType: revisionTypeSummary,
          }
        : null,
    dryRunValidation: options.live
      ? null
      : {
          note: "No agent was invoked; these are the sealed pre-agent graph states, not treatment outcomes.",
          observedFrozenState,
          byDirection: directionSummary,
          byRevisionType: revisionTypeSummary,
        },
    noMaintenanceBaseline:
      status === "aborted" ||
      options.externalProviderDiagnostic ||
      (options.live && !options.testHarness && !fullFormalSelection)
        ? null
        : noMaintenanceBaseline(selected.map((fixture) => fixture.privateCase.replay)),
    partialNoMaintenanceBaseline:
      status === "aborted" || partialLiveDiagnosticsAvailable
        ? noMaintenanceBaseline(processedItems)
        : null,
  };
  const summaryPath = join(options.runDir, "summary.json");
  try {
    writeJsonl(resultsPath, results);
    writeJsonAtomic(summaryPath, summary);
    writeJsonAtomic(runManifestPath, {
      ...baseManifest,
      status,
      completedAt: new Date().toISOString(),
      processedCases: results.length,
      agentCompletedCases: results.filter((result) => result.process.completed).length,
      unstartedCases: selected.length - results.length,
      integrityChecksPassed,
      abortedReason,
      processFailures,
      autonomousSuccesses: results.filter((result) => result.score.autonomousSuccess).length,
      resultsFile: relative(options.runDir, resultsPath),
      resultsSha256: sha256File(resultsPath),
      summaryFile: relative(options.runDir, summaryPath),
      summarySha256: sha256File(summaryPath),
    });
  } catch (error) {
    const finalizationReason = `result finalization failed: ${safeError(error)}`;
    const invalidatedSummary = {
      ...summary,
      status: "aborted",
      analysisStatus: "incomplete-not-for-primary-analysis",
      integrityChecksPassed: false,
      overall: null,
      byDirection: null,
      byRevisionType: null,
      partialObservedResults:
        options.live && !options.testHarness
          ? {
              note:
                "Unsealed diagnostic subset after result-finalization failure; never use as a primary estimate.",
              overall: observedFrozenState,
              byDirection: directionSummary,
              byRevisionType: revisionTypeSummary,
            }
          : null,
      noMaintenanceBaseline: null,
      partialNoMaintenanceBaseline: noMaintenanceBaseline(processedItems),
      finalizationFailure: finalizationReason,
    };
    let invalidatedSummaryRecorded = false;
    try {
      writeJsonAtomic(summaryPath, invalidatedSummary);
      invalidatedSummaryRecorded = true;
    } catch {
      // Remove a previously publishable filename from the normal output
      // contract. The quarantined file remains available for diagnosis but is
      // explicitly named as unsealed.
      if (existsSync(summaryPath)) {
        try {
          renameSync(
            summaryPath,
            join(options.runDir, `summary.unsealed-${crypto.randomUUID()}.json`),
          );
        } catch {
          // The aborted manifest below remains the authoritative seal if the
          // output filesystem cannot even quarantine the summary.
        }
      }
    }
    try {
      const resultArtifact = optionalSealedArtifact(resultsPath, options.runDir);
      const summaryArtifact = invalidatedSummaryRecorded
        ? optionalSealedArtifact(summaryPath, options.runDir)
        : null;
      writeJsonAtomic(runManifestPath, {
        ...baseManifest,
        status: "aborted",
        completedAt: new Date().toISOString(),
        processedCases: results.length,
        agentCompletedCases: results.filter((result) => result.process.completed).length,
        unstartedCases: selected.length - results.length,
        integrityChecksPassed: false,
        abortedReason: finalizationReason,
        ...(resultArtifact
          ? { resultsFile: resultArtifact.path, resultsSha256: resultArtifact.sha256 }
          : {}),
        ...(summaryArtifact
          ? { summaryFile: summaryArtifact.path, summarySha256: summaryArtifact.sha256 }
          : {}),
      });
    } catch {
      // The outer error still reports the original finalization failure. If the
      // output filesystem itself is unavailable, no manifest write can be guaranteed.
    }
    throw error;
  }

  console.log(`output: ${options.runDir}`);
  console.log(
    JSON.stringify(
      summary.overall ??
        summary.dryRunValidation?.observedFrozenState ??
        summary.testHarnessValidation?.observedState ??
        summary.partialObservedResults?.overall,
      null,
      2,
    ),
  );
  if (fatalError !== null) throw fatalError;
  if (
    status === "aborted" ||
    (options.live &&
      !options.testHarness &&
      (options.externalProviderDiagnostic
        ? summary.partialObservedResults?.overall.processCompletionRate !== 1
        : summary.overall?.processCompletionRate !== 1))
  ) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`VitaminC run failed: ${safeError(error)}`);
    process.exitCode = 1;
  });
}

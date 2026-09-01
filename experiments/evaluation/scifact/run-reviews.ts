#!/usr/bin/env bun

import type { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openDatabase } from "../../../src/db.ts";
import { loadReviewConfig, type ReviewConfig } from "../../../src/review-config.ts";
import { runReview } from "../../../src/review-run.ts";
import { closeFixtureDatabase, copyFixtureProject } from "../common/graph-fixture.ts";
import {
  readJson,
  sha256File,
  sha256Text,
  writeJson,
  writeJsonAtomic,
  writeJsonl,
} from "../common/manifest.ts";
import { validateFixtureManifest } from "./score-reviews.ts";
import type {
  FailedReviewCaseResult,
  AuditAttempt,
  FixtureCase,
  FixtureManifest,
  ReviewCaseResult,
  ReviewRunManifest,
  SuccessfulReviewCaseResult,
} from "./types.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const DEFAULT_RUN_ROOT = join(
  REPO_ROOT,
  "experiments",
  "evaluation",
  "outputs",
  "scifact",
  "runs",
);

function usage(): string {
  return `Run Warranted review directly against prebuilt SciFact graph fixtures.

Dry-run is the default and never loads credentials or calls a model.

Usage:
  bun experiments/evaluation/scifact/run-reviews.ts --fixtures <manifest> [options]

Options:
  --fixtures <path>        Required fixture-manifest.json
  --case <id>              Select a case; repeatable
  --limit <n>              Select the first n cases
  --run-dir <path>         New live-run output directory
  --review-config <path>   Required with --live
  --concurrency <n>        Worker count, capped by review config
  --live                   Make paid reviewer calls
  --all                    Explicitly authorize a live run of the full selection
  --help                   Show this help
`;
}

function positiveInteger(name: string, value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function timestampId(): string {
  return new Date().toISOString().replace(/[-:.]/g, "");
}

function resolveFrom(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function selectFixtureCases(
  manifest: FixtureManifest,
  ids: string[],
  limit: number | null,
): FixtureCase[] {
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicateIds.length > 0) throw new Error(`Duplicate --case id: ${duplicateIds[0]}`);
  const available = new Map(manifest.cases.map((fixture) => [fixture.caseId, fixture]));
  if (available.size !== manifest.cases.length) throw new Error("Fixture manifest has duplicate case ids");
  const selected = ids.length > 0
    ? ids.map((id) => {
        const fixture = available.get(id);
        if (!fixture) throw new Error(`Unknown fixture case: ${id}`);
        return fixture;
      })
    : [...manifest.cases];
  return limit === null ? selected : selected.slice(0, limit);
}

function safeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function latestReviewEvent(
  db: Database,
  eventId: number,
): { node_id: number | null; op: string; payload: string } | null {
  return db
    .query("SELECT node_id, op, payload FROM events WHERE id = ?")
    .get(eventId) as { node_id: number | null; op: string; payload: string } | null;
}

function reviewEventCount(db: Database, targetId: number): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND op = 'review'")
    .get(targetId) as { n: number };
  return row.n;
}

function auditFileCount(path: string | null): number {
  if (!path || !existsSync(path)) return 0;
  return readdirSync(path).filter((name) => name.endsWith(".json")).length;
}

function readAuditAttempts(path: string, runDir: string): AuditAttempt[] {
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const file = join(path, name);
      const record = readJson<{
        model?: unknown;
        output?: { raw?: unknown; durationMs?: unknown; successfulReads?: unknown };
      }>(file);
      if (
        typeof record.model !== "string" ||
        typeof record.output?.raw !== "string" ||
        typeof record.output.durationMs !== "number" ||
        !Array.isArray(record.output.successfulReads) ||
        record.output.successfulReads.some((item) => typeof item !== "string")
      ) {
        throw new Error(`Malformed review audit: ${file}`);
      }
      return {
        model: record.model,
        durationMs: record.output.durationMs,
        rawSha256: sha256Text(record.output.raw),
        successfulReads: record.output.successfulReads as string[],
        file: relative(runDir, file),
      };
    });
}

export function validateFixtureFiles(
  fixtures: FixtureCase[],
  fixtureManifestDir: string,
): void {
  for (const fixture of fixtures) {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(fixture.caseId)) {
      throw new Error(`Unsafe fixture case id: ${fixture.caseId}`);
    }
    const project = resolveFrom(fixtureManifestDir, fixture.projectDir);
    if (isAbsolute(fixture.projectDir) || !isInside(fixtureManifestDir, project)) {
      throw new Error(`Fixture project escapes its manifest directory: ${fixture.projectDir}`);
    }
    const graph = join(project, ".toulmin", "graph.db");
    for (const metadata of fixture.attachments) {
      const attachment = resolve(project, metadata.path);
      if (isAbsolute(metadata.path) || !isInside(project, attachment)) {
        throw new Error(`Fixture attachment escapes its project: ${metadata.path}`);
      }
      if (sha256File(attachment) !== metadata.sha256) {
        throw new Error(`Fixture attachment hash mismatch: ${fixture.caseId}/${metadata.docId}`);
      }
    }
    if (sha256File(graph) !== fixture.graphSha256) {
      throw new Error(`Fixture graph hash mismatch: ${fixture.caseId}`);
    }
  }
}

export interface ExecuteCaseOptions {
  fixture: FixtureCase;
  fixtureManifestDir: string;
  runDir: string;
  baseConfig: ReviewConfig;
  reviewFn?: typeof runReview;
}

/** Run one case from a private DB copy. Exported for deterministic runner tests. */
export async function executeCase(options: ExecuteCaseOptions): Promise<ReviewCaseResult> {
  const { fixture, fixtureManifestDir, runDir, baseConfig } = options;
  const caseOut = join(runDir, "cases", fixture.caseId);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(fixture.caseId)) {
    throw new Error(`Unsafe fixture case id: ${fixture.caseId}`);
  }
  const sourceProject = resolveFrom(fixtureManifestDir, fixture.projectDir);
  if (isAbsolute(fixture.projectDir) || !isInside(fixtureManifestDir, sourceProject)) {
    throw new Error(`Fixture project escapes its manifest directory: ${fixture.projectDir}`);
  }
  const auditDir = join(caseOut, "audit");
  mkdirSync(caseOut, { recursive: true });
  mkdirSync(auditDir, { recursive: true });

  const scratch = mkdtempSync(join(tmpdir(), `scifact-review-${fixture.caseId}-`));
  const scratchProject = join(scratch, "project");
  const graphOut = join(caseOut, "graph.db");
  const started = performance.now();
  let db: Database | null = null;
  let scratchDbPath: string | null = null;

  try {
    const sourceGraph = join(sourceProject, ".toulmin", "graph.db");
    if (sha256File(sourceGraph) !== fixture.graphSha256) {
      throw new Error("fixture changed after preflight validation");
    }
    for (const metadata of fixture.attachments) {
      if (sha256File(resolve(sourceProject, metadata.path)) !== metadata.sha256) {
        throw new Error(`fixture attachment ${metadata.docId} changed after preflight validation`);
      }
    }
    copyFixtureProject(sourceProject, scratchProject);
    scratchDbPath = join(scratchProject, ".toulmin", "graph.db");
    if (sha256File(scratchDbPath) !== fixture.graphSha256) {
      throw new Error("copied fixture graph does not match its manifest hash");
    }
    db = openDatabase(scratchDbPath);
    const beforeEvents = reviewEventCount(db, fixture.targetId);
    if (beforeEvents !== 0) {
      throw new Error(`fixture already contains ${beforeEvents} review event(s) for the target`);
    }
    const attachmentHashesBefore = new Map(
      fixture.attachments.map((metadata) => {
        const attachment = resolve(scratchProject, metadata.path);
        if (isAbsolute(metadata.path) || !isInside(scratchProject, attachment)) {
          throw new Error(`Fixture attachment escapes its project: ${metadata.path}`);
        }
        return [metadata.path, sha256File(attachment)] as const;
      }),
    );
    const config: ReviewConfig = {
      ...baseConfig,
      dbPath: scratchDbPath,
      auditDir,
    };
    const reviewed = await (options.reviewFn ?? runReview)(config, db, fixture.targetId);
    const auditAttempts = readAuditAttempts(auditDir, runDir);
    if (auditAttempts.length === 0) {
      throw new Error("review completed without a readable audit record");
    }
    const event = latestReviewEvent(db, reviewed.eventId);
    if (!event || event.op !== "review" || event.node_id !== fixture.targetId) {
      throw new Error(`review returned event ${reviewed.eventId}, but no matching review event exists`);
    }
    const payload = JSON.parse(event.payload) as {
      Q1?: unknown;
      Q2?: unknown;
      model?: unknown;
      protocol?: unknown;
      findings?: unknown;
      rejected?: unknown;
    };
    if (typeof payload.model !== "string" || typeof payload.protocol !== "string") {
      throw new Error(`review event ${reviewed.eventId} is missing model/protocol provenance`);
    }
    const findingDrafts = reviewed.findings.map(({ id: _id, ...finding }) => finding);
    if (
      payload.Q1 !== reviewed.Q1 ||
      payload.Q2 !== reviewed.Q2 ||
      payload.model !== reviewed.actualModel ||
      JSON.stringify(payload.findings ?? []) !== JSON.stringify(findingDrafts) ||
      JSON.stringify(payload.rejected ?? []) !== JSON.stringify(reviewed.rejected)
    ) {
      throw new Error(`review event ${reviewed.eventId} disagrees with the returned review result`);
    }
    if (auditAttempts.at(-1)?.model !== reviewed.actualModel) {
      throw new Error("review result model disagrees with its final audit attempt");
    }
    const reviewedReads = new Set(
      reviewed.attachmentsRead.map((path) => (isAbsolute(path) ? resolve(path) : resolve(scratchProject, path))),
    );
    const auditedReads = new Set(
      auditAttempts
        .at(-1)!
        .successfulReads.map((path) => (isAbsolute(path) ? resolve(path) : resolve(scratchProject, path))),
    );
    const expectedReviewAttachments =
      fixture.mode === "primary" ? fixture.attachments : [];
    for (const metadata of expectedReviewAttachments) {
      const expectedRead = resolve(scratchProject, metadata.path);
      if (!reviewedReads.has(expectedRead) || !auditedReads.has(expectedRead)) {
        throw new Error(`review did not auditably read fixture attachment ${metadata.path}`);
      }
    }
    const afterEvents = reviewEventCount(db, fixture.targetId);
    if (afterEvents - beforeEvents !== 1) {
      throw new Error(`expected one new review event, observed ${afterEvents - beforeEvents}`);
    }
    for (const metadata of fixture.attachments) {
      if (sha256File(resolve(scratchProject, metadata.path)) !== attachmentHashesBefore.get(metadata.path)) {
        throw new Error(`reviewer changed evidence attachment ${metadata.path}`);
      }
    }

    closeFixtureDatabase(db, scratchDbPath);
    db = null;
    copyFileSync(scratchDbPath, graphOut);
    const graphSha256 = sha256File(graphOut);
    const result: SuccessfulReviewCaseResult = {
      schemaVersion: 1,
      caseId: fixture.caseId,
      status: "ok",
      durationMs: Math.round(performance.now() - started),
      eventId: reviewed.eventId,
      model: baseConfig.model,
      actualModel: reviewed.actualModel,
      fallbackModel: baseConfig.fallbackModel ?? null,
      protocolHash: payload.protocol,
      Q1: reviewed.Q1,
      Q2: reviewed.Q2,
      findings: reviewed.findings,
      rejected: reviewed.rejected,
      graphPath: relative(runDir, graphOut),
      graphSha256,
      auditDir: relative(runDir, auditDir),
      auditFiles: auditAttempts.length,
      auditAttempts,
      attachmentsRead: expectedReviewAttachments.map((attachment) => attachment.path),
      reviewEventsAdded: 1,
      attachmentUnchanged: true,
    };
    writeJsonAtomic(join(caseOut, "result.json"), result);
    return result;
  } catch (error) {
    if (db) {
      try {
        closeFixtureDatabase(db, scratchDbPath ?? undefined);
      } catch {
        try {
          db.close();
        } catch {
          // Preserve the original review failure.
        }
      }
      db = null;
    }
    let archivedGraph: string | null = null;
    let archivedGraphSha256: string | null = null;
    if (scratchDbPath && existsSync(scratchDbPath)) {
      copyFileSync(scratchDbPath, graphOut);
      archivedGraph = relative(runDir, graphOut);
      archivedGraphSha256 = sha256File(graphOut);
    }
    const result: FailedReviewCaseResult = {
      schemaVersion: 1,
      caseId: fixture.caseId,
      status: "error",
      durationMs: Math.round(performance.now() - started),
      error: safeError(error),
      graphPath: archivedGraph,
      graphSha256: archivedGraphSha256,
      auditDir: relative(runDir, auditDir),
      auditFiles: auditFileCount(auditDir),
      auditAttempts: (() => {
        try {
          return readAuditAttempts(auditDir, runDir);
        } catch {
          return [];
        }
      })(),
      reviewEventsAdded: safeReviewEventCount(scratchDbPath, fixture.targetId),
    };
    writeJsonAtomic(join(caseOut, "result.json"), result);
    return result;
  } finally {
    if (db) db.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

function safeReviewEventCount(dbPath: string | null, targetId: number): number {
  if (!dbPath || !existsSync(dbPath)) return 0;
  try {
    const db = openDatabase(dbPath);
    try {
      return reviewEventCount(db, targetId);
    } finally {
      db.close();
    }
  } catch {
    return -1;
  }
}

async function runPool(
  fixtures: FixtureCase[],
  concurrency: number,
  execute: (fixture: FixtureCase) => Promise<ReviewCaseResult>,
  shouldStop: () => boolean,
): Promise<ReviewCaseResult[]> {
  const results: ReviewCaseResult[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, fixtures.length) }, async () => {
    while (!shouldStop()) {
      const index = cursor++;
      const fixture = fixtures[index];
      if (!fixture) return;
      console.log(`Reviewing ${fixture.caseId} (${index + 1}/${fixtures.length})`);
      const result = await execute(fixture);
      results.push(result);
      console.log(
        result.status === "ok"
          ? `  ${fixture.caseId}: Q1=${result.Q1}, Q2=${result.Q2}, ${result.durationMs}ms`
          : `  ${fixture.caseId}: ERROR ${result.error}`,
      );
    }
  });
  await Promise.all(workers);
  return results.sort((a, b) => a.caseId.localeCompare(b.caseId));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    strict: true,
    allowPositionals: false,
    options: {
      fixtures: { type: "string" },
      case: { type: "string", multiple: true, default: [] },
      limit: { type: "string" },
      "run-dir": { type: "string" },
      "review-config": { type: "string" },
      concurrency: { type: "string" },
      live: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(usage());
    return;
  }
  if (!values.fixtures) throw new Error("--fixtures is required");
  const fixtureManifestPath = resolve(values.fixtures);
  const fixtureManifestSha256 = sha256File(fixtureManifestPath);
  const fixtureManifest = readJson<FixtureManifest>(fixtureManifestPath);
  if (fixtureManifest.schemaVersion !== 2) {
    throw new Error(`Unsupported fixture manifest schema: ${fixtureManifest.schemaVersion}`);
  }
  validateFixtureManifest(fixtureManifest);
  const limit = positiveInteger("--limit", values.limit);
  const selected = selectFixtureCases(fixtureManifest, values.case, limit);
  if (selected.length === 0) throw new Error("No fixture cases selected");
  const fixtureManifestDir = dirname(fixtureManifestPath);
  validateFixtureFiles(selected, fixtureManifestDir);

  if (!values.live) {
    console.log("DRY-RUN: no reviewer calls will be made.\n");
    console.log(`Fixture manifest: ${fixtureManifestPath}`);
    console.log(`Selected cases: ${selected.length}`);
    console.log("Review config and credentials: not loaded");
    console.log(`Expected reviewer calls: ${selected.length}`);
    console.log(`Worst case after built-in parse retry: ${selected.length * 2}`);
    console.log("Add --live --review-config <path>; add --all for the full selection.");
    return;
  }

  if (!values["review-config"]) throw new Error("--review-config is required with --live");
  const fullSelection = values.case.length === 0 && limit === null;
  if (fullSelection && !values.all) {
    throw new Error("A full live run requires --all; use --limit or --case for a bounded smoke test");
  }
  const runDir = resolve(values["run-dir"] ?? join(DEFAULT_RUN_ROOT, `run-${timestampId()}`));
  if (existsSync(runDir)) throw new Error(`Run directory already exists: ${runDir}`);
  mkdirSync(runDir, { recursive: true });

  // Load once against a run-local placeholder, never against an immutable fixture.
  const preflightDbPath = join(runDir, "preflight", ".toulmin", "graph.db");
  const baseConfig = loadReviewConfig(resolve(values["review-config"]), preflightDbPath);
  if (!baseConfig) throw new Error("Review configuration is missing or invalid");
  const configuredLimit = baseConfig.maxConcurrency ?? 4;
  const requestedConcurrency = positiveInteger("--concurrency", values.concurrency) ?? configuredLimit;
  const concurrency = Math.min(requestedConcurrency, configuredLimit);
  baseConfig.maxConcurrency = concurrency;

  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
    console.error("Interrupt received: no new cases will start; waiting for in-flight reviews.");
  };
  process.once("SIGINT", onInterrupt);
  const results = await runPool(
    selected,
    concurrency,
    (fixture) => executeCase({ fixture, fixtureManifestDir, runDir, baseConfig }),
    () => interrupted,
  );
  process.removeListener("SIGINT", onInterrupt);

  const resultsFile = join(runDir, "results.jsonl");
  writeJsonl(resultsFile, results);
  if (sha256File(fixtureManifestPath) !== fixtureManifestSha256) {
    throw new Error("Fixture manifest changed during the live run; refusing to seal the run");
  }
  const runManifest: ReviewRunManifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    fixtureManifest: fixtureManifestPath,
    fixtureManifestSha256,
    model: baseConfig.model,
    fallbackModel: baseConfig.fallbackModel ?? null,
    baseUrl: baseConfig.baseUrl ?? null,
    maxTurns: baseConfig.maxTurns,
    concurrency,
    auditRequired: true,
    selectedCaseIds: selected.map((fixture) => fixture.caseId),
    requestedCases: selected.length,
    completedCases: results.length,
    failedCases: results.filter((result) => result.status === "error").length,
    interrupted,
    resultsFile: relative(runDir, resultsFile),
    resultsSha256: sha256File(resultsFile),
  };
  writeJson(join(runDir, "run-manifest.json"), runManifest);
  console.log(`Run artifacts: ${runDir}`);
  if (runManifest.failedCases > 0 || interrupted || results.length !== selected.length) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`scifact review run failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}

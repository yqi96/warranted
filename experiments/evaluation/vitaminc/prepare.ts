#!/usr/bin/env bun

import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
} from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import {
  sha256File,
  sha256Text,
  writeJson,
  writeJsonl,
} from "../common/manifest.ts";
import { loadNaturalDirectionReplaysWithAudit } from "./adapter.ts";
import { EVIDENCE_ATTACHMENT, seedPostUpdateGraph } from "./graph.ts";
import type {
  CandidateAudit,
  CandidateExclusionReason,
  PreparedManifest,
  PreparedPrivateCase,
  PreparedPublicCase,
  ReplayCase,
  ReplayDirection,
  SelectedCounts,
  VitaminCFlaggingRow,
} from "./types.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const DEFAULT_DATA = join(
  REPO_ROOT,
  "experiments/benchmarks/vitaminc/data/vitaminc/dev.jsonl",
);
const DEFAULT_FLAGGING = join(
  REPO_ROOT,
  "experiments/benchmarks/vitaminc/data/vitaminc_flagging/dev.jsonl",
);
const DEFAULT_SEED = 20260901;
const DIRECTIONS = ["SUP_TO_REF", "REF_TO_SUP"] as const;
const IMPLEMENTATION_PATHS = [
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

export interface PrepareVitaminCOptions {
  inputPath: string;
  flaggingPath: string;
  split: string;
  perDirection: number;
  seed: number;
  outputDir: string;
}

export interface CandidateValidationResult {
  eligible: ReplayCase[];
  audit: CandidateAudit;
}

function timestampId(): string {
  return new Date().toISOString().replace(/[-:.]/g, "");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function positiveInteger(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${name} must be a positive integer, got ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

function integer(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be an integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function seededHash(seed: number, namespace: string, ...parts: string[]): string {
  return sha256Text([String(seed), namespace, ...parts].join("\u0000"));
}

function metadataText(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
}

/**
 * Canonical comparison for the raw flagging sentences and the tokenised
 * fact-verification evidence. NFKC and case folding are applied, then Unicode
 * letter/mark/number runs and meaning-bearing symbols are retained in their
 * original order. This removes tokenizer-only whitespace, Penn Treebank quote
 * markers, and non-semantic punctuation spacing without permitting word,
 * number, sign, currency, comparison, percentage, or degree substitutions.
 */
export function canonicalTokenSignature(value: string): string {
  return (
    value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\s+n['’]t\b/gu, "n't")
      .match(/[\p{L}\p{M}\p{N}]+|[%$£€¥+\-−<>≤≥=°]/gu) ?? []
  ).join("\u0000");
}

export function validateSplitPaths(
  split: string,
  inputPath: string,
  flaggingPath: string,
): void {
  const expected = split.trim();
  if (!expected) throw new Error("--split must not be empty");
  const inputSplit = basename(inputPath, extname(inputPath));
  const flaggingSplit = basename(flaggingPath, extname(flaggingPath));
  if (inputSplit !== expected || flaggingSplit !== expected) {
    throw new Error(
      `Split/path mismatch: --split=${JSON.stringify(expected)}, ` +
        `input=${JSON.stringify(inputSplit)}, flagging=${JSON.stringify(flaggingSplit)}`,
    );
  }
  const inputAssetRoot = dirname(dirname(resolve(inputPath)));
  const flaggingAssetRoot = dirname(dirname(resolve(flaggingPath)));
  if (inputAssetRoot !== flaggingAssetRoot) {
    throw new Error(
      `Input and flagging files must share one dataset asset root: ` +
        `${inputAssetRoot} != ${flaggingAssetRoot}`,
    );
  }
}

export async function loadFlaggingRows(
  inputPath: string,
): Promise<VitaminCFlaggingRow[]> {
  const rows: VitaminCFlaggingRow[] = [];
  const lines = createInterface({
    input: createReadStream(inputPath),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as VitaminCFlaggingRow);
    } catch (error) {
      throw new Error(`Invalid flagging JSONL at ${inputPath}:${lineNumber}: ${error}`);
    }
  }
  return rows;
}

function emptyExclusionCounts(): Record<CandidateExclusionReason, number> {
  return {
    non_real_revision: 0,
    missing_flagging_case: 0,
    non_unique_flagging_case: 0,
    non_factual_flagging_case: 0,
    revision_mismatch: 0,
    page_mismatch: 0,
    sent_a_mismatch: 0,
    sent_b_mismatch: 0,
  };
}

function rejectionReason(
  item: ReplayCase,
  flaggingByCase: ReadonlyMap<string, VitaminCFlaggingRow[]>,
): CandidateExclusionReason | undefined {
  if (item.revisionType !== "real") return "non_real_revision";
  const matches = flaggingByCase.get(item.sourceCaseId);
  if (!matches) return "missing_flagging_case";
  if (matches.length !== 1) return "non_unique_flagging_case";
  const flagging = matches[0]!;
  if (flagging.label !== "factual") return "non_factual_flagging_case";
  if (
    !item.wikiRevisionId ||
    !flagging.wiki_revision_id ||
    metadataText(item.wikiRevisionId) !== metadataText(flagging.wiki_revision_id)
  ) {
    return "revision_mismatch";
  }
  if (
    !item.page ||
    !flagging.page ||
    metadataText(item.page) !== metadataText(flagging.page)
  ) {
    return "page_mismatch";
  }
  if (
    typeof flagging.sent_a !== "string" ||
    canonicalTokenSignature(item.e0) !== canonicalTokenSignature(flagging.sent_a)
  ) {
    return "sent_a_mismatch";
  }
  if (
    typeof flagging.sent_b !== "string" ||
    canonicalTokenSignature(item.e1) !== canonicalTokenSignature(flagging.sent_b)
  ) {
    return "sent_b_mismatch";
  }
  return undefined;
}

export function validateNaturalRealCandidates(
  candidates: readonly ReplayCase[],
  flaggingRows: readonly VitaminCFlaggingRow[],
): CandidateValidationResult {
  const flaggingByCase = new Map<string, VitaminCFlaggingRow[]>();
  for (const row of flaggingRows) {
    const key = typeof row.case_id === "string" ? row.case_id : "";
    const values = flaggingByCase.get(key) ?? [];
    values.push(row);
    flaggingByCase.set(key, values);
  }

  const excluded = emptyExclusionCounts();
  const eligible: ReplayCase[] = [];
  for (const item of candidates) {
    const reason = rejectionReason(item, flaggingByCase);
    if (reason) excluded[reason] += 1;
    else eligible.push(item);
  }

  return {
    eligible,
    audit: {
      adapterCandidates: candidates.length,
      flaggingRows: flaggingRows.length,
      flaggingUniqueCaseIds: flaggingByCase.size,
      eligibleCandidates: eligible.length,
      eligibleSourceCaseIds: new Set(eligible.map((item) => item.sourceCaseId)).size,
      eligibleByDirection: {
        SUP_TO_REF: eligible.filter((item) => item.direction === "SUP_TO_REF").length,
        REF_TO_SUP: eligible.filter((item) => item.direction === "REF_TO_SUP").length,
      },
      excluded,
    },
  };
}

function representativesByDirection(
  candidates: readonly ReplayCase[],
  seed: number,
): Record<ReplayDirection, Map<string, ReplayCase>> {
  const groups: Record<ReplayDirection, Map<string, ReplayCase[]>> = {
    SUP_TO_REF: new Map(),
    REF_TO_SUP: new Map(),
  };
  for (const item of candidates) {
    const byCluster = groups[item.direction];
    const values = byCluster.get(item.sourceCaseId) ?? [];
    values.push(item);
    byCluster.set(item.sourceCaseId, values);
  }

  return Object.fromEntries(
    DIRECTIONS.map((direction) => {
      const representatives = new Map<string, ReplayCase>();
      for (const [cluster, values] of groups[direction]) {
        const ranked = values.toSorted((left, right) => {
          const leftRank = seededHash(
            seed,
            "within-cluster",
            direction,
            cluster,
            left.id,
            ...left.sourceIds,
          );
          const rightRank = seededHash(
            seed,
            "within-cluster",
            direction,
            cluster,
            right.id,
            ...right.sourceIds,
          );
          return compareStrings(leftRank, rightRank) || compareStrings(left.id, right.id);
        });
        representatives.set(cluster, ranked[0]!);
      }
      return [direction, representatives];
    }),
  ) as Record<ReplayDirection, Map<string, ReplayCase>>;
}

function rankedClusters(
  clusters: Iterable<string>,
  seed: number,
  namespace: string,
  direction: ReplayDirection,
): string[] {
  return [...clusters].toSorted((left, right) => {
    const leftRank = seededHash(seed, namespace, direction, left);
    const rightRank = seededHash(seed, namespace, direction, right);
    return compareStrings(leftRank, rightRank) || compareStrings(left, right);
  });
}

/**
 * Select equal direction quotas with globally disjoint source revisions. Shared
 * clusters are deterministically partitioned before ranking, and a shortage is
 * an error rather than an implicit stratum fallback.
 */
export function selectDirectionalCases(
  candidates: readonly ReplayCase[],
  perDirection: number,
  seed: number,
): ReplayCase[] {
  if (!Number.isSafeInteger(perDirection) || perDirection <= 0) {
    throw new Error(`perDirection must be a positive integer, got ${perDirection}`);
  }
  const representatives = representativesByDirection(candidates, seed);
  const supClusters = new Set(representatives.SUP_TO_REF.keys());
  const refClusters = new Set(representatives.REF_TO_SUP.keys());
  if (supClusters.size < perDirection || refClusters.size < perDirection) {
    throw new Error(
      `Insufficient direction clusters: SUP_TO_REF=${supClusters.size}, ` +
        `REF_TO_SUP=${refClusters.size}, requested=${perDirection}`,
    );
  }
  const union = new Set([...supClusters, ...refClusters]);
  if (union.size < perDirection * 2) {
    throw new Error(
      `Cannot select globally disjoint sourceCaseIds: union=${union.size}, ` +
        `required=${perDirection * 2}`,
    );
  }

  const pools: Record<ReplayDirection, Set<string>> = {
    SUP_TO_REF: new Set([...supClusters].filter((cluster) => !refClusters.has(cluster))),
    REF_TO_SUP: new Set([...refClusters].filter((cluster) => !supClusters.has(cluster))),
  };
  const shared = [...supClusters].filter((cluster) => refClusters.has(cluster));
  for (const cluster of shared) {
    const assignment = Number.parseInt(
      seededHash(seed, "shared-cluster-partition", cluster).slice(0, 8),
      16,
    ) % 2;
    pools[DIRECTIONS[assignment]!]!.add(cluster);
  }

  for (const direction of DIRECTIONS) {
    const other: ReplayDirection =
      direction === "SUP_TO_REF" ? "REF_TO_SUP" : "SUP_TO_REF";
    const deficit = perDirection - pools[direction].size;
    if (deficit <= 0) continue;
    const movable = rankedClusters(
      [...pools[other]].filter(
        (cluster) => supClusters.has(cluster) && refClusters.has(cluster),
      ),
      seed,
      "shared-cluster-transfer",
      direction,
    );
    if (movable.length < deficit || pools[other].size - deficit < perDirection) {
      throw new Error(
        `Unable to rebalance disjoint ${direction} clusters without violating quotas`,
      );
    }
    for (const cluster of movable.slice(0, deficit)) {
      pools[other].delete(cluster);
      pools[direction].add(cluster);
    }
  }

  const selected = DIRECTIONS.flatMap((direction) =>
    rankedClusters(pools[direction], seed, "direction-cluster", direction)
      .slice(0, perDirection)
      .map((cluster) => representatives[direction].get(cluster)!),
  );
  const selectedClusters = new Set(selected.map((item) => item.sourceCaseId));
  if (
    selected.length !== perDirection * 2 ||
    selectedClusters.size !== selected.length
  ) {
    throw new Error("Directional sampler violated its global cluster-disjointness contract");
  }
  return mixSelectedCases(selected, seed);
}

export function mixSelectedCases(
  selected: readonly ReplayCase[],
  seed: number,
): ReplayCase[] {
  return selected.toSorted((left, right) => {
    const leftRank = seededHash(seed, "public-order", left.id, ...left.sourceIds);
    const rightRank = seededHash(seed, "public-order", right.id, ...right.sourceIds);
    return compareStrings(leftRank, rightRank) || compareStrings(left.id, right.id);
  });
}

function gitProvenance(): { commit: string | null; dirty: boolean | null } {
  const commit = Bun.spawnSync({
    cmd: ["git", "rev-parse", "HEAD"],
    cwd: REPO_ROOT,
  });
  const status = Bun.spawnSync({
    cmd: ["git", "status", "--porcelain"],
    cwd: REPO_ROOT,
  });
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

export function opaqueCaseId(seed: number, index: number, item: ReplayCase): string {
  return `case-${seededHash(seed, "opaque-case", String(index), item.id).slice(0, 20)}`;
}

function implementationFileHashes(): Array<{ path: string; sha256: string }> {
  return IMPLEMENTATION_PATHS.map((path) => ({
    path,
    sha256: sha256File(join(REPO_ROOT, path)),
  }));
}

function selectedCounts(selected: readonly ReplayCase[]): SelectedCounts {
  return {
    total: selected.length,
    uniqueSourceCaseIds: new Set(selected.map((item) => item.sourceCaseId)).size,
    byDirection: {
      SUP_TO_REF: selected.filter((item) => item.direction === "SUP_TO_REF").length,
      REF_TO_SUP: selected.filter((item) => item.direction === "REF_TO_SUP").length,
    },
    byRevisionType: {
      real: selected.filter((item) => item.revisionType === "real").length,
    },
  };
}

export async function prepareVitaminC(
  options: PrepareVitaminCOptions,
): Promise<PreparedManifest> {
  const inputPath = resolve(options.inputPath);
  const flaggingPath = resolve(options.flaggingPath);
  const outputDir = resolve(options.outputDir);
  validateSplitPaths(options.split, inputPath, flaggingPath);
  if (!Number.isSafeInteger(options.seed)) {
    throw new Error(`seed must be a safe integer, got ${options.seed}`);
  }
  if (!Number.isSafeInteger(options.perDirection) || options.perDirection <= 0) {
    throw new Error(
      `perDirection must be a positive integer, got ${options.perDirection}`,
    );
  }
  if (!existsSync(inputPath)) {
    throw new Error(`Missing fact-verification data: ${inputPath}`);
  }
  if (!existsSync(flaggingPath)) {
    throw new Error(`Missing required flagging data: ${flaggingPath}`);
  }
  if (existsSync(outputDir)) {
    throw new Error(`Output directory already exists: ${outputDir}`);
  }

  const factVerificationSha256 = sha256File(inputPath);
  const flaggingSha256 = sha256File(flaggingPath);
  const adapterResult = await loadNaturalDirectionReplaysWithAudit(inputPath);
  const candidates = adapterResult.cases;
  const flaggingRows = await loadFlaggingRows(flaggingPath);
  const validation = validateNaturalRealCandidates(candidates, flaggingRows);
  const selected = selectDirectionalCases(
    validation.eligible,
    options.perDirection,
    options.seed,
  );

  mkdirSync(outputDir, { recursive: true });
  const publicCasesUnsorted: PreparedPublicCase[] = [];
  const privateCases: PreparedPrivateCase[] = [];
  for (const [index, item] of selected.entries()) {
    const publicCaseId = opaqueCaseId(options.seed, index, item);
    const projectDir = join(outputDir, "public", publicCaseId, "project");
    const dbPath = join(projectDir, ".toulmin", "graph.db");
    const seedMetadata = seedPostUpdateGraph(dbPath, item, publicCaseId);
    const graphSha256 = sha256File(dbPath);
    seedMetadata.graphSha256 = graphSha256;
    publicCasesUnsorted.push({
      schemaVersion: 2,
      publicCaseId,
      projectDir: relative(outputDir, projectDir),
      graphSha256,
      evidenceSha256: sha256File(join(projectDir, EVIDENCE_ATTACHMENT)),
    });
    privateCases.push({
      schemaVersion: 2,
      publicCaseId,
      replay: item,
      seed: seedMetadata,
    });
  }

  const publicCases = publicCasesUnsorted.toSorted((left, right) =>
    compareStrings(left.publicCaseId, right.publicCaseId),
  );
  privateCases.sort((left, right) =>
    compareStrings(left.publicCaseId, right.publicCaseId),
  );

  const privateDir = join(outputDir, "private");
  const privateCasesPath = join(privateDir, "cases.jsonl");
  mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  chmodSync(privateDir, 0o700);
  writeJsonl(privateCasesPath, privateCases);
  chmodSync(privateCasesPath, 0o600);

  if (
    sha256File(inputPath) !== factVerificationSha256 ||
    sha256File(flaggingPath) !== flaggingSha256
  ) {
    throw new Error("Dataset input changed while fixtures were being prepared");
  }

  const publicManifestPath = join(outputDir, "public", "public-manifest.json");
  writeJson(publicManifestPath, {
    schemaVersion: 2,
    cases: publicCases,
  });

  const manifest: PreparedManifest = {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    adapterVersion: "vitaminc-replay/v2",
    dataset: {
      split: options.split,
      factVerificationPath: inputPath,
      factVerificationSha256,
      flaggingPath,
      flaggingSha256,
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
    selection: {
      seed: options.seed,
      perDirection: options.perDirection,
    },
    adapterAudit: adapterResult.audit,
    candidates: validation.audit,
    selectedCounts: selectedCounts(selected),
    implementationFiles: implementationFileHashes(),
    repository: gitProvenance(),
    publicCases,
    publicManifestFile: relative(outputDir, publicManifestPath),
    publicManifestSha256: sha256File(publicManifestPath),
    privateCasesFile: relative(outputDir, privateCasesPath),
    privateCasesSha256: sha256File(privateCasesPath),
  };
  writeJson(join(outputDir, "fixture-manifest.json"), manifest);
  return manifest;
}

async function main(): Promise<void> {
  const { values: opts } = parseArgs({
    options: {
      input: { type: "string", default: DEFAULT_DATA },
      flagging: { type: "string", default: DEFAULT_FLAGGING },
      split: { type: "string", default: "dev" },
      "per-direction": { type: "string", default: "2" },
      seed: { type: "string", default: String(DEFAULT_SEED) },
      "out-dir": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  if (opts.help) {
    console.log(`Prepare frozen, gold-isolated VitaminC real-revision projects.

Usage:
  bun experiments/evaluation/vitaminc/prepare.ts [options]

Options:
  --input <path>          Fact-verification JSONL
  --flagging <path>       Matching required revision-flagging JSONL
  --split <name>          Dataset split; must match both filenames (default: dev)
  --per-direction <n>     Globally disjoint real revisions per flip direction
  --seed <n>              Deterministic sampling seed
  --out-dir <path>        New output directory
`);
    return;
  }

  const outputDir = resolve(
    opts["out-dir"] ??
      join(
        REPO_ROOT,
        "experiments/evaluation/outputs/vitaminc/prepared",
        timestampId(),
      ),
  );
  const manifest = await prepareVitaminC({
    inputPath: opts.input!,
    flaggingPath: opts.flagging!,
    split: opts.split!,
    perDirection: positiveInteger(
      "--per-direction",
      opts["per-direction"],
      2,
    ),
    seed: integer("--seed", opts.seed, DEFAULT_SEED),
    outputDir,
  });

  console.log(
    `Prepared ${manifest.selectedCounts.total} real natural-direction cases from ` +
      `${basename(manifest.dataset.factVerificationPath)}`,
  );
  console.log(`  SUP_TO_REF: ${manifest.selectedCounts.byDirection.SUP_TO_REF}`);
  console.log(`  REF_TO_SUP: ${manifest.selectedCounts.byDirection.REF_TO_SUP}`);
  console.log(
    `  excluded candidates: ${Object.values(manifest.candidates.excluded).reduce(
      (sum, count) => sum + count,
      0,
    )}`,
  );
  console.log(`output: ${outputDir}`);
}

if (import.meta.main) {
  await main();
}

#!/usr/bin/env bun

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as service from "../../../src/service.ts";
import { closeFixtureDatabase, openFixtureDatabase } from "../common/graph-fixture.ts";
import { readJsonl, sha256File, sha256Text, writeJson } from "../common/manifest.ts";
import {
  SCIFACT_LABELS,
  type CandidateClaim,
  type CandidatePair,
  type FixtureCase,
  type FixtureManifest,
  type ReviewMode,
  type SelectedCandidate,
  type SciFactClaim,
  type SciFactDocument,
  type SciFactLabel,
} from "./types.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const DEFAULT_DATA_DIR = join(REPO_ROOT, "experiments", "benchmarks", "scifact", "data");
const DEFAULT_OUTPUT_ROOT = join(
  REPO_ROOT,
  "experiments",
  "evaluation",
  "outputs",
  "scifact",
  "fixtures",
);
const DEFAULT_SEED = 20260901;

export const Q1_WARRANT =
  "An empirical report whose result matches a claim in direction, population, intervention or " +
  "exposure, outcome, quantity, and scope provides evidence for that claim.";

export const Q2_WARRANT = Q1_WARRANT;

const SOURCE_SENTENCE_WARRANT =
  "A verbatim sentence in the attached source can be treated as a faithful statement of what " +
  "that source reports.";

function usage(): string {
  return `Build isolated Warranted graph fixtures from SciFact.

Usage:
  bun experiments/evaluation/scifact/build-fixtures.ts [options]

Options:
  --split <train|dev>       Labeled SciFact split (default: dev)
  --modes <names>          primary and/or q2-oracle (default: primary)
  --per-label <n>          Deterministically sample n cases per available label and mode
  --seed <n>               Sampling seed (default: ${DEFAULT_SEED})
  --data-dir <path>        Directory containing corpus.jsonl and claims_<split>.jsonl
  --out-dir <path>         New output directory; must not already exist
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

function integer(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be an integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseModes(value: string): ReviewMode[] {
  const modes = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (
    modes.length === 0 ||
    modes.some((mode) => mode !== "primary" && mode !== "q2-oracle")
  ) {
    throw new Error(
      `--modes must contain primary and/or q2-oracle; got ${JSON.stringify(value)}`,
    );
  }
  return modes as ReviewMode[];
}

function timestampId(): string {
  return new Date().toISOString().replace(/[-:.]/g, "");
}

function gitProvenance(): { repositoryCommit: string | null; repositoryDirty: boolean | null } {
  const commit = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: REPO_ROOT });
  const status = Bun.spawnSync({ cmd: ["git", "status", "--porcelain"], cwd: REPO_ROOT });
  return {
    repositoryCommit:
      commit.exitCode === 0 ? new TextDecoder().decode(commit.stdout).trim() || null : null,
    repositoryDirty:
      status.exitCode === 0 ? new TextDecoder().decode(status.stdout).trim().length > 0 : null,
  };
}

function emptyCounts(): Record<ReviewMode, Record<SciFactLabel, number>> {
  return {
    primary: { SUPPORT: 0, CONTRADICT: 0, NOINFO: 0 },
    "q2-oracle": { SUPPORT: 0, CONTRADICT: 0, NOINFO: 0 },
  };
}

/** Pair every labeled claim with each cited/evidence document. */
export function enumerateCandidatePairs(
  split: string,
  claims: SciFactClaim[],
  documents: SciFactDocument[],
): CandidatePair[] {
  const corpus = new Map<number, SciFactDocument>();
  for (const document of documents) {
    if (!Number.isSafeInteger(document.doc_id)) {
      throw new Error(`Invalid SciFact document id: ${JSON.stringify(document.doc_id)}`);
    }
    if (corpus.has(document.doc_id)) throw new Error(`Duplicate corpus document ${document.doc_id}`);
    if (!Array.isArray(document.abstract)) {
      throw new Error(`Document ${document.doc_id} has no abstract sentence array`);
    }
    corpus.set(document.doc_id, document);
  }
  const pairs: CandidatePair[] = [];
  const claimIds = new Set<number>();

  for (const row of claims) {
    if (!Number.isSafeInteger(row.id)) throw new Error(`Invalid SciFact claim id: ${row.id}`);
    if (claimIds.has(row.id)) throw new Error(`Duplicate SciFact claim ${row.id}`);
    claimIds.add(row.id);
    if (typeof row.claim !== "string" || row.claim.trim() === "") {
      throw new Error(`SciFact claim ${row.id} has empty content`);
    }
    if (row.cited_doc_ids.some((id) => !Number.isSafeInteger(id))) {
      throw new Error(`SciFact claim ${row.id} contains an invalid cited document id`);
    }
    const evidenceDocIds = Object.keys(row.evidence).map((id) => Number(id));
    if (evidenceDocIds.some((id) => !Number.isSafeInteger(id))) {
      throw new Error(`SciFact claim ${row.id} contains an invalid evidence document id`);
    }
    const docIds = new Set<number>([
      ...row.cited_doc_ids,
      ...evidenceDocIds,
    ]);
    if (docIds.size === 0) {
      throw new Error(`SciFact claim ${row.id} has no cited or evidence document`);
    }
    for (const docId of [...docIds].sort((a, b) => a - b)) {
      const document = corpus.get(docId);
      if (!document) throw new Error(`Claim ${row.id} refers to missing corpus document ${docId}`);
      const rationales = row.evidence[String(docId)] ?? [];
      const labels = [...new Set(rationales.map((rationale) => rationale.label))];
      if (labels.some((label) => label !== "SUPPORT" && label !== "CONTRADICT")) {
        throw new Error(`Claim ${row.id}, document ${docId} has an invalid rationale label`);
      }
      if (labels.length > 1) {
        throw new Error(`Claim ${row.id}, document ${docId} has conflicting rationale labels`);
      }
      for (const rationale of rationales) {
        if (!Array.isArray(rationale.sentences) || rationale.sentences.length === 0) {
          throw new Error(`Claim ${row.id}, document ${docId} has an empty rationale set`);
        }
        for (const sentenceId of rationale.sentences) {
          if (
            !Number.isSafeInteger(sentenceId) ||
            sentenceId < 0 ||
            sentenceId >= document.abstract.length
          ) {
            throw new Error(
              `Claim ${row.id}, document ${docId} has out-of-range rationale sentence ${sentenceId}`,
            );
          }
        }
      }
      const label: SciFactLabel = labels[0] ?? "NOINFO";
      pairs.push({
        split,
        claimId: row.id,
        claim: row.claim,
        docId,
        label,
        rationaleSets: rationales.map((rationale) => [...rationale.sentences]),
        document,
      });
    }
  }

  return pairs.sort((a, b) => a.claimId - b.claimId || a.docId - b.docId);
}

/** Collapse document relations into the official SciFact claim-level unit. */
export function groupCandidateClaims(candidates: CandidatePair[]): CandidateClaim[] {
  const groups = new Map<number, CandidatePair[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.claimId) ?? [];
    group.push(candidate);
    groups.set(candidate.claimId, group);
  }

  const claims: CandidateClaim[] = [];
  for (const [claimId, documents] of groups) {
    if (documents.length === 0) throw new Error(`SciFact claim ${claimId} has no cited documents`);
    const first = documents[0]!;
    if (
      documents.some(
        (item) => item.split !== first.split || item.claim !== first.claim || item.claimId !== claimId,
      )
    ) {
      throw new Error(`Candidate rows disagree within SciFact claim ${claimId}`);
    }
    const evidenceLabels = [
      ...new Set(
        documents
          .map((item) => item.label)
          .filter((label): label is Exclude<SciFactLabel, "NOINFO"> => label !== "NOINFO"),
      ),
    ];
    if (evidenceLabels.length > 1) {
      throw new Error(`SciFact claim ${claimId} has conflicting claim-level evidence labels`);
    }
    claims.push({
      split: first.split,
      claimId,
      claim: first.claim,
      label: evidenceLabels[0] ?? "NOINFO",
      documents: [...documents].sort((a, b) => a.docId - b.docId),
    });
  }
  return claims.sort((a, b) => a.claimId - b.claimId);
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(values: T[], seed: number): T[] {
  const out = [...values];
  const rng = random(seed);
  for (let index = out.length - 1; index > 0; index--) {
    const next = Math.floor(rng() * (index + 1));
    [out[index], out[next]] = [out[next]!, out[index]!];
  }
  return out;
}

export function selectCandidates(
  candidates: CandidatePair[],
  modes: ReviewMode[],
  perLabel: number | null,
  seed: number,
): SelectedCandidate[] {
  const claims = groupCandidateClaims(candidates);
  const selected: SelectedCandidate[] = [];
  for (const [modeIndex, mode] of modes.entries()) {
    for (const [labelIndex, label] of SCIFACT_LABELS.entries()) {
      // NOINFO is a valid claim-level primary negative, but has no rationale
      // sentences from which to construct the optional Q2 oracle diagnostic.
      if (mode === "q2-oracle" && label === "NOINFO") continue;
      const matching: SelectedCandidate[] =
        mode === "primary"
          ? claims
              .filter((claim) => claim.label === label)
              .map((claim) => ({ mode, claim, pair: null, rationaleSetIndex: null }))
          : candidates
              .filter((candidate) => candidate.label === label)
              .flatMap((pair) =>
                pair.rationaleSets.map((_sentences, rationaleSetIndex) => ({
                  mode,
                  claim: claims.find((item) => item.claimId === pair.claimId)!,
                  pair,
                  rationaleSetIndex,
                })),
              );
      if (perLabel !== null && matching.length < perLabel) {
        throw new Error(
          `Requested ${perLabel} ${label} ${mode} cases, but only ${matching.length} are available`,
        );
      }
      const picked =
        perLabel === null
          ? matching
          : shuffled(matching, seed + modeIndex * 1009 + labelIndex * 9176).slice(0, perLabel);
      selected.push(...picked);
    }
  }
  return selected.sort(
    (a, b) =>
      a.mode.localeCompare(b.mode) ||
      a.claim.claimId - b.claim.claimId ||
      (a.pair?.docId ?? -1) - (b.pair?.docId ?? -1) ||
      (a.rationaleSetIndex ?? -1) - (b.rationaleSetIndex ?? -1),
  );
}

export function renderAbstract(document: SciFactDocument): string {
  return [
    `# ${document.title}`,
    "",
    ...document.abstract.map((sentence, index) => `[${index}] ${sentence}`),
    "",
  ].join("\n");
}

export function buildFixtureCase(
  outputDir: string,
  candidate: SelectedCandidate,
  caseId: string,
): FixtureCase {
  const { mode, claim, pair, rationaleSetIndex } = candidate;
  const projectRelative = join("cases", caseId, "project");
  const projectDir = join(outputDir, projectRelative);
  mkdirSync(join(projectDir, "evidence"), { recursive: true });

  const sourcePairs = mode === "primary" ? claim.documents : [pair];
  const attachments = sourcePairs.map((sourcePair) => {
    const path = join("evidence", `${sourcePair.docId}.md`);
    writeFileSync(join(projectDir, path), renderAbstract(sourcePair.document), "utf8");
    return {
      docId: sourcePair.docId,
      path,
      sha256: sha256File(join(projectDir, path)),
      goldLabel: sourcePair.label,
      goldRationaleSets:
        mode === "q2-oracle"
          ? [sourcePair.rationaleSets[rationaleSetIndex]!]
          : sourcePair.rationaleSets.map((set) => [...set]),
    };
  });

  const { db, dbPath, ctx } = openFixtureDatabase(projectDir);
  let targetId: number;
  try {
    if (mode === "primary") {
      targetId = service.createPropositions(db, ctx, [
        {
          content: claim.claim,
          warrant: Q1_WARRANT,
          evidence: { attachments: attachments.map((attachment) => attachment.path) },
          note: "Deterministic SciFact claim-level oracle-cited-abstracts review fixture.",
        },
      ])[0]!.id;
    } else {
      const sentenceIds = pair.rationaleSets[rationaleSetIndex];
      if (!sentenceIds || sentenceIds.length === 0) {
        throw new Error(`Q2 fixture ${caseId} has an empty rationale set`);
      }
      const rationaleSentences = sentenceIds.map((sentenceId) => {
        const sentence = pair.document.abstract[sentenceId];
        if (sentence === undefined) {
          throw new Error(
            `Claim ${pair.claimId}, document ${pair.docId} refers to missing sentence ${sentenceId}`,
          );
        }
        return sentence;
      });
      const evidence = service.createPropositions(
        db,
        ctx,
        rationaleSentences.map((sentence) => ({
          content: `The abstract “${pair.document.title}” reports: ${sentence}`,
          warrant: SOURCE_SENTENCE_WARRANT,
          evidence: { attachments: [attachments[0]!.path] },
          note: "Source-grounded premise for a deterministic SciFact Q2-oracle fixture.",
        })),
      );
      service.setQualifier(
        db,
        ctx,
        evidence.map((item) => ({
          id: item.id,
          qualifier: "certainly" as const,
          note: "The proposition is copied verbatim from the attached abstract.",
        })),
      );
      targetId = service.createPropositions(db, ctx, [
        {
          content: pair.claim,
          warrant: Q2_WARRANT,
          evidence: { nodes: evidence.map((item) => item.id) },
          note: "Deterministic SciFact Q2-oracle review fixture.",
        },
      ])[0]!.id;
    }
  } finally {
    closeFixtureDatabase(db, dbPath);
  }

  return {
    schemaVersion: 2,
    caseId,
    mode,
    split: claim.split,
    claimId: claim.claimId,
    docIds: attachments.map((attachment) => attachment.docId),
    goldLabel: claim.label,
    goldRationaleSetIndex: rationaleSetIndex,
    goldRationaleDocId: pair?.docId ?? null,
    projectDir: relative(outputDir, projectDir),
    attachments,
    graphSha256: sha256File(join(projectDir, ".toulmin", "graph.db")),
    targetId,
    expected: {
      question: mode === "primary" ? "COMBINED" : "Q2",
      verdict: claim.label === "SUPPORT" ? "pass" : "fail",
    },
  };
}

export interface BuildOptions {
  split: "train" | "dev";
  modes: ReviewMode[];
  perLabel: number | null;
  seed: number;
  dataDir: string;
  outputDir: string;
}

export function buildFixtures(options: BuildOptions): FixtureManifest {
  if (existsSync(options.outputDir)) {
    throw new Error(`Output directory already exists; refusing to overwrite: ${options.outputDir}`);
  }
  const corpusPath = join(options.dataDir, "corpus.jsonl");
  const claimsPath = join(options.dataDir, `claims_${options.split}.jsonl`);
  if (!existsSync(corpusPath)) throw new Error(`Missing SciFact corpus: ${corpusPath}`);
  if (!existsSync(claimsPath)) throw new Error(`Missing SciFact claims: ${claimsPath}`);

  const claims = readJsonl<SciFactClaim>(claimsPath);
  const documents = readJsonl<SciFactDocument>(corpusPath);
  const candidates = enumerateCandidatePairs(options.split, claims, documents);
  const selected = selectCandidates(candidates, options.modes, options.perLabel, options.seed);
  mkdirSync(options.outputDir, { recursive: true });

  const sequence: Record<ReviewMode, number> = { primary: 0, "q2-oracle": 0 };
  const cases = selected.map((candidate) => {
    const ordinal = ++sequence[candidate.mode];
    const caseId = `${candidate.mode}-${String(ordinal).padStart(6, "0")}`;
    return buildFixtureCase(options.outputDir, candidate, caseId);
  });
  const counts = emptyCounts();
  for (const fixture of cases) counts[fixture.mode][fixture.goldLabel]++;

  const manifest: FixtureManifest = {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    adapter: {
      version: "scifact-review/v2",
      primaryUnit: "claim",
      attachmentPolicy: "all-cited-and-evidence-abstracts",
      positiveLabel: "SUPPORT",
      negativeLabels: ["CONTRADICT", "NOINFO"],
      warrant: Q1_WARRANT,
      warrantSha256: sha256Text(Q1_WARRANT),
      ...gitProvenance(),
    },
    dataset: {
      name: "SciFact",
      split: options.split,
      corpusPath,
      claimsPath,
      corpusSha256: sha256File(corpusPath),
      claimsSha256: sha256File(claimsPath),
    },
    selection: {
      modes: options.modes,
      seed: options.seed,
      perLabel: options.perLabel,
    },
    counts,
    cases,
  };
  writeJson(join(options.outputDir, "fixture-manifest.json"), manifest);
  return manifest;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    strict: true,
    allowPositionals: false,
    options: {
      split: { type: "string", default: "dev" },
      modes: { type: "string", default: "primary" },
      "per-label": { type: "string" },
      seed: { type: "string" },
      "data-dir": { type: "string" },
      "out-dir": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(usage());
    return;
  }
  if (values.split !== "train" && values.split !== "dev") {
    throw new Error(`--split must be train or dev; test is unlabeled`);
  }
  const outputDir = resolve(
    values["out-dir"] ?? join(DEFAULT_OUTPUT_ROOT, `${values.split}-${timestampId()}`),
  );
  const manifest = buildFixtures({
    split: values.split,
    modes: parseModes(values.modes),
    perLabel: positiveInteger("--per-label", values["per-label"]),
    seed: integer("--seed", values.seed, DEFAULT_SEED),
    dataDir: resolve(values["data-dir"] ?? DEFAULT_DATA_DIR),
    outputDir,
  });
  console.log(`Built ${manifest.cases.length} fixture(s): ${join(outputDir, "fixture-manifest.json")}`);
  for (const mode of manifest.selection.modes) {
    const counts = manifest.counts[mode];
    console.log(
      `  ${mode}: SUPPORT=${counts.SUPPORT}, CONTRADICT=${counts.CONTRADICT}, NOINFO=${counts.NOINFO}`,
    );
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`scifact fixture build failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}

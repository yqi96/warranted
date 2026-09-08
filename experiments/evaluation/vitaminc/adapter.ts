import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type {
  AdapterAudit,
  ReplayCase,
  ReplayDirection,
  VitaminCLabel,
  VitaminCRow,
} from "./types.ts";

const TEMPORAL_PAIRS = [
  [1, 2],
  [3, 4],
] as const;

const DEFAULT_SAMPLE_SEED = "vitaminc-natural-direction-v1";

type TemporalSuffix = 1 | 2 | 3 | 4;

interface CandidateReplay extends ReplayCase {
  temporalStart: 1 | 3;
  duplicateKey: string;
}

type CandidateBuildRejectReason = keyof AdapterAudit["candidateBuildRejects"];

type CandidateBuildResult =
  | { candidate: CandidateReplay; rejection?: never }
  | { candidate?: never; rejection: CandidateBuildRejectReason };

export interface NaturalDirectionReplayBuild {
  cases: ReplayCase[];
  audit: AdapterAudit;
}

export interface SeededStratifiedSampleOptions<T> {
  seed: string | number;
  stratum: (item: T) => string;
  key: (item: T) => string;
  quota: number | Readonly<Record<string, number>>;
}

export interface ReplaySampleOptions {
  seed?: string | number;
  perDirection:
    | number
    | Readonly<Partial<Record<ReplayDirection, number>>>;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeOptional(value: string | undefined): string {
  return value === undefined ? "" : normalizeText(value);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function temporalSuffix(row: VitaminCRow): TemporalSuffix | undefined {
  if (typeof row.unique_id !== "string" || typeof row.case_id !== "string") {
    return undefined;
  }
  const match = /^(.*)_([1-4])$/.exec(row.unique_id);
  if (!match || match[1] !== row.case_id) return undefined;
  return Number(match[2]) as TemporalSuffix;
}

function labelDirection(
  before: VitaminCRow,
  after: VitaminCRow,
): {
  direction: ReplayDirection;
  y0: VitaminCLabel;
  y1: VitaminCLabel;
} | undefined {
  if (before.label === "SUPPORTS" && after.label === "REFUTES") {
    return { direction: "SUP_TO_REF", y0: "SUPPORTS", y1: "REFUTES" };
  }
  if (before.label === "REFUTES" && after.label === "SUPPORTS") {
    return { direction: "REF_TO_SUP", y0: "REFUTES", y1: "SUPPORTS" };
  }
  return undefined;
}

function buildCandidate(
  before: VitaminCRow,
  after: VitaminCRow,
  temporalStart: 1 | 3,
): CandidateBuildResult {
  const labels = labelDirection(before, after);
  if (!labels) return { rejection: "nonFlip" };
  const beforeRevision = before.wiki_revision_id ?? before.FEVER_id;
  const afterRevision = after.wiki_revision_id ?? after.FEVER_id;

  if (
    !before.case_id ||
    before.case_id !== after.case_id ||
    !beforeRevision ||
    beforeRevision !== afterRevision ||
    normalizeOptional(before.page) !== normalizeOptional(after.page) ||
    normalizeOptional(before.revision_type) !== normalizeOptional(after.revision_type)
  ) {
    return { rejection: "metadataInconsistency" };
  }
  if (
    !before.claim ||
    !after.claim ||
    normalizeText(before.claim) !== normalizeText(after.claim) ||
    !before.evidence ||
    !after.evidence ||
    normalizeText(before.evidence) === normalizeText(after.evidence)
  ) {
    return { rejection: "contentInconsistency" };
  }

  const pairId = `vc-${shortHash(`${before.case_id}\u0000${temporalStart}`)}`;
  const duplicateKey = [
    normalizeText(before.claim),
    normalizeText(before.evidence),
    normalizeText(after.evidence),
    labels.y0,
    labels.y1,
  ].join("\u0000");

  return {
    candidate: {
      id: pairId,
      pairId,
      direction: labels.direction,
      claim: before.claim,
      e0: before.evidence,
      y0: labels.y0,
      e1: after.evidence,
      y1: labels.y1,
      sourceIds: [before.unique_id, after.unique_id],
      sourceCaseId: before.case_id,
      wikiRevisionId: beforeRevision,
      page: before.page,
      revisionType: before.revision_type,
      temporalStart,
      duplicateKey,
    },
  };
}

/**
 * Build only naturally ordered VitaminC label flips. `_1 -> _2` and
 * `_3 -> _4` are the two before/after pairs emitted for each source revision.
 * A pair is discarded when either slot is duplicated or its provenance/text
 * is inconsistent. Duplicate semantic tuples are discarded in full rather
 * than selecting an arbitrary source.
 */
export function buildNaturalDirectionReplaysWithAudit(
  rows: Iterable<VitaminCRow>,
): NaturalDirectionReplayBuild {
  const grouped = new Map<string, Map<TemporalSuffix, VitaminCRow[]>>();
  const audit: AdapterAudit = {
    inputRows: 0,
    recognizedTemporalRows: 0,
    expectedTemporalPairs: 0,
    completeUniqueSlotPairs: 0,
    slotPairDrops: {
      missing: 0,
      duplicated: 0,
    },
    candidateBuildRejects: {
      nonFlip: 0,
      metadataInconsistency: 0,
      contentInconsistency: 0,
    },
    candidatesBeforeSemanticDedup: 0,
    duplicateSemanticTupleGroups: 0,
    duplicateSemanticTupleCandidatesDropped: 0,
    emittedCandidates: 0,
  };

  for (const row of rows) {
    audit.inputRows += 1;
    const suffix = temporalSuffix(row);
    if (suffix === undefined) continue;
    audit.recognizedTemporalRows += 1;
    const slots = grouped.get(row.case_id) ?? new Map<TemporalSuffix, VitaminCRow[]>();
    const values = slots.get(suffix) ?? [];
    values.push(row);
    slots.set(suffix, values);
    grouped.set(row.case_id, slots);
  }

  const candidates: CandidateReplay[] = [];
  audit.expectedTemporalPairs = grouped.size * TEMPORAL_PAIRS.length;
  for (const sourceCaseId of [...grouped.keys()].sort()) {
    const slots = grouped.get(sourceCaseId)!;
    for (const [beforeSuffix, afterSuffix] of TEMPORAL_PAIRS) {
      const beforeRows = slots.get(beforeSuffix);
      const afterRows = slots.get(afterSuffix);
      if (!beforeRows || !afterRows) {
        audit.slotPairDrops.missing += 1;
        continue;
      }
      if (beforeRows.length !== 1 || afterRows.length !== 1) {
        audit.slotPairDrops.duplicated += 1;
        continue;
      }
      audit.completeUniqueSlotPairs += 1;
      const result = buildCandidate(
        beforeRows[0]!,
        afterRows[0]!,
        beforeSuffix,
      );
      if (result.rejection) {
        audit.candidateBuildRejects[result.rejection] += 1;
      } else {
        candidates.push(result.candidate!);
      }
    }
  }
  audit.candidatesBeforeSemanticDedup = candidates.length;

  const duplicateCounts = new Map<string, number>();
  for (const candidate of candidates) {
    duplicateCounts.set(
      candidate.duplicateKey,
      (duplicateCounts.get(candidate.duplicateKey) ?? 0) + 1,
    );
  }

  audit.duplicateSemanticTupleGroups = [...duplicateCounts.values()].filter(
    (count) => count > 1,
  ).length;
  audit.duplicateSemanticTupleCandidatesDropped = candidates.filter(
    (candidate) => duplicateCounts.get(candidate.duplicateKey)! > 1,
  ).length;

  const cases = candidates
    .filter((candidate) => duplicateCounts.get(candidate.duplicateKey) === 1)
    .sort(
      (a, b) =>
        a.sourceCaseId.localeCompare(b.sourceCaseId) ||
        a.temporalStart - b.temporalStart,
    )
    .map(({ temporalStart: _temporalStart, duplicateKey: _duplicateKey, ...replay }) => replay);
  audit.emittedCandidates = cases.length;
  return { cases, audit };
}

export function buildNaturalDirectionReplays(
  rows: Iterable<VitaminCRow>,
): ReplayCase[] {
  return buildNaturalDirectionReplaysWithAudit(rows).cases;
}

/**
 * Deterministic, input-order-independent sampling within arbitrary strata.
 * SHA-256 ranking avoids a mutable PRNG and makes a frozen seed reproducible
 * across processes and Bun versions.
 */
export function seededStratifiedSample<T>(
  items: readonly T[],
  options: SeededStratifiedSampleOptions<T>,
): T[] {
  const strata = new Map<string, T[]>();
  for (const item of items) {
    const name = options.stratum(item);
    const values = strata.get(name) ?? [];
    values.push(item);
    strata.set(name, values);
  }

  const sampled: T[] = [];
  for (const name of [...strata.keys()].sort()) {
    const quota =
      typeof options.quota === "number"
        ? options.quota
        : (options.quota[name] ?? 0);
    if (!Number.isInteger(quota) || quota < 0) {
      throw new Error(`invalid quota for stratum ${name}: ${quota}`);
    }
    const ranked = strata.get(name)!.toSorted((a, b) => {
      const aKey = options.key(a);
      const bKey = options.key(b);
      const aRank = shortHash(`${options.seed}\u0000${name}\u0000${aKey}`);
      const bRank = shortHash(`${options.seed}\u0000${name}\u0000${bKey}`);
      return aRank.localeCompare(bRank) || aKey.localeCompare(bKey);
    });
    sampled.push(...ranked.slice(0, quota));
  }
  return sampled;
}

/** Sample equal or explicitly configured quotas from the two natural directions. */
export function sampleReplayCases(
  cases: readonly ReplayCase[],
  options: ReplaySampleOptions,
): ReplayCase[] {
  const quota =
    typeof options.perDirection === "number"
      ? options.perDirection
      : {
          SUP_TO_REF: options.perDirection.SUP_TO_REF ?? 0,
          REF_TO_SUP: options.perDirection.REF_TO_SUP ?? 0,
        };
  return seededStratifiedSample(cases, {
    seed: options.seed ?? DEFAULT_SAMPLE_SEED,
    stratum: (item) => item.direction,
    key: (item) => `${item.sourceCaseId}\u0000${item.sourceIds.join("\u0000")}`,
    quota,
  });
}

export async function loadNaturalDirectionReplays(
  inputPath: string,
): Promise<ReplayCase[]> {
  return (await loadNaturalDirectionReplaysWithAudit(inputPath)).cases;
}

export async function loadNaturalDirectionReplaysWithAudit(
  inputPath: string,
): Promise<NaturalDirectionReplayBuild> {
  const rows: VitaminCRow[] = [];
  const lines = createInterface({
    input: createReadStream(inputPath),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line) as VitaminCRow);
  }
  return buildNaturalDirectionReplaysWithAudit(rows);
}

/**
 * Backwards-compatible entry point for the first runner. The numeric argument
 * now means a quota per natural direction; no source pair is ever reversed.
 */
export async function loadBidirectionalReplays(
  inputPath: string,
  limitPerDirection: number,
): Promise<ReplayCase[]> {
  if (!Number.isInteger(limitPerDirection) || limitPerDirection < 0) {
    throw new Error("limitPerDirection must be a non-negative integer");
  }
  return sampleReplayCases(await loadNaturalDirectionReplays(inputPath), {
    seed: DEFAULT_SAMPLE_SEED,
    perDirection: limitPerDirection,
  });
}

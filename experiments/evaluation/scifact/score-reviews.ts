#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readJson, readJsonl, sha256File, sha256Text, writeJson } from "../common/manifest.ts";
import type {
  CaseScore,
  ClusterBootstrapSummary,
  FixtureCase,
  FixtureManifest,
  LabelScore,
  ModeScore,
  ReviewCaseResult,
  ReviewMode,
  ReviewRunManifest,
  SciFactDocument,
  ScoreSummary,
} from "./types.ts";

function usage(): string {
  return `Score a completed SciFact Warranted-review run without calling a model.

Usage:
  bun experiments/evaluation/scifact/score-reviews.ts --run-dir <path> [options]

Options:
  --run-dir <path>          Directory containing run-manifest.json
  --fixtures <path>         Override the fixture manifest locked by the run
  --out-dir <path>          New score output directory (default: <run-dir>/scores)
  --allow-incomplete        Score successful cases while reporting failures separately
  --help                    Show this help
`;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function csvCell(value: unknown): string {
  const string = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

function documentMap(documents: SciFactDocument[]): Map<number, SciFactDocument> {
  return new Map(documents.map((document) => [document.doc_id, document]));
}

export function validateFixtureManifest(manifest: FixtureManifest): void {
  if (manifest.schemaVersion !== 2) {
    throw new Error(`Unsupported fixture manifest schema: ${manifest.schemaVersion}`);
  }
  if (manifest.adapter.version !== "scifact-review/v2") {
    throw new Error(`Unsupported SciFact adapter version: ${manifest.adapter.version}`);
  }
  if (
    manifest.adapter.primaryUnit !== "claim" ||
    manifest.adapter.attachmentPolicy !== "all-cited-and-evidence-abstracts" ||
    manifest.adapter.positiveLabel !== "SUPPORT" ||
    JSON.stringify(manifest.adapter.negativeLabels) !== JSON.stringify(["CONTRADICT", "NOINFO"])
  ) {
    throw new Error("Fixture manifest has an unsupported claim/attachment/label policy");
  }
  if (sha256Text(manifest.adapter.warrant) !== manifest.adapter.warrantSha256) {
    throw new Error("Fixture manifest warrant hash mismatch");
  }
  assertUnique(manifest.cases.map((fixture) => fixture.caseId), "fixture case id");
  assertUnique(manifest.selection.modes, "selected fixture mode");
  const selectedModes = new Set(manifest.selection.modes);
  const observed = {
    primary: { SUPPORT: 0, CONTRADICT: 0, NOINFO: 0 },
    "q2-oracle": { SUPPORT: 0, CONTRADICT: 0, NOINFO: 0 },
  };
  const primaryClaimIds: string[] = [];
  for (const fixture of manifest.cases) {
    if (fixture.schemaVersion !== 2) {
      throw new Error(`Fixture ${fixture.caseId} has unsupported schema ${fixture.schemaVersion}`);
    }
    if (!selectedModes.has(fixture.mode)) {
      throw new Error(`Fixture ${fixture.caseId} has an unselected mode ${fixture.mode}`);
    }
    if (!Array.isArray(fixture.attachments) || fixture.attachments.length === 0) {
      throw new Error(`Fixture ${fixture.caseId} has no abstract attachment`);
    }
    assertUnique(fixture.attachments.map((item) => item.path), `${fixture.caseId} attachment path`);
    assertUnique(
      fixture.attachments.map((item) => String(item.docId)),
      `${fixture.caseId} attachment document`,
    );
    const attachmentDocIds = fixture.attachments.map((item) => item.docId);
    if (JSON.stringify(fixture.docIds) !== JSON.stringify(attachmentDocIds)) {
      throw new Error(`Fixture ${fixture.caseId} docIds disagree with its attachments`);
    }
    if (attachmentDocIds.some((docId, index) => index > 0 && docId <= attachmentDocIds[index - 1]!)) {
      throw new Error(`Fixture ${fixture.caseId} attachments are not sorted by document id`);
    }
    for (const attachment of fixture.attachments) {
      if (!Number.isSafeInteger(attachment.docId)) {
        throw new Error(`Fixture ${fixture.caseId} has an invalid attachment document id`);
      }
      if (attachment.goldLabel === "NOINFO" && attachment.goldRationaleSets.length > 0) {
        throw new Error(`Fixture ${fixture.caseId} gives a NOINFO attachment a gold rationale`);
      }
      if (attachment.goldLabel !== "NOINFO" && attachment.goldRationaleSets.length === 0) {
        throw new Error(`Fixture ${fixture.caseId} has evidence without a gold rationale`);
      }
      if (attachment.goldRationaleSets.some((set) => set.length === 0)) {
        throw new Error(`Fixture ${fixture.caseId} has an empty gold rationale set`);
      }
    }
    const expected = fixture.goldLabel === "SUPPORT" ? "pass" : "fail";
    if (fixture.expected.verdict !== expected) {
      throw new Error(`Fixture ${fixture.caseId} has an invalid gold verdict mapping`);
    }
    if (fixture.mode === "primary" && fixture.expected.question !== "COMBINED") {
      throw new Error(`Primary fixture ${fixture.caseId} must use the combined Q1/Q2 endpoint`);
    }
    const evidenceLabels = [
      ...new Set(
        fixture.attachments
          .map((item) => item.goldLabel)
          .filter((label) => label !== "NOINFO"),
      ),
    ];
    if (fixture.mode === "primary") {
      primaryClaimIds.push(String(fixture.claimId));
      if (fixture.goldRationaleDocId !== null || fixture.goldRationaleSetIndex !== null) {
        throw new Error(`Primary fixture ${fixture.caseId} must not select one gold rationale`);
      }
      if (evidenceLabels.length > 1 || (evidenceLabels[0] ?? "NOINFO") !== fixture.goldLabel) {
        throw new Error(`Primary fixture ${fixture.caseId} has inconsistent claim/document labels`);
      }
    } else {
      if (fixture.expected.question !== "Q2") {
        throw new Error(`Q2-oracle fixture ${fixture.caseId} must use the Q2 endpoint`);
      }
      if (
        fixture.goldLabel === "NOINFO" ||
        fixture.attachments.length !== 1 ||
        fixture.goldRationaleDocId !== fixture.attachments[0]!.docId ||
        fixture.goldRationaleSetIndex === null ||
        fixture.attachments[0]!.goldLabel !== fixture.goldLabel
      ) {
        throw new Error(`Q2-oracle fixture ${fixture.caseId} has invalid rationale provenance`);
      }
    }
    observed[fixture.mode][fixture.goldLabel]++;
  }
  assertUnique(primaryClaimIds, "primary fixture claim id");
  for (const mode of ["primary", "q2-oracle"] as const) {
    for (const label of ["SUPPORT", "CONTRADICT", "NOINFO"] as const) {
      if (manifest.counts[mode][label] !== observed[mode][label]) {
        throw new Error(`Fixture count mismatch for ${mode}/${label}`);
      }
    }
  }
}

interface QuoteAssessment {
  inSource: boolean;
  matchingSentenceIds: number[];
  ambiguous: boolean;
  hitsGoldRationale: boolean;
}

export function assessQuote(
  quote: string,
  document: SciFactDocument,
  goldRationaleSets: number[][],
  attachmentText?: string,
): QuoteAssessment {
  const normalizedQuote = normalize(quote);
  const source = normalize(
    attachmentText ??
      [
        `# ${document.title}`,
        "",
        ...document.abstract.map((sentence, index) => `[${index}] ${sentence}`),
      ].join("\n"),
  );
  const matchingSentenceIds = document.abstract.flatMap((sentence, index) => {
    const normalizedSentence = normalize(sentence);
    const renderedSentence = normalize(`[${index}] ${sentence}`);
    return normalizedSentence.includes(normalizedQuote) || renderedSentence.includes(normalizedQuote)
      ? [index]
      : [];
  });
  const gold = new Set(goldRationaleSets.flat());
  const membership = new Set(matchingSentenceIds.map((id) => gold.has(id)));
  const ambiguous = membership.size > 1;
  return {
    inSource: normalizedQuote.length > 0 && source.includes(normalizedQuote),
    matchingSentenceIds,
    ambiguous,
    hitsGoldRationale:
      normalizedQuote.length > 0 &&
      source.includes(normalizedQuote) &&
      matchingSentenceIds.length > 0 &&
      !ambiguous &&
      matchingSentenceIds.every((id) => gold.has(id)),
  };
}

function locatorMatchesSentence(locator: string, sentenceIds: number[]): boolean {
  const normalized = locator.toLowerCase();
  return sentenceIds.some((sentenceId) => {
    const renderedLine = sentenceId + 3;
    return (
      normalized.includes(`[${sentenceId}]`) ||
      new RegExp(`\\bsentence\\s*${sentenceId}\\b`).test(normalized) ||
      new RegExp(`\\bline\\s*${renderedLine}\\b`).test(normalized)
    );
  });
}

function scoreMode(cases: CaseScore[], mode: ReviewMode): ModeScore {
  const selected = cases.filter((item) => item.mode === mode);
  const completed = selected.filter((item) => item.actual !== "error");
  const tp = completed.filter((item) => item.expected === "pass" && item.actual === "pass").length;
  const tn = completed.filter((item) => item.expected === "fail" && item.actual === "fail").length;
  const fp = completed.filter((item) => item.expected === "fail" && item.actual === "pass").length;
  const positiveCases = completed.filter((item) => item.expected === "pass").length;
  const negativeCases = completed.filter((item) => item.expected === "fail").length;
  const contradictCases = completed.filter((item) => item.goldLabel === "CONTRADICT");
  const noInfoCases = completed.filter((item) => item.goldLabel === "NOINFO");
  const positiveMisses = positiveCases - tp;
  const negativeMisses = negativeCases - tn;
  const positivePredictedFail = completed.filter(
    (item) => item.expected === "pass" && item.actual === "fail",
  ).length;
  const positiveF1 = ratio(2 * tp, 2 * tp + fp + positiveMisses);
  const negativeF1 = ratio(2 * tn, 2 * tn + positivePredictedFail + negativeMisses);
  const correct = tp + tn;
  const failedVerdicts = completed.filter((item) => item.actual === "fail").length;
  const failuresWithFinding = completed.filter(
    (item) => item.actual === "fail" && item.hasRequiredFinding === true,
  ).length;
  return {
    total: selected.length,
    completed: completed.length,
    errors: selected.length - completed.length,
    coverage: ratio(completed.length, selected.length),
    failureRate: ratio(selected.length - completed.length, selected.length),
    invalidVerdicts: completed.filter((item) => item.invalidVerdict).length,
    correct,
    accuracy: ratio(correct, completed.length),
    endToEndAccuracy: ratio(correct, selected.length),
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, positiveCases),
    supportRecall: ratio(tp, positiveCases),
    negativeRecall: ratio(tn, negativeCases),
    contradictRecall: ratio(
      contradictCases.filter((item) => item.actual === "fail").length,
      contradictCases.length,
    ),
    noInfoRecall: ratio(
      noInfoCases.filter((item) => item.actual === "fail").length,
      noInfoCases.length,
    ),
    f1: positiveF1,
    macroF1:
      positiveF1 === null || negativeF1 === null ? null : (positiveF1 + negativeF1) / 2,
    negativeCases,
    falsePasses: fp,
    falsePassRate: ratio(fp, negativeCases),
    positiveCases,
    falseFails: positiveMisses,
    falseFailRate: ratio(positiveMisses, positiveCases),
    failedVerdicts,
    failuresWithFinding,
    failureFindingCoverage: ratio(failuresWithFinding, failedVerdicts),
  };
}

function scoreLabel(cases: CaseScore[], mode: ReviewMode, label: CaseScore["goldLabel"]): LabelScore {
  const selected = cases.filter((item) => item.mode === mode && item.goldLabel === label);
  const completed = selected.filter((item) => item.actual !== "error");
  const correct = completed.filter((item) => item.correct).length;
  return {
    total: selected.length,
    completed: completed.length,
    errors: selected.length - completed.length,
    pass: completed.filter((item) => item.actual === "pass").length,
    fail: completed.filter((item) => item.actual === "fail").length,
    n_a: completed.filter((item) => item.actual === "n/a").length,
    correct,
    accuracy: ratio(correct, completed.length),
  };
}

function percentile(sorted: number[], probability: number): number {
  if (sorted.length === 0) throw new Error("Cannot take a percentile of an empty sample");
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  const weight = index - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function binaryMetrics(cases: CaseScore[]): {
  accuracy: number;
  macroF1: number | null;
  falseSupportedRate: number | null;
  supportRecall: number | null;
  negativeRecall: number | null;
  contradictRecall: number | null;
  noInfoRecall: number | null;
} {
  const tp = cases.filter((item) => item.expected === "pass" && item.actual === "pass").length;
  const tn = cases.filter((item) => item.expected === "fail" && item.actual === "fail").length;
  const fp = cases.filter((item) => item.expected === "fail" && item.actual === "pass").length;
  const fn = cases.filter((item) => item.expected === "pass" && item.actual === "fail").length;
  const positiveF1 = ratio(2 * tp, 2 * tp + fp + fn);
  const negativeF1 = ratio(2 * tn, 2 * tn + fp + fn);
  const contradictCases = cases.filter((item) => item.goldLabel === "CONTRADICT");
  const noInfoCases = cases.filter((item) => item.goldLabel === "NOINFO");
  return {
    accuracy: (tp + tn) / cases.length,
    macroF1:
      positiveF1 === null || negativeF1 === null ? null : (positiveF1 + negativeF1) / 2,
    falseSupportedRate: ratio(fp, tn + fp),
    supportRecall: ratio(tp, tp + fn),
    negativeRecall: ratio(tn, tn + fp),
    contradictRecall: ratio(
      contradictCases.filter((item) => item.actual === "fail").length,
      contradictCases.length,
    ),
    noInfoRecall: ratio(
      noInfoCases.filter((item) => item.actual === "fail").length,
      noInfoCases.length,
    ),
  };
}

export function claimClusterBootstrap(
  cases: CaseScore[],
  iterations = 10_000,
  seed = 20260901,
): ClusterBootstrapSummary | null {
  const selected = cases.filter((item) => item.mode === "primary");
  if (
    selected.length === 0 ||
    selected.some((item) => item.actual !== "pass" && item.actual !== "fail")
  ) {
    return null;
  }
  const clusters = new Map<number, CaseScore[]>();
  for (const item of selected) {
    const cluster = clusters.get(item.claimId) ?? [];
    cluster.push(item);
    clusters.set(item.claimId, cluster);
  }
  const clusterCases = [...clusters.values()];
  const rng = seededRandom(seed);
  const accuracy: number[] = [];
  const macroF1: number[] = [];
  const falseSupportedRate: number[] = [];
  const supportRecall: number[] = [];
  const negativeRecall: number[] = [];
  const contradictRecall: number[] = [];
  const noInfoRecall: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const sample: CaseScore[] = [];
    for (let index = 0; index < clusterCases.length; index++) {
      sample.push(...clusterCases[Math.floor(rng() * clusterCases.length)]!);
    }
    const metrics = binaryMetrics(sample);
    accuracy.push(metrics.accuracy);
    if (metrics.macroF1 !== null) macroF1.push(metrics.macroF1);
    if (metrics.falseSupportedRate !== null) falseSupportedRate.push(metrics.falseSupportedRate);
    if (metrics.supportRecall !== null) supportRecall.push(metrics.supportRecall);
    if (metrics.negativeRecall !== null) negativeRecall.push(metrics.negativeRecall);
    if (metrics.contradictRecall !== null) contradictRecall.push(metrics.contradictRecall);
    if (metrics.noInfoRecall !== null) noInfoRecall.push(metrics.noInfoRecall);
  }
  accuracy.sort((a, b) => a - b);
  macroF1.sort((a, b) => a - b);
  falseSupportedRate.sort((a, b) => a - b);
  supportRecall.sort((a, b) => a - b);
  negativeRecall.sort((a, b) => a - b);
  contradictRecall.sort((a, b) => a - b);
  noInfoRecall.sort((a, b) => a - b);
  const estimate = binaryMetrics(selected);
  const interval = (values: number[], point: number) => ({
    estimate: point,
    lower: percentile(values, 0.025),
    upper: percentile(values, 0.975),
  });
  return {
    unit: "claim",
    clusters: clusterCases.length,
    cases: selected.length,
    iterations,
    seed,
    confidenceLevel: 0.95,
    accuracy: interval(accuracy, estimate.accuracy),
    macroF1:
      estimate.macroF1 === null || macroF1.length === 0
        ? null
        : interval(macroF1, estimate.macroF1),
    falseSupportedRate:
      estimate.falseSupportedRate === null || falseSupportedRate.length === 0
        ? null
        : interval(falseSupportedRate, estimate.falseSupportedRate),
    supportRecall:
      estimate.supportRecall === null || supportRecall.length === 0
        ? null
        : interval(supportRecall, estimate.supportRecall),
    negativeRecall:
      estimate.negativeRecall === null || negativeRecall.length === 0
        ? null
        : interval(negativeRecall, estimate.negativeRecall),
    contradictRecall:
      estimate.contradictRecall === null || contradictRecall.length === 0
        ? null
        : interval(contradictRecall, estimate.contradictRecall),
    noInfoRecall:
      estimate.noInfoRecall === null || noInfoRecall.length === 0
        ? null
        : interval(noInfoRecall, estimate.noInfoRecall),
  };
}

export function scoreReviewCases(
  manifest: FixtureManifest,
  results: ReviewCaseResult[],
  documents: SciFactDocument[],
  fixtureManifestDir?: string,
): ScoreSummary {
  validateFixtureManifest(manifest);
  assertUnique(results.map((result) => result.caseId), "result case id");
  const fixtures = new Map(manifest.cases.map((fixture) => [fixture.caseId, fixture]));
  const corpus = documentMap(documents);
  const caseScores: CaseScore[] = [];
  let acceptedFindings = 0;
  let rejectedFindings = 0;
  let q1Quotes = 0;
  let q1VerbatimQuotes = 0;
  let q1AmbiguousQuotes = 0;
  let locatorsPresent = 0;
  let locatorMatches = 0;
  let validCitations = 0;
  let failedCasesWithQ1Finding = 0;
  let failedCasesEligibleForGoldRationaleHit = 0;
  let failedCasesWithGoldRationaleHit = 0;
  let contradictCasesWithFinding = 0;
  let contradictRationaleHits = 0;
  let failWithoutFinding = 0;
  let passWithFinding = 0;

  for (const result of results) {
    const fixture = fixtures.get(result.caseId);
    if (!fixture) throw new Error(`Result refers to unknown fixture ${result.caseId}`);
    if (result.status === "error") {
      caseScores.push({
        caseId: result.caseId,
        mode: fixture.mode,
        claimId: fixture.claimId,
        docIds: fixture.docIds,
        goldLabel: fixture.goldLabel,
        expected: fixture.expected.verdict,
        actual: "error",
        Q1: null,
        Q2: null,
        invalidVerdict: false,
        correct: false,
        hasRequiredFinding: null,
        q1Quotes: 0,
        q1VerbatimQuotes: 0,
        q1AmbiguousQuotes: 0,
        rationaleHit: null,
        rejectedFindings: 0,
      });
      continue;
    }

    acceptedFindings += result.findings.length;
    rejectedFindings += result.rejected.length;
    const actual =
      fixture.expected.question === "COMBINED"
        ? result.Q1 === "pass" && result.Q2 === "pass"
          ? "pass"
          : "fail"
        : result.Q2;
    const failedQuestions: Array<"Q1" | "Q2"> =
      fixture.expected.question === "COMBINED"
        ? [
            ...(result.Q1 === "pass" ? [] : (["Q1"] as const)),
            ...(result.Q2 === "pass" ? [] : (["Q2"] as const)),
          ]
        : result.Q2 === "fail"
          ? ["Q2"]
          : [];
    const hasRequiredFinding =
      actual === "fail"
        ? failedQuestions.every((question) =>
            result.findings.some((finding) => finding.question === question),
          )
        : null;
    if (actual === "fail" && hasRequiredFinding === false) failWithoutFinding++;
    if (actual === "pass" && result.findings.length > 0) passWithFinding++;

    let caseQuotes = 0;
    let caseVerbatim = 0;
    let caseAmbiguous = 0;
    let rationaleHit: boolean | null = null;
    if (fixture.mode === "primary") {
      const findings = result.findings.filter((finding) => finding.question === "Q1");
      const attachmentContexts = new Map(
        fixture.attachments.map((metadata) => {
          const document = corpus.get(metadata.docId);
          if (!document) throw new Error(`Corpus no longer contains document ${metadata.docId}`);
          const attachmentText = fixtureManifestDir
            ? readFileSync(
                join(fixtureManifestDir, fixture.projectDir, metadata.path),
                "utf8",
              )
            : undefined;
          return [metadata.path, { metadata, document, attachmentText }] as const;
        }),
      );
      const assessments = findings.map((finding) => {
        caseQuotes++;
        q1Quotes++;
        if (finding.citation.locator.trim()) locatorsPresent++;
        const context = attachmentContexts.get(finding.citation.attachment);
        const assessment = context
          ? assessQuote(
              finding.citation.quote,
              context.document,
              context.metadata.goldRationaleSets,
              context.attachmentText,
            )
          : {
              inSource: false,
              matchingSentenceIds: [],
              ambiguous: false,
              hitsGoldRationale: false,
            };
        const locatorMatchesQuote = locatorMatchesSentence(
          finding.citation.locator,
          assessment.matchingSentenceIds,
        );
        if (locatorMatchesQuote) locatorMatches++;
        const validCitation = context !== undefined && locatorMatchesQuote && assessment.inSource;
        if (validCitation) validCitations++;
        if (assessment.inSource) {
          caseVerbatim++;
          q1VerbatimQuotes++;
        }
        if (assessment.ambiguous) {
          caseAmbiguous++;
          q1AmbiguousQuotes++;
        }
        return { ...assessment, validCitation };
      });
      if (actual === "fail" && findings.length > 0) {
        failedCasesWithQ1Finding++;
        const hasGoldRationale = fixture.attachments.some(
          (attachment) => attachment.goldRationaleSets.length > 0,
        );
        if (hasGoldRationale) {
          failedCasesEligibleForGoldRationaleHit++;
          rationaleHit = assessments.some(
            (assessment) => assessment.validCitation && assessment.hitsGoldRationale,
          );
          if (rationaleHit) failedCasesWithGoldRationaleHit++;
        }
      }
      if (fixture.goldLabel === "CONTRADICT" && result.Q1 === "fail" && findings.length > 0) {
        contradictCasesWithFinding++;
        rationaleHit ??= assessments.some(
          (assessment) => assessment.validCitation && assessment.hitsGoldRationale,
        );
        if (rationaleHit) contradictRationaleHits++;
      }
    }

    caseScores.push({
      caseId: result.caseId,
      mode: fixture.mode,
      claimId: fixture.claimId,
      docIds: fixture.docIds,
      goldLabel: fixture.goldLabel,
      expected: fixture.expected.verdict,
      actual,
      Q1: result.Q1,
      Q2: result.Q2,
      invalidVerdict: fixture.mode === "primary" && result.Q1 === "n/a",
      correct: actual === fixture.expected.verdict,
      hasRequiredFinding,
      q1Quotes: caseQuotes,
      q1VerbatimQuotes: caseVerbatim,
      q1AmbiguousQuotes: caseAmbiguous,
      rationaleHit,
      rejectedFindings: result.rejected.length,
    });
  }

  const completedDurations = results
    .filter((result) => result.status === "ok")
    .map((result) => result.durationMs)
    .sort((a, b) => a - b);
  const durationPercentile = (probability: number): number | null =>
    completedDurations.length === 0 ? null : percentile(completedDurations, probability);
  const totalDurationMs = completedDurations.reduce((sum, value) => sum + value, 0);
  const bootstrap = claimClusterBootstrap(caseScores);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    totalCases: caseScores.length,
    completedCases: results.filter((result) => result.status === "ok").length,
    errorCases: results.filter((result) => result.status === "error").length,
    byMode: {
      primary: scoreMode(caseScores, "primary"),
      "q2-oracle": scoreMode(caseScores, "q2-oracle"),
    },
    byModeAndGoldLabel: {
      primary: {
        SUPPORT: scoreLabel(caseScores, "primary", "SUPPORT"),
        CONTRADICT: scoreLabel(caseScores, "primary", "CONTRADICT"),
        NOINFO: scoreLabel(caseScores, "primary", "NOINFO"),
      },
      "q2-oracle": {
        SUPPORT: scoreLabel(caseScores, "q2-oracle", "SUPPORT"),
        CONTRADICT: scoreLabel(caseScores, "q2-oracle", "CONTRADICT"),
        NOINFO: scoreLabel(caseScores, "q2-oracle", "NOINFO"),
      },
    },
    q1CitationChecks: {
      quotes: q1Quotes,
      verbatimQuotes: q1VerbatimQuotes,
      verbatimRate: ratio(q1VerbatimQuotes, q1Quotes),
      ambiguousQuotes: q1AmbiguousQuotes,
      locatorsPresent,
      locatorRate: ratio(locatorsPresent, q1Quotes),
      locatorMatches,
      locatorMatchRate: ratio(locatorMatches, q1Quotes),
      validCitations,
      validCitationRate: ratio(validCitations, q1Quotes),
      failedCasesWithQ1Finding,
      failedCasesEligibleForGoldRationaleHit,
      failedCasesWithGoldRationaleHit,
      failedCaseGoldRationaleHitRate: ratio(
        failedCasesWithGoldRationaleHit,
        failedCasesEligibleForGoldRationaleHit,
      ),
      contradictCasesWithFinding,
      contradictRationaleHits,
      contradictRationaleHitRate: ratio(contradictRationaleHits, contradictCasesWithFinding),
    },
    protocol: {
      acceptedFindings,
      rejectedFindings,
      acceptedFindingRate: ratio(acceptedFindings, acceptedFindings + rejectedFindings),
      rejectedFindingRate: ratio(rejectedFindings, acceptedFindings + rejectedFindings),
      failWithoutFinding,
      passWithFinding,
    },
    runtime: {
      completedCases: completedDurations.length,
      totalDurationMs,
      meanDurationMs: ratio(totalDurationMs, completedDurations.length),
      medianDurationMs: durationPercentile(0.5),
      p95DurationMs: durationPercentile(0.95),
      reviewerFailureRate: ratio(
        results.filter((result) => result.status === "error").length,
        results.length,
      ),
      tokenUsageAvailable: false,
    },
    primaryClaimClusterBootstrap: bootstrap,
    cases: caseScores.sort((a, b) => a.caseId.localeCompare(b.caseId)),
  };
}

function assertUnique(values: string[], description: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${description}: ${value}`);
    seen.add(value);
  }
}

function resolveFrom(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function verifyFixtureFiles(manifest: FixtureManifest, manifestDir: string): void {
  for (const fixture of manifest.cases) {
    const project = resolveFrom(manifestDir, fixture.projectDir);
    const graph = join(project, ".toulmin", "graph.db");
    if (isAbsolute(fixture.projectDir) || !isInside(manifestDir, project)) {
      throw new Error(`Fixture ${fixture.caseId} contains an unsafe path`);
    }
    for (const metadata of fixture.attachments) {
      const attachment = resolve(project, metadata.path);
      if (isAbsolute(metadata.path) || !isInside(project, attachment)) {
        throw new Error(`Fixture ${fixture.caseId} contains an unsafe attachment path`);
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

function verifyRunCaseArtifacts(
  result: ReviewCaseResult,
  fixture: FixtureCase,
  runDir: string,
): void {
  if (result.graphPath !== null) {
    const graphPath = resolveFrom(runDir, result.graphPath);
    if (isAbsolute(result.graphPath) || !isInside(runDir, graphPath)) {
      throw new Error(`Case ${result.caseId} archived graph escapes the run directory`);
    }
    if (!result.graphSha256 || sha256File(graphPath) !== result.graphSha256) {
      throw new Error(`Case ${result.caseId} archived graph hash mismatch`);
    }
    if (result.status === "ok") {
      // A readonly SQLite connection to a WAL-mode file still creates -shm/-wal
      // sidecars. Verify a temporary copy so scoring never mutates the archive.
      const scratch = mkdtempSync(join(tmpdir(), "scifact-score-db-"));
      const scratchGraph = join(scratch, "graph.db");
      copyFileSync(graphPath, scratchGraph);
      const db = new Database(scratchGraph, { readonly: true });
      try {
        const event = db
          .query("SELECT node_id, op, payload FROM events WHERE id = ?")
          .get(result.eventId) as { node_id: number | null; op: string; payload: string } | null;
        if (!event || event.node_id !== fixture.targetId || event.op !== "review") {
          throw new Error(`Case ${result.caseId} archived graph lacks its review event`);
        }
        const payload = JSON.parse(event.payload) as Record<string, unknown>;
        const drafts = result.findings.map(({ id: _id, ...finding }) => finding);
        if (
          payload.Q1 !== result.Q1 ||
          payload.Q2 !== result.Q2 ||
          payload.model !== result.actualModel ||
          payload.protocol !== result.protocolHash ||
          JSON.stringify(payload.findings ?? []) !== JSON.stringify(drafts) ||
          JSON.stringify(payload.rejected ?? []) !== JSON.stringify(result.rejected)
        ) {
          throw new Error(`Case ${result.caseId} archived event disagrees with results.jsonl`);
        }
      } finally {
        db.close();
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  } else if (result.graphSha256 !== null) {
    throw new Error(`Case ${result.caseId} has a graph hash without an archived graph`);
  }

  if (result.auditFiles !== result.auditAttempts.length) {
    throw new Error(`Case ${result.caseId} audit file count mismatch`);
  }
  for (const attempt of result.auditAttempts) {
    const auditPath = resolveFrom(runDir, attempt.file);
    if (isAbsolute(attempt.file) || !isInside(runDir, auditPath)) {
      throw new Error(`Case ${result.caseId} audit path escapes the run directory`);
    }
    const audit = readJson<{
      model?: unknown;
      output?: { raw?: unknown; successfulReads?: unknown };
    }>(auditPath);
    if (
      audit.model !== attempt.model ||
      typeof audit.output?.raw !== "string" ||
      sha256Text(audit.output.raw) !== attempt.rawSha256 ||
      !Array.isArray(audit.output.successfulReads) ||
      audit.output.successfulReads.some((item) => typeof item !== "string") ||
      JSON.stringify(audit.output.successfulReads) !== JSON.stringify(attempt.successfulReads)
    ) {
      throw new Error(`Case ${result.caseId} audit hash/provenance mismatch`);
    }
  }
  if (result.status === "ok") {
    if (result.auditAttempts.at(-1)?.model !== result.actualModel) {
      throw new Error(`Case ${result.caseId} final audit model mismatch`);
    }
    const expectedReads =
      fixture.mode === "primary" ? fixture.attachments.map((attachment) => attachment.path) : [];
    if (JSON.stringify(result.attachmentsRead) !== JSON.stringify(expectedReads)) {
      throw new Error(`Case ${result.caseId} attachment Read trace is incomplete or unstable`);
    }
  }
}

function writeCaseCsv(path: string, cases: CaseScore[]): void {
  const keys: Array<keyof CaseScore> = [
    "caseId",
    "mode",
    "claimId",
    "docIds",
    "goldLabel",
    "expected",
    "actual",
    "Q1",
    "Q2",
    "invalidVerdict",
    "correct",
    "hasRequiredFinding",
    "q1Quotes",
    "q1VerbatimQuotes",
    "q1AmbiguousQuotes",
    "rationaleHit",
    "rejectedFindings",
  ];
  const lines = [
    keys.join(","),
    ...cases.map((item) => keys.map((key) => csvCell(item[key])).join(",")),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    strict: true,
    allowPositionals: false,
    options: {
      "run-dir": { type: "string" },
      fixtures: { type: "string" },
      "out-dir": { type: "string" },
      "allow-incomplete": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(usage());
    return;
  }
  if (!values["run-dir"]) throw new Error("--run-dir is required");
  const runDir = resolve(values["run-dir"]);
  const runManifestPath = join(runDir, "run-manifest.json");
  const runManifest = readJson<ReviewRunManifest>(runManifestPath);
  const lockedFixtureManifest = resolveFrom(runDir, runManifest.fixtureManifest);
  const fixtureManifestPath = values.fixtures
    ? resolve(values.fixtures)
    : lockedFixtureManifest;
  if (
    values.fixtures &&
    lockedFixtureManifest !== fixtureManifestPath
  ) {
    throw new Error("--fixtures does not match the fixture manifest locked by the run");
  }
  const fixtures = readJson<FixtureManifest>(fixtureManifestPath);
  validateFixtureManifest(fixtures);
  if (sha256File(fixtureManifestPath) !== runManifest.fixtureManifestSha256) {
    throw new Error("Fixture manifest hash does not match the run lock");
  }
  const fixtureManifestDir = dirname(fixtureManifestPath);
  const corpusPath = resolveFrom(fixtureManifestDir, fixtures.dataset.corpusPath);
  const claimsPath = resolveFrom(fixtureManifestDir, fixtures.dataset.claimsPath);
  if (sha256File(corpusPath) !== fixtures.dataset.corpusSha256) {
    throw new Error("SciFact corpus hash no longer matches the fixture manifest");
  }
  if (sha256File(claimsPath) !== fixtures.dataset.claimsSha256) {
    throw new Error("SciFact claims hash no longer matches the fixture manifest");
  }
  verifyFixtureFiles(fixtures, fixtureManifestDir);
  const resultsPath = resolveFrom(runDir, runManifest.resultsFile);
  if (
    isAbsolute(runManifest.resultsFile) ||
    !isInside(runDir, resultsPath) ||
    sha256File(resultsPath) !== runManifest.resultsSha256
  ) {
    throw new Error("results.jsonl hash/path does not match the run manifest");
  }
  const results = readJsonl<ReviewCaseResult>(resultsPath);
  if (runManifest.requestedCases !== runManifest.selectedCaseIds.length) {
    throw new Error("Run manifest requestedCases does not match selectedCaseIds");
  }
  if (runManifest.completedCases !== results.length) {
    throw new Error("Run manifest completedCases does not match results.jsonl");
  }
  if (
    runManifest.failedCases !== results.filter((result) => result.status === "error").length
  ) {
    throw new Error("Run manifest failedCases does not match results.jsonl");
  }
  for (const result of results) {
    const fixture = fixtures.cases.find((item) => item.caseId === result.caseId);
    if (!fixture) throw new Error(`Result refers to unknown fixture ${result.caseId}`);
    verifyRunCaseArtifacts(result, fixture, runDir);
    if (result.status === "ok") {
      if (result.model !== runManifest.model) {
        throw new Error(
          `Case ${result.caseId} recorded model ${result.model}, expected ${runManifest.model}`,
        );
      }
      if (!result.protocolHash) throw new Error(`Case ${result.caseId} has no protocol hash`);
      const allowedModels = new Set(
        [runManifest.model, runManifest.fallbackModel].filter(
          (model): model is string => typeof model === "string",
        ),
      );
      if (!allowedModels.has(result.actualModel)) {
        throw new Error(`Case ${result.caseId} audit recorded unexpected model ${result.actualModel}`);
      }
      if (runManifest.auditRequired && result.auditAttempts.length === 0) {
        throw new Error(`Case ${result.caseId} has no reviewer audit attempt`);
      }
      if (result.actualModel !== result.auditAttempts.at(-1)?.model) {
        throw new Error(`Case ${result.caseId} actual model disagrees with its audit`);
      }
      if (result.reviewEventsAdded !== 1 || result.attachmentUnchanged !== true) {
        throw new Error(`Case ${result.caseId} failed review postconditions`);
      }
    }
  }
  assertUnique(runManifest.selectedCaseIds, "selected case id");
  assertUnique(results.map((result) => result.caseId), "result case id");
  const fixtureIds = new Set(fixtures.cases.map((fixture) => fixture.caseId));
  for (const caseId of runManifest.selectedCaseIds) {
    if (!fixtureIds.has(caseId)) throw new Error(`Run selected unknown fixture ${caseId}`);
  }
  const resultIds = new Set(results.map((result) => result.caseId));
  const missing = runManifest.selectedCaseIds.filter((caseId) => !resultIds.has(caseId));
  const unexpected = results.filter((result) => !runManifest.selectedCaseIds.includes(result.caseId));
  if (unexpected.length > 0) {
    throw new Error(`results.jsonl contains ${unexpected.length} case(s) not selected by the run`);
  }
  const hasFailures = results.some((result) => result.status === "error");
  const incomplete = runManifest.interrupted || missing.length > 0 || hasFailures;
  if (incomplete && !values["allow-incomplete"]) {
    throw new Error(
      `Run is incomplete (${missing.length} missing, ` +
        `${results.filter((result) => result.status === "error").length} errors); ` +
        `pass --allow-incomplete to score successful coverage explicitly`,
    );
  }

  const scoredResults: ReviewCaseResult[] = [
    ...results,
    ...missing.map(
      (caseId): ReviewCaseResult => ({
        schemaVersion: 1,
        caseId,
        status: "error",
        durationMs: 0,
        error: "not_run: selected case has no result",
        graphPath: null,
        graphSha256: null,
        auditDir: null,
        auditFiles: 0,
        auditAttempts: [],
        reviewEventsAdded: 0,
      }),
    ),
  ];
  const corpus = readJsonl<SciFactDocument>(corpusPath);
  const summary = scoreReviewCases(fixtures, scoredResults, corpus, fixtureManifestDir);
  const outputDir = resolve(values["out-dir"] ?? join(runDir, "scores"));
  if (existsSync(outputDir)) throw new Error(`Score output directory already exists: ${outputDir}`);
  mkdirSync(outputDir, { recursive: true });
  writeJson(join(outputDir, "summary.json"), summary);
  writeCaseCsv(join(outputDir, "cases.csv"), summary.cases);
  console.log(`Scored ${summary.completedCases}/${summary.totalCases} completed case(s): ${outputDir}`);
  for (const mode of ["primary", "q2-oracle"] as const) {
    const score = summary.byMode[mode];
    console.log(
      `  ${mode}: completed-accuracy=${score.accuracy ?? "n/a"}, ` +
        `end-to-end=${score.endToEndAccuracy ?? "n/a"}, coverage=${score.coverage ?? "n/a"}, ` +
        `false-supported=${score.falsePassRate ?? "n/a"}`,
    );
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`scifact scoring failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}

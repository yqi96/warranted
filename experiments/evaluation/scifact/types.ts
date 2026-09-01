import type { Finding, RejectedFinding } from "../../../src/types.ts";

export const SCIFACT_LABELS = ["SUPPORT", "CONTRADICT", "NOINFO"] as const;
export type SciFactLabel = (typeof SCIFACT_LABELS)[number];
export type ReviewMode = "primary" | "q2-oracle";

export interface SciFactRationale {
  label: "SUPPORT" | "CONTRADICT";
  sentences: number[];
}

export interface SciFactClaim {
  id: number;
  claim: string;
  evidence: Record<string, SciFactRationale[]>;
  cited_doc_ids: number[];
}

export interface SciFactDocument {
  doc_id: number;
  title: string;
  abstract: string[];
  structured: boolean;
}

export interface CandidatePair {
  split: string;
  claimId: number;
  claim: string;
  docId: number;
  label: SciFactLabel;
  rationaleSets: number[][];
  document: SciFactDocument;
}

export interface CandidateClaim {
  split: string;
  claimId: number;
  claim: string;
  label: SciFactLabel;
  documents: CandidatePair[];
}

export interface FixtureAttachment {
  docId: number;
  /** Relative to the fixture project. */
  path: string;
  sha256: string;
  /** Relation between this one abstract and the claim. */
  goldLabel: SciFactLabel;
  /** Empty only when this cited abstract has no gold evidence relation. */
  goldRationaleSets: number[][];
}

export interface FixtureCase {
  schemaVersion: 2;
  caseId: string;
  mode: ReviewMode;
  split: string;
  claimId: number;
  /** All abstracts materialized in this fixture. Primary cases may contain several. */
  docIds: number[];
  goldLabel: SciFactLabel;
  /** Q2 has one fixture per alternative gold rationale set. */
  goldRationaleSetIndex: number | null;
  /** Q2 source document; null for claim-level primary cases. */
  goldRationaleDocId: number | null;
  /** Relative to the directory containing fixture-manifest.json. */
  projectDir: string;
  /** Gold stays manifest-side and is never written under projectDir. */
  attachments: FixtureAttachment[];
  graphSha256: string;
  targetId: number;
  expected: { question: "COMBINED" | "Q2"; verdict: "pass" | "fail" };
}

export type SelectedCandidate =
  | {
      mode: "primary";
      claim: CandidateClaim;
      pair: null;
      rationaleSetIndex: null;
    }
  | {
      mode: "q2-oracle";
      claim: CandidateClaim;
      pair: CandidatePair;
      rationaleSetIndex: number;
    };

export interface FixtureManifest {
  schemaVersion: 2;
  createdAt: string;
  adapter: {
    version: "scifact-review/v2";
    primaryUnit: "claim";
    attachmentPolicy: "all-cited-and-evidence-abstracts";
    positiveLabel: "SUPPORT";
    negativeLabels: ["CONTRADICT", "NOINFO"];
    warrant: string;
    warrantSha256: string;
    repositoryCommit: string | null;
    repositoryDirty: boolean | null;
  };
  dataset: {
    name: "SciFact";
    split: string;
    corpusPath: string;
    claimsPath: string;
    corpusSha256: string;
    claimsSha256: string;
  };
  selection: {
    modes: ReviewMode[];
    seed: number;
    perLabel: number | null;
  };
  counts: Record<ReviewMode, Record<SciFactLabel, number>>;
  cases: FixtureCase[];
}

export interface SuccessfulReviewCaseResult {
  schemaVersion: 1;
  caseId: string;
  status: "ok";
  durationMs: number;
  eventId: number;
  model: string;
  actualModel: string;
  fallbackModel: string | null;
  protocolHash: string;
  Q1: "pass" | "fail" | "n/a";
  Q2: "pass" | "fail";
  findings: Finding[];
  rejected: RejectedFinding[];
  graphPath: string;
  graphSha256: string;
  auditDir: string | null;
  auditFiles: number;
  auditAttempts: AuditAttempt[];
  attachmentsRead: string[];
  reviewEventsAdded: 1;
  attachmentUnchanged: true;
}

export interface FailedReviewCaseResult {
  schemaVersion: 1;
  caseId: string;
  status: "error";
  durationMs: number;
  error: string;
  graphPath: string | null;
  graphSha256: string | null;
  auditDir: string | null;
  auditFiles: number;
  auditAttempts: AuditAttempt[];
  reviewEventsAdded: number;
}

export type ReviewCaseResult = SuccessfulReviewCaseResult | FailedReviewCaseResult;

export interface AuditAttempt {
  model: string;
  durationMs: number;
  rawSha256: string;
  successfulReads: string[];
  file: string;
}

export interface ReviewRunManifest {
  schemaVersion: 1;
  createdAt: string;
  fixtureManifest: string;
  fixtureManifestSha256: string;
  model: string;
  fallbackModel: string | null;
  baseUrl: string | null;
  maxTurns: number;
  concurrency: number;
  auditRequired: true;
  selectedCaseIds: string[];
  requestedCases: number;
  completedCases: number;
  failedCases: number;
  interrupted: boolean;
  resultsFile: string;
  resultsSha256: string;
}

export interface CaseScore {
  caseId: string;
  mode: ReviewMode;
  claimId: number;
  docIds: number[];
  goldLabel: SciFactLabel;
  expected: "pass" | "fail";
  actual: "pass" | "fail" | "n/a" | "error";
  Q1: "pass" | "fail" | "n/a" | null;
  Q2: "pass" | "fail" | null;
  invalidVerdict: boolean;
  correct: boolean;
  hasRequiredFinding: boolean | null;
  q1Quotes: number;
  q1VerbatimQuotes: number;
  q1AmbiguousQuotes: number;
  rationaleHit: boolean | null;
  rejectedFindings: number;
}

export interface ModeScore {
  total: number;
  completed: number;
  errors: number;
  coverage: number | null;
  failureRate: number | null;
  invalidVerdicts: number;
  correct: number;
  accuracy: number | null;
  endToEndAccuracy: number | null;
  precision: number | null;
  recall: number | null;
  supportRecall: number | null;
  negativeRecall: number | null;
  contradictRecall: number | null;
  noInfoRecall: number | null;
  f1: number | null;
  macroF1: number | null;
  negativeCases: number;
  falsePasses: number;
  falsePassRate: number | null;
  positiveCases: number;
  falseFails: number;
  falseFailRate: number | null;
  failedVerdicts: number;
  failuresWithFinding: number;
  failureFindingCoverage: number | null;
}

export interface LabelScore {
  total: number;
  completed: number;
  errors: number;
  pass: number;
  fail: number;
  n_a: number;
  correct: number;
  accuracy: number | null;
}

export interface ConfidenceInterval {
  estimate: number;
  lower: number;
  upper: number;
}

export interface ClusterBootstrapSummary {
  unit: "claim";
  clusters: number;
  cases: number;
  iterations: number;
  seed: number;
  confidenceLevel: 0.95;
  accuracy: ConfidenceInterval;
  macroF1: ConfidenceInterval | null;
  falseSupportedRate: ConfidenceInterval | null;
  supportRecall: ConfidenceInterval | null;
  negativeRecall: ConfidenceInterval | null;
  contradictRecall: ConfidenceInterval | null;
  noInfoRecall: ConfidenceInterval | null;
}

export interface ScoreSummary {
  schemaVersion: 1;
  generatedAt: string;
  totalCases: number;
  completedCases: number;
  errorCases: number;
  byMode: Record<ReviewMode, ModeScore>;
  byModeAndGoldLabel: Record<ReviewMode, Record<SciFactLabel, LabelScore>>;
  q1CitationChecks: {
    quotes: number;
    verbatimQuotes: number;
    verbatimRate: number | null;
    ambiguousQuotes: number;
    locatorsPresent: number;
    locatorRate: number | null;
    locatorMatches: number;
    locatorMatchRate: number | null;
    validCitations: number;
    validCitationRate: number | null;
    failedCasesWithQ1Finding: number;
    failedCasesEligibleForGoldRationaleHit: number;
    failedCasesWithGoldRationaleHit: number;
    failedCaseGoldRationaleHitRate: number | null;
    contradictCasesWithFinding: number;
    contradictRationaleHits: number;
    contradictRationaleHitRate: number | null;
  };
  runtime: {
    completedCases: number;
    totalDurationMs: number;
    meanDurationMs: number | null;
    medianDurationMs: number | null;
    p95DurationMs: number | null;
    reviewerFailureRate: number | null;
    tokenUsageAvailable: false;
  };
  protocol: {
    acceptedFindings: number;
    rejectedFindings: number;
    acceptedFindingRate: number | null;
    rejectedFindingRate: number | null;
    failWithoutFinding: number;
    passWithFinding: number;
  };
  primaryClaimClusterBootstrap: ClusterBootstrapSummary | null;
  cases: CaseScore[];
}

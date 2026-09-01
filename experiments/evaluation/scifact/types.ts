import type { Finding, RejectedFinding } from "../../../src/types.ts";

export const SCIFACT_LABELS = ["SUPPORT", "CONTRADICT", "NOINFO"] as const;
export type SciFactLabel = (typeof SCIFACT_LABELS)[number];
export type ReviewMode = "primary" | "q2-oracle";
export type GraphExpectedVerdict = "pass" | "fail";

export const MECHANICAL_GRAPH_VERDICT_POLICY_VERSION =
  "scifact-materialized-graph-mechanical/v1" as const;
export type MechanicalGraphVerdictReasonCode =
  | "all-target-attachments-support-with-rationale"
  | "target-has-non-supporting-attachment"
  | "q2-support-rationale"
  | "q2-non-support-rationale";

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
  /** SciFact source relation between this one abstract and the claim. */
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
  /** SciFact's claim-level source label. This is not the expected graph verdict. */
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
  /**
   * Legacy v2 source-label mapping stored by the deterministic builder: SUPPORT -> pass,
   * CONTRADICT/NOINFO -> fail. This field is not graph gold. Scoring must use an independently
   * adjudicated graphExpectedVerdict overlay; changing builder semantics is reserved for v3.
   */
  expected: { question: "COMBINED" | "Q2"; verdict: GraphExpectedVerdict };
}

export interface GraphVerdictAttachmentAudit {
  docId: number;
  sourceGoldLabel: SciFactLabel;
  rationaleSetCount: number;
  allRationaleSetsNonEmpty: boolean;
  passesMechanicalSupportCheck: boolean;
}

export interface GraphVerdictOverlayCase {
  caseId: string;
  mode: ReviewMode;
  claimId: number;
  sourceGoldLabel: SciFactLabel;
  manifestExpectedVerdict: GraphExpectedVerdict;
  mechanicalGraphVerdict: GraphExpectedVerdict;
  mechanicalChangedFromManifest: boolean;
  mechanicalReasonCode: MechanicalGraphVerdictReasonCode;
  mechanicalReason: string;
  attachments: GraphVerdictAttachmentAudit[];
  decisionStatus: "provisional" | "adjudicated";
  graphExpectedVerdict: GraphExpectedVerdict | null;
  changedFromManifest: boolean | null;
  adjudicationReason: string | null;
}

export interface GraphVerdictOverlay {
  schemaVersion: 2;
  createdAt: string;
  fixtureManifestSha256: string;
  policy: {
    mechanicalVersion: typeof MECHANICAL_GRAPH_VERDICT_POLICY_VERSION;
    mechanicalRule: string;
    adjudicationRule: string;
  };
  adjudication: {
    method: string | null;
    bundlePath: string | null;
    bundleSha256: string | null;
    adjudicationsSha256: string | null;
    consensusSha256: string | null;
  };
  counts: {
    total: number;
    sourceGoldLabel: Record<SciFactLabel, number>;
    mechanicalGraphVerdict: Record<GraphExpectedVerdict, number>;
    mechanicalChangedFromManifest: number;
    adjudicated: number;
    graphExpectedVerdict: Record<GraphExpectedVerdict, number>;
    changedFromManifest: number;
  };
  cases: GraphVerdictOverlayCase[];
}

export interface GraphVerdictAdjudicationBundle {
  schemaVersion: 1;
  createdAt: string;
  fixtureManifestSha256: string;
  policy: {
    mechanicalVersion: typeof MECHANICAL_GRAPH_VERDICT_POLICY_VERSION;
    mechanicalRule: string;
    adjudicationRule: string;
  };
  adjudications: {
    /** Path relative to the bundle file. */
    path: string;
    sha256: string;
    cases: number;
  };
  consensus: {
    /** Path relative to the bundle file. */
    path: string;
    sha256: string;
    cases: number;
    method: string;
  };
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
  /** SciFact source label, retained only for provenance and subgroup reporting. */
  sourceGoldLabel: SciFactLabel;
  /** Gold verdict for the graph exactly as materialized. */
  graphExpectedVerdict: GraphExpectedVerdict;
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
  graphPassRecall: number | null;
  graphFailRecall: number | null;
  /** Recall of graph fails inside the source CONTRADICT subgroup. */
  contradictGraphFailRecall: number | null;
  /** Recall of graph fails inside the source NOINFO subgroup. */
  noInfoGraphFailRecall: number | null;
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
  graphPassRecall: ConfidenceInterval | null;
  graphFailRecall: ConfidenceInterval | null;
  contradictGraphFailRecall: ConfidenceInterval | null;
  noInfoGraphFailRecall: ConfidenceInterval | null;
}

export interface ScoreSummary {
  schemaVersion: 3;
  generatedAt: string;
  labeling: {
    sourceGoldLabel: "fixture.goldLabel";
    graphExpectedVerdict: "adjudicated-overlay";
    fixtureManifestSha256: string;
    graphVerdictOverlaySha256: string;
    adjudicationMethod: string;
    adjudicationBundleSha256: string;
    adjudicationsSha256: string;
    consensusSha256: string;
    mechanicalPolicyVersion: typeof MECHANICAL_GRAPH_VERDICT_POLICY_VERSION;
    allCasesAdjudicated: true;
  };
  totalCases: number;
  completedCases: number;
  errorCases: number;
  byMode: Record<ReviewMode, ModeScore>;
  byModeAndSourceGoldLabel: Record<ReviewMode, Record<SciFactLabel, LabelScore>>;
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

export interface ScoreArtifactLock {
  path: string;
  sha256: string;
}

export interface ScoreManifest {
  schemaVersion: 1;
  generatedAt: string;
  scoreSummarySchemaVersion: 3;
  artifacts: {
    runManifest: ScoreArtifactLock;
    results: ScoreArtifactLock;
    recoveryProvenance: ScoreArtifactLock | null;
    fixtureManifest: ScoreArtifactLock;
    graphVerdictOverlay: ScoreArtifactLock;
    adjudicationBundle: ScoreArtifactLock;
    summary: ScoreArtifactLock;
    casesCsv: ScoreArtifactLock;
  };
}

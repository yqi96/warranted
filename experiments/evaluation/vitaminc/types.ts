export type VitaminCLabel = "SUPPORTS" | "REFUTES";
export type ReplayDirection = "SUP_TO_REF" | "REF_TO_SUP";
export type ReplayTransition = ReplayDirection | "SUP_TO_SUP" | "REF_TO_REF";
export type InitialRelation = "evidence" | "rebuttal";

export interface VitaminCRow {
  unique_id: string;
  case_id: string;
  wiki_revision_id?: string;
  FEVER_id?: string;
  label: string;
  claim: string;
  evidence: string;
  page?: string;
  revision_type?: string;
}

export interface VitaminCFlaggingRow {
  case_id: string;
  wiki_revision_id: string;
  label: string;
  sent_a: string;
  sent_b: string;
  page: string;
}

export interface ReplayCase {
  /** Evaluator-side id. Never expose it to the agent because it may encode provenance. */
  id: string;
  pairId: string;
  direction: ReplayDirection;
  transition?: ReplayTransition;
  material?: boolean;
  claim: string;
  e0: string;
  y0: VitaminCLabel;
  e1: string;
  y1: VitaminCLabel;
  sourceIds: [string, string];
  sourceCaseId: string;
  wikiRevisionId?: string;
  temporalPair?: "1_2" | "3_4";
  page?: string;
  revisionType?: string;
}

export interface SeedMetadata {
  schemaVersion?: 2;
  /** Opaque public id used for the scratch directory. */
  publicCaseId?: string;
  /** Evaluator-side fields below remain outside the agent scratch. */
  caseId: string;
  pairId: string;
  direction: ReplayDirection;
  evidenceId: number;
  claimId: number;
  warningId: string;
  prompt?: string;
  lastSeedEventId?: number;
  initialClaimContent?: string;
  initialClaimContentHash?: string;
  initialEvidenceContentHash?: string;
  initialQualifier?: string;
  initialRelation?: InitialRelation;
  pendingWarningCodes?: string[];
  initialWarningCodes?: string[];
  graphSha256?: string;
}

export type AgentFailureKind =
  | "spawn_failure"
  | "auth_failure"
  | "timeout"
  | "max_turns"
  | "nonzero_exit"
  | "invalid_output"
  | "mcp_failure"
  | "artifact_failure"
  | "agent_error"
  | "protocol_violation";

export interface PreparedPublicCase {
  schemaVersion: 2;
  publicCaseId: string;
  projectDir: string;
  graphSha256: string;
  evidenceSha256: string;
}

export interface PreparedPrivateCase {
  schemaVersion: 2;
  publicCaseId: string;
  replay: ReplayCase;
  seed: SeedMetadata;
}

export interface AdapterAudit {
  inputRows: number;
  recognizedTemporalRows: number;
  expectedTemporalPairs: number;
  completeUniqueSlotPairs: number;
  /** Mutually exclusive drop reasons; a missing slot takes precedence. */
  slotPairDrops: {
    missing: number;
    duplicated: number;
  };
  candidateBuildRejects: {
    nonFlip: number;
    metadataInconsistency: number;
    contentInconsistency: number;
  };
  candidatesBeforeSemanticDedup: number;
  duplicateSemanticTupleGroups: number;
  duplicateSemanticTupleCandidatesDropped: number;
  emittedCandidates: number;
}

export type CandidateExclusionReason =
  | "non_real_revision"
  | "missing_flagging_case"
  | "non_unique_flagging_case"
  | "non_factual_flagging_case"
  | "revision_mismatch"
  | "page_mismatch"
  | "sent_a_mismatch"
  | "sent_b_mismatch";

export interface CandidateAudit {
  adapterCandidates: number;
  flaggingRows: number;
  flaggingUniqueCaseIds: number;
  eligibleCandidates: number;
  eligibleSourceCaseIds: number;
  eligibleByDirection: Record<ReplayDirection, number>;
  excluded: Record<CandidateExclusionReason, number>;
}

export interface SelectedCounts {
  total: number;
  uniqueSourceCaseIds: number;
  byDirection: Record<ReplayDirection, number>;
  byRevisionType: Record<"real", number>;
}

export interface ImplementationFileHash {
  path: string;
  sha256: string;
}

export interface PreparedManifest {
  schemaVersion: 2;
  createdAt: string;
  adapterVersion: "vitaminc-replay/v2";
  dataset: {
    split: string;
    factVerificationPath: string;
    factVerificationSha256: string;
    flaggingPath: string;
    flaggingSha256: string;
  };
  design: {
    population: "real-natural-factual-revisions";
    directions: ["SUP_TO_REF", "REF_TO_SUP"];
    clusterUnit: "sourceCaseId";
    globallyDisjointSourceCaseIds: true;
    flaggingValidationRequired: true;
  };
  sampler: {
    version: "vitaminc-cluster-sha256/v1";
    method: "seeded-sha256-cluster-partition";
    withinCluster: "minimum-seeded-sha256";
    publicOrder: "seeded-sha256";
  };
  selection: {
    seed: number;
    perDirection: number;
  };
  adapterAudit: AdapterAudit;
  candidates: CandidateAudit;
  selectedCounts: SelectedCounts;
  implementationFiles: ImplementationFileHash[];
  repository: {
    commit: string | null;
    dirty: boolean | null;
  };
  publicCases: PreparedPublicCase[];
  publicManifestFile: string;
  publicManifestSha256: string;
  privateCasesFile: string;
  privateCasesSha256: string;
}

export interface CaseScore {
  caseId: string;
  pairId: string;
  direction: ReplayDirection;
  agentRan: boolean;
  warningPresentBeforeAgent: boolean;
  warningPendingAfterAgent: boolean;
  revalidated: boolean;
  oldRelationRemoved: boolean;
  newRelationAdded: boolean;
  relationCorrect: boolean;
  qualifierUpdated: boolean;
  finalQualifier: string;
  predictedLabel: VitaminCLabel | "ABSTAIN";
  goldLabel: VitaminCLabel;
  labelCorrect: boolean;
  staleUse: boolean;
  warningDismissed: boolean;
}

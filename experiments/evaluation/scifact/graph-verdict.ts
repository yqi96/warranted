import {
  MECHANICAL_GRAPH_VERDICT_POLICY_VERSION,
  type FixtureCase,
  type GraphExpectedVerdict,
  type GraphVerdictAttachmentAudit,
  type GraphVerdictOverlay,
  type GraphVerdictOverlayCase,
  type MechanicalGraphVerdictReasonCode,
  type SciFactLabel,
} from "./types.ts";

export const MECHANICAL_GRAPH_VERDICT_RULE =
  "For a primary target, pass iff every materialized target attachment has SciFact relation " +
  "SUPPORT and at least one rationale set, with every rationale set non-empty. For q2-oracle, " +
  "pass iff its single oracle rationale attachment has relation SUPPORT and the same rationale " +
  "condition. The SciFact claim-level source label is never used to derive this provisional " +
  "verdict. A pass still requires semantic adjudication of the actual attachment text.";

export const GRAPH_VERDICT_ADJUDICATION_RULE =
  "Treat every materialized attachment as an asserted evidence edge. Every attachment must be " +
  "relevant to the claim, and the attachment set must actually support the claim's direction, " +
  "entities or population, intervention or exposure, outcome, quantity, and scope. Explicit " +
  "contradiction, a truly unrelated attachment, or a key unsupported detail makes the graph fail. " +
  "Multiple attachments may jointly supply the support.";

export interface MechanicalGraphVerdictDerivation {
  question: "COMBINED" | "Q2";
  verdict: GraphExpectedVerdict;
  reasonCode: MechanicalGraphVerdictReasonCode;
  reason: string;
  attachments: GraphVerdictAttachmentAudit[];
}

function auditAttachment(
  attachment: FixtureCase["attachments"][number],
): GraphVerdictAttachmentAudit {
  const allRationaleSetsNonEmpty =
    attachment.goldRationaleSets.length > 0 &&
    attachment.goldRationaleSets.every((set) => Array.isArray(set) && set.length > 0);
  return {
    docId: attachment.docId,
    sourceGoldLabel: attachment.goldLabel,
    rationaleSetCount: attachment.goldRationaleSets.length,
    allRationaleSetsNonEmpty,
    passesMechanicalSupportCheck:
      attachment.goldLabel === "SUPPORT" && allRationaleSetsNonEmpty,
  };
}

function attachmentFailure(attachment: GraphVerdictAttachmentAudit): string {
  const problems: string[] = [];
  if (attachment.sourceGoldLabel !== "SUPPORT") {
    problems.push(`relation=${attachment.sourceGoldLabel}`);
  }
  if (!attachment.allRationaleSetsNonEmpty) {
    problems.push("no complete non-empty SUPPORT rationale");
  }
  return `doc ${attachment.docId} (${problems.join(", ")})`;
}

/** Derive a metadata-only provisional verdict, never the final semantic gold verdict. */
export function deriveMechanicalGraphVerdict(
  fixture: Pick<FixtureCase, "mode" | "attachments">,
): MechanicalGraphVerdictDerivation {
  const attachments = fixture.attachments.map(auditAttachment);
  const nonSupporting = attachments.filter(
    (attachment) => !attachment.passesMechanicalSupportCheck,
  );

  if (fixture.mode === "primary") {
    if (attachments.length > 0 && nonSupporting.length === 0) {
      return {
        question: "COMBINED",
        verdict: "pass",
        reasonCode: "all-target-attachments-support-with-rationale",
        reason:
          `All ${attachments.length} materialized target attachment(s) have source relation ` +
          "SUPPORT and complete non-empty SUPPORT rationale sets.",
        attachments,
      };
    }
    return {
      question: "COMBINED",
      verdict: "fail",
      reasonCode: "target-has-non-supporting-attachment",
      reason:
        nonSupporting.length > 0
          ? `Materialized target attachment(s) do not support the claim: ${nonSupporting
              .map(attachmentFailure)
              .join("; ")}.`
          : "The materialized target has no attachment that can establish Q1 faithfulness.",
      attachments,
    };
  }

  const only = attachments[0];
  if (attachments.length === 1 && only?.passesMechanicalSupportCheck) {
    return {
      question: "Q2",
      verdict: "pass",
      reasonCode: "q2-support-rationale",
      reason:
        `The q2-oracle premise comes from SUPPORT document ${only.docId} with complete ` +
        "non-empty SUPPORT rationale sets.",
      attachments,
    };
  }
  return {
    question: "Q2",
    verdict: "fail",
    reasonCode: "q2-non-support-rationale",
    reason:
      attachments.length === 1 && only
        ? `The q2-oracle premise is not a supporting rationale: ${attachmentFailure(only)}.`
        : `The q2-oracle fixture has ${attachments.length} provenance attachments instead of one.`,
    attachments,
  };
}

function emptySourceCounts(): Record<SciFactLabel, number> {
  return { SUPPORT: 0, CONTRADICT: 0, NOINFO: 0 };
}

function emptyVerdictCounts(): Record<GraphExpectedVerdict, number> {
  return { pass: 0, fail: 0 };
}

export function buildProvisionalGraphVerdictOverlay(
  manifest: { cases: FixtureCase[] },
  fixtureManifestSha256: string,
  createdAt = new Date().toISOString(),
): GraphVerdictOverlay {
  const sourceGoldLabel = emptySourceCounts();
  const graphExpectedVerdict = emptyVerdictCounts();
  let changedFromManifest = 0;
  const cases: GraphVerdictOverlayCase[] = manifest.cases.map((fixture) => {
    const derived = deriveMechanicalGraphVerdict(fixture);
    const changed = fixture.expected.verdict !== derived.verdict;
    sourceGoldLabel[fixture.goldLabel]++;
    graphExpectedVerdict[derived.verdict]++;
    if (changed) changedFromManifest++;
    return {
      caseId: fixture.caseId,
      mode: fixture.mode,
      claimId: fixture.claimId,
      sourceGoldLabel: fixture.goldLabel,
      manifestExpectedVerdict: fixture.expected.verdict,
      mechanicalGraphVerdict: derived.verdict,
      mechanicalChangedFromManifest: changed,
      mechanicalReasonCode: derived.reasonCode,
      mechanicalReason: derived.reason,
      attachments: derived.attachments,
      decisionStatus: "provisional",
      graphExpectedVerdict: null,
      changedFromManifest: null,
      adjudicationReason: null,
    };
  });
  return {
    schemaVersion: 2,
    createdAt,
    fixtureManifestSha256,
    policy: {
      mechanicalVersion: MECHANICAL_GRAPH_VERDICT_POLICY_VERSION,
      mechanicalRule: MECHANICAL_GRAPH_VERDICT_RULE,
      adjudicationRule: GRAPH_VERDICT_ADJUDICATION_RULE,
    },
    adjudication: {
      method: null,
      bundlePath: null,
      bundleSha256: null,
      adjudicationsSha256: null,
      consensusSha256: null,
    },
    counts: {
      total: cases.length,
      sourceGoldLabel,
      mechanicalGraphVerdict: graphExpectedVerdict,
      mechanicalChangedFromManifest: changedFromManifest,
      adjudicated: 0,
      graphExpectedVerdict: emptyVerdictCounts(),
      changedFromManifest: 0,
    },
    cases,
  };
}

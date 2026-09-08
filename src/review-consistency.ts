/** Mechanical consistency checks for the Q1/Q2 review protocol. */

import { ReviewUnavailableError } from "./errors.ts";
import type { FindingDraft, RejectedFinding } from "./types.ts";

export function assertVerdictFindingConsistency(outcome: {
  Q1: "pass" | "fail" | "n/a";
  Q2: "pass" | "fail";
  findings: FindingDraft[];
  rejected?: RejectedFinding[];
}): void {
  const hasQ1 = outcome.findings.some((finding) => finding.question === "Q1");
  const hasQ2 = outcome.findings.some((finding) => finding.question === "Q2");
  const rejectedQuestions = new Set(
    (outcome.rejected ?? []).flatMap((finding) => {
      const raw = finding.raw;
      if (!raw || typeof raw !== "object" || !("question" in raw)) return [];
      const question = raw.question;
      return question === "Q1" || question === "Q2" ? [question] : [];
    })
  );
  const mismatches: string[] = [];

  if ((outcome.Q1 === "fail") !== hasQ1) {
    mismatches.push(`Q1=${outcome.Q1} but accepted Q1 findings=${hasQ1 ? "yes" : "no"}`);
  }
  if ((outcome.Q2 === "fail") !== hasQ2) {
    mismatches.push(`Q2=${outcome.Q2} but accepted Q2 findings=${hasQ2 ? "yes" : "no"}`);
  }
  if (outcome.Q1 !== "fail" && rejectedQuestions.has("Q1")) {
    mismatches.push(`Q1=${outcome.Q1} but a reported Q1 finding was mechanically rejected`);
  }
  if (outcome.Q2 !== "fail" && rejectedQuestions.has("Q2")) {
    mismatches.push(`Q2=${outcome.Q2} but a reported Q2 finding was mechanically rejected`);
  }

  if (mismatches.length > 0) {
    throw new ReviewUnavailableError(
      `Review verdict and accepted findings disagree (${mismatches.join("; ")}). Nothing was recorded.`
    );
  }
}

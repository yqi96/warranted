/**
 * Warranted — Toulmin 要素定义
 *
 * 所有 tool description 和 field describe 的域模型文本常量。
 * 基于 Toulmin, The Uses of Argument (1958)。
 * 经典示例：British citizenship。
 */

export const ELEMENTS = {
  claim: {
    description:
      "Record a claim — the conclusion whose merit must be established. " +
      "Example: 'I am a British citizen.'",
    content: "The claim: what conclusion do I want to prove?",
    qualifier:
      "Degree of certainty: 'probably', 'presumably', 'certainly', 'in most cases'. " +
      "Do NOT write methodological limitations or uncertainties here — those belong in Rebuttal.",
    status:
      "Claim status — an agent-assigned judgment, not a system verdict. The system does not decide truth; " +
      "it only enforces structural preconditions: any non-'proposed' status requires compile to have passed. " +
      "'proposed' = initial state, no judgment asserted yet; " +
      "'supported' = you judge the evidence sufficient (requires a warrant whose grounds are all verified); " +
      "'disputed' = you judge the claim under credible challenge (requires at least one rebuttal); " +
      "'refuted' = you judge the claim disproven (same structural gate as 'disputed' — at least one rebuttal). " +
      "'disputed' and 'refuted' share the same preconditions; choosing between them is your assessment of how decisively the rebuttals defeat the claim.",
  },

  statement: {
    description:
      "Record a statement — an atomic factual proposition with provenance (source, verification, attachments). " +
      "A statement is created independently of any argument role; its role as ground evidence, warrant backing, " +
      "or rebuttal condition is determined by the argument structure it is used in, not by the statement itself. ",
    content:
      "What this statement records. Write one declarative factual proposition that can be independently verified or cited. " +
      "State the fact — what is established, observed, or published — not the method or context that produced it. " +
      "Keep each statement atomic: one independently verifiable proposition per node.",
    source:
      "Statement source: 'observed' (independently produced), 'hypothesis' (to be verified), or 'literature' (from published work). " +
      "If source='hypothesis', write in the same declarative form as observed statements — source='hypothesis' already encodes uncertainty; do not add hedging language to content.",
    verification:
      "Verification status. " +
      "'pending' = not yet independently verified; " +
      "'verified' = triggers automatic evidence review — only succeeds if review passes, otherwise reverts to pending.",
    attachments:
      "File paths supporting this statement. " +
      "Statements with source='literature' must provide the reference files (e.g., paper PDF, reference document) as attachments; the reference files themselves serve as the description document — no separate markdown description file is required. " +
      "Other statements should include a description document (e.g., `statement-<topic>.md`) plus any files needed to substantiate the statement, including but not limited to code, result files, execution logs, data, and references. " +
      "The description document should independently explain what the statement records and how the supporting files substantiate it.",
  },

  warrant: {
    description:
      "Record a warrant — an inference-licensing principle that authorizes movement from ground to claim. " +
      "Names a domain-general principle, not an if-then bridge. ",
    content: [
      "Write the domain-general inference-licensing principle that makes these grounds relevant to this claim.",
      "It should explain why this kind of evidence is allowed to support this kind of conclusion, and must hold beyond this specific argument.",
      "Do not restate the claim, summarize the grounds, cite a source, or write a case-specific if-then bridge.",
      "Wrong: 'If temperature increased, then climate change occurred' (case-specific bridge).",
      "Right: 'Sustained temperature increases across multiple independent datasets indicate systematic climate change' (inference-licensing principle).",
    ].join(" "),
    claimId: "The claim this warrant supports.",
    groundIds:
      "Node IDs to use as grounds for this warrant. Use Statement node IDs for factual evidence; Claim node IDs are allowed only for chain reasoning when a subclaim serves as a ground.",
  },

  rebuttal: {
    targetId: "Target Claim or Warrant node ID that this rebuttal statement challenges.",
    targetType: "Target node type: 'claim' or 'warrant'.",
  },
} as const;

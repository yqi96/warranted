/**
 * Warranted — 面向 agent 的教学内容集中管理
 *
 * 所有 tool description、field describe、Hint、Warning 文本常量。
 * tools.ts 和 service.ts 引用此文件，不内联字符串。
 *
 * 要素定义基于 Toulmin, The Uses of Argument (1958)。
 * 经典示例：British citizenship。
 */

// =============================================================================
// Element Definitions — 用于 tool description + content field describe
// =============================================================================

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
      "Claim status. Requires compile to pass before advancing to any non-proposed status. " +
      "'proposed' = initial state, verdict not yet reached; " +
      "'supported' = compile passed and evidence independently assessed as sufficient; " +
      "'disputed' = compile passed, contradicting evidence exists, claim is under challenge but not conclusively disproven; " +
      "'refuted' = compile passed, claim definitively disproven — evidence conclusively shows it is false, no reasonable interpretation supports it.",
  },

  ground: {
    description:
      "Record a ground — a fact, evidence, or data appealed to as foundation for the claim. " +
      "A ground must be independent of the claim. " +
      "Example: 'I was born in Bermuda.'",
    content: [
      "A Ground must be a research RESULT — what was found, observed, produced, or discovered.",
      "It is NOT a description of data availability, input datasets, or methodology.",
      "Wrong: 'This database contains N records available at X' (data availability statement — not a result).",
      "Wrong: 'We used regression analysis' (methodology — belongs in Backing).",
      "Right: 'The temperature increased by 2°C over the past century' (an observed result).",
      "Right: 'Method A achieves 85.3% accuracy on benchmark X' (a research finding).",
      "Right (hypothesis): 'The treatment group shows improved outcomes' (an expected result).",
      "Test: Does this state what was FOUND/PRODUCED, or what was USED/AVAILABLE? Only the former is a Ground.",
      "A Ground is atomic: one measurement or observation that cannot be further decomposed.",
      "Three forms of composite Grounds: (1) before/after or comparison ('reduces from 42.3 to 38.7' bundles baseline=42.3 and ablated=38.7), (2) multiple metrics ('achieves 85% accuracy AND 12ms latency'), (3) multiple conditions ('performs well on clean AND noisy inputs').",
      "Each form decomposes into one Ground per independent measurement.",
      "Test: how many independent measurements does verifying this require? Each one is a separate Ground.",
      "Exception — source='literature': content may be a reported finding, opinion, perspective, or argument from published work (e.g., 'Smith et al. argue that method A is unsuitable for sparse data'). No definition review is applied; content validity is covered when verification='verified'.",
    ].join(" "),
    source: "Evidence source: 'observed' (independently produced), 'hypothesis' (to be verified), or 'literature' (from published work). If source='hypothesis', write in the same declarative form as observed Grounds — source='hypothesis' already encodes uncertainty; do not add hedging language to content.",
    verification:
      "Ground verification status. " +
      "'pending' = not yet independently verified; " +
      "'verified' = triggers automatic evidence review — only succeeds if review passes, otherwise reverts to pending.",
    attachments: "File paths supporting this ground. Grounds with ref_claim_id (chain reasoning) do not need attachments. Other grounds MUST have a description document (e.g., `ground-<topic>.md`) — an independent narrative specific to this ground — explaining: what the ground states, how the evidence was produced, and where the files come from. Files alone without explanation are not enough — the document is the ground's provenance record.",
    refClaimId: "Use an existing Claim as a Ground for chain reasoning (Claim A's conclusion becomes Claim B's evidence). Mutually exclusive with content/source/verification/attachments — the Ground's content is auto-derived from the referenced Claim.",
  },

  warrant: {
    description:
      "Record a warrant — a statement authorizing movement from ground to claim. " +
      "Names a domain-general principle, not an if-then bridge. " +
      "Example: 'A person born in Bermuda will legally be a British citizen.'",
    content: [
      "What domain-general principle authorizes moving from this ground to this claim?",
      "Must hold beyond this specific argument.",
      "Wrong: 'If temperature increased, then climate change occurred' (if-then bridge).",
      "Right: 'Sustained temperature increases across multiple datasets indicate systematic climate change' (inference-licensing principle).",
    ].join(" "),
    claimId: "The claim this warrant supports.",
    groundIds: "Ground IDs to associate as evidence.",
  },

  backing: {
    description:
      "Record backing — credentials certifying the warrant's credibility. " +
      "Introduced when the warrant alone is not convincing. " +
      "Example: 'The British Nationality Act specifies birthright citizenship.'",
    content:
      "What authority, theory, or methodology certifies this warrant? " +
      "Example: 'This conclusion follows the methodology established by the IPCC Assessment Reports.'",
    warrantId: "The warrant this backing supports.",
  },

  rebuttal: {
    description:
      "Record a rebuttal — restrictions that may legitimately apply to the claim. " +
      "Names conditions under which the claim fails. " +
      "Contradictions are information, not problems to eliminate — use this when evidence contradicts rather than deleting or rewriting the Claim. " +
      "Example: 'Unless he has betrayed Britain and become a spy.'",
    content: [
      "The exception or restriction under which the argument fails.",
      "Must be a genuine counter-argument, not an observation note.",
      "Wrong: 'Station A has missing data' (observation).",
      "Right: 'Localized data gaps suggest the pattern may not generalize to all regions' (counter-argument).",
    ].join(" "),
    targetId: "ID of the claim or warrant being rebutted.",
    targetType: "Type of the target node.",
  },

  compile: {
    description:
      "Compile a claim — trigger a two-stage review of the argument chain. " +
      "Stage 1: check each element (Claim/Warrant/Ground) follows Toulmin definitions. " +
      "Stage 2: if Stage 1 passes, check overall logical chain coherence. " +
      "If review passes, the claim gets 'compiled' status. " +
      "If any node in the argument is later modified, compiled status is auto-cleared.",
    claimId: "The claim ID to compile.",
  },
} as const;

// =============================================================================
// Post-Operation Hints — 操作后提示
// =============================================================================

export const HINTS = {
  claimNoWarrants: [
    "Hint: This claim has no warrants yet. To build the reasoning chain:",
    "  1. create_ground — provide evidence (or derive from existing claims via ref_claim_id)",
    "  2. create_warrant — link the claim to its grounds with an inference rule",
    "  3. create_backing (optional) — support the warrant's credibility",
  ].join("\n"),

  groundPendingHypothesis:
    "Hint: This is a hypothesis to verify. To mark it verified, provide a description document explaining what the ground states and how evidence was produced, plus supporting files.",

  groundPendingLiterature:
    "Hint: This ground cites published work. To mark it verified, attach the source (PDF, webpage, or equivalent) with a specific reference (author, year, title, DOI or page).",

  groundPendingObserved:
    "Hint: This ground reports an original observation or experiment. To mark it verified, attach all available evidence: raw data, result files, code, logs, or any other artifacts produced.",

  reviewDispatched:
    "Hint: An async review has been dispatched to verify the reasoning chain. " +
    "Results will be available on the next tool call.",

  claimStale: (claimId: number) =>
    `Hint: Claim #${claimId} has pending changes that need review. ` +
    `Call compile to verify the argument.`,

  groundVerificationReverted: (nodeId: number) =>
    `Hint: Ground #${nodeId} content changed — verification reverted to pending. Re-mark as verified when ready.`,
} as const;

// =============================================================================
// Post-Deletion Warnings — 删除后警告
// =============================================================================

export const WARNINGS = {
  /** D4: 删除被链式引用的 Claim */
  deleteClaimReferencedByGround: (nodeId: number, gids: string) =>
    `Warning: Claim #${nodeId} was referenced by Ground(s) #${gids} as chain reasoning evidence. ` +
    `These Grounds and their Warrant associations have been deleted. ` +
    `Please review the correctness of related arguments.`,

  /** D1: 删除被 Warrant 引用的 Ground */
  deleteGroundReferencedByWarrant: (nodeId: number, wids: string) =>
    `Warning: Ground #${nodeId} was referenced by Warrant(s) ${wids}. ` +
    `It has been removed from these Warrants. ` +
    `Please review the correctness of the associated arguments.`,

  /** D3: 删除支撑非 proposed Claim 的 Warrant */
  deleteWarrantSupportingClaim: (nodeId: number, claimId: number, status: string) =>
    `Warning: Warrant #${nodeId} supported Claim #${claimId} (status: "${status}"). ` +
    `The Claim's support structure has been weakened. ` +
    `Please review whether the Claim's status is still appropriate.`,

  /** H2: Ground 从 verified 退回 */
  revertGroundVerification: (nodeId: number, wids: string) =>
    `Warning: Ground #${nodeId} was previously verified but is now being reverted. ` +
    `Warrants ${wids} reference this Ground. ` +
    `Claims depending on these Warrants may no longer satisfy the "supported" criteria. ` +
    `Please review whether the related Claims' status is still appropriate.`,

  /** Compile 失效 */
  compileInvalidated: (claimId: number, nodeId: number) =>
    `Warning: Claim #${claimId}'s compiled status has been cleared ` +
    `because node #${nodeId} in its argument chain was modified.`,

  /** 自动审查触发 */
  autoReviewTriggered: (claimId: number, triggerNode?: number) =>
    `Auto-review triggered for Claim #${claimId}` +
    (triggerNode ? ` due to changes in node #${triggerNode}` : "") +
    `.`,
} as const;

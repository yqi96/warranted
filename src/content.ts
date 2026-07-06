/**
 * Toulmin MCP — 面向 agent 的教学内容集中管理
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
  },

  ground: {
    description:
      "Record a ground — a fact, evidence, or data appealed to as foundation for the claim. " +
      "A ground must be independent of the claim. " +
      "Example: 'I was born in Bermuda.'",
    content: [
      "State a fact or result — not a methodology.",
      "Wrong: 'We used regression analysis' (methodology — belongs in Backing).",
      "Right: 'The temperature increased by 2°C over the past century' (an observed result).",
      "Right (hypothesis): 'The treatment group will show improved outcomes' (an expected result).",
    ].join(" "),
    source: "Evidence source: 'observed' (independently produced), 'hypothesis' (to be verified), or 'literature' (from published work).",
    verification: "Has this evidence been independently verified?",
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

  groundPending:
    "Hint: This is a hypothesis to verify. Verification work requires documentation: " +
    "a description document (e.g., `ground-<topic>.md`) — an independent narrative specific to this ground — explaining what the ground states and how evidence was produced, plus supporting files. " +
    "Without these, the Ground cannot pass acceptance.",
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
} as const;

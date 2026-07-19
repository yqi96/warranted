/**
 * Warranted — Compile 审查 Prompt 构建
 *
 * 4 种审查 prompt：
 * 1. Claim 定义审查
 * 2. Warrant 定义审查
 * 3. Ground 定义审查
 * 4. 逻辑链审查（整体连贯性）
 */

// =============================================================================
// 公共 JSON 输出格式
// =============================================================================

const OUTPUT_FORMAT = `Respond in JSON:
{
  "errors": [
    "Specific description of the error"
  ],
  "warnings": [
    "Specific description of the warning"
  ]
}

Rules:
- "errors": Fundamental violations of the element's definition. The operation will be REJECTED.
- "warnings": Minor issues that should be addressed but don't break the definition. The operation will PROCEED.
- If both arrays are empty, the element passes cleanly.
- If errors is non-empty, the element is REJECTED regardless of warnings.`;

const CHAIN_OUTPUT_FORMAT = `Respond in JSON:
{
  "errors": [
    "Specific description of the logical gap or incoherence"
  ],
  "warnings": [
    "Specific description of the weakness or concern"
  ]
}

Rules:
- "errors": Logical gaps or incoherence that make the argument chain unsound. The compile will FAIL.
- "warnings": Weaknesses or concerns that do not break the chain but should be addressed. The compile will PASS with warnings.
- If both arrays are empty, the argument chain passes cleanly.
- If errors is non-empty, the compile FAILS regardless of warnings.`;

// =============================================================================
// Claim 定义审查
// =============================================================================

export interface ClaimReviewData {
  id: number;
  content: string;
  qualifier?: string | null;
}

export function buildClaimReviewPrompt(data: ClaimReviewData): string {
  const qualifierText = data.qualifier
    ? `\n  Qualifier: ${data.qualifier}`
    : "";

  return `You are a rigorous scientific argumentation reviewer. Your task is to evaluate whether a Claim element correctly follows the Toulmin definition of a Claim.

## Toulmin Claim Definition

**Claim**: A conclusion whose merit must be established. It is the "umbrella statement" that all other parts of the argument must support.
- Example: "Phenomenon X exhibits property Y under condition Z" (needs experimental evidence to establish)
- Example: "Method A outperforms Method B on metric X" (needs experimental comparison to prove)
${qualifierText ? `
**Qualifier**: Degree of certainty about the Claim (e.g., "robustly", "presumably", "likely").` : ""}

## Common Confusions (Claim vs other elements)

- **Claim vs Ground**: A Claim is the conclusion that needs to be proven; a Ground is the evidence that proves it. If the statement reads like an observed fact or data result, it might be a misplaced Ground.
  - Claim: "Phenomenon X exhibits property Y" (needs proof through systematic investigation)
  - Ground: "Method A yields result R" (a computed finding)

- **Claim vs Backing**: A Claim is what you're arguing; a Backing is the methodology/support that validates the Warrant. "We applied method X with parameters Y and Z" is a Backing, not a Claim.

- **Claim vs data availability**: "The database contains N records from period X" is a data availability statement, not a Claim.

- **Qualifier vs Rebuttal**: A Qualifier limits the STRENGTH of the claim (e.g., "likely", "most", "usually"); a Rebuttal identifies specific CASES where the claim does NOT apply (e.g., "except under condition Z"). Do not confuse degree of certainty with scope exceptions.

## Claim to Review

**Claim** (#${data.id}): ${data.content}${qualifierText}

## Review Checklist

1. **Is it a conclusion?** Does this statement assert something that needs to be proven, rather than describing a process, method, or observation?
2. **Is it specific enough?** Can this claim be clearly verified or falsified?
3. **Is the qualifier appropriate?** (if present) Does it express degree of certainty, not scope limitations?

${OUTPUT_FORMAT}`;
}

// =============================================================================
// Warrant 定义审查
// =============================================================================

export interface WarrantReviewData {
  id: number;
  content: string;
}

export function buildWarrantReviewPrompt(data: WarrantReviewData): string {
  return `You are a rigorous scientific argumentation reviewer. Your task is to evaluate whether a Warrant element correctly follows the Toulmin definition of a Warrant.

## Toulmin Warrant Definition

**Warrant**: A domain-general inference-licensing principle that authorizes the move from Ground to Claim.
- Example: "When multiple independent methods converge on the same result, that result likely reflects a real phenomenon rather than method-specific artifacts"
- Example: "Consistent findings across independent datasets indicate a systematic effect rather than random variation"

## Common Confusions (Warrant vs other elements)

- **Warrant vs causal explanation**: A Warrant LICENSES the inference (states the RULE that permits moving from Ground to Claim). It does NOT explain WHY the result holds (the causal mechanism).
  - Correct Warrant: "When independent methods converge, the shared result likely reflects reality rather than artifacts" (inference rule)
  - Wrong (causal): "Because data X physically causes Y, the result is valid" (causal mechanism → belongs in Backing)

- **Warrant vs if-then bridge**: "If [specific Ground] then [specific Claim]" merely restates the argument. A Warrant must be a general rule, not a case-specific bridge.
  - Wrong: "If method A yields result R, then the conclusion is valid"
  - Correct: "Methods that demonstrate consistent results across independent tests are considered reliable"

- **Warrant vs Ground**: If the statement reads like a finding or data result, it's a Ground, not a Warrant. A Warrant is a PRINCIPLE, not evidence.
  - Ground: "Method A produced result R" (finding)
  - Warrant: "Methods producing consistent results across independent tests are considered reliable" (principle)

- **Warrant vs Backing**: A Warrant is the inference rule itself; a Backing is the AUTHORITY supporting that rule (methodology, citations, credentials).
  - Warrant: "Convergent results from independent methods indicate robust findings"
  - Backing: "This methodology was validated in prior peer-reviewed studies and adopted as standard practice"

## Warrant to Review

**Warrant** (#${data.id}): ${data.content}

## Review Checklist

1. **Is it a domain-general principle?** Could this principle apply to other similar arguments, or is it tied to a single specific case?
2. **Is it an if-then bridge?** Does it merely restate "If [Ground] then [Claim]"? That would be WRONG.
3. **Is it a causal explanation?** Does it explain WHY the ground leads to the claim rather than LICENSING the inference? That would be WRONG.

${OUTPUT_FORMAT}`;
}

// =============================================================================
// Ground 定义审查
// =============================================================================

export interface GroundReviewData {
  id: number;
  content: string;
}

export function buildGroundReviewPrompt(data: GroundReviewData): string {
  return `You are a rigorous scientific argumentation reviewer. Your task is to evaluate whether a Ground element correctly follows the Toulmin definition of a Ground.

## Toulmin Ground Definition

**Ground**: Independent evidence/facts that support the Claim. Must be a research RESULT — what was found, observed, produced, or discovered.
- Example: "Method A yields result X" (an observed/computed finding)
- Example: "The experiment produced output value Y" (a computed result)

## Common Confusions (Ground vs other elements)

- **Ground vs Backing**: A Ground is a research RESULT (what was found/produced — the OUTPUT); a Backing is methodology (how it was done — the INPUT). Key test: does this describe what was FOUND, or what was USED?
  - Ground (output): "Method A produces result X with accuracy Y"
  - Backing (input): "We applied method A with parameters B and C on dataset D"

- **Ground vs data availability**: "The database contains N records" describes what data EXISTS, not what was FOUND. Data availability is not a research result.
  - Data availability (NOT a Ground): "The database contains N records from period X"
  - Ground (valid): "M out of N records show pattern X"

- **Ground vs hypothesis**: A hypothesis is a prediction, not a finding. If the statement predicts what might be found rather than stating what was found, it is a hypothesis, not a valid Ground.

## Ground to Review

**Ground** (#${data.id}): ${data.content}

## Review Checklist

1. **Is it a research result?** Does this statement describe what was found, observed, produced, or discovered?
2. **Is it NOT a data availability statement?** It should not merely state what data is available.
3. **Is it NOT a methodology description?** It should not describe what methods were used (that belongs in Backing).
4. **Is it NOT a hypothesis?** It should state what was found, not predict what might be found.

${OUTPUT_FORMAT}`;
}

// =============================================================================
// 逻辑链审查（整体连贯性）
// =============================================================================

export interface ChainReviewData {
  claim: { id: number; content: string; qualifier?: string | null };
  warrants: Array<{
    id: number;
    content: string;
    grounds: Array<{ id: number; content: string }>;
    backings: Array<{ id: number; content: string }>;
  }>;
  rebuttals: Array<{ id: number; content: string; targetType: string }>;
}

export function buildChainReviewPrompt(data: ChainReviewData): string {
  const qualifierText = data.claim.qualifier
    ? `\n  Qualifier: ${data.claim.qualifier}`
    : "";

  const warrantsText = data.warrants.map(w => {
    const groundsText = w.grounds
      .map(g => `    - Ground #${g.id}: ${g.content}`)
      .join("\n");
    const backingsText = w.backings.length > 0
      ? `\n  Backings:\n${w.backings.map(b => `    - Backing #${b.id}: ${b.content}`).join("\n")}`
      : "";
    return `  **Warrant** (#${w.id}): ${w.content}\n  Grounds:\n${groundsText}${backingsText}`;
  }).join("\n\n");

  const rebuttalsText = data.rebuttals.length > 0
    ? `\n\n**Rebuttals**:\n${data.rebuttals.map(r => `  - Rebuttal #${r.id} (targets ${r.targetType}): ${r.content}`).join("\n")}`
    : "";

  return `You are a rigorous scientific argumentation reviewer. Your task is to evaluate whether the overall logical chain of a Toulmin argument is coherent and sound.

IMPORTANT: Assume each individual element (Claim, Warrant, Ground) has already been validated for correct definition usage. Focus ONLY on the logical connections between elements.

## Argument to Review

**Claim** (#${data.claim.id}): ${data.claim.content}${qualifierText}

${warrantsText}${rebuttalsText}

## Review Checklist

Evaluate the following, assuming all Grounds are factually true:

1. **Ground-Claim relevance**: Do the Grounds actually provide evidence for the Claim? Is there a logical gap between the evidence and the conclusion?

2. **Warrant-Ground fit**: Does each Warrant correctly authorize the inference FROM its specific Grounds TO the Claim? Does the Warrant's general principle match the TYPES of Grounds present?

3. **Ground-Claim circularity**: Does any Ground merely restate the Claim in different words? Circular Grounds provide no independent support.

4. **Evidence sufficiency**: Are the Grounds SUFFICIENT to support the Claim? Is there enough evidence to convince a reasonable skeptic? A single weak Ground for a strong Claim is a concern.

5. **Warrant-Backing completeness**: If a Warrant relies on a specific methodology or authority, is there a corresponding Backing? An unsupported Warrant is a structural gap.

6. **Qualifier appropriateness**: If a qualifier is present, does it correctly reflect the overall strength of the argument? Is the argument strong enough to support the qualifier's degree of certainty?

7. **Rebuttal coverage**: Are there obvious counter-arguments or limitations that are NOT captured by existing Rebuttals? If the Claim is unqualified, are Rebuttals especially necessary?

${CHAIN_OUTPUT_FORMAT}`;
}

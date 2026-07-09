/**
 * Toulmin MCP — Compile 审查 Prompt 构建
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
  "verdict": "pass" | "concerns" | "fail",
  "summary": "One-paragraph assessment",
  "issues": [
    {
      "severity": "major" | "minor" | "info",
      "message": "Specific description of the issue"
    }
  ]
}

Verdicts:
- "pass": No issues found. The element correctly follows its definition.
- "concerns": Minor issues that should be addressed but don't break the definition.
- "fail": Fundamental violation of the element's definition.`;

// =============================================================================
// Claim 定义审查
// =============================================================================

export interface ClaimReviewData {
  id: number;
  content: string;
  status: string;
  qualifier?: string | null;
}

export function buildClaimReviewPrompt(data: ClaimReviewData): string {
  const qualifierText = data.qualifier
    ? `\n  Qualifier: ${data.qualifier}`
    : "";

  return `You are a rigorous scientific argumentation reviewer. Your task is to evaluate whether a Claim element correctly follows the Toulmin definition of a Claim.

## Toulmin Claim Definition

**Claim**: A conclusion whose merit must be established.
- Example: "The temperature increased by 2°C over the past century"
- Example: "Method A outperforms Method B on metric X"
- NOT a methodology or observation process
- NOT a data availability statement
- NOT a description of what was done (that belongs in Backing)
${qualifierText ? `
**Qualifier**: Degree of certainty about the Claim (e.g., "robustly", "presumably", "likely").
- NOT scope limitations (those belong in Rebuttal)
- NOT methodological caveats` : ""}

## Claim to Review

**Claim** (#${data.id}): ${data.content}
- Status: ${data.status}${qualifierText}

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
  claimContent: string;
  claimId: number;
  groundContents: Array<{ id: number; content: string }>;
}

export function buildWarrantReviewPrompt(data: WarrantReviewData): string {
  const groundsText = data.groundContents
    .map(g => `  - Ground #${g.id}: ${g.content}`)
    .join("\n");

  return `You are a rigorous scientific argumentation reviewer. Your task is to evaluate whether a Warrant element correctly follows the Toulmin definition of a Warrant.

## Toulmin Warrant Definition

**Warrant**: A domain-general inference-licensing principle that authorizes the move from Ground to Claim. Must hold beyond this specific argument.
- Example: "If multiple independent methods converge on the same pattern, that pattern likely reflects a real phenomenon rather than method-specific artifacts"
- Example: "Sustained temperature increases across multiple datasets indicate systematic climate change"
- NOT an if-then bridge ("If [specific Ground] then [specific Claim]")
- NOT a causal explanation of why the Ground leads to the Claim
- Must be a GENERAL principle, not specific to this argument

## Warrant to Review

**Warrant** (#${data.id}): ${data.content}

**Supports Claim** (#${data.claimId}): ${data.claimContent}

**Linked Grounds**:
${groundsText}

## Review Checklist

1. **Is it a domain-general principle?** Does this warrant hold beyond this specific argument? Could it apply to other similar arguments?
2. **Is it an if-then bridge?** Does it merely restate "If [Ground] then [Claim]"? That would be WRONG.
3. **Is it a causal explanation?** Does it explain WHY the ground leads to the claim rather than LICENSING the inference? That would be WRONG.
4. **Does it correctly authorize the inference?** Does it connect these specific types of grounds to this type of claim?

${OUTPUT_FORMAT}`;
}

// =============================================================================
// Ground 定义审查
// =============================================================================

export interface GroundReviewData {
  id: number;
  content: string;
  source: string;
  verification: string;
}

export function buildGroundReviewPrompt(data: GroundReviewData): string {
  return `You are a rigorous scientific argumentation reviewer. Your task is to evaluate whether a Ground element correctly follows the Toulmin definition of a Ground.

## Toulmin Ground Definition

**Ground**: Independent evidence/facts that support the Claim. Must be a research RESULT — what was found, observed, produced, or discovered.
- Example: "Method A yields result X" (an observed/computed finding)
- Example: "The temperature increased by 2°C over the past century" (an observed result)
- NOT a data availability statement ("Database contains N records available at X")
- NOT a methodology description ("We used regression analysis")
- NOT an input dataset description ("The dataset consists of 10,000 samples from...")
- Test: Does this state what was FOUND/PRODUCED, or what was USED/AVAILABLE? Only the former is a valid Ground.

## Ground to Review

**Ground** (#${data.id}): ${data.content}
- Source: ${data.source}
- Verification: ${data.verification}

## Review Checklist

1. **Is it a research result?** Does this statement describe what was found, observed, produced, or discovered?
2. **Is it independent of the claim?** Is this evidence that exists separately from the conclusion it supports?
3. **Is it NOT a data availability statement?** It should not merely state what data is available.
4. **Is it NOT a methodology description?** It should not describe what methods were used (that belongs in Backing).
5. **Is the source type appropriate?** Does the declared source (${data.source}) match the nature of this ground?

${OUTPUT_FORMAT}`;
}

// =============================================================================
// 逻辑链审查（整体连贯性）
// =============================================================================

export interface ChainReviewData {
  claim: { id: number; content: string; status: string; qualifier?: string | null };
  warrants: Array<{
    id: number;
    content: string;
    grounds: Array<{ id: number; content: string; source: string; verification: string }>;
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
      .map(g => `    - Ground #${g.id} (${g.source}/${g.verification}): ${g.content}`)
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

2. **Warrant-Ground fit**: Does each Warrant correctly authorize the inference FROM its specific Grounds TO the Claim?

3. **Completeness**: Is the argument complete? Are there obvious gaps in the reasoning?

4. **Qualifier appropriateness**: If a qualifier is present, does it correctly reflect the strength of the overall argument?

5. **Rebuttal coverage**: Are there obvious counter-arguments or limitations that are NOT captured by existing Rebuttals?

${OUTPUT_FORMAT}`;
}

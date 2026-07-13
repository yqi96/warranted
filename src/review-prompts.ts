/**
 * Toulmin MCP — 审查 Prompt 构建
 *
 * 为两种审查类型构建 LLM prompt：
 * 1. 推理链审查（Argument Review）
 * 2. Ground 证据审查（Ground Evidence Review）
 */

// =============================================================================
// 推理链审查
// =============================================================================

export interface ArgumentReviewData {
  claim: { id: number; content: string; status: string; qualifier?: string | null };
  warrant: { id: number; content: string };
  grounds: Array<{ id: number; content: string; source: string; verification: string; attachments: string[] }>;
  backings?: Array<{ id: number; content: string }>;
  rebuttals?: Array<{ id: number; content: string; targetType: string }>;
}

export function buildArgumentReviewPrompt(data: ArgumentReviewData): string {
  const { claim, warrant, grounds, backings, rebuttals } = data;

  const groundsText = grounds
    .map(g => `  - Ground #${g.id}: ${g.content}`)
    .join("\n");

  const qualifierText = claim.qualifier
    ? `\n  Qualifier: ${claim.qualifier}`
    : "";

  const backingsText = backings && backings.length > 0
    ? `\n\n**Backings**:\n${backings.map(b => `  - Backing #${b.id}: ${b.content}`).join("\n")}`
    : "";

  const rebuttalsText = rebuttals && rebuttals.length > 0
    ? `\n\n**Rebuttals**:\n${rebuttals.map(r => `  - Rebuttal #${r.id} (targets ${r.targetType}): ${r.content}`).join("\n")}`
    : "";

  return `You are a rigorous scientific argumentation reviewer. Your task is to evaluate whether a Toulmin argument chain is logically sound.

## Toulmin Element Definitions

**Claim**: A conclusion whose merit must be established.
- Example: "The temperature increased by 2°C over the past century"
- NOT a methodology or observation process

**Ground**: Independent evidence/facts that support the Claim. Must be a research RESULT — what was found, observed, or produced.
- Example: "Method A yields result X" (an observed/computed finding)
- NOT a data availability statement ("Database contains N records")
- NOT a methodology description ("We used regression analysis")

**Warrant**: A domain-general inference-licensing principle that authorizes the move from Ground to Claim. Must hold beyond this specific argument.
- Example: "If multiple independent methods converge on the same pattern, that pattern likely reflects a real phenomenon rather than method-specific artifacts"
- NOT an if-then bridge ("If [Ground] then [Claim]")
- NOT a causal explanation of why the Ground leads to the Claim

**Qualifier**: Degree of certainty about the Claim (e.g., "robustly", "presumably", "likely").
- NOT scope limitations (those belong in Rebuttal)

**Backing**: Additional support for the Warrant (optional).

**Rebuttal**: Conditions under which the Claim would not hold (optional).

## Argument Chain to Review

**Claim** (#${claim.id}): ${claim.content}${qualifierText}

**Warrant** (#${warrant.id}): ${warrant.content}

**Grounds**:
${groundsText}${backingsText}${rebuttalsText}

## Review Checklist

Evaluate the following, assuming all Grounds are factually true:

1. **Warrant validity**: Does the Warrant name a genuine domain-general principle? Or is it merely an if-then bridge ("If [Ground] then [Claim]")? A valid Warrant should hold beyond this specific argument.

2. **Ground-Claim relevance**: Do the Grounds actually provide evidence for the Claim? Is there a logical gap between the evidence and the conclusion?

3. **Warrant-Ground fit**: Does the Warrant correctly authorize the inference FROM these specific Grounds TO this Claim?

4. **Element definitions**: Is each element used correctly per the definitions above?

5. **Qualifier appropriateness**: If a qualifier is present, does it correctly reflect the strength of the argument?

## Output Format

Respond in JSON:
{
  "verdict": "sound" | "concerns" | "invalid",
  "summary": "One-paragraph overall assessment",
  "issues": [
    {
      "severity": "major" | "minor" | "info",
      "element": "claim" | "warrant" | "ground",
      "nodeId": <number>,
      "message": "Specific description of the issue"
    }
  ]
}

Verdicts:
- "sound": The chain is logically valid. No issues found.
- "concerns": The chain has issues that should be addressed but is not fundamentally broken.
- "invalid": The chain has fundamental logical flaws.`;
}

// =============================================================================
// Ground 证据审查
// =============================================================================

export interface GroundEvidenceReviewData {
  ground: {
    id: number;
    content: string;
    source: string;
    verification: string;
    attachments: string[];
  };
}

export function buildGroundEvidencePrompt(data: GroundEvidenceReviewData): string {
  const { ground } = data;

  const attachmentsText = ground.attachments.length > 0
    ? ground.attachments.map(a => `  - ${a}`).join("\n")
    : "  (none)";

  return `You are a rigorous scientific evidence reviewer. Your task is to evaluate whether a Ground's attachments provide sufficient evidence to support its claimed correctness.

IMPORTANT: Before answering, you MUST use your Read tool to read every attachment file listed below. Do not guess their contents — actually read them.

## Ground to Review

**Ground** (#${ground.id}): ${ground.content}
- Source: ${ground.source}
- Verification: ${ground.verification}
- Attachments:
${attachmentsText}

## Review Checklist

Evaluate the following and report any issues found:

1. **Attachment accessibility**: Can all listed attachment files be read? Report an error for any file that does not exist or cannot be accessed.

2. **Description document**: Is there a description document (e.g., ground-<topic>.md) among the attachments that explains:
   - What the ground states
   - How the evidence was produced
   - Where the files come from
   Report an error if no such document exists. Report a warning if the document exists but does not cover all three aspects.

3. **Evidence sufficiency**: Are the attachments sufficient to independently verify the Ground's correctness?
   - For "observed" grounds: Are there experimental results, data files, or observation logs?
   - For "literature" grounds: Is there a specific citation or reference?
   - For "hypothesis" grounds marked verified: Is there independent verification evidence?
   Report an error if the evidence is insufficient. Report a warning if partial evidence exists but gaps remain.

4. **Content-attachment consistency**: Does the Ground's content accurately describe what the attachments contain? Report an error if the content directly contradicts the attachments. Report a warning for minor discrepancies that don't change the meaning.

5. **Source appropriateness**: Is the declared source type (${ground.source}) correct given the evidence? Report a warning if the source type is debatable but not clearly wrong.

## Output Format

Respond in JSON:
{
  "errors": [
    "Specific description of the error"
  ],
  "warnings": [
    "Specific description of the warning"
  ]
}

Rules:
- "errors": The Ground cannot be marked as verified. The verification will be REJECTED.
- "warnings": Minor issues that should be addressed but don't block verification. The operation will PROCEED.
- If both arrays are empty, the evidence is sufficient and the Ground passes cleanly.
- If errors is non-empty, the Ground is REJECTED regardless of warnings.`;
}

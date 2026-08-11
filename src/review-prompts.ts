/**
 * Warranted — 审查 Prompt 构建
 *
 * Statement 证据审查（Statement Evidence Review）的 LLM prompt。
 * 审查对象是单个 statement 节点（判定其 verification=verified 是否成立），
 * 与"逻辑链审查"（compile-prompts.ts，statement 处于 argument 中扮演 ground 角色）不同。
 */

// =============================================================================
// Statement 证据审查
// =============================================================================

/**
 * 审查者的输入里没有 verification：它要判的就是"该不该 verified"，
 * 把当前值递给它就是把答案递给它（pending 与 verified 各锚定一个方向）。
 */
export interface StatementEvidenceReviewData {
  statement: {
    id: number;
    content: string;
    source: string;
    attachments: string[];
  };
}

export function buildStatementEvidencePrompt(data: StatementEvidenceReviewData): string {
  const { statement } = data;

  const attachmentsText = statement.attachments.length > 0
    ? statement.attachments.map(a => `  - ${a}`).join("\n")
    : "  (none)";

  return `You are a rigorous scientific evidence reviewer. Your task is to evaluate whether a Statement's attachments provide sufficient evidence to support its claimed correctness.

IMPORTANT: Before answering, you MUST use your Read tool to read every attachment file listed below. Do not guess their contents — actually read them.

## Statement to Review

**Statement** (#${statement.id}): ${statement.content}
- Source: ${statement.source}
- Attachments:
${attachmentsText}

## Review Checklist

Evaluate the following and report any issues found:

1. **Attachment accessibility**: Can all listed attachment files be read? Report an error for any file that does not exist or cannot be accessed.

2. **Description document**: Is there a description document (e.g., statement-<topic>.md) among the attachments that explains:
   - What the statement asserts
   - How the evidence was produced
   - Where the files come from
   Report an error if no such document exists — EXCEPT for source='literature': if the attachments include the actual reference files (e.g., a paper PDF, a reference document) and those files are readable, the reference files themselves serve as the description document; no separate markdown description file is required.

3. **Evidence sufficiency**: Are the attachments sufficient to independently verify the Statement's correctness?
   - For "observed" statements: Are there experimental results, data files, or observation logs?
   - For "literature" statements: Is there a specific citation or reference in the attachments? The reference files themselves (e.g., a paper PDF) are sufficient evidence; no separate description document is required as long as the files are readable.
   Report an error if the evidence is insufficient. Report a warning if partial evidence exists but gaps remain.

4. **Content-attachment consistency**: Does the Statement's content accurately describe what the attachments contain? Report an error if the content directly contradicts the attachments. Report a warning for minor discrepancies that don't change the meaning.

5. **Source appropriateness**: Is the declared source type (${statement.source}) correct given the evidence? Report a warning if the source type is debatable but not clearly wrong.

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
- "errors": The Statement cannot be marked as verified. The verification will be REJECTED.
- "warnings": Minor issues that should be addressed but don't block verification. The operation will PROCEED.
- If both arrays are empty, the evidence is sufficient and the Statement passes cleanly.
- If errors is non-empty, the Statement is REJECTED regardless of warnings.`;
}

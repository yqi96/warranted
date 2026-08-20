/**
 * Warranted — 审查 Prompt 构建(design.md §2.2 / api.md §4.1)
 *
 * 审查器只回答两个问题:
 * - **Q1 忠实性**:附件有没有真的说这条命题声称的事。只针对**附件**。
 * - **Q2 有效性**:证据即便为真,这条 warrant 能否推出 content。
 *
 * 旧的 Statement 证据审查(五条清单 + errors/warnings)整个退役:它给的是
 * "该不该 verified"的判决,而新系统里 review 不产出 pass/fail 的门,只产出带引证的
 * finding,判决归 L3。
 *
 * **输入边界是本文件的类型,不是 prompt 里的一句禁令**(design.md §2.2):
 * `ReviewInput` 里有每条证据命题的 qualifier(前提的极性是前提的一部分),
 * **没有被审查命题自己的 qualifier**(那是待判的结论)。越界的修法是删字段——
 * 一个 prompt 拿不到的字段,措辞怎么写都泄不出去。
 */

import type { Qualifier } from "./types.ts";

/** Prompt 版本。改动本文件的任何措辞都要跟着改它——协议 hash 由它与正文一起算。 */
export const REVIEW_PROTOCOL_VERSION = "q1q2/1";

// =============================================================================
// 输入
// =============================================================================

/** 一条被引用进证据槽的命题。带 qualifier:以它**当下的认识状态**为前提。 */
export interface EvidenceNodeInput {
  id: number;
  content: string;
  /**
   * 它自己的档位。**必须进**:一条 content 写着"假设 X 成立"、qualifier 落
   * `refuted` 的证据,把它的 content 当真恰恰是反的(design.md §1.2 起 `refuted`
   * 也能当证据)。不给这个字段,Q2 根本不成立。
   */
  qualifier: Qualifier;
}

/**
 * 递给审查器的全部东西:单条命题 + 它的直接证据 + 它的 warrant。不递归、不吃子图。
 *
 * **这里没有 `qualifier` 字段,而且不该有。** 被审查命题自己的档位是 L3 待判的结论,
 * 递过去就是把答案递给它。这条边界靠"字段不存在"落实。
 */
export interface ReviewInput {
  id: number;
  content: string;
  /** 内联文本或晋升后那条命题的 content。审查器不需要知道是哪一种——它读的是同一句话。 */
  warrant: string | null;
  attachments: string[];
  evidenceNodes: EvidenceNodeInput[];
}

// =============================================================================
// Prompt
// =============================================================================

/**
 * 反模式清单。**是识别辅助,不是合同**(design.md §2.2):合同只有 Q1/Q2 两条。
 * 写成"常见形态"而不是"违反下列任一即 fail",既抓得到清单外的新形态,方差也更低。
 */
const ANTIPATTERN_HINTS = [
  "The warrant restates the content in other words, so it carries no inferential load.",
  "The warrant is an ad-hoc if-then bridge about this case only, not a principle that holds beyond this argument.",
  "The evidence establishes correlation while the content asserts causation.",
  "The evidence is about a different population, period, or quantity than the content.",
].join("\n");

export function buildReviewPrompt(input: ReviewInput): string {
  const attachments =
    input.attachments.length > 0
      ? input.attachments.map((a) => `  - ${a}`).join("\n")
      : "  (none — Q1 has nothing to act on)";

  const evidence =
    input.evidenceNodes.length > 0
      ? input.evidenceNodes
          .map((n) => `  - #${n.id} [${n.qualifier}]: ${n.content}`)
          .join("\n")
      : "  (none)";

  const warrant = input.warrant ?? "(empty — nothing states why this kind of evidence supports this kind of conclusion)";

  return `You are an independent reviewer giving a second opinion on one proposition in an argument graph. You are an advisor, not a gate: nothing you say blocks anything. Your value is in pointing at specific broken points that a careful reader would otherwise miss.

Answer exactly two questions about the proposition below. Nothing else is in scope.

**Q1 — Faithfulness.** Do the attachments actually say what this proposition claims, or are they fabricated, misread, or in direct contradiction? This question applies **only to attachment files**. You MUST use your Read tool to open every attachment listed; do not guess at their contents. If there are no attachments, Q1 is "n/a".

**Q2 — Validity.** Granting the evidence as true, does the warrant actually get you from the evidence to the content? Take each referenced proposition at its stated qualifier: a premise marked "refuted" enters as a refuted claim, not as a true one, and an argument that needs it to be true is broken.

Do not assess how important a flaw is, do not suggest how to fix anything, and do not evaluate propositions other than this one. Referenced propositions are quoted by reference, not copied — do not review their evidence.

## The proposition under review

**#${input.id}**: ${input.content}

**Warrant**: ${warrant}

**Attachments** (Q1 acts on these):
${attachments}

**Referenced propositions** (premises for Q2, at their current standing):
${evidence}

## Common shapes of a broken Q2

These are recognition aids, not a checklist. A flaw not on this list still counts; an item on this list that does not actually break the inference does not.

${ANTIPATTERN_HINTS}

## Output

Return a raw JSON object:

{
  "Q1": "pass" | "fail" | "n/a",
  "Q2": "pass" | "fail",
  "findings": [ ... ]
}

Report "fail" only when you can produce a finding for it, and a finding for every failure. "n/a" is for Q1 when there are no attachments — do not report "pass" in that case, it would claim faithfulness was checked.

Each finding is one of two shapes, decided by which question broke:

Q1 finding — cite the attachment text:
{ "question": "Q1", "confidence": "high" | "low",
  "content": "<what is broken: which claim the attachment does not support, and how it differs>",
  "citation": { "attachment": "<a path from the Attachments list above>",
                "locator": "<page / line / section, enough for a person to find it>",
                "quote": "<verbatim text from the attachment>" } }

Q2 finding — cite the text in the graph where the inference breaks:
{ "question": "Q2", "confidence": "high" | "low",
  "content": "<what is broken: which step does not go through>",
  "citation": { "node_id": <${input.id}, or the id of a referenced proposition>,
                "slot": "content" | "warrant",
                "quote": "<verbatim substring of that node's content or warrant>" } }

Rules that are checked mechanically, and rejected findings are discarded:
- Every finding needs a citation. A finding without one is not reportable.
- A Q1 citation.attachment must be one of the paths listed above.
- A Q2 citation.node_id must be ${input.id} or a referenced proposition's id.
- A Q2 citation.quote must appear **verbatim** in that node's content or warrant. Copy it; do not paraphrase, do not reconstruct from memory.

"confidence" is how sure you are of your own judgement — "high" when you can point at the exact words that break, "low" when something reads wrong but you cannot pin it. There is no middle value. It is not how severe the problem is; severity needs a view of the whole graph, which you do not have.

If both questions pass, return them as "pass" with an empty findings array. Saying "nothing is broken here" is a real answer and is recorded as one.`;
}

/**
 * 协议 hash:钉住"这次 finding 是按哪套规则产出的"(design.md §2.3)。
 *
 * 算的是 prompt 全文而不只是版本号——版本号是人手维护的,忘了改就撒谎;全文 hash
 * 改一个字就变。版本号留着是给人读的。
 */
export function protocolHash(prompt: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(REVIEW_PROTOCOL_VERSION);
  h.update("\n");
  h.update(prompt);
  return h.digest("hex").slice(0, 16);
}

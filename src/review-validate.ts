/**
 * Warranted — finding 的机械校验(api.md §4.1 F1–F4)
 *
 * 把 design.md §2.3 的"强制引证"从措辞变成可执行判据。校验的对象是**单条 finding**:
 * 不通过 = 这一条不合格,拒收并记一次协议违规,**不是拒绝 review 整体**。答"是"的那部分
 * 结论照样落库。
 *
 * 校验的比对基准是**递给审查器的那份视图**(`ReviewInput`),不是数据库当下的样子。
 * 两者理论上同一时刻取自同一处,但写成前者才让这句话成立:引一段它从没见过的文字,
 * 就是在编——哪怕那段文字确实存在于图的别处。
 */

import type { FindingDraft, RejectedFinding } from "./types.ts";
import type { ReviewInput } from "./review-prompts.ts";

export type { RejectedFinding };

export interface ValidationOutcome {
  accepted: FindingDraft[];
  rejected: RejectedFinding[];
}

/**
 * 逐字比对前把连续空白折成一个空格。
 *
 * 这不是给转述留口子:词与词序一个不动,折的只有换行与缩进。原文里一句跨行的话,
 * 审查器复制过来几乎必然带着换行或被重排,严格按字节比会把**忠实复制**判成编造——
 * 而 F4 存在的意义是抓编造,不是抓排版。
 */
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** 取 (nodeId, slot) 在**审查器看到的那份视图**里对应的文本;看不到就返回 null。 */
function slotTextOf(input: ReviewInput, nodeId: number, slot: string): string | null {
  if (nodeId === input.id) {
    if (slot === "content") return input.content;
    // 晋升与否在这里不分叉:审查器看到的 warrant 是一句话,不是一个节点引用。
    if (slot === "warrant") return input.warrant;
    return null;
  }
  const ev = input.evidenceNodes.find((n) => n.id === nodeId);
  if (!ev) return null;
  // 证据命题的 warrant 不在审查视野里(design.md §2.2 的 scope),所以引它验不过。
  return slot === "content" ? ev.content : null;
}

/** 校验一批 finding。顺序保留:接受的那些按原顺序编号,序号要对得上人读到的清单。 */
export function validateFindings(input: ReviewInput, raw: unknown[]): ValidationOutcome {
  const accepted: FindingDraft[] = [];
  const rejected: RejectedFinding[] = [];

  for (const item of raw) {
    const r = validateOne(input, item);
    if ("failed" in r) rejected.push(r);
    else accepted.push(r);
  }

  return { accepted, rejected };
}

function validateOne(input: ReviewInput, item: unknown): FindingDraft | RejectedFinding {
  const bad = (failed: RejectedFinding["failed"], detail: string): RejectedFinding => ({
    failed,
    detail,
    raw: item,
  });

  if (!item || typeof item !== "object") return bad("shape", "finding is not an object");
  const f = item as Record<string, unknown>;

  if (f.question !== "Q1" && f.question !== "Q2") {
    return bad("shape", `question must be "Q1" or "Q2", got ${JSON.stringify(f.question)}`);
  }
  if (f.confidence !== "high" && f.confidence !== "low") {
    return bad("shape", `confidence must be "high" or "low", got ${JSON.stringify(f.confidence)}`);
  }
  if (!isNonEmptyString(f.content)) {
    return bad("shape", "content is empty — a finding must state what is broken");
  }
  if (!f.citation || typeof f.citation !== "object") {
    return bad("shape", "citation is missing — it is a required field, without exception");
  }

  const c = f.citation as Record<string, unknown>;

  // F1:两种形态共有。
  if (!isNonEmptyString(c.quote)) return bad("F1", "citation.quote is empty");

  if (f.question === "Q1") {
    if (!isNonEmptyString(c.attachment)) {
      return bad("F2", "citation.attachment is empty");
    }
    // F2:必须是本命题附件槽里的一个。
    if (!input.attachments.includes(c.attachment)) {
      return bad(
        "F2",
        `citation.attachment "${c.attachment}" is not in the attachment slot of #${input.id}`
      );
    }
    return {
      nodeId: input.id,
      question: "Q1",
      confidence: f.confidence,
      content: f.content,
      citation: {
        attachment: c.attachment,
        // locator 缺失不拒收:它是给人翻页用的,不在 F1–F4 里。空着比伪造一个好。
        locator: isNonEmptyString(c.locator) ? c.locator : "",
        quote: c.quote,
      },
    };
  }

  // Q2。node_id 走 snake_case:那是契约里的名字,LLM 看到的也是它。
  const nodeId = c.node_id ?? c.nodeId;
  if (typeof nodeId !== "number" || !Number.isInteger(nodeId)) {
    return bad("F3", `citation.node_id must be an integer, got ${JSON.stringify(nodeId)}`);
  }
  if (c.slot !== "content" && c.slot !== "warrant") {
    return bad("shape", `citation.slot must be "content" or "warrant", got ${JSON.stringify(c.slot)}`);
  }

  // F3:∈ {被审查命题} ∪ {其证据槽里的命题}。
  const allowed = nodeId === input.id || input.evidenceNodes.some((n) => n.id === nodeId);
  if (!allowed) {
    return bad(
      "F3",
      `citation.node_id #${nodeId} is neither #${input.id} nor one of its referenced propositions`
    );
  }

  // F4:逐字子串。验不过 = 审查器在编。
  const text = slotTextOf(input, nodeId, c.slot);
  if (text === null) {
    return bad("F4", `#${nodeId} has no ${c.slot} in the reviewed view — nothing to quote from`);
  }
  if (!normalize(text).includes(normalize(c.quote))) {
    return bad("F4", `citation.quote does not appear verbatim in #${nodeId}'s ${c.slot}`);
  }

  return {
    nodeId: input.id,
    question: "Q2",
    confidence: f.confidence,
    content: f.content,
    citation: { nodeId, slot: c.slot, quote: c.quote },
  };
}

/**
 * Warranted — 域模型措辞
 *
 * 新本体只有**一个命题 + 五个槽位**(design.md §1.1),所以这里也只有五段文字加两段
 * 辅助字段——旧的 claim / statement / warrant / rebuttal 四套描述随类型塌缩一并消失。
 *
 * 这些字符串是 design.md §1.4 的落点:旧"类型"承担的写作引导全部转移到参数描述。
 * 一个 `content` 字段要同时接住"某文献声称 X"和"因此该方法不成立",区分它们的不再是
 * 节点类型,而是这里写清楚该怎么落笔。
 *
 * `content` 与 `warrant` 的措辞**逐字沿用旧 elements.ts** 里已经用过的表述(api.md §6):
 * 那是在真实使用里验证过的文字,换本体不是重新发明它们的理由。
 */

export const ELEMENTS = {
  /** 命题本身。V1 硬拒空值,其余一概不拦。 */
  content: [
    "What this proposition records. Write one declarative statement that can be independently judged.",
    "When evidence exists, state what is established, observed, or published — not merely the activity that produced it.",
    "Before evidence exists, a hypothesis, assumption, acceptance criterion, or declarative open proposition ('Whether X holds remains unestablished') may be recorded prospectively, but a bare question is not a proposition and an unrun or unread result must not sound observed; leave it 'unestablished'.",
    "Keep it atomic at the judgment boundary: split statements that need different evidence, scope, uncertainty, or qualifiers.",
  ].join(" "),

  /**
   * 理由槽。可空——V4 已取消,"理由非空"从入场券降回结构检查表的 `possibly` 及以上
   * (design.md §3.1 表注)。所以措辞里不能出现"必填"。
   */
  warrant: [
    "The inferential bridge explaining why this evidence supports this content within its stated scope.",
    "It may be a domain principle, measurement or decision rule, or an explicit model mechanism, with the conditions under which it applies.",
    "It must carry real inferential load: do not restate the content, summarize the evidence, cite a source, or encode the desired outcome in a tautological case-specific if-then.",
    "Wrong: 'If this run produced the desired result, then the method works' (desired conclusion restated as a condition).",
    "Right: 'Under the stated simulation assumptions, agreement across independent parameter sweeps supports numerical robustness within the tested range' (conditional inference rule).",
    "May be left empty while the proposition is still 'unestablished'; taking it to 'possibly' or above is when the structural check asks for it.",
  ].join(" "),

  attachments: [
    "File paths supporting this proposition.",
    "When citing published work, attach the reference files themselves (e.g. the paper PDF) — the reference is its own description document, no separate markdown needed.",
    "Otherwise provide a description document (e.g. `statement-<topic>.md`) plus whatever substantiates the proposition: code, result files, execution logs, data.",
    "The description document should explain what this proposition records and index how the files support it; it is not independent corroboration of its own assertions.",
  ].join(" "),

  /**
   * 证据槽的命题成员。这段话唯一的工作是把"引用不是副本"说清楚,以及把
   * `refuted` 当证据这条**合法**用法的正确写法交代掉(design.md §1.3)。
   */
  evidenceNodes: [
    "Proposition ids this one rests on. What you attach is a reference, not a copy — you always see that proposition's current content, including later revisions.",
    "Referencing a 'refuted' proposition is legitimate: there you rely on the fact that it was refuted.",
    "When you do, say so in the warrant ('because X has been refuted, ...') — do not leave the polarity flip for the reader to infer.",
  ].join(" "),

  qualifier: [
    "How much credence this proposition carries, on one ordered scale:",
    "refuted → unestablished → possibly → probably → certainly.",
    "'unestablished' is the honest starting point, not a failure state — it says no judgment has been made yet.",
    "'refuted' means the graph records what defeated it, so it sits at the far end of the same scale rather than off it.",
    "One qualifier covers the whole proposition; split measured results, interpretations, generalizations, and external comparisons when they merit different credence.",
    "Do not encode a limitation in the qualifier label. Narrow the content or scope, or record the limitation as its own proposition; attach it as a rebuttal only when it is itself a specific counter-example, exception, or contradiction to the content or warrant.",
  ].join(" "),

  attacks: [
    "Register this proposition as a rebuttal of an existing one.",
    "Use it only when this genuinely is a counter-example, exception, or contradiction; an ordinary observation is not a rebuttal.",
    "slot='content' attacks the conclusion; slot='warrant' attacks the reasoning principle that licenses it.",
    "Attacking an inline warrant promotes it to a proposition of its own first — the response reports that promotion.",
  ].join(" "),

  note: [
    "What evidence forced this change. Worth writing whenever you revise something already settled —",
    "the event stream is the only place that reason survives.",
  ].join(" "),

  dismissReason:
    "Why this warning or finding does not hold, or needs no action. It goes into the event stream and is readable one by one via get_history.",
} as const;

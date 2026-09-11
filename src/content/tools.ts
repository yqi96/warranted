/**
 * Warranted — 11 个工具的 title 与 description
 *
 * description 是**常驻上下文**:它每一轮都在,读者是在"要不要用它"这一刻读它的。
 * 所以只有两样东西值得占位——**这是什么场景**,和**与最近邻怎么分**(CLAUDE.md)。
 * 流程阶段、目标复述、正文摘要一律不进;"这个字段怎么填"进 params.ts。
 *
 * 每条 description 因此都是同一个形状:一句话说场景,一句话给判别。判别句里点名的
 * 那个工具就是它的最近邻,两者的描述要互相咬合(api.md §1 的判别列)。
 */

export const TOOLS = {
  // ── 写入 ───────────────────────────────────────────────────────────────────

  create_propositions: {
    title: "Create propositions",
    description:
      "Record one or more propositions. " +
      "Use this for new nodes; to change one that already exists, use update_proposition. " +
      "Everything created here lands at 'unestablished' — credence is set only by set_qualifier.",
  },

  update_proposition: {
    title: "Update proposition",
    description:
      "Change a proposition's content, its warrant text, or the members of its evidence and rebuttal slots. " +
      "This tool changes what the proposition says and rests on; to change how much credence it carries, use set_qualifier.",
  },

  set_qualifier: {
    title: "Set qualifier",
    description:
      "Judge how much credence one or more propositions carry. This is the final call, and only you can make it. " +
      "Use this to record a judgment; to change the facts being judged, use update_proposition.",
  },

  promote_warrant: {
    title: "Promote warrant",
    description:
      "Lift a proposition's inline warrant out into a proposition of its own, leaving the slot pointing at it. " +
      "Only worth doing when you need to rebut that reasoning principle, give it backing of its own, or reuse it elsewhere; otherwise leave the warrant inline.",
  },

  delete_proposition: {
    title: "Delete proposition",
    description:
      "Delete a proposition. Nothing cascades — what sits in an evidence slot is a reference, not a child. " +
      "When changing research direction, retain the evidence and explain the revision in a note; update downstream references as needed. " +
      "Use 'refuted' only when counterevidence warrants that judgment, not merely to stop pursuing a proposition. A refuted proposition can still be cited with its negative polarity.",
  },

  // ── 读取 ───────────────────────────────────────────────────────────────────

  get_argument: {
    title: "Get argument",
    description:
      "Read a proposition in full — five slots, structural warnings, unresolved findings, reviewer freshness and the current reviewer/agent decision — plus its neighbours to the requested depth. " +
      "Use this when you know the id; when you do not, find_propositions first.",
  },

  find_propositions: {
    title: "Find propositions",
    description:
      "Filter propositions by keyword, credence band, or whether anything on them is unresolved. " +
      "Use this to locate ids and to sweep in bulk; to see one proposition in full, use get_argument.",
  },

  get_stats: {
    title: "Get stats",
    description:
      "Whole-graph recorded-state summary: unresolved findings, structural-check violations, review freshness/coverage, separate reviewer/agent decisions, and counts per credence band. " +
      "It does not prove truth, completeness, or alignment of an outward answer. Use it before a substantive handoff; to inspect one proposition, use get_argument.",
  },

  get_history: {
    title: "Get history",
    description:
      "Read the event stream — changes, judgments and opinions, with time and attribution. " +
      "Use this to ask how something came to be the way it is; to ask what it is now, use get_argument.",
  },

  // ── 意见 ───────────────────────────────────────────────────────────────────

  review: {
    title: "Review proposition",
    description:
      "Ask an independent third-party model to check one proposition's current local view: whether its attachments substantiate what it claims (Q1), and whether the direct evidence, even granting it, gets you to the content (Q2). " +
      "It sees no history, command trace, omitted file, or wider graph, so it cannot by itself establish chronology or provenance. " +
      "It reads evidence needed for this proposition, not necessarily every attachment or page. Supply relevant original evidence and optional location hints without withholding contrary context. Returned reading ranges describe observed access, not exhaustive verification; a necessary evidence gap can make the review incomplete, but unrelated unread material alone does not. " +
      "Reviews may take several minutes and are expensive; use them deliberately for consequential semantic risks. " +
      "If the runtime supports background or asynchronous tool calls, prefer that mode, but keep the reviewed proposition and attachments unchanged, do not submit a duplicate while one is pending, and do not rely on a verdict until the result returns. " +
      "Identical completed or in-flight requests may be reused; refresh=true requests a fresh review when needed, not merely to clear a status. " +
      "Each execution attempt has its own timeout, not a per-node or research-task budget. Repeated failures prompt your judgment but do not disable review. " +
      "An incomplete result reports the failure and any candidate findings for verification; these are not recorded findings or a pass and cannot be dismissed by id. Earlier findings remain in force. Structural checks remain automatic.",
  },

  dismiss: {
    title: "Dismiss warning or finding",
    description:
      "Judge that a warning or finding is mistaken, acceptable within the stated scope, or already fixed and checked. Give a specific reason for each item; this does not edit evidence or change qualifiers. " +
      "Dismissing the last finding in the latest valid review also records your acceptance of the current input (reviewDecision: passed, source: agent), without rewriting the reviewer's verdict. Check the current version before doing so. " +
      "Later input changes make that acceptance stale. You may re-confirm with a new reason on a current-batch finding; small verified fixes do not require another review. Never dismiss a material unresolved issue merely to clear a status.",
  },
} as const;

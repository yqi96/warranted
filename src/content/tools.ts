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
      "To keep the record that it existed but stop it supporting anything, use set_qualifier with 'refuted' instead.",
  },

  // ── 读取 ───────────────────────────────────────────────────────────────────

  get_argument: {
    title: "Get argument",
    description:
      "Read a proposition in full — five slots, structural warnings, unresolved findings — plus its neighbours to the requested depth. " +
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
      "Whole-graph settlement summary: unresolved findings, structural-check violations, propositions flagged for re-check, and counts per credence band. " +
      "Use this to sweep the graph before reporting or handing off; to look at one proposition, use get_argument.",
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
      "Ask an independent third-party model to check one proposition: whether its attachments really say what it claims (Q1), and whether the evidence, even granting it, gets you to the content (Q2). " +
      "Slow and expensive, so call it deliberately. Structural problems — empty evidence, missing attachments, references that dropped a band — are checked for free and automatically; this tool is for the semantic ones.",
  },

  dismiss: {
    title: "Dismiss warning or finding",
    description:
      "Rule that a structural warning or a review finding does not hold, or needs no action. A reason is mandatory. " +
      "Use this to say 'I looked, and I judge it does not apply'; to actually fix what it points at, use update_proposition or set_qualifier.",
  },
} as const;

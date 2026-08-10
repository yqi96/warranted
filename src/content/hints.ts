/** Warranted — 操作后提示文本（追加在工具返回结果末尾） */

export const HINTS = {
  /** create_claim 成功后：引导 agent 建立完整推理链 */
  claimNoWarrants: [
    "Hint: This claim has no warrants yet. To build the argument graph:",
    "  1. create_statement — record factual propositions that may serve as evidence",
    "  2. create_warrant — connect the claim to statement or subclaim node IDs used as grounds",
    "  3. compile_arguments — review the logical relationships before advancing the claim status",
  ].join("\n"),

  /**
   * create_statement / update_node：source=literature 且 verification=pending 时。
   * The reference files are already attached by the time this fires — literature
   * statements cannot be created without them — so what is still outstanding is
   * the review, not the archiving. Telling the caller to "attach the source file"
   * here would be the last text in the repository implying that a pending
   * literature statement with no attachment is a normal state.
   */
  groundPendingLiterature:
    "Hint: This statement cites published work and its reference files are attached. It is recorded but not yet reviewed — verify it (individually, or in bulk via verify_statements) before anything rests on it or cites it. Make sure the attachments carry specific citation details such as author, year, title, DOI, or page.",

  /** create_statement / update_node：source=observed 且 verification=pending 时 */
  groundPendingObserved:
    "Hint: This statement records a self-produced experiment/observation or an independent reproduction of a stated result. To mark it verified, attach a description document plus available substantiating files such as raw data, result files, code, execution logs, or other produced artifacts.",

  /** get_argument 返回 stale Claim 时 */
  staleClaimBanner:
    "⚠ STALE — logical chain review pending. Call compile_arguments.",

  /** get_argument 返回 compile 失败的 Claim 时 —— 与 stale 不同，重跑 compile 不会改变结果 */
  failedClaimBanner:
    "⚠ COMPILE FAILED — re-running compile_arguments will not change this. Fix the argument itself, then compile again.",

  /** mutation 使 Claim compile 状态失效时追加 */
  compileAfterMutation:
    "Hint: Call compile_arguments to review the logical relationships.",

  /** reviewConfig 为空（审查完全未配置）时告知 agent 自行核验；element definition 审查始终延迟到 compile_arguments，与此 hint 的触发条件无关 */
  reviewSkipped:
    "Hint: Automatic review is not configured, so no evidence review ran for this node. " +
    "Self-verify that any 'verified' statement is backed by real evidence.",

  /** assertTagsRegistered 失败时的错误提示模板 */
  tagNotRegistered: (tag: string, suggestions: string) =>
    `Tag "${tag}" is not registered.\nSimilar existing: ${suggestions}\nUse it, or register a new tag first with create_tag.`,
} as const;

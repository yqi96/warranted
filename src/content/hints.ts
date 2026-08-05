/** Warranted — 操作后提示文本（追加在工具返回结果末尾） */

export const HINTS = {
  /** create_claim 成功后：引导 agent 建立完整推理链 */
  claimNoWarrants: [
    "Hint: This claim has no warrants yet. To build the argument graph:",
    "  1. create_statement — record factual propositions that may serve as evidence",
    "  2. create_warrant — connect the claim to statement or subclaim node IDs used as grounds",
    "  3. compile_arguments — review the logical relationships before advancing the claim status",
  ].join("\n"),

  /** create_statement / update_node：source=literature 且 verification=pending 时 */
  groundPendingLiterature:
    "Hint: This statement cites published work. To mark it verified, attach the source file or reference material (PDF, webpage capture, or equivalent) with specific citation details such as author, year, title, DOI, or page.",

  /** create_statement / update_node：source=observed 且 verification=pending 时 */
  groundPendingObserved:
    "Hint: This statement records a self-produced experiment/observation or an independent reproduction of a stated result. To mark it verified, attach a description document plus available substantiating files such as raw data, result files, code, execution logs, or other produced artifacts.",

  /** get_argument 返回 stale Claim 时 */
  staleClaimBanner:
    "⚠ STALE — logical chain review pending. Call compile_arguments.",

  /** mutation 使 Claim compile 状态失效时追加 */
  compileAfterMutation:
    "Hint: Call compile_arguments to review the logical relationships.",

  /** reviewConfig 为空（审查完全未配置）时告知 agent 自行核验；element definition 审查始终延迟到 compile_arguments，与此 hint 的触发条件无关 */
  reviewSkipped:
    "Hint: Automatic review is not configured, so no evidence review ran for this node. " +
    "Self-verify that any 'verified' statement is backed by real evidence.",

  /** update_node 修改 Statement content 后，verification 自动回退为 pending 时 */
  groundVerificationReverted: (nodeId: number) =>
    `Hint: Statement #${nodeId} content changed — verification reverted to pending. Re-mark as verified when ready.`,
} as const;

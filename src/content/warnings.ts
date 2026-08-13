/** Warranted — 删除/变更后警告文本 */

/**
 * 「充分性依据垮了，但论证的形式没变」这一类回退的共用模板。
 *
 * 两个触发点（撤回一个 Statement 的核实、下层 Claim 改判）只在两句话上不同：
 * 依据为什么没了，以及怎么把它补回来。中间"不要重跑 compile"那句必须字字相同——
 * 它是这两条警告存在的唯一理由，写成两份就会有一天只改了其中一份。
 */
function sufficiencyLostRevert(
  claimId: number,
  previousStatus: string,
  reason: string,
  remedy: string
): string {
  return (
    `Warning: Claim #${claimId} status reverted from "${previousStatus}" to "proposed" ` +
    `because ${reason}, so the Claim no longer meets the structural requirement for "${previousStatus}". ` +
    `Its compile verdict is deliberately left untouched: the argument's logic did not change, so ` +
    `do NOT re-run compile_arguments for Claim #${claimId}. ${remedy}, then re-assess the status directly.`
  );
}

export const WARNINGS = {
  /** D4: 删除被链式引用的 Claim */
  deleteClaimReferencedByGround: (nodeId: number, gids: string) =>
    `Warning: Claim #${nodeId} was referenced by Ground(s) #${gids} as chain reasoning evidence. ` +
    `These Grounds and their Warrant associations have been deleted. ` +
    `Please review the correctness of related arguments.`,

  /** D1: 删除被 Warrant 引用的 Ground */
  deleteGroundReferencedByWarrant: (nodeId: number, wids: string) =>
    `Warning: Ground #${nodeId} was referenced by Warrant(s) ${wids}. ` +
    `It has been removed from these Warrants. ` +
    `Please review the correctness of the associated arguments.`,

  /** D3: 删除支撑非 proposed Claim 的 Warrant */
  deleteWarrantSupportingClaim: (nodeId: number, claimId: number, status: string) =>
    `Warning: Warrant #${nodeId} supported Claim #${claimId} (status: "${status}"). ` +
    `The Claim's support structure has been weakened. ` +
    `Please review whether the Claim's status is still appropriate.`,

  /** H2: Ground 从 verified 退回 */
  revertGroundVerification: (nodeId: number, wids: string) =>
    `Warning: Ground #${nodeId} was previously verified but is now being reverted. ` +
    `Warrants ${wids} reference this Ground. ` +
    `Claims depending on these Warrants may no longer satisfy the "supported" criteria. ` +
    `Please review whether the related Claims' status is still appropriate.`,

  /** Compile 失效 */
  compileInvalidated: (claimId: number, nodeId: number) =>
    `Warning: Claim #${claimId}'s compiled status has been cleared ` +
    `because node #${nodeId} in its argument chain was modified.`,

  /** Claim status 被回退 */
  statusReverted: (claimId: number, previousStatus: string, nodeId: number) =>
    `Warning: Claim #${claimId} status reverted from "${previousStatus}" to "proposed" ` +
    `because node #${nodeId} in its argument chain was modified. ` +
    `Re-run compile_arguments and re-assess status when ready.`,

  /**
   * 撤回核实后回退 status —— 和 statusReverted 分开写，是因为要说的话正好相反：
   * 那条要求重跑 compile，这条明确告诉 agent 不要重跑。论证的形式没变过，
   * compile 的结论依然有效，重跑只是花一次模型调用拿回同一个答案。
   */
  statusRevertedVerificationWithdrawn: (claimId: number, previousStatus: string, nodeId: number) =>
    sufficiencyLostRevert(
      claimId,
      previousStatus,
      `statement #${nodeId}'s verification was withdrawn`,
      `Re-verify #${nodeId} (or reground the argument)`
    ),

  /**
   * D28: 下层 Claim 改判后回退上层 status。和上面那条同源——按规则 C′，一条 Claim
   * 算不算"已核实的证据"取决于它自身的 status，所以下层改判会抽掉上层的依据，
   * 而上层论证的形式一个字没变。
   */
  statusRevertedGroundClaimUnsettled: (claimId: number, previousStatus: string, nodeId: number) =>
    sufficiencyLostRevert(
      claimId,
      previousStatus,
      `Claim #${nodeId}, used as a Ground here, no longer counts as verified evidence`,
      `Settle #${nodeId} to a status that counts as evidence, or reground the argument`
    ),

  /**
   * compile 跑完之后这条 Claim 手上没有一条 passed 的记录 → status 退回 proposed。
   *
   * 刻意不走 sufficiencyLostRevert：那个模板的核心是"论证没变，不要重跑 compile"，
   * 这条正相反——是 compile 自己没通过，重跑正是要做的事。两者都是"回退 status"，
   * 但要 agent 做的下一步完全不同，合成一条就会有一半的场合在说反话。
   */
  statusRevertedCompileNotPassed: (claimId: number, previousStatus: string, verdict: string) =>
    `Warning: Claim #${claimId} status reverted from "${previousStatus}" to "proposed" ` +
    `because its compile verdict is now "${verdict}", and any non-"proposed" status requires a ` +
    `passed compile. Fix what compile reported, re-run compile_arguments, then set the status again.`,

  /** G_CONTENT: Statement 正文变更 → verification 自动退回 pending。
   *  文案自带 "Warning: " 前缀，与本模块其余条目一致：它经由 service 的 warnings
   *  渠道进入 formatReviewIssues，写成 "Hint: ..." 会渲染成 "Warning: Hint: ..."。
   *  这确实是一句警告而不是建议——系统已经改掉了一个状态，不是在提议什么。 */
  verificationRevertedOnContentChange: (nodeId: number) =>
    `Warning: Statement #${nodeId} content changed — verification reverted to pending. ` +
    `Re-mark as verified when ready.`,

  /**
   * §4.2: `paper:` tag carried with source="observed".
   * Neutral statement of the combination plus both legitimate readings — writing
   * it as an imperative ("should be literature") would emit a false warning on
   * every core node a reproduction task creates, and a warning channel that
   * cries wolf stops being read at all.
   */
  paperTagObservedSource: (itemRef: string, paperTags: string[]) =>
    `Warning: ${itemRef} carries ${paperTags.join(", ")} with source="observed". ` +
    `Two readings are both legitimate: a result this paper states (reproduction), ` +
    `or your own observation about it. If instead this is a proposition extracted ` +
    `from the paper, it should be source="literature".`,

  /** §4.3.2: attachment resolves, but lies outside the review working directory. */
  attachmentOutOfRoot: (path: string) =>
    `Warning: attachment "${path}" resolves outside the review working directory. ` +
    `It is not portable, and whether a review session can read it depends on the runtime environment.`,

  /**
   * attachments 整体替换（非 add/remove）丢掉了调用前已存在的路径。整体替换本身是既有
   * 设计，不是这条警告要拦的；它只负责让"丢了什么"这件事不再无声——尤其是同一次调用还
   * 改了 content 时，原本唯一的信号是 verificationRevertedOnContentChange，那条只字不提
   * attachments。
   */
  attachmentsReplaced: (nodeId: number, dropped: string[]) =>
    `Warning: Statement #${nodeId}'s attachments update replaced the array and dropped ` +
    `${dropped.length} previously-attached path(s): ${dropped.join(", ")}. ` +
    `attachments is not additive — pass the full list of paths you want to keep.`,

  /**
   * compile_arguments 在没有配审查模型时的一次性提醒。
   *
   * 一次调用只发一条，不是每条 Claim 发一条：说的是环境缺配置这一件事，重复 N 遍
   * 只会把真正针对某条 Claim 的话挤掉。
   */
  compiledWithoutReviewModel: (claimRefs: string) =>
    `Warning: ${claimRefs} recorded as passed without any logic review — no review model is ` +
    `configured, so only the deterministic structural checks ran. Whether the Grounds actually ` +
    `support the Claim through the Warrant has not been examined. Start the server with ` +
    `--review-config <file> (a JSON file carrying at least an apiKey) and re-run ` +
    `compile_arguments to have the logic reviewed.`,
} as const;

/** Warranted — 删除/变更后警告文本 */

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
} as const;

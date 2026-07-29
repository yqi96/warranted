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
} as const;

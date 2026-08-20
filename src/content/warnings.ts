/**
 * Warranted — 结构检查警告文本
 *
 * 旧本体的十几条警告全部退役(api.md §7.1):它们的共同前提是"系统会替 agent 回退
 * 状态",而新系统从不回退,只标红。新警告只有一族——**结构检查 / 该重查**,按
 * design.md §3.1 的四档判据与 §3.1c 的基线比对派生。
 *
 * 写法上三条约束:
 * - **只说断在哪,不说该改成什么。** 系统只照不判(§3.1"归属"),给出修法就是在替
 *   L3 下结论。允许的最强语气是指出该重看哪一段。
 * - **带上触发点的具体值。** "某个附件不见了"是噪音,"attachments/foo.md 不见了"
 *   才是能行动的信息;整条命题级的判据(S1/S3/A1/R0)没有触发点,句子里也就不提。
 * - **不带感叹与评价。** 标红不是拒绝,是提示(CLAUDE.md);句子里出现"你应该"
 *   就是把提示写成了判决。
 */

import type { Qualifier } from "../types.ts";

/** 判据编号 → 一句话。参数即触发点,签名各不相同是有意的:编译器替我们核对触发点。 */
export const WARNINGS = {
  /** S1 证据槽为空 */
  evidenceEmpty: (nodeId: number, qualifier: Qualifier) =>
    `#${nodeId} is "${qualifier}", but its evidence slot is empty — no attachments, ` +
    `no referenced propositions. Anything at "possibly" or above is expected to say what it rests on.`,

  /** S2 附件文件不存在 */
  attachmentMissing: (nodeId: number, path: string) =>
    `#${nodeId}: attachment "${path}" no longer resolves to an existing file. ` +
    `It existed when it was attached — something moved or deleted it since.`,

  /** S5 附件解析到项目根之外 */
  attachmentOutOfRoot: (nodeId: number, path: string) =>
    `#${nodeId}: attachment "${path}" resolves outside the project root. ` +
    `It is not portable, and whether a review session can read it depends on the runtime environment.`,

  /** S3 理由为空 */
  warrantEmpty: (nodeId: number, qualifier: Qualifier) =>
    `#${nodeId} is "${qualifier}", but its warrant slot is empty — nothing states why this ` +
    `kind of evidence supports this kind of conclusion.`,

  /** S4 引用的命题落 unestablished */
  evidenceUnestablished: (nodeId: number, refId: number, role: "evidence" | "warrant") =>
    `#${nodeId} rests on #${refId} as ${role}, and #${refId} is still "unestablished". ` +
    `Something not yet assessed cannot hold up a "probably" or "certainly". ` +
    `("refuted" is not in this family — using it as evidence means using the fact that it was refuted.)`,

  /** A1 反驳槽为空 */
  rebuttalEmpty: (nodeId: number) =>
    `#${nodeId} is "refuted", but its rebuttal slot is empty — nothing in the graph records what refuted it.`,

  /** A2 反驳自己没落在正向三档 */
  rebuttalNotPositive: (nodeId: number, rebuttalId: number, qualifier: Qualifier) =>
    `#${nodeId} is "refuted" on the strength of #${rebuttalId}, which is itself "${qualifier}". ` +
    `A rebuttal's force dissolves along with its own standing.`,

  /** R0 本命题自判断以来已变 */
  selfChanged: (nodeId: number, qualifier: Qualifier, at: string) =>
    `#${nodeId} has changed since it was judged "${qualifier}" at ${at} — its content, warrant, ` +
    `evidence members or rebuttal members are no longer what that judgment was made on.`,

  /** R1 判断时依据的引用已被删除 */
  refGone: (nodeId: number, refId: number, role: string) =>
    `#${nodeId} was judged on #${refId} as ${role}, and #${refId} no longer exists.`,

  /** R2 判断时依据的引用 content 已变 */
  refContentChanged: (nodeId: number, refId: number, role: string) =>
    `#${nodeId} was judged on #${refId} as ${role}, and #${refId}'s content has been rewritten since. ` +
    `What that judgment read is not what is there now.`,

  /** R3 判断时依据的引用 qualifier 已变 */
  refQualifierChanged: (
    nodeId: number,
    refId: number,
    role: string,
    was: Qualifier,
    now: Qualifier
  ) => `#${nodeId} was judged when #${refId} (${role}) was "${was}"; it is now "${now}".`,
} as const;

/**
 * qualifier 落到非 `unestablished`、而该命题仍有未处理 finding 时的醒目提示
 * (design.md §2.5,由 `set_qualifier` 返回)。
 *
 * 不是结构检查警告,所以不进上表、没有 id、不能被 dismiss:它说的不是"图有个断点",
 * 而是"你手上还压着别人给的意见"。真要结算那些 finding,得逐条 dismiss 或重跑 review。
 */
export function unresolvedFindingsOnSettle(
  nodeId: number,
  qualifier: Qualifier,
  count: number
): string {
  return (
    `#${nodeId} was set to "${qualifier}" while ${count} review finding(s) on it are still unresolved. ` +
    `Findings do not expire on their own — settle each one with dismiss (stating why) or re-run review.`
  );
}

/**
 * C4:改动一条已定案的命题却没留 note 时的**温和**提示(design.md §3.3)。
 *
 * 措辞刻意是建议而非要求——C4 明写"不强制"。写成"必须"会让它在每一次正常的
 * 错字修订上响一次,而一条常亮的提示等于没有提示。
 */
export function suggestNote(nodeId: number, qualifier: Qualifier): string {
  return (
    `#${nodeId} is already settled at "${qualifier}". Consider passing note to record what ` +
    `evidence forced this change — it is the only place that reason survives.`
  );
}

/** 删除一条被引用的命题时,列出被摘掉引用的命题(api.md §2.5)。 */
export function deleteAffected(nodeId: number, affected: number[]): string {
  return (
    `#${nodeId} was referenced by ${affected.map((i) => `#${i}`).join(", ")}. ` +
    `Those references have been removed from their slots, and those propositions are now ` +
    `flagged for re-check — their acknowledged warnings have all re-armed.`
  );
}


/**
 * Warranted — 结构检查(L1)
 *
 * design.md §3.1 的判据在这里落地。**每次读取时重算**,不落库、不是一个可跑的动作
 * (旧 `compile_state` 已废)。它只发现"该重查"并标出触发点,不替查、不替改、不下结论。
 *
 * 两族判据,派生方式不同:
 *
 * - **S/A 族(当前状态)**:只看图现在长什么样,按命题**自己的** qualifier 分档启用。
 *   S = 支撑侧,A = 攻击侧。
 * - **R 族(基线比对)**:拿当前值与"设 qualifier 那一刻的快照"比,回答"我判断时
 *   依据的东西还是不是这个"(§3.1c)。
 *
 * R 族**不按档位放宽**,只跳过 `unestablished`(它没有基线)。§3.1 给 `possibly` 的
 * 放宽针对的是**可信度要求**("引用链得多可信"),而 R 族问的是**事实变没变**:
 * 你判 `possibly` 时读的那段证据被改写了,这条 possibly 一样需要重看。两者是不同的
 * 东西,放宽其一不蕴含放宽其二。
 *
 * §3.1 表里 `probably/certainly` 那行的第④条("每条直接引用的命题存在、content 未变、
 * qualifier ≠ unestablished")不重复实现:它分解成 S4(分档) + R1(引用没了) +
 * R2(content 变了),各实现一次。`refuted` 行的"每条反驳存在、content 未变"就是
 * ref_role='rebuttal' 的 R1/R2。§3.1 那句"证据从 certainly 掉到 refuted……由基线比对管"
 * 落在 R3。
 */

import type { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { dirname, resolve, sep } from "path";
import * as repo from "./repo.ts";
import { contentHash, recheckFingerprint, selfFingerprint, warningId } from "./hash.ts";
import { WARNINGS } from "./content/warnings.ts";
import {
  CheckCode,
  POSITIVE_QUALIFIERS,
  type Qualifier,
  type RefRole,
  type StructuralWarning,
  type WarrantSlot,
} from "./types.ts";

// =============================================================================
// 附件路径:一处解析,写读共用
// =============================================================================

/**
 * 附件路径的解析基准 = 数据库文件的祖父目录(`<root>/.toulmin/graph.db` → `<root>`),
 * 也就是审查子进程实际的 cwd。
 *
 * 写入期的 V3 与读取期的 S2 必须用**同一个**基准,否则会出现"写得进、读出来标红"
 * 的分裂——旧实现的注释已经记过这个教训(校验器算出与审查器不同的 cwd,比没有校验器更糟)。
 * 所以基准只在这里算一次,V3 与 S2/S5 都从这个 context 取。
 */
export interface CheckContext {
  /** 附件相对路径的解析基准(绝对路径)。 */
  root: string;
}

export function checkContext(dbPath: string): CheckContext {
  // ":memory:" 没有目录结构,dirname 两次落到 "." —— 解析到进程 cwd,对测试与
  // 临时库都是唯一说得通的基准。
  return { root: resolve(dirname(dirname(dbPath))) };
}

export function resolveAttachment(ctx: CheckContext, path: string): string {
  return resolve(ctx.root, path);
}

export function attachmentExists(ctx: CheckContext, path: string): boolean {
  return existsSync(resolveAttachment(ctx, path));
}

/** 解析结果是否落在 root 之内。用前缀比较,补上分隔符防止 `/a/bc` 冒充 `/a/b`。 */
export function isInsideRoot(ctx: CheckContext, path: string): boolean {
  const resolved = resolveAttachment(ctx, path);
  const root = ctx.root.endsWith(sep) ? ctx.root : ctx.root + sep;
  return resolved === ctx.root || resolved.startsWith(root);
}

// =============================================================================
// 命题当前状态的快照
// =============================================================================

/** 一条命题当前的五个槽位(判据与指纹的共同输入)。 */
export interface NodeState {
  id: number;
  content: string;
  qualifier: Qualifier;
  warrant: WarrantSlot;
  attachments: string[];
  evidenceNodes: number[];
  rebuttals: number[];
}

/** 一条**直接引用**的当前值。直接引用 = 证据命题 + 反驳 + 晋升后的理由(§3.1 原理)。 */
export interface RefState {
  id: number;
  role: RefRole;
  contentHash: string;
  qualifier: Qualifier;
}

export function warrantSlotOf(row: {
  warrant_text: string | null;
  warrant_node_id: number | null;
}): WarrantSlot {
  if (row.warrant_node_id !== null) return { kind: "promoted", node_id: row.warrant_node_id };
  if (row.warrant_text !== null && row.warrant_text !== "") {
    return { kind: "inline", text: row.warrant_text };
  }
  return { kind: "empty" };
}

export function loadNodeState(db: Database, id: number): NodeState | null {
  const row = repo.getProposition(db, id);
  if (!row) return null;
  return {
    id: row.id,
    content: row.content,
    qualifier: row.qualifier,
    warrant: warrantSlotOf(row),
    attachments: repo.getAttachments(db, id),
    evidenceNodes: repo.getEvidenceNodes(db, id),
    rebuttals: repo.getRebuttals(db, id),
  };
}

/**
 * 读出所有直接引用的当前 (content hash, qualifier)。
 *
 * 顺序固定为 evidence → rebuttal → warrant,并按 id 排序;指纹函数自己也排序,
 * 这里排是为了让调用方拿到的清单可预测(基线写入直接用它)。
 */
export function loadRefStates(db: Database, state: NodeState): RefState[] {
  const wanted: Array<{ id: number; role: RefRole }> = [];
  for (const id of state.evidenceNodes) wanted.push({ id, role: "evidence" });
  for (const id of state.rebuttals) wanted.push({ id, role: "rebuttal" });
  if (state.warrant.kind === "promoted") {
    wanted.push({ id: state.warrant.node_id, role: "warrant" });
  }
  if (wanted.length === 0) return [];

  const rows = repo.getPropositions(db, [...new Set(wanted.map((w) => w.id))]);
  const byId = new Map(rows.map((r) => [r.id, r]));

  const out: RefState[] = [];
  for (const w of wanted) {
    const row = byId.get(w.id);
    // 引用不悬空是 V2 保证的;真出现了就跳过而不是抛——结构检查是只读通道,
    // 在这里抛异常会让一条坏数据把整个 get_argument 打死。
    if (!row) continue;
    out.push({
      id: w.id,
      role: w.role,
      contentHash: contentHash(row.content),
      qualifier: row.qualifier,
    });
  }
  return out;
}

/** 指纹函数要的那份 self 形状。 */
function selfInput(state: NodeState) {
  return {
    content: state.content,
    warrant: state.warrant,
    evidenceNodes: state.evidenceNodes,
    attachments: state.attachments,
    rebuttals: state.rebuttals,
  };
}

/** 重查指纹 = 触发条件① + ②(api.md §5)。所有 warning id 都挂在它上面。 */
export function fingerprintOf(state: NodeState, refs: RefState[]): string {
  return recheckFingerprint(selfInput(state), refs);
}

export function selfFingerprintOf(state: NodeState): string {
  return selfFingerprint(selfInput(state));
}

// =============================================================================
// 判据
// =============================================================================

const AT_POSSIBLY_OR_ABOVE: readonly Qualifier[] = ["possibly", "probably", "certainly"];
const AT_PROBABLY_OR_ABOVE: readonly Qualifier[] = ["probably", "certainly"];

interface RawWarning {
  code: CheckCode;
  trigger: string | null;
  message: string;
}

/** 触发点标识:同一条引用在不同槽位是不同的触发点,所以带上 role。 */
function refTrigger(role: RefRole, id: number): string {
  return `${role}:${id}`;
}

/**
 * S/A 族:只看当前状态,按本命题的 qualifier 分档。
 *
 * `unestablished` 一条都不查——它就是"还没评估",拿判据去问一个还没开始回答的问题
 * 只会制造常亮标红。
 */
function currentStateChecks(
  ctx: CheckContext,
  state: NodeState,
  refs: RefState[]
): RawWarning[] {
  const out: RawWarning[] = [];
  const q = state.qualifier;

  if (AT_POSSIBLY_OR_ABOVE.includes(q)) {
    // S1 证据非空:附件与命题共用一个槽,两边都空才算空。
    if (state.attachments.length === 0 && state.evidenceNodes.length === 0) {
      out.push({
        code: CheckCode.EvidenceEmpty,
        trigger: null,
        message: WARNINGS.evidenceEmpty(state.id, q),
      });
    }

    // S2 / S5 附件:写硬读软。写入时 V3 查过存在,之后被删/被移出根在这里标红。
    for (const path of state.attachments) {
      if (!attachmentExists(ctx, path)) {
        out.push({
          code: CheckCode.AttachmentMissing,
          trigger: path,
          message: WARNINGS.attachmentMissing(state.id, path),
        });
        // 文件都不在了,再说一句"它不可移植"是噪音。
        continue;
      }
      if (!isInsideRoot(ctx, path)) {
        out.push({
          code: CheckCode.AttachmentOutOfRoot,
          trigger: path,
          message: WARNINGS.attachmentOutOfRoot(state.id, path),
        });
      }
    }

    // S3 理由非空。晋升后的理由永远非空(被指向的那条命题 content 受 V1 保护)。
    if (state.warrant.kind === "empty") {
      out.push({
        code: CheckCode.WarrantEmpty,
        trigger: null,
        message: WARNINGS.warrantEmpty(state.id, q),
      });
    }
  }

  // S4 引用链的闸,实质起点在 probably。只问"能不能用"(≠ unestablished),
  // 不问极性——极性变没变由 R3 管,同一件事判两次迟早判出两个答案(§3.1)。
  // 攻击侧的反驳不在此列:它走 A2 的正向三档。
  if (AT_PROBABLY_OR_ABOVE.includes(q)) {
    for (const ref of refs) {
      if (ref.role === "rebuttal") continue;
      if (ref.qualifier !== "unestablished") continue;
      out.push({
        code: CheckCode.EvidenceUnestablished,
        trigger: refTrigger(ref.role, ref.id),
        message: WARNINGS.evidenceUnestablished(
          state.id,
          ref.id,
          ref.role === "warrant" ? "warrant" : "evidence"
        ),
      });
    }
  }

  // A 族只在 refuted 上跑:攻击侧的判据问的是"推翻它的东西还站得住吗"。
  if (q === "refuted") {
    if (state.rebuttals.length === 0) {
      out.push({
        code: CheckCode.RebuttalEmpty,
        trigger: null,
        message: WARNINGS.rebuttalEmpty(state.id),
      });
    }
    for (const ref of refs) {
      if (ref.role !== "rebuttal") continue;
      if (POSITIVE_QUALIFIERS.includes(ref.qualifier)) continue;
      out.push({
        code: CheckCode.RebuttalNotPositive,
        trigger: refTrigger(ref.role, ref.id),
        message: WARNINGS.rebuttalNotPositive(state.id, ref.id, ref.qualifier),
      });
    }
  }

  return out;
}

/**
 * R 族:与基线比。
 *
 * 没有基线时整族跳过。这只在两种情况下发生:qualifier 还是初始的 `unestablished`
 * (从没判过),或库是手工改出来的。**不为"缺基线"另发一条警告**——那不是图的断点,
 * 是不该存在的状态,发一条 agent 无从处理的警告只会稀释真警告。
 */
function baselineChecks(db: Database, state: NodeState, refs: RefState[]): RawWarning[] {
  if (state.qualifier === "unestablished") return [];
  const head = repo.getBaselineHead(db, state.id);
  if (!head) return [];

  const out: RawWarning[] = [];

  // R0 自己变了(content / 理由 / 证据成员 / 反驳成员任一)。
  if (head.selfFingerprint !== selfFingerprintOf(state)) {
    out.push({
      code: CheckCode.SelfChanged,
      trigger: null,
      message: WARNINGS.selfChanged(state.id, head.qualifier, head.at),
    });
  }

  // R1–R3 逐条引用比。以**基线**为准遍历,不是以当前引用清单:引用被删掉之后
  // 当前清单里根本没有它,只有基线还记得曾经靠它做过判断(R1 因此才成立)。
  const current = new Map(refs.map((r) => [`${r.role}:${r.id}`, r]));
  for (const base of repo.getBaselineRefs(db, state.id)) {
    const key = `${base.refRole}:${base.refId}`;
    const now = current.get(key);

    if (!now) {
      // 当前清单里没有:要么命题被删了,要么它还在但已被从这个槽里摘掉。
      // 两者对这条判断的意义相同——判断时依据的那条引用,现在不在了。
      out.push({
        code: CheckCode.RefGone,
        trigger: key,
        message: WARNINGS.refGone(state.id, base.refId, base.refRole),
      });
      continue;
    }
    // R2 与 R3 各说各的事,可以同时成立,不合并:content 改了和改判了要 agent
    // 做的事不同(重读原文 vs 重估强度)。
    if (now.contentHash !== base.contentHash) {
      out.push({
        code: CheckCode.RefContentChanged,
        trigger: key,
        message: WARNINGS.refContentChanged(state.id, base.refId, base.refRole),
      });
    }
    if (now.qualifier !== base.qualifier) {
      out.push({
        code: CheckCode.RefQualifierChanged,
        trigger: key,
        message: WARNINGS.refQualifierChanged(
          state.id,
          base.refId,
          base.refRole,
          base.qualifier,
          now.qualifier
        ),
      });
    }
  }

  return out;
}

// =============================================================================
// 对外入口
// =============================================================================

/**
 * 算出一条命题当前的全部结构检查警告,并解析每条的处置状态。
 *
 * 读取算法照 api.md §5:算出当前警告集合 → 到事件流查同 id 的 dismiss 事件 →
 * 命中标"已阅"(附理由与时间),未命中标"待处理"。
 *
 * **复燃不需要任何代码**:id 里含重查指纹,指纹一变 id 全变,旧 dismiss 事件自然
 * 匹配不上。这就是 §3.1b"任一触发发生则所有已阅警告一律复燃"的全部实现。
 */
export function computeWarnings(
  db: Database,
  ctx: CheckContext,
  id: number
): StructuralWarning[] {
  const state = loadNodeState(db, id);
  if (!state) return [];
  return computeWarningsFor(db, ctx, state);
}

/** 已经拿到 state 时的入口(批量读取时避免重复查同一条命题)。 */
export function computeWarningsFor(
  db: Database,
  ctx: CheckContext,
  state: NodeState,
  refs?: RefState[]
): StructuralWarning[] {
  const refStates = refs ?? loadRefStates(db, state);
  const fingerprint = fingerprintOf(state, refStates);

  const raw = [
    ...currentStateChecks(ctx, state, refStates),
    ...baselineChecks(db, state, refStates),
  ];
  if (raw.length === 0) return [];

  const withIds = raw.map((w) => ({
    ...w,
    id: warningId(state.id, w.code, w.trigger, fingerprint),
  }));

  const dismissals = repo.findDismissals(
    db,
    withIds.map((w) => w.id)
  );

  return withIds.map((w) => {
    const hit = dismissals.get(w.id);
    return {
      id: w.id,
      nodeId: state.id,
      code: w.code,
      trigger: w.trigger,
      message: w.message,
      state: hit ? ("acknowledged" as const) : ("pending" as const),
      ...(hit ? { dismissal: hit } : {}),
    };
  });
}

/** 只要"有没有未处理的",不需要整串警告(find_propositions / get_stats 用)。 */
export function hasPendingWarnings(db: Database, ctx: CheckContext, id: number): boolean {
  return computeWarnings(db, ctx, id).some((w) => w.state === "pending");
}

/**
 * Warranted — Service 层
 *
 * 业务逻辑住在这里:V1–V3 硬拒、事件留痕、自动晋升、基线写入。
 * repo 只看得见单条 SQL,tools 只负责 MCP 的形状;规则必须在两者之间。
 *
 * 三条贯穿全层的约束,改动时先读它们:
 *
 * 1. **姿态原则零例外**(design.md §3.1)。抛 `ValidationError` 的地方只有三处成因:
 *    content 空、引用悬空、写入时附件不存在。认识论要求(证据非空、理由非空、
 *    引用链可用)**一律不在这里拦**,它们由结构检查在读时标红。
 * 2. **基线只有一个写入者**(§3.1c)。`repo.writeBaseline` 在本文件里只被
 *    `setQualifier` 调用;`createPropositions` / `updateProposition` 都不接受
 *    qualifier 入参,连"顺手落一档"的机会都不给。
 * 3. **一次操作一条事件,写在同一个事务里**(I8)。事件不是日志,是过期检测与
 *    "已阅"判定的数据源;写在事务外就会出现"图变了但没人知道它变过"。
 */

import type { Database } from "bun:sqlite";
import { existsSync } from "fs";
import * as repo from "./repo.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import {
  checkContext,
  computeWarningsFor,
  loadNodeState,
  loadRefStates,
  resolveAttachment,
  selfFingerprintOf,
  warrantSlotOf,
  type CheckContext,
  type NodeState,
} from "./structural-check.ts";
import { suggestNote, deleteAffected, unresolvedFindingsOnSettle } from "./content/warnings.ts";
import type {
  ArgumentResult,
  CreatePropositionItem,
  CreateResultItem,
  DeleteResult,
  DismissItem,
  DismissResultItem,
  EventRecord,
  EventRow,
  FieldDiff,
  Finding,
  FindingView,
  FindPropositionsParams,
  FindResult,
  PromoteResult,
  PromoteWarrantParams,
  PropositionRow,
  PropositionView,
  Qualifier,
  ReviewOutcome,
  SetQualifierItem,
  SetQualifierResultItem,
  SettlementSummary,
  StructuralWarning,
  UpdatePropositionParams,
  UpdateResult,
} from "./types.ts";
import { QUALIFIERS } from "./types.ts";

export { checkContext, type CheckContext };

// =============================================================================
// V1–V3:三条硬拒,全是数据合法性
// =============================================================================

/** V1 content 非空。空白串也算空——一条只有空格的命题不是命题。 */
function requireContent(content: unknown, label = "content"): string {
  if (typeof content !== "string" || content.trim() === "") {
    throw new ValidationError(`${label} must be a non-empty string.`);
  }
  return content;
}

/** V2 引用不悬空。 */
function requireExists(db: Database, ids: number[], label: string): void {
  for (const id of ids) {
    if (!Number.isInteger(id)) {
      throw new ValidationError(`${label} must be proposition ids (integers), got ${String(id)}.`);
    }
    if (!repo.propositionExists(db, id)) {
      throw new ValidationError(`${label} references #${id}, which does not exist.`);
    }
  }
}

/**
 * V3 写入时附件路径存在。
 *
 * 解析基准与结构检查、与审查子进程的 cwd 是同一个(见 structural-check 的
 * CheckContext 注释):校验器算出与读取侧不同的基准,比没有校验器更糟。
 *
 * URL 单独挡:它不是"文件不存在",而是把一个取不回来的东西当成了证据。
 */
function requireAttachments(ctx: CheckContext, paths: string[]): void {
  for (const p of paths) {
    if (typeof p !== "string" || p.trim() === "") {
      throw new ValidationError("Attachment paths must be non-empty strings.");
    }
    if (p.startsWith("http://") || p.startsWith("https://")) {
      throw new ValidationError(
        `Attachment "${p}" is a URL. Attach local files — a link is not something a reviewer can read back.`
      );
    }
    if (!existsSync(resolveAttachment(ctx, p))) {
      throw new ValidationError(
        `Attachment "${p}" does not exist (resolved from ${ctx.root}).`
      );
    }
  }
}

function requireQualifier(q: unknown): Qualifier {
  if (typeof q !== "string" || !(QUALIFIERS as readonly string[]).includes(q)) {
    throw new ValidationError(
      `qualifier must be one of ${QUALIFIERS.join(", ")}, got ${JSON.stringify(q)}.`
    );
  }
  return q as Qualifier;
}

function mustLoad(db: Database, id: number): PropositionRow {
  const row = repo.getProposition(db, id);
  if (!row) throw new NotFoundError(id);
  return row;
}

// =============================================================================
// 视图组装
// =============================================================================

/**
 * 一条命题当前"算数"的 findings。
 *
 * 只取**最近一次 review** 的那批:design.md §3.1b 说 finding 由"驳回"或
 * "新一次 review 取代"结算,后者在这里落地。更早的批次不消失——它们还在事件流里,
 * `get_history` 读得到——只是不再算作待处理。
 */
export function findingViews(db: Database, nodeId: number): FindingView[] {
  const rows = repo.listFindingsByNode(db, nodeId);
  if (rows.length === 0) return [];

  const latest = Math.max(...rows.map((r) => r.review_event_id));
  const current = rows.filter((r) => r.review_event_id === latest);

  const dismissals = repo.findDismissals(
    db,
    current.map((r) => r.id)
  );

  return current.map((r) => {
    const hit = dismissals.get(r.id);
    return {
      id: r.id,
      nodeId: r.node_id,
      question: r.question,
      confidence: r.confidence,
      content: r.content,
      citation: JSON.parse(r.citation),
      state: hit ? ("acknowledged" as const) : ("pending" as const),
      ...(hit ? { dismissal: hit } : {}),
      at: r.at,
    };
  });
}

function viewOf(db: Database, ctx: CheckContext, state: NodeState, row: PropositionRow): PropositionView {
  return {
    id: state.id,
    content: state.content,
    qualifier: state.qualifier,
    warrant: state.warrant,
    evidence: { attachments: state.attachments, nodes: state.evidenceNodes },
    rebuttals: state.rebuttals,
    warnings: computeWarningsFor(db, ctx, state),
    findings: findingViews(db, state.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function propositionView(db: Database, ctx: CheckContext, id: number): PropositionView {
  const row = mustLoad(db, id);
  const state = loadNodeState(db, id)!;
  return viewOf(db, ctx, state, row);
}

function warningsOf(db: Database, ctx: CheckContext, id: number): StructuralWarning[] {
  const state = loadNodeState(db, id);
  return state ? computeWarningsFor(db, ctx, state) : [];
}

// =============================================================================
// 写入 1:create_propositions
// =============================================================================

/**
 * 新建命题(批量)。**没有 qualifier 入参**,一律落 `unestablished`(api.md §2.1)。
 *
 * `attacks.slot === "warrant"` 且目标理由是内联的时候,系统在同一事务内把那段
 * 内联理由晋升成命题,再把反驳挂到晋升出来的命题上。这是全系统唯一一处系统替
 * agent 建节点的地方,所以返回体必须显式报告(`promoted`)。
 */
export function createPropositions(
  db: Database,
  ctx: CheckContext,
  items: CreatePropositionItem[]
): CreateResultItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError("items must be a non-empty array.");
  }

  return db.transaction((): CreateResultItem[] => {
    const out: CreateResultItem[] = [];

    for (const item of items) {
      const content = requireContent(item.content);
      const attachments = item.evidence?.attachments ?? [];
      const evidenceNodes = item.evidence?.nodes ?? [];

      requireAttachments(ctx, attachments);
      requireExists(db, evidenceNodes, "evidence.nodes");
      if (item.attacks) requireExists(db, [item.attacks.node], "attacks.node");

      const warrantText =
        typeof item.warrant === "string" && item.warrant.trim() !== "" ? item.warrant : null;

      const row = repo.insertProposition(db, content, warrantText);
      if (attachments.length > 0) repo.addAttachments(db, row.id, attachments);
      if (evidenceNodes.length > 0) repo.addEvidenceNodes(db, row.id, evidenceNodes);

      let promoted: { from_node: number; new_id: number } | undefined;
      if (item.attacks) {
        const target = attachRebuttal(db, item.attacks.node, item.attacks.slot, row.id);
        promoted = target.promoted;
      }

      repo.appendEvent(db, {
        nodeId: row.id,
        op: "create",
        actor: "tool",
        payload: {
          content,
          warrant: warrantText,
          evidence: { attachments, nodes: evidenceNodes },
          ...(item.attacks ? { attacks: item.attacks } : {}),
        },
        note: item.note ?? null,
      });

      out.push({
        id: row.id,
        warnings: warningsOf(db, ctx, row.id),
        ...(promoted ? { promoted } : {}),
      });
    }

    return out;
  })();
}

/**
 * 把 `rebuttalId` 挂到 `targetId` 的反驳槽上,必要时先晋升目标的内联理由。
 *
 * 攻击 `content` 与攻击 `warrant` 在存储上同形——都是"某条命题的反驳槽多一条引用",
 * 差别只在挂到哪条命题上。这正是 §1.2 用晋升换来的东西:不为攻击理由加特例列。
 */
function attachRebuttal(
  db: Database,
  targetId: number,
  slot: "content" | "warrant",
  rebuttalId: number
): { attachedTo: number; promoted?: { from_node: number; new_id: number } } {
  if (slot === "content") {
    repo.addRebuttals(db, targetId, [rebuttalId]);
    repo.touchProposition(db, targetId);
    return { attachedTo: targetId };
  }

  const target = mustLoad(db, targetId);
  const warrant = warrantSlotOf(target);

  if (warrant.kind === "promoted") {
    // 已经是独立命题了,直接攻击它。
    repo.addRebuttals(db, warrant.node_id, [rebuttalId]);
    repo.touchProposition(db, warrant.node_id);
    return { attachedTo: warrant.node_id };
  }

  if (warrant.kind === "empty") {
    // 空槽没有可攻击的对象。这不是认识论判断,是 V2 那一类的悬空引用:
    // 你指名要攻击的东西不存在。
    throw new ValidationError(
      `#${targetId} has no warrant to attack — its warrant slot is empty. ` +
        `Attack its content instead, or give it a warrant first.`
    );
  }

  const { newId } = promoteInline(db, targetId, warrant.text, null, [], [], "system");
  repo.addRebuttals(db, newId, [rebuttalId]);
  return { attachedTo: newId, promoted: { from_node: targetId, new_id: newId } };
}

/**
 * 内联理由 → 独立命题。`promote_warrant` 与自动晋升共用这一条路径。
 *
 * 晋升**不触发原命题重查**(design.md §3.1):原命题的理由在语义上一个字没变,
 * 变的只是它存在哪儿。但 `warrant_text → warrant_node_id` 会改掉自身指纹,所以
 * 原命题上的已阅警告仍会复燃——这是指纹派生的既有代价,不为它开特例。
 */
function promoteInline(
  db: Database,
  fromNode: number,
  text: string,
  ownWarrant: string | null,
  attachments: string[],
  evidenceNodes: number[],
  actor: "tool" | "system"
): { newId: number } {
  const created = repo.insertProposition(db, text, ownWarrant);
  if (attachments.length > 0) repo.addAttachments(db, created.id, attachments);
  if (evidenceNodes.length > 0) repo.addEvidenceNodes(db, created.id, evidenceNodes);

  repo.updatePropositionFields(db, fromNode, {
    warrantText: null,
    warrantNodeId: created.id,
  });

  repo.appendEvent(db, {
    nodeId: created.id,
    op: "promote",
    actor,
    payload: { from_node: fromNode, new_id: created.id, content: text },
  });

  return { newId: created.id };
}

// =============================================================================
// 写入 2:update_proposition
// =============================================================================

/**
 * 改 content / 内联理由 / 证据成员 / 反驳成员。**不接受 qualifier**。
 *
 * 成员一律 add/remove,不提供整体替换——整体替换会静默丢成员(见 9393354),
 * 而"静默"正是这个系统存在的理由。
 */
export function updateProposition(
  db: Database,
  ctx: CheckContext,
  params: UpdatePropositionParams
): UpdateResult {
  const before = mustLoad(db, params.id);

  return db.transaction((): UpdateResult => {
    const beforeState = loadNodeState(db, params.id)!;
    const diff: FieldDiff = {};

    if (params.content !== undefined) {
      const content = requireContent(params.content);
      if (content !== before.content) {
        diff.content = { old: before.content, new: content };
        repo.updatePropositionFields(db, params.id, { content });
      }
    }

    if (params.warrant !== undefined) {
      if (before.warrant_node_id !== null) {
        // 理由已经是一条独立命题,改它要改那条命题。指出 id,免得调用方去猜。
        throw new ValidationError(
          `#${params.id}'s warrant was promoted to proposition #${before.warrant_node_id}. ` +
            `Update #${before.warrant_node_id}'s content instead.`
        );
      }
      const next = params.warrant.trim() === "" ? null : params.warrant;
      if (next !== before.warrant_text) {
        diff.warrant = { old: before.warrant_text, new: next };
        repo.updatePropositionFields(db, params.id, { warrantText: next });
      }
    }

    const ev = params.evidence;
    if (ev) {
      const addA = ev.add_attachments ?? [];
      const addN = ev.add_nodes ?? [];
      requireAttachments(ctx, addA);
      requireExists(db, addN, "evidence.add_nodes");

      if (addA.length > 0) repo.addAttachments(db, params.id, addA);
      if (ev.remove_attachments?.length) {
        repo.removeAttachments(db, params.id, ev.remove_attachments);
      }
      if (addN.length > 0) repo.addEvidenceNodes(db, params.id, addN);
      if (ev.remove_nodes?.length) repo.removeEvidenceNodes(db, params.id, ev.remove_nodes);
    }

    if (params.rebuttals) {
      const add = params.rebuttals.add ?? [];
      requireExists(db, add, "rebuttals.add");
      if (add.length > 0) repo.addRebuttals(db, params.id, add);
      if (params.rebuttals.remove?.length) {
        repo.removeRebuttals(db, params.id, params.rebuttals.remove);
      }
    }

    const afterState = loadNodeState(db, params.id)!;

    // 成员清单的 diff 事后比,不按入参记:入参说的是"我要求做什么",
    // 事后比说的是"实际变成了什么"。事件流要记的是后者。
    recordMemberDiff(diff, "evidence.attachments", beforeState.attachments, afterState.attachments);
    recordMemberDiff(diff, "evidence.nodes", beforeState.evidenceNodes, afterState.evidenceNodes);
    recordMemberDiff(diff, "rebuttals", beforeState.rebuttals, afterState.rebuttals);

    if (Object.keys(diff).length === 0) {
      // 什么都没变就不写事件:一条空 diff 的 update 事件只会稀释事件流。
      return { id: params.id, warnings: computeWarningsFor(db, ctx, afterState) };
    }

    // 只改了成员、没改字段时 updatePropositionFields 不会刷 updated_at,补一次。
    repo.touchProposition(db, params.id);
    repo.appendEvent(db, {
      nodeId: params.id,
      op: "update",
      actor: "tool",
      payload: diff,
      note: params.note ?? null,
    });

    const notices: string[] = [];
    if (!params.note && before.qualifier !== "unestablished") {
      notices.push(suggestNote(params.id, before.qualifier));
    }

    return {
      id: params.id,
      warnings: computeWarningsFor(db, ctx, loadNodeState(db, params.id)!),
      ...(notices.length > 0 ? { notices } : {}),
    };
  })();
}

function recordMemberDiff<T>(diff: FieldDiff, field: string, before: T[], after: T[]): void {
  const a = JSON.stringify(before);
  const b = JSON.stringify(after);
  if (a !== b) diff[field] = { old: before, new: after };
}

// =============================================================================
// 写入 3:set_qualifier(基线的唯一写入者)
// =============================================================================

/**
 * 判定可信度(批量),并在同一事务内落基线快照。
 *
 * 三件副作用(api.md §2.3):落基线、跑结构检查并返回、未处理 finding 提示。
 * **违反结构检查不拦截**——返回警告,让 agent 看见,然后由它决定。
 */
export function setQualifier(
  db: Database,
  ctx: CheckContext,
  updates: SetQualifierItem[]
): SetQualifierResultItem[] {
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new ValidationError("updates must be a non-empty array.");
  }

  return db.transaction((): SetQualifierResultItem[] => {
    const out: SetQualifierResultItem[] = [];

    for (const u of updates) {
      const before = mustLoad(db, u.id);
      const qualifier = requireQualifier(u.qualifier);

      repo.writeQualifier(db, u.id, qualifier);

      // 基线 = 判断当时的"我依据的是什么"。写在改 qualifier 之后、读引用之前,
      // 顺序无关紧要(引用的值不受本次写入影响),但必须在同一事务里。
      const state = loadNodeState(db, u.id)!;
      const refs = loadRefStates(db, state);
      repo.writeBaseline(
        db,
        { nodeId: u.id, qualifier, selfFingerprint: selfFingerprintOf(state) },
        refs.map((r) => ({
          refId: r.id,
          refRole: r.role,
          contentHash: r.contentHash,
          qualifier: r.qualifier,
        }))
      );

      repo.appendEvent(db, {
        nodeId: u.id,
        op: "qualifier",
        actor: "tool",
        payload: { old: before.qualifier, new: qualifier },
        note: u.note ?? null,
      });

      const notices: string[] = [];
      const unresolved = findingViews(db, u.id).filter((f) => f.state === "pending");
      if (qualifier !== "unestablished" && unresolved.length > 0) {
        notices.push(unresolvedFindingsOnSettle(u.id, qualifier, unresolved.length));
      }

      out.push({
        id: u.id,
        qualifier,
        previous: before.qualifier,
        warnings: computeWarningsFor(db, ctx, state, refs),
        ...(notices.length > 0 ? { notices } : {}),
      });
    }

    return out;
  })();
}

// =============================================================================
// 写入 4:promote_warrant
// =============================================================================

/** 把内联理由拎出来立成独立命题,原槽位改为指向它。 */
export function promoteWarrant(
  db: Database,
  ctx: CheckContext,
  params: PromoteWarrantParams
): PromoteResult {
  const row = mustLoad(db, params.id);

  return db.transaction((): PromoteResult => {
    const warrant = warrantSlotOf(row);
    if (warrant.kind === "promoted") {
      throw new ValidationError(
        `#${params.id}'s warrant is already proposition #${warrant.node_id}.`
      );
    }
    if (warrant.kind === "empty") {
      throw new ValidationError(
        `#${params.id} has no inline warrant to promote. Write one with update_proposition first.`
      );
    }

    const attachments = params.evidence?.attachments ?? [];
    const evidenceNodes = params.evidence?.nodes ?? [];
    requireAttachments(ctx, attachments);
    requireExists(db, evidenceNodes, "evidence.nodes");

    const ownWarrant =
      typeof params.warrant === "string" && params.warrant.trim() !== "" ? params.warrant : null;

    const { newId } = promoteInline(
      db,
      params.id,
      warrant.text,
      ownWarrant,
      attachments,
      evidenceNodes,
      "tool"
    );

    if (params.note) {
      repo.appendEvent(db, {
        nodeId: params.id,
        op: "update",
        actor: "tool",
        payload: { warrant: { old: warrant.text, new: { promoted_to: newId } } },
        note: params.note,
      });
    }

    return { id: params.id, newId, warnings: warningsOf(db, ctx, newId) };
  })();
}

// =============================================================================
// 写入 5:delete_proposition
// =============================================================================

/**
 * 硬删。**没有 cascade**:证据槽里挂的是引用不是所有权,级联删会销毁 agent
 * 没有指名的节点(api.md §2.5)。
 *
 * 被引用时从各引用方的槽里摘掉这条引用(否则违反 V2),那些引用方因成员清单
 * 变化被标为该重查、已阅警告全部复燃——这一条不需要代码,指纹变了 id 就全变。
 */
export function deleteProposition(
  db: Database,
  ctx: CheckContext,
  params: { id: number; note?: string }
): DeleteResult {
  const row = mustLoad(db, params.id);

  return db.transaction((): DeleteResult => {
    const state = loadNodeState(db, params.id)!;

    const affected = [
      ...repo.findEvidenceReferrers(db, params.id),
      ...repo.findRebuttalTargets(db, params.id),
      ...repo.findWarrantReferrers(db, params.id),
    ];
    const uniqueAffected = [...new Set(affected)].filter((i) => i !== params.id).sort((a, b) => a - b);

    // 墓碑:整节点 before 快照。事件的 node_id 没有外键,正是为了让它活过这一删。
    repo.appendEvent(db, {
      nodeId: params.id,
      op: "delete",
      actor: "tool",
      payload: {
        before: {
          content: state.content,
          qualifier: state.qualifier,
          warrant: state.warrant,
          evidence: { attachments: state.attachments, nodes: state.evidenceNodes },
          rebuttals: state.rebuttals,
          created_at: row.created_at,
        },
        affected: uniqueAffected,
      },
      note: params.note ?? null,
    });

    // 引用的摘除由 schema 的 CASCADE / SET NULL 完成;这里只需刷新引用方的
    // updated_at,让"我变过"在时间线上可见。
    repo.deleteProposition(db, params.id);
    for (const id of uniqueAffected) repo.touchProposition(db, id);

    const notices: string[] = [];
    if (uniqueAffected.length > 0) notices.push(deleteAffected(params.id, uniqueAffected));
    if (!params.note && row.qualifier !== "unestablished") {
      notices.push(suggestNote(params.id, row.qualifier));
    }

    return {
      id: params.id,
      affected: uniqueAffected,
      ...(notices.length > 0 ? { notices } : {}),
    };
  })();
}

// =============================================================================
// 读取 1:get_argument
// =============================================================================

/** 读一条命题及其邻域。邻域**不分组**:角色只取决于以谁为中心看(design.md §1.3)。 */
export function getArgument(
  db: Database,
  ctx: CheckContext,
  params: { id: number; depth?: number }
): ArgumentResult {
  const root = propositionView(db, ctx, params.id);
  const depth = params.depth ?? 1;
  if (depth <= 0) return { root, neighbors: [] };

  const seen = new Set<number>([params.id]);
  let frontier: PropositionView[] = [root];
  const neighbors: PropositionView[] = [];

  for (let d = 0; d < depth; d++) {
    const next: PropositionView[] = [];
    for (const node of frontier) {
      const linked = [
        ...node.evidence.nodes,
        ...node.rebuttals,
        ...(node.warrant.kind === "promoted" ? [node.warrant.node_id] : []),
      ];
      for (const id of linked) {
        if (seen.has(id)) continue;
        seen.add(id);
        const view = propositionView(db, ctx, id);
        neighbors.push(view);
        next.push(view);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  return { root, neighbors };
}

// =============================================================================
// 读取 2:find_propositions
// =============================================================================

export function findPropositions(
  db: Database,
  ctx: CheckContext,
  params: FindPropositionsParams
): FindResult {
  const limit = params.limit ?? 20;
  const offset = params.offset ?? 0;

  if (!params.has_unresolved) {
    const { rows, total } = repo.findPropositions(db, {
      query: params.query,
      qualifier: params.qualifier,
      limit,
      offset,
    });
    return {
      items: rows.map((r) => viewOf(db, ctx, loadNodeState(db, r.id)!, r)),
      total,
    };
  }

  // has_unresolved 是**算出来**的属性,SQL 里没有对应的列,所以只能先取候选集再过滤。
  // 分页因此落在过滤之后:先分页会让每页少几条、总数对不上,那比多读一次全表更糟。
  const { rows } = repo.findPropositions(db, {
    query: params.query,
    qualifier: params.qualifier,
    limit: Number.MAX_SAFE_INTEGER,
    offset: 0,
  });

  const matched = rows
    .map((r) => viewOf(db, ctx, loadNodeState(db, r.id)!, r))
    .filter(
      (v) =>
        v.warnings.some((w) => w.state === "pending") ||
        v.findings.some((f) => f.state === "pending")
    );

  return { items: matched.slice(offset, offset + limit), total: matched.length };
}

// =============================================================================
// 读取 3:get_stats
// =============================================================================

/** 全图结算摘要。红点清单在前,计数在后(design.md §4)。 */
export function getStats(db: Database, ctx: CheckContext): SettlementSummary {
  const byQualifier = Object.fromEntries(QUALIFIERS.map((q) => [q, 0])) as Record<
    Qualifier,
    number
  >;
  for (const [q, n] of Object.entries(repo.countByQualifier(db))) {
    byQualifier[q as Qualifier] = n;
  }

  const unresolvedFindings: SettlementSummary["unresolvedFindings"] = [];
  const unresolvedWarnings: SettlementSummary["unresolvedWarnings"] = [];
  const missing: string[] = [];
  let attachmentTotal = 0;

  for (const id of repo.allPropositionIds(db)) {
    const state = loadNodeState(db, id)!;

    attachmentTotal += state.attachments.length;
    for (const p of state.attachments) {
      if (!existsSync(resolveAttachment(ctx, p))) missing.push(p);
    }

    const pendingFindings = findingViews(db, id).filter((f) => f.state === "pending");
    if (pendingFindings.length > 0) {
      unresolvedFindings.push({ nodeId: id, count: pendingFindings.length });
    }

    const pendingWarnings = computeWarningsFor(db, ctx, state).filter(
      (w) => w.state === "pending"
    );
    if (pendingWarnings.length > 0) {
      unresolvedWarnings.push({
        nodeId: id,
        codes: [...new Set(pendingWarnings.map((w) => w.code))],
      });
    }
  }

  return {
    total: repo.countPropositions(db),
    byQualifier,
    unresolvedFindings,
    unresolvedWarnings,
    attachments: { total: attachmentTotal, missing },
  };
}

// =============================================================================
// 读取 4:get_history
// =============================================================================

/** 事件流。列名 actor 在这里变回契约里的名字 `by`。 */
export function getHistory(
  db: Database,
  params: { id?: number; limit?: number; offset?: number }
): { events: EventRecord[]; total: number } {
  const { rows, total } = repo.listEvents(db, {
    nodeId: params.id,
    limit: params.limit ?? 50,
    offset: params.offset ?? 0,
  });
  return { events: rows.map(toEventRecord), total };
}

function toEventRecord(row: EventRow): EventRecord {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    // 载荷解析不了也要把事件交出去:一条读不懂的历史仍然是历史,
    // 吞掉它才是真正的抹除。
    payload = { raw: row.payload };
  }
  return {
    id: row.id,
    at: row.at,
    by: row.actor,
    op: row.op,
    nodeId: row.node_id,
    payload,
    ...(row.note ? { note: row.note } : {}),
    ...(row.target_key ? { targetKey: row.target_key } : {}),
  };
}

// =============================================================================
// 意见 1:review 落库
// =============================================================================

/**
 * 把一次审查的结果写进事件流并建立 findings 索引。
 *
 * **答"是"也留痕**:Q1/Q2 全 pass、findings 为空的一次 review 照样写事件——
 * 没有这一层,"从没 review 过"与"review 过且没问题"分不开(design.md §2.2)。
 */
export function recordReview(db: Database, outcome: ReviewOutcome): { eventId: number; findings: Finding[] } {
  mustLoad(db, outcome.nodeId);

  return db.transaction((): { eventId: number; findings: Finding[] } => {
    const eventId = repo.appendEvent(db, {
      nodeId: outcome.nodeId,
      op: "review",
      actor: "tool",
      payload: {
        Q1: outcome.Q1,
        Q2: outcome.Q2,
        model: outcome.model,
        protocol: outcome.protocolHash,
        findings: outcome.findings,
        // 拒收记录进载荷不进表:它不是一条意见,是一次协议违规的证物。
        ...(outcome.rejected?.length ? { rejected: outcome.rejected } : {}),
      },
    });

    // id 在这里才生成:它要 review 事件的 id,而那要等落库(见 FindingDraft 注释)。
    const findings: Finding[] = outcome.findings.map(
      (f, i) => ({ ...f, id: `f_${eventId}_${i + 1}` }) as Finding
    );
    if (findings.length > 0) repo.insertFindings(db, eventId, findings);

    return { eventId, findings };
  })();
}

// =============================================================================
// 意见 2:dismiss
// =============================================================================

/**
 * 驳回一条警告或一条 finding,必写理由。
 *
 * **作用域是单条**:每项自带 id 与自己的理由。批量调用省的是往返,不是思考——
 * 这与 §3.1b"不提供命题级批量驳回"不冲突,那一条防的是"一个理由清掉一片"。
 *
 * 驳回是**降级不是删除**:只往事件流里 append 一条,原对象一个字节都不改。
 */
export function dismiss(
  db: Database,
  ctx: CheckContext,
  items: DismissItem[]
): DismissResultItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError("items must be a non-empty array.");
  }

  return db.transaction((): DismissResultItem[] =>
    items.map((item) => {
      if (typeof item.reason !== "string" || item.reason.trim() === "") {
        // 理由是这个动作全部的审计价值,空理由等于没驳回。
        throw new ValidationError(`dismiss ${item.id}: reason is required.`);
      }

      const target = classifyDismissTarget(db, ctx, item.id);
      if (target === "unknown") {
        // 不抛异常:警告 id 会随图变化复燃成新 id,拿着一个过期 id 来驳回是
        // 正常现象,不是调用错误。据实说明比失败更有用。
        return {
          id: item.id,
          target,
          ok: false,
          message:
            `No current warning or finding has id ${item.id}. ` +
            `Structural warnings re-arm with new ids whenever the proposition or its ` +
            `references change — re-read the proposition and dismiss the current id.`,
        };
      }

      repo.appendEvent(db, {
        nodeId: null,
        op: "dismiss",
        actor: "tool",
        payload: { reason: item.reason },
        note: item.reason,
        targetKey: item.id,
      });

      return { id: item.id, target, ok: true };
    })
  )();
}

/**
 * 这个 id 现在指着什么。
 *
 * finding id 查表(它不随图变化);警告 id 只能**重算**——它不存在任何表里,
 * 这正是可寻址性方案的代价与好处:没有一张会漂移的警告状态表。
 */
function classifyDismissTarget(
  db: Database,
  ctx: CheckContext,
  id: string
): "warning" | "finding" | "unknown" {
  if (id.startsWith("f_")) {
    const hit = repo
      .listAllFindings(db)
      .some((f) => f.id === id);
    return hit ? "finding" : "unknown";
  }
  for (const nodeId of repo.allPropositionIds(db)) {
    if (warningsOf(db, ctx, nodeId).some((w) => w.id === id)) return "warning";
  }
  return "unknown";
}

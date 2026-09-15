/** Record-only experiment entry: five slots, references and append-only revision history.
 * Derived from service.ts at the frozen common base. No checks, review calls, notices,
 * attachment hashing, judgment baselines, or automatic research feedback are run here.
 * Original service.ts remains for historical evaluators and shared-core regression tests;
 * the installed records plugin and its visualizer both use this module instead.
 */
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import * as repo from "./repo.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import { checkContext, loadNodeState, resolveAttachment, warrantSlotOf, type CheckContext } from "./structural-check.ts";
import { QUALIFIERS } from "./types.ts";
import type { CreatePropositionItem, UpdatePropositionParams, SetQualifierItem, PromoteWarrantParams, PropositionRow, Qualifier, FieldDiff, EventRecord, EventRow } from "./types.ts";
import type * as Full from "./types.ts";
type PropositionView = Omit<Full.PropositionView, "warnings" | "findings" | "review" | "reviewDecision">;
type CreateResultItem = Omit<Full.CreateResultItem, "warnings" | "notices">;
type UpdateResult = Omit<Full.UpdateResult, "warnings" | "notices">;
type SetQualifierResultItem = Omit<Full.SetQualifierResultItem, "warnings" | "notices">;
type PromoteResult = Omit<Full.PromoteResult, "warnings">;
type DeleteResult = Omit<Full.DeleteResult, "notices">;
type FindPropositionsParams = Omit<Full.FindPropositionsParams, "has_unresolved">;
type ArgumentResult = { root: PropositionView; neighbors: PropositionView[] };
type FindResult = { items: PropositionView[]; total: number };
export { checkContext, type CheckContext };

function requireContent(content: unknown, label = "content"): string {
  if (typeof content !== "string" || content.trim() === "") {
    throw new ValidationError(`${label} must be a non-empty string.`);
  }
  return content;
}

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

function requireAttachments(ctx: CheckContext, paths: string[]): void {
  for (const p of paths) {
    if (typeof p !== "string" || p.trim() === "") {
      throw new ValidationError("Attachment paths must be non-empty strings.");
    }
    if (p.startsWith("http://") || p.startsWith("https://")) {
      throw new ValidationError(
        `Attachment "${p}" is a URL. Use a local file path for an attachment.`
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


export function propositionView(db: Database, ctx: CheckContext, id: number, _cache?: Map<string, string | null>): PropositionView {
  const row = mustLoad(db, id);
  const state = loadNodeState(db, id)!;
  return { id, content: state.content, qualifier: state.qualifier, warrant: state.warrant,
    evidence: { attachments: state.attachments, nodes: state.evidenceNodes }, rebuttals: state.rebuttals,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

export function assertRecordDatabase(db: Database): void {
  const previous = db.query("SELECT id FROM events WHERE op IN ('review', 'dismiss') LIMIT 1").get();
  if (previous) throw new ValidationError("This database contains another treatment's events. Use an independent records-arm database.");
}

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
        ...(promoted ? { promoted } : {}),
      });
    }

    return out;
  })();
}

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
    repo.addRebuttals(db, warrant.node_id, [rebuttalId]);
    repo.touchProposition(db, warrant.node_id);
    return { attachedTo: warrant.node_id };
  }

  if (warrant.kind === "empty") {
    throw new ValidationError(
      `#${targetId} has no warrant to attack — its warrant slot is empty. ` +
        `Attack its content instead, or give it a warrant first.`
    );
  }

  const { newId } = promoteInline(db, targetId, warrant.text, null, [], [], "system");
  repo.addRebuttals(db, newId, [rebuttalId]);
  return { attachedTo: newId, promoted: { from_node: targetId, new_id: newId } };
}

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
    recordMemberDiff(diff, "evidence.attachments", beforeState.attachments, afterState.attachments);
    recordMemberDiff(diff, "evidence.nodes", beforeState.evidenceNodes, afterState.evidenceNodes);
    recordMemberDiff(diff, "rebuttals", beforeState.rebuttals, afterState.rebuttals);

    if (Object.keys(diff).length === 0) {
      return { id: params.id };
    }
    repo.touchProposition(db, params.id);
    repo.appendEvent(db, {
      nodeId: params.id,
      op: "update",
      actor: "tool",
      payload: diff,
      note: params.note ?? null,
    });

    return {
      id: params.id,
    };
  })();
}

function recordMemberDiff<T>(diff: FieldDiff, field: string, before: T[], after: T[]): void {
  const a = JSON.stringify(before);
  const b = JSON.stringify(after);
  if (a !== b) diff[field] = { old: before, new: after };
}

export function setQualifier(db: Database, ctx: CheckContext, updates: SetQualifierItem[]): SetQualifierResultItem[] {
  if (!Array.isArray(updates) || updates.length === 0) throw new ValidationError("updates must be a non-empty array.");
  return db.transaction(() => updates.map(u => {
    const before = mustLoad(db, u.id);
    const qualifier = requireQualifier(u.qualifier);
    repo.writeQualifier(db, u.id, qualifier);
    repo.appendEvent(db, { nodeId: u.id, op: "qualifier", actor: "tool", payload: { old: before.qualifier, new: qualifier }, note: u.note ?? null });
    return { id: u.id, qualifier, previous: before.qualifier };
  }))();
}

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

    return { id: params.id, newId };
  })();
}

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
    repo.deleteProposition(db, params.id);
    for (const id of uniqueAffected) repo.touchProposition(db, id);

    return {
      id: params.id,
      affected: uniqueAffected,
    };
  })();
}

export function getArgument(
  db: Database,
  ctx: CheckContext,
  params: { id: number; depth?: number }
): ArgumentResult {
  const attachmentCache = new Map<string, string | null>();
  const root = propositionView(db, ctx, params.id, attachmentCache);
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
        const view = propositionView(db, ctx, id, attachmentCache);
        neighbors.push(view);
        next.push(view);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  return { root, neighbors };
}

export function findPropositions(db: Database, ctx: CheckContext, params: FindPropositionsParams): FindResult {
  const { rows, total } = repo.findPropositions(db, { query: params.query, qualifier: params.qualifier, limit: params.limit ?? 20, offset: params.offset ?? 0 });
  return { items: rows.map(row => propositionView(db, ctx, row.id)), total };
}

export function getStats(db: Database, ctx: CheckContext) {
  const byQualifier = Object.fromEntries(QUALIFIERS.map(q => [q, 0]));
  Object.assign(byQualifier, repo.countByQualifier(db));
  const attachments = repo.allPropositionIds(db).reduce((count, id) => count + repo.getAttachments(db, id).length, 0);
  return { total: repo.countPropositions(db), byQualifier, attachments: { total: attachments } };
}

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

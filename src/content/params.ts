/**
 * Warranted — 工具参数的 .describe() 文本
 *
 * design.md §1.4 把旧"类型"承担的写作引导整个转移到了这里:一个 `content` 字段要
 * 同时接住记录性命题与结论性命题,区分它们的不再是节点类型,而是这段文字。所以
 * **description 短、params 长**是有意的分配,不是失衡。
 *
 * 域模型字段转发自 `ELEMENTS`,保持工具面与域模型同源;操作性参数(分页、过滤、id)
 * 在本文件直接定义——它们与本体无关,只与调用方式有关。
 */

import { ELEMENTS } from "./elements.ts";

export const PARAMS = {
  // ── 域模型(转发自 ELEMENTS)────────────────────────────────────────────────

  content: ELEMENTS.content,
  warrant: ELEMENTS.warrant,
  attachments: ELEMENTS.attachments,
  evidence_nodes: ELEMENTS.evidenceNodes,
  qualifier: ELEMENTS.qualifier,
  attacks: ELEMENTS.attacks,
  note: ELEMENTS.note,
  dismiss_reason: ELEMENTS.dismissReason,

  // ── 各工具的顶层入参 ───────────────────────────────────────────────────────

  create_items:
    "The propositions to create. There is no single-item form and no qualifier field: " +
    "everything lands at 'unestablished', and credence is set only by set_qualifier.",

  update_evidence:
    "Add or remove evidence members. Attachments and referenced propositions are always " +
    "added and removed by name — there is no whole-slot replacement, because replacement " +
    "drops members silently and silence is the thing this system exists to remove.",

  update_rebuttals:
    "Add or remove rebuttal members by id. Same add/remove rule as evidence.",

  set_qualifier_updates:
    "One entry per proposition being judged. Each carries its own id, its own band, and " +
    "optionally its own note — batching saves round trips, not thinking.",

  promote_own_warrant:
    "The warrant of the promoted proposition itself — why its own evidence supports it. " +
    "Not the text being promoted (that is already there). May be left empty.",

  promote_evidence:
    "Optional backing for the promoted warrant: what substantiates this reasoning principle.",

  dismiss_items:
    "One entry per warning or finding being ruled out. Each needs its own id and its own reason; " +
    "one reason cannot clear a whole proposition's worth of warnings.",

  // ── 节点标识 ───────────────────────────────────────────────────────────────

  proposition_id: "Proposition id.",
  target_id: "Id of the proposition being attacked.",
  attack_slot:
    "Which slot to attack: 'content' (the conclusion) or 'warrant' (the reasoning principle that licenses it).",
  warning_or_finding_id:
    "A structural-warning id or a finding id, exactly as it was reported. " +
    "Warning ids are derived from the proposition's current state, so they change whenever it does.",

  // ── 读取参数 ───────────────────────────────────────────────────────────────

  depth:
    "How far to walk from this proposition. 1 (the default) gives its direct evidence, " +
    "rebuttals and promoted warrant; 0 gives only the proposition itself.",

  find_query:
    "Keyword search over proposition content. Needs at least 3 characters.",

  find_qualifier:
    "Only return propositions in these bands. Omit to include all.",

  find_has_unresolved:
    "Only return propositions carrying a pending finding or a pending structural warning. " +
    "This is the work queue.",

  history_id:
    "Restrict the event stream to one proposition. Omit for the whole graph's recent events. " +
    "Deleted propositions still have history — their tombstone event carries the full before-snapshot.",

  // ── 分页 ───────────────────────────────────────────────────────────────────

  limit: "Maximum number of items to return.",
  offset:
    "Number of items to skip (default 0). For self-consuming queues — filters that remove " +
    "items as you handle them, such as has_unresolved — always re-query with offset=0.",
} as const;

/**
 * Warranted — MCP 工具参数描述文本
 *
 * 所有工具参数的 .describe() 字符串。
 * 域模型参数（Claim/Statement/Warrant 字段）转发自 ELEMENTS；
 * 工具操作参数（过滤器、增量更新、标志位）在此直接定义。
 */

import { ELEMENTS } from "./elements.ts";

export const PARAMS = {
  // ── 域模型参数（转发自 ELEMENTS，与工具的 Zod schema 保持同源）────────────

  // create_claim / update_node
  claim_content: ELEMENTS.claim.content,
  claim_qualifier: ELEMENTS.claim.qualifier,
  /** update_node.status；create_claim 无 status 参数（由系统初始化为 proposed） */
  claim_status: ELEMENTS.claim.status,

  // create_statement / update_node
  statement_content: ELEMENTS.statement.content,
  statement_source: ELEMENTS.statement.source,
  statement_verification: ELEMENTS.statement.verification,
  statement_attachments: ELEMENTS.statement.attachments,

  // create_warrant / update_node
  warrant_content: ELEMENTS.warrant.content,
  warrant_claim_id: ELEMENTS.warrant.claimId,
  warrant_ground_ids: ELEMENTS.warrant.groundIds,
  warrant_backing_ids: ELEMENTS.warrant.backingIds,

  // create_statement.rebuttal_for 内嵌对象字段
  rebuttal_target_id: ELEMENTS.rebuttal.targetId,
  rebuttal_target_type: ELEMENTS.rebuttal.targetType,

  // ── 列表过滤器 ──────────────────────────────────────────────────────────────

  // list_claims.status
  claim_status_filter:
    "Filter by status (comma-separated: proposed,supported,disputed,refuted)",
  claim_compile_status_filter:
    "Filter by compile_status (comma-separated: passed,stale,null). Omit to include all.",
  // list_statements.source
  statement_source_filter:
    "Filter by source type (comma-separated: literature,observed). Omit to include all.",
  // list_statements.verification
  statement_verification_filter:
    "Filter by verification status (comma-separated: verified,pending). Omit to include all.",
  statement_role_filter:
    "Filter by role: 'ground', 'backing', or 'rebuttal'. Intersects with relation tables.",
  // list_statements.without_tag
  tag_without_filter:
    "Exclude nodes with this tag. Supports prefix wildcards: 'theme:*' matches all 'theme:' tags.",
  // pagination
  pagination_limit:
    "Maximum number of items to return (default 50).",
  pagination_offset:
    "Number of items to skip (default 0). For self-consuming queues (filters that remove completed items), always re-query with offset=0.",

  // list_tags
  tag_prefix:
    "Filter tags by namespace prefix. For example, 'theme:' lists only tags in the 'theme:' namespace.",
  tag_min_count:
    "Minimum node count to include. Use 0 to find tags that are registered but have no nodes attached (the work-queue signal).",

  // ── 节点标识 ────────────────────────────────────────────────────────────────

  any_node_id: "Any node ID",           // get_argument.node_id
  node_id: "Node ID",                   // get_node.node_id
  node_id_to_update: "Node ID to update", // update_node.node_id
  node_id_to_delete: "Node ID to delete", // delete_node.node_id

  // ── 搜索 ────────────────────────────────────────────────────────────────────

  // search_nodes.keyword
  search_keyword: "Search keyword",
  // search_nodes.node_type
  node_type_filter:
    "Filter by node type. 'ground', 'backing', 'rebuttal' are virtual filters that query by relationship role; 'statement' returns all statements regardless of role.",

  // ── update_node 专用字段 ────────────────────────────────────────────────────

  new_content: "New content",
  new_attachments: "New attachment file paths",
  /** Warrant 的 ground_ids 增量更新；{ add?: number[], remove?: number[] } */
  ground_ids_incremental:
    "Incrementally update the node IDs used as grounds for this warrant. If the thing you rely on is a record (observed or read), it is a Statement; if it is itself a conclusion you argued, it is a Claim. Both are accepted.",
  /** Warrant 的 backing 增量更新；{ add?: number[], remove?: number[] } */
  backing_ids_incremental:
    "Incrementally update the node IDs used as backing for this warrant. If the thing you rely on is a record (observed or read), it is a Statement; if it is itself a conclusion you argued, it is a Claim. Both are accepted. Each backing should substantiate the warrant's inference-licensing principle.",
  /**
   * Claim/Warrant 的 rebuttal 增量更新；{ add?: number[], remove?: number[] }。
   * target_type 由被更新节点的类型推断，不需要显式传入。
   */
  rebuttal_ids_incremental:
    "Incrementally update the node IDs used as rebuttals for this Claim or Warrant. If the thing you rely on is a record (observed or read), it is a Statement; if it is itself a conclusion you argued, it is a Claim. Both are accepted. Each rebuttal should name a genuine counter-condition, exception, or contradiction; target_type is inferred from the updated node's type.",
  qualifier_update:
    "Claim qualifier: degree of certainty ('probably', 'presumably', 'certainly')",

  // ── delete_node ─────────────────────────────────────────────────────────────

  cascade_delete: "Recursively delete child nodes (required for Claims)",

  // ── compile_arguments ───────────────────────────────────────────────────────

  claim_ids_to_compile: "Specific Claim IDs to compile. Omit to compile all Claims.",

  // ── create_statement 专用 ───────────────────────────────────────────────────

  /** create_statement.rebuttal_for（整个对象的 .describe()） */
  rebuttal_for_stmt:
    "If provided, this statement is recorded as a rebuttal for the target Claim or Warrant. Use this for counter-conditions, exceptions, or contradicting evidence, not ordinary observation notes.",

  // ── 标签参数 ──────────────────────────────────────────────────────────────────

  tag_name:
    "Tag name in format <namespace>:<name>, e.g., 'theme:attention-mechanism'. Only lowercase letters, digits, hyphens, and underscores are allowed. " +
    "Dots, slashes, and uppercase are not: lowercase the identifier and replace every other character with '-' " +
    "(lr=0.001 -> 'exp:lr-0-001', llama-3.1 -> 'model:llama-3-1', n=1e-4 -> 'exp:lr-1e-4', one sweep -> 'sweep:2026-03-lr'). " +
    "This is an encoding, not a structure: a tag is a flat string with no key=value, so range queries over the encoded value are not expressible.",
  tag_description:
    "Description of what this tag represents and what kind of nodes it should be applied to.",
  tag_claim_id:
    "Optional Claim ID that this tag points to — the claim that generalizes this category. Establishes a two-sided taxonomy.",
  tag_namespace_cardinality:
    "Cardinality class for this namespace: 'dense' (hundreds of members, e.g., paper:, run:) or 'bounded' (a dozen members, e.g., theme:, condition:). " +
    "Will this namespace's members grow into the hundreds, or hold steady at a dozen? " +
    "The undeclared default is to run the near-match check. 'paper:' is pre-declared as dense.",
  tag_tags_array:
    "Optional array of registered tag names to apply to this node. Tags must be registered first via create_tag.",
  tag_tags_object:
    "Incremental tag updates: { add?: string[], remove?: string[] }. Tags must be registered first via create_tag.",
  tag_filter:
    "Optional tag name to filter by. Only nodes with this tag are returned.",
  tag_from:
    "Current tag name to rename or merge from.",
  tag_to:
    "New tag name (for rename) or target tag name (for merge).",
  tag_tags_array_input:
    "Array of tag objects to register (max 200). Each object: { name, description, claim_id? }.",
} as const;

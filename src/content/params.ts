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

  // create_statement.rebuttal_for 内嵌对象字段
  rebuttal_target_id: ELEMENTS.rebuttal.targetId,
  rebuttal_target_type: ELEMENTS.rebuttal.targetType,

  // ── 列表过滤器 ──────────────────────────────────────────────────────────────

  // list_claims.status
  claim_status_filter:
    "Filter by status (comma-separated: proposed,supported,disputed,refuted)",
  // list_statements.source
  statement_source_filter:
    "Filter by source type (comma-separated: literature,observed). Omit to include all.",
  // list_statements.verification
  statement_verification_filter:
    "Filter by verification status (comma-separated: verified,pending). Omit to include all.",

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
    "Incrementally update the node IDs used as grounds for this warrant. Use Statement node IDs for factual evidence; Claim node IDs are allowed only for chain reasoning.",
  /** Warrant 的 backing statements 增量更新；{ add?: number[], remove?: number[] } */
  backing_ids_incremental:
    "Incrementally update the Statement node IDs used as backing for this warrant. Each backing statement should substantiate the warrant's inference-licensing principle.",
  /**
   * Claim/Warrant 的 rebuttal 增量更新；{ add?: number[], remove?: number[] }。
   * target_type 由被更新节点的类型推断，不需要显式传入。
   */
  rebuttal_ids_incremental:
    "Incrementally update the Statement node IDs used as rebuttals for this Claim or Warrant. Each rebuttal statement should name a genuine counter-condition, exception, or contradiction; target_type is inferred from the updated node's type.",
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
} as const;

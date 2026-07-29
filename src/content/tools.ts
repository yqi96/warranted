/**
 * Warranted — MCP 工具级描述文本
 *
 * 每个工具的 title 和 description。
 * create_claim / create_statement / create_warrant 的 description 转发自 ELEMENTS，
 * 其余工具的 description 在此直接定义。
 */

import { ELEMENTS } from "./elements.ts";

export const TOOLS = {
  // ── 创建节点（description 转发自 ELEMENTS，保持域模型与工具文本同源）──────

  create_claim: {
    title: "Create Claim",
    description: ELEMENTS.claim.description,
  },

  create_statement: {
    title: "Create Statement",
    description: ELEMENTS.statement.description,
  },

  create_warrant: {
    title: "Create Warrant",
    description: ELEMENTS.warrant.description,
  },

  // ── 列表查询 ────────────────────────────────────────────────────────────────

  list_claims: {
    title: "List Claims",
    description: "List all claims, optionally filtered by status.",
  },

  list_statements: {
    title: "List Statements",
    description:
      "List all statement (evidence) nodes, optionally filtered by source type and/or verification status.",
  },

  // ── 查询 / 检索 ─────────────────────────────────────────────────────────────

  /** 返回以指定节点为根的完整论证子图（Claim→Warrant→Ground+Backing+Rebuttal） */
  get_argument: {
    title: "Get Argument",
    description:
      "Get the complete argumentation subgraph for a node. " +
      "Claim-type grounds (chain reasoning) are listed as ground references but not recursively expanded — call get_argument on that claim ID to see its own subgraph.",
  },

  /** 返回单节点所有字段；不遍历关联关系 */
  get_node: {
    title: "Get Node",
    description:
      "Get all fields of a single node by ID, including attachments. Does not traverse relationships.",
  },

  search_nodes: {
    title: "Search Nodes",
    description: "Search nodes by keyword, optionally filtered by type.",
  },

  get_stats: {
    title: "Get Stats",
    description: "Get global argumentation statistics.",
  },

  // ── 变更 ────────────────────────────────────────────────────────────────────

  /**
   * 通用更新入口，支持：content / status / verification / source /
   * attachments / qualifier / ground_ids / backing_ids / rebuttal_ids 增量变更。
   * 变更 content 时自动使相关 Claim 的 compile_status 失效。
   */
  update_node: {
    title: "Update Node",
    description: "Update a node's content, status, verification, or relationships.",
  },

  /**
   * 删除节点。
   * - Ground/Warrant：自动清理反向引用，返回影响警告
   * - Claim：需要 cascade=true，递归删除子节点
   */
  delete_node: {
    title: "Delete Node",
    description:
      "Delete a node. Deleting Ground/Warrant auto-cleans references and returns warnings. Claim deletion requires cascade=true.",
  },

  // ── 编译 ────────────────────────────────────────────────────────────────────

  /**
   * 触发 LLM 审查论证链逻辑一致性。
   * 仅在哈希变化时重新调用 LLM；结果写入 .toulmin/reviews/。
   * 需要 ANTHROPIC_API_KEY。
   */
  compile_arguments: {
    title: "Compile Arguments",
    description:
      "Compile a claim — review the argument graph for logical coherence, not final truth or net support. " +
      "Checks whether grounds are connected to the claim through appropriate warrants, whether rebuttals genuinely challenge their target claim or warrant, whether backings substantiate their warrant rather than merely restating the claim or summarizing the grounds, and whether any ground is circular (merely restates the claim). " +
      "Individual element definitions are assumed already validated at create/update time; compile audits only the connections between elements, not whether each element matches its own definition. " +
      "Compile independently audits logical relationships; it does not decide whether the grounds defeat the rebuttals or whether the claim is ultimately supported. " +
      "If review passes, the claim's compile_status becomes 'passed'. " +
      "If any node in the argument is later modified, compile_status is reset to 'stale'. " +
      "When to call: after completing all nodes under a Claim (Warrant + Ground(s) in place), " +
      "after any structural change to an existing argument, or whenever a Claim shows stale status. " +
      "Omit claim_ids to compile all Claims at once.",
  },
} as const;

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
    description:
      "List all claims, optionally filtered by status, compile_status, and tag. " +
      "Returns paginated results with total count in the header line. " +
      "For self-consuming queues (filters that remove completed items), always re-query with offset=0.",
  },

  list_statements: {
    title: "List Statements",
    description:
      "List all statement (evidence) nodes, optionally filtered by source type, " +
      "verification status, tag, role, and without_tag. " +
      "Returns paginated results with total count in the header line. " +
      "For self-consuming queues (filters that remove completed items), always re-query with offset=0.",
  },

  // ── 查询 / 检索 ─────────────────────────────────────────────────────────────

  /** 返回以指定节点为根的完整论证子图（Claim→Warrant→Ground+Backing+Rebuttal） */
  get_argument: {
    title: "Get Argument",
    description:
      "Get the complete argumentation subgraph for a node. " +
      "Claim-type grounds (chain reasoning) are listed as ground references but not recursively expanded — call get_argument on that claim ID to see its own subgraph. " +
      "Output size grows linearly with Ground count: a Claim carrying 40 Grounds measures approximately 2.4K tokens. " +
      "At 500–700 nodes, the visualizer is only suitable for viewing a single Claim's subtree, not the whole graph (known 0.5.0 limitation).",
  },

  /** 返回单节点所有字段；不遍历关联关系 */
  get_node: {
    title: "Get Node",
    description:
      "Get all fields of a single node by ID, including attachments. Does not traverse relationships.",
  },

  search_nodes: {
    title: "Search Nodes",
    description:
      "Search nodes by keyword, optionally filtered by type and tag. " +
      "Supports FTS5 trigram for substring matching (3+ characters). " +
      "For queries under 3 characters, falls back to LIKE. " +
      "Trigram handles both Chinese and English substring matching. " +
      "Returns paginated results with total count in the header line. " +
      "For self-consuming queues (filters that remove completed items), always re-query with offset=0.",
  },

  get_stats: {
    title: "Get Stats",
    description:
      "Get global argumentation statistics, including tag namespace aggregates, " +
      "namespace gap matrix (unclassified backlog), role counts, and attachment file listing. " +
      "The scale block helps answer 'where did I get to?' after interruption.",
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
      "Compile also reviews the Claim's and each Warrant's own definitions (whether each matches its Toulmin element definition) concurrently with the logical-connection review — element content is not validated at create/update time. " +
      "Compile independently audits logical relationships; it does not decide whether the grounds defeat the rebuttals or whether the claim is ultimately supported. " +
      "If review passes, the claim's compile_status becomes 'passed'. " +
      "If any node in the argument is later modified, compile_status is reset to 'stale'. " +
      "When to call: after completing all nodes under a Claim (Warrant + Ground(s) in place), " +
      "after any structural change to an existing argument, or whenever a Claim shows stale status. " +
      "Omit claim_ids to compile all Claims at once.",
  },

  // ── 标签 ──────────────────────────────────────────────────────────────────

  create_tag: {
    title: "Create Tag",
    description:
      "Register a tag — organizational metadata for argument nodes. " +
      "Format: <namespace>:<name> (lowercase, alphanumeric, hyphens, underscores). " +
      "Tags are orthogonal to argument structure: tagging, retagging, renaming, and merging never invalidate a compile. " +
      "Small graphs (a few dozen nodes) usually do not need tags. " +
      "The vocabulary is closed: an unregistered tag errors on the write path with near-match suggestions. " +
      "This error is the mechanism, not an obstacle — it turns 'I want to use a new wording' into an explicit taxonomic decision. " +
      "A dense-namespace tag is not the source of truth for an identifier: the original identifier cannot be recovered from a tag. " +
      "The optional namespace_cardinality parameter governs whether near-match checks run (" +
      "declare 'dense' for namespaces that grow into the hundreds, 'bounded' for those that hold steady at a dozen). " +
      "Namespaces need no prior approval — 'paper:', 'theme:', 'meta:' are conventions, not an allow-list. " +
      "The undeclared default is to run the near-match check. " +
      "The optional claim_id parameter establishes a two-sided taxonomy: from a category you can find its conclusion, and from a conclusion you can find its members.",
  },

  create_tags: {
    title: "Create Tags (Bulk)",
    description:
      "Register multiple tags in one call (max 200). " +
      "Per-item independent: one bad name does not block the other 199. " +
      "The optional namespace_cardinality parameter is applied to every new namespace in the batch. " +
      "Small graphs (a few dozen nodes) usually do not need tags.",
  },

  list_tags: {
    title: "List Tags",
    description:
      "List all registered tags with their node counts and descriptions. " +
      "Supports prefix filter (e.g., 'theme:'), min_count filter, and pagination. " +
      "Small graphs (a few dozen nodes) usually do not need tags.",
  },

  rename_tag: {
    title: "Rename Tag",
    description:
      "Rename a tag. All node_tags entries follow via ON UPDATE CASCADE. " +
      "Tag operations never invalidate a compile.",
  },

  merge_tags: {
    title: "Merge Tags",
    description:
      "Merge one tag into another. All node_tags entries are moved; overlapping nodes are deduplicated. " +
      "If the source tag has a claim_id and the target does not, a warning is produced. " +
      "The Claim is never automatically revised — that is an argumentative act belonging to the agent. " +
      "Tag operations never invalidate a compile.",
  },

  // ── PR3: 批量创建与验证 ──────────────────────────────────────────────────────

  create_statements: {
    title: "Create Statements (Batch)",
    description:
      "Atomic writes per unit (1-50 items). " +
      "A batch is the scope you would be willing to redo wholesale on failure, not 'as much as fits' — " +
      "homogeneous same-origin items belong together; split heterogeneous large batches yourself. The cap of 50 is a defense, not a target. " +
      "All validation runs first; if any item fails, every failure is reported, the entire batch is rejected, and zero statements are created. " +
      "On success, all items are written in a single transaction, each with its own result line. " +
      "Each item must specify source ('literature' or 'observed'). " +
      "source='literature' requires at least one attachment. " +
      "Attachment paths must resolve from the review working directory. " +
      "Tags must be registered in advance. " +
      "Statements land 'pending' by default and cost no review — verify them in bulk once you know which ones the argument rests on.",
  },

  verify_statements: {
    title: "Verify Statements (Batch)",
    description:
      "Run evidence review on multiple statements concurrently (1-50, concurrency ≤ 4). " +
      "Three outcomes: passed → marked 'verified'; the reviewer judged it failing → remains 'pending' with review reasons; " +
      "the review itself errored (exception, timeout, denied tool calls) → remains 'pending' with a 'review errored' note. " +
      "The third is reported separately because it means the statement was not evaluated at all: retry it, do not edit its content. " +
      "Paths are rechecked before submitting each review; missing files are reported as per-item errors " +
      "without invoking the reviewer. " +
      "Note an asymmetry in what review costs to prepare: source='literature' items need nothing beyond the attached reference files, " +
      "but source='observed' items must each already have a description document among their attachments explaining what is asserted, " +
      "how the evidence was produced, and where the files came from. On observed-dominated work this tool saves round trips, not that cost. " +
      "Requires review configuration.",
  },

  tag_nodes: {
    title: "Tag Nodes (Batch)",
    description:
      "Add or remove tags on multiple nodes in one call (1-200 nodes). " +
      "All tags in the 'add' array must be registered in advance — if any is unregistered, the entire call is rejected. " +
      "Non-existent node IDs are listed as skipped; remaining nodes are processed. " +
      "All writes happen in a single transaction. " +
      "Tag operations never invalidate a compile.",
  },

  update_tag: {
    title: "Update Tag",
    description:
      "Update a tag's description and/or claim_id. " +
      "The tag must exist. " +
      "Tag operations never invalidate a compile.",
  },
} as const;

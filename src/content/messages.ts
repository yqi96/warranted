/** Warranted — 工具返回的输出消息文本 */

export const MESSAGES = {
  no_claims: "No claims found.",                 // list_claims 空结果
  no_statements: "No statements found.",         // list_statements 空结果
  no_matching_nodes: "No matching nodes found.", // search_nodes 空结果
  no_claims_to_compile: "No claims to compile.", // compile_arguments 无 claim 时
  review_not_configured: "Review not configured. Set ANTHROPIC_API_KEY to enable compile.", // compile_arguments 未配置时
} as const;

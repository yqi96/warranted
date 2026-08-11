/** Warranted — 工具返回的输出消息文本 */

export const MESSAGES = {
  no_claims: "No claims found.",                 // list_claims 空结果
  no_statements: "No statements found.",         // list_statements 空结果
  no_matching_nodes: "No matching nodes found.", // search_nodes 空结果
  no_claims_to_compile: "No claims to compile.", // compile_arguments 无 claim 时
  // verify_statements 未配置审查时。compile_arguments 不用这条：它没配模型也通过，
  // 只附一条 warnings.compiledWithoutReviewModel
  review_not_configured:
    "Review is not configured, so statements cannot be submitted for review. " +
    "Start the server with --review-config <file> to enable it.",
} as const;

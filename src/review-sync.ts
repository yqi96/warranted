/**
 * Warranted — 同步审查执行器
 *
 * 直接调用 LLM API 执行审查，返回结果并保存到 review 目录。
 */

import type { Database } from "bun:sqlite";
import type { ReviewConfig } from "./review-config.ts";
import { buildStatementEvidencePrompt } from "./review-prompts.ts";
import { callAgent, parseLLMResponse } from "./review-llm.ts";
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { log } from "./logger.ts";
import * as repo from "./repo.ts";
import { reviewCwd } from "./review-config.ts";

// =============================================================================
// Statement Evidence Review（同步）
// =============================================================================

/** Statement 证据审查结果 */
export interface StatementReviewResult {
  errors: string[];
  warnings: string[];
  /**
   * §3.0's third outcome. Set when the review infrastructure itself failed
   * (exception, timeout, SDK failure, denied tool calls) rather than when the
   * reviewer judged the evidence inadequate. The two carry opposite
   * prescriptions — retry vs. fix the evidence — so callers must not merge them,
   * and must never mark a statement `verified` when this is set.
   */
  reviewError?: string;
  /** Tool calls the SDK denied. Non-empty means the reviewer may never have read the evidence. */
  deniedTools?: string[];
}

/** A denial means the verdict may rest on evidence the reviewer never read. */
function denialResult(deniedTools: string[], warnings: string[]): StatementReviewResult {
  return {
    errors: [],
    warnings,
    deniedTools,
    reviewError: `review denied ${deniedTools.length} tool call(s) (${deniedTools.join(", ")}) — the reviewer may not have read the attachments`,
  };
}

/** 创建前证据审查：不依赖 DB，接受参数直接审查 */
export async function reviewStatementEvidencePreCreate(
  config: ReviewConfig,
  params: { content: string; source: string; attachments: string[] }
): Promise<StatementReviewResult> {
  const prompt = buildStatementEvidencePrompt({
    statement: {
      id: 0, // 尚未创建
      content: params.content,
      source: params.source,
      attachments: params.attachments,
    },
  });

  const deniedTools: string[] = [];
  try {
    const cwd = reviewCwd(config);
    log("statement_review", "OK", 0, `START statement_reviewer: pre-create`);
    const t0 = Date.now();

    const response = await callAgent(config, prompt, params.attachments, cwd, undefined, deniedTools);
    const elapsed = Date.now() - t0;
    const parsed = parseLLMResponse(response, "");
    const errors: string[] = ((parsed.errors as Array<any>) || []).map(e =>
      typeof e === "string" ? e : e.message || String(e)
    );
    const warnings: string[] = ((parsed.warnings as Array<any>) || []).map(w =>
      typeof w === "string" ? w : w.message || String(w)
    );

    log("statement_review", "OK", elapsed,
      `END statement_reviewer: pre-create → ${errors.length} error(s), ${warnings.length} warning(s)`);

    if (deniedTools.length > 0) return denialResult(deniedTools, warnings);

    return { errors, warnings };
  } catch (error) {
    log("statement_review", "ERR", 0, `pre-create: ${error}`);
    return { errors: [], warnings: [], reviewError: String(error) };
  }
}

/** 已有 Statement 证据审查：从 DB 读取，审查并保存结果 */
export async function executeStatementReview(
  config: ReviewConfig,
  db: Database,
  statementId: number
): Promise<StatementReviewResult> {
  const statementRow = repo.getNodeById(db, statementId);
  if (!statementRow) {
    return { errors: [`Statement #${statementId} not found.`], warnings: [] };
  }

  const statementData = JSON.parse(statementRow.data);

  const prompt = buildStatementEvidencePrompt({
    statement: {
      id: statementId,
      content: statementRow.content,
      source: statementData.source || "unknown",
      attachments: statementData.attachments || [],
    },
  });

  const deniedTools: string[] = [];
  try {
    const cwd = reviewCwd(config);
    log("statement_review", "OK", 0,
      `START statement_reviewer: statement=#${statementId}`);
    const t0 = Date.now();

    const response = await callAgent(config, prompt, statementData.attachments || [], cwd, undefined, deniedTools);
    const elapsed = Date.now() - t0;
    const parsed = parseLLMResponse(response, "");
    const errors: string[] = ((parsed.errors as Array<any>) || []).map(e =>
      typeof e === "string" ? e : e.message || String(e)
    );
    const warnings: string[] = ((parsed.warnings as Array<any>) || []).map(w =>
      typeof w === "string" ? w : w.message || String(w)
    );

    log("statement_review", "OK", elapsed,
      `END statement_reviewer: statement=#${statementId} → ${errors.length} error(s), ${warnings.length} warning(s)`);

    const result: StatementReviewResult = deniedTools.length > 0
      ? denialResult(deniedTools, warnings)
      : { errors, warnings };
    saveStatementReviewFile(config, statementId, result);

    return result;
  } catch (error) {
    log("statement_review", "ERR", 0, `statement=#${statementId}: ${error}`);
    return { errors: [], warnings: [], reviewError: String(error) };
  }
}

// =============================================================================
// 工具函数
// =============================================================================

/** 将 Statement 证据审查结果保存为独立 JSON 文件到 reviews/ 目录 */
export function saveStatementReviewFile(
  config: ReviewConfig,
  statementId: number,
  result: StatementReviewResult
): void {
  if (!config.reviewDir) return;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `statement_evidence_statement${statementId}_${timestamp}.json`;
  const filepath = join(config.reviewDir, filename);

  mkdirSync(config.reviewDir, { recursive: true });
  writeFileSync(filepath, JSON.stringify({
    statementId,
    reviewedAt: new Date().toISOString().slice(0, 19),
    ...result,
  }, null, 2), "utf-8");
}

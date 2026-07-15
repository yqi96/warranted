/**
 * Toulmin MCP — 同步审查执行器
 *
 * 直接调用 LLM API 执行审查，返回结果并保存到 review 目录。
 */

import type { Database } from "bun:sqlite";
import type { ReviewConfig } from "./review-config.ts";
import { buildArgumentReviewPrompt, buildGroundEvidencePrompt } from "./review-prompts.ts";
import { callAgent, parseLLMResponse } from "./review-llm.ts";
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { log } from "./logger.ts";
import * as repo from "./repo.ts";

// =============================================================================
// 类型定义
// =============================================================================

export interface ReviewResult {
  verdict: string;
  summary: string;
  issues: Array<{
    severity: string;
    element?: string;
    nodeId?: number;
    message: string;
  }>;
}

// =============================================================================
// Argument Review（同步）
// =============================================================================

export async function executeArgumentReview(
  config: ReviewConfig,
  db: Database,
  claimId: number,
  warrantId: number,
  groundIds: number[]
): Promise<ReviewResult | null> {
  // 1. 从数据库读取节点数据
  const claimRow = repo.getNodeById(db, claimId);
  const warrantRow = repo.getNodeById(db, warrantId);
  if (!claimRow || !warrantRow) return null;

  const claimData = JSON.parse(claimRow.data);
  const warrantData = JSON.parse(warrantRow.data);

  const grounds = groundIds.map(gid => {
    const gRow = repo.getNodeById(db, gid);
    if (!gRow) return null;
    const gData = JSON.parse(gRow.data);
    return {
      id: gid,
      content: gRow.content,  // content 是独立字段
      source: gData.source || "unknown",
      verification: gData.verification || "pending",
      attachments: gData.attachments || [],
    };
  }).filter(Boolean) as any[];

  if (grounds.length === 0) return null;

  // 2. 构建 Prompt
  const prompt = buildArgumentReviewPrompt({
    claim: {
      id: claimId,
      content: claimRow.content,  // content 是独立字段
      status: claimData.status || "proposed",
      qualifier: claimData.qualifier,
    },
    warrant: {
      id: warrantId,
      content: warrantRow.content,  // content 是独立字段
    },
    grounds,
  });

  // 3. 调用 LLM
  try {
    const cwd = dirname(dirname(config.dbPath));  // .toulmin 的父目录（项目根目录）
    const response = await callAgent(config, prompt, [], cwd);
    const result = parseLLMResponse(response, "concerns") as unknown as ReviewResult;

    // 4. 保存结果到 review 目录
    saveReviewResult(config, "argument", { claimId, warrantId, groundIds }, result);

    // 5. 如果 verdict 不是 sound，返回结果
    if (result.verdict !== "sound") {
      return result;
    }

    return null; // sound 时静默
  } catch (error) {
    console.error(`[Toulmin Review] Argument review failed: ${error}`);
    return null;
  }
}

// =============================================================================
// Ground Evidence Review（同步）
// =============================================================================

/** Ground 证据审查结果 */
export interface GroundReviewResult {
  errors: string[];
  warnings: string[];
}

/** 创建前证据审查：不依赖 DB，接受参数直接审查 */
export async function reviewGroundEvidencePreCreate(
  config: ReviewConfig,
  params: { content: string; source: string; attachments: string[] }
): Promise<GroundReviewResult> {
  const prompt = buildGroundEvidencePrompt({
    ground: {
      id: 0, // 尚未创建
      content: params.content,
      source: params.source,
      verification: "verified",
      attachments: params.attachments,
    },
  });

  try {
    const cwd = dirname(dirname(config.dbPath));
    log("ground_review", "OK", 0, `START ground_reviewer: pre-create`);
    const t0 = Date.now();

    const response = await callAgent(config, prompt, params.attachments, cwd);
    const elapsed = Date.now() - t0;
    const parsed = parseLLMResponse(response, "");
    const errors: string[] = ((parsed.errors as Array<any>) || []).map(e =>
      typeof e === "string" ? e : e.message || String(e)
    );
    const warnings: string[] = ((parsed.warnings as Array<any>) || []).map(w =>
      typeof w === "string" ? w : w.message || String(w)
    );

    log("ground_review", "OK", elapsed,
      `END ground_reviewer: pre-create → ${errors.length} error(s), ${warnings.length} warning(s)`);

    return { errors, warnings };
  } catch (error) {
    log("ground_review", "ERR", 0, `pre-create: ${error}`);
    return { errors: [`Reviewer error: ${error}`], warnings: [] };
  }
}

/** 已有 Ground 证据审查：从 DB 读取，审查并保存结果 */
export async function executeGroundReview(
  config: ReviewConfig,
  db: Database,
  groundId: number
): Promise<GroundReviewResult> {
  // 1. 从数据库读取 Ground 数据
  const groundRow = repo.getNodeById(db, groundId);
  if (!groundRow) {
    return { errors: [`Ground #${groundId} not found.`], warnings: [] };
  }

  const groundData = JSON.parse(groundRow.data);

  // 2. 链式推理 Ground（有 ref_claim_id）跳过证据审查
  if (groundData.ref_claim_id !== null && groundData.ref_claim_id !== undefined) {
    log("ground_review", "OK", 0,
      `START ground_reviewer: ground=#${groundId} (chain reasoning → skip)`);
    log("ground_review", "OK", 0,
      `END ground_reviewer: ground=#${groundId} → skipped (chain reasoning, ref_claim_id=${groundData.ref_claim_id})`);
    return { errors: [], warnings: [] };
  }

  // 3. 构建 Prompt
  const prompt = buildGroundEvidencePrompt({
    ground: {
      id: groundId,
      content: groundRow.content,
      source: groundData.source || "unknown",
      verification: groundData.verification || "pending",
      attachments: groundData.attachments || [],
    },
  });

  // 4. 调用 LLM
  try {
    const cwd = dirname(dirname(config.dbPath));
    log("ground_review", "OK", 0,
      `START ground_reviewer: ground=#${groundId}`);
    const t0 = Date.now();

    const response = await callAgent(config, prompt, groundData.attachments || [], cwd);
    const elapsed = Date.now() - t0;
    const parsed = parseLLMResponse(response, "");
    const errors: string[] = ((parsed.errors as Array<any>) || []).map(e =>
      typeof e === "string" ? e : e.message || String(e)
    );
    const warnings: string[] = ((parsed.warnings as Array<any>) || []).map(w =>
      typeof w === "string" ? w : w.message || String(w)
    );

    log("ground_review", "OK", elapsed,
      `END ground_reviewer: ground=#${groundId} → ${errors.length} error(s), ${warnings.length} warning(s)`);

    // 5. 保存结果到 review 目录
    saveGroundReviewFile(config, groundId, { errors, warnings });

    return { errors, warnings };
  } catch (error) {
    log("ground_review", "ERR", 0, `ground=#${groundId}: ${error}`);
    return { errors: [`Reviewer error: ${error}`], warnings: [] };
  }
}

// =============================================================================
// 工具函数
// =============================================================================

/** 将 Ground 证据审查结果保存为独立 JSON 文件到 reviews/ 目录 */
export function saveGroundReviewFile(
  config: ReviewConfig,
  groundId: number,
  result: GroundReviewResult
): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `ground_evidence_ground${groundId}_${timestamp}.json`;
  const filepath = join(config.reviewDir, filename);

  mkdirSync(config.reviewDir, { recursive: true });
  writeFileSync(filepath, JSON.stringify({
    groundId,
    reviewedAt: new Date().toISOString().slice(0, 19),
    ...result,
  }, null, 2), "utf-8");
}

function saveReviewResult(
  config: ReviewConfig,
  reviewType: string,
  context: Record<string, any>,
  result: ReviewResult
): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${reviewType}_${timestamp}.json`;
  const filepath = join(config.reviewDir, filename);

  // 确保目录存在
  mkdirSync(config.reviewDir, { recursive: true });

  const data = {
    reviewType,
    timestamp: new Date().toISOString(),
    context,
    result,
  };

  writeFileSync(filepath, JSON.stringify(data, null, 2), "utf-8");
}

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

export async function executeGroundReview(
  config: ReviewConfig,
  db: Database,
  groundId: number
): Promise<ReviewResult | null> {
  // 1. 从数据库读取 Ground 数据
  const groundRow = repo.getNodeById(db, groundId);
  if (!groundRow) return null;

  const groundData = JSON.parse(groundRow.data);

  // 2. 如果有 ref_ass_id，读取 referenced Claim
  let referencedClaim = null;
  if (groundData.ref_ass_id) {
    const claimRow = repo.getNodeById(db, groundData.ref_ass_id);
    if (claimRow) {
      referencedClaim = {
        id: groundData.ref_ass_id,
        content: claimRow.content,  // content 是独立字段
      };
    }
  }

  // 3. 构建 Prompt
  const prompt = buildGroundEvidencePrompt({
    ground: {
      id: groundId,
      content: groundRow.content,  // content 是独立字段
      source: groundData.source || "unknown",
      verification: groundData.verification || "pending",
      attachments: groundData.attachments || [],
      refClaimId: groundData.ref_ass_id,
    },
    referencedClaim,
  });

  // 4. 调用 LLM
  try {
    const cwd = dirname(dirname(config.dbPath));  // .toulmin 的父目录（项目根目录）
    const response = await callAgent(config, prompt, groundData.attachments || [], cwd);
    const result = parseLLMResponse(response, "insufficient") as unknown as ReviewResult;

    // 5. 保存结果到 review 目录
    saveReviewResult(config, "ground_evidence", { groundId }, result);

    // 6. 如果 verdict 不是 sufficient，返回结果
    if (result.verdict !== "sufficient") {
      return result;
    }

    return null; // sufficient 时静默
  } catch (error) {
    console.error(`[Toulmin Review] Ground review failed: ${error}`);
    return null;
  }
}

// =============================================================================
// 工具函数
// =============================================================================


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

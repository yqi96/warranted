/**
 * Toulmin MCP — Compile Service 层
 *
 * compile 包含多项检查，不同时机触发：
 * - 节点定义检查：节点 content 变化时触发（reviewNodeDefinition）
 * - 逻辑链检查：论证图哈希变化时触发（compileArgument → runChainReview）
 *
 * 失效管理：节点修改时清除受影响 Claim 的 compiled 状态
 */

import type { Database } from "bun:sqlite";
import type { ReviewConfig } from "./review-config.ts";
import type {
  CompileResult,
  CompileVerdict,
  ElementReviewResult,
  AutoVerifyResult,
} from "./types.ts";
import * as repo from "./repo.ts";
import { runChainReview } from "./compile-reviewers.ts";
import { computeArgumentHash } from "./merkle-hash.ts";
import { findWarrantsUsingGround } from "./service.ts";
import { WARNINGS } from "./content.ts";
import { log } from "./logger.ts";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { callAndParse } from "./review-llm.ts";
import {
  buildClaimReviewPrompt,
  buildWarrantReviewPrompt,
  buildGroundReviewPrompt,
} from "./compile-prompts.ts";

// =============================================================================
// 审查结果持久化
// =============================================================================

/** 将逻辑链审查结果保存为独立 JSON 文件到 reviews/ 目录 */
function saveChainReviewFile(
  config: ReviewConfig,
  claimId: number,
  review: ElementReviewResult,
  compiledAt: string
): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `compile_claim${claimId}_chain_${timestamp}.json`;
  const filepath = join(config.reviewDir, filename);

  mkdirSync(config.reviewDir, { recursive: true });
  writeFileSync(filepath, JSON.stringify({
    claimId,
    compiledAt,
    ...review,
  }, null, 2), "utf-8");
}

/** 将节点定义审查结果保存为独立 JSON 文件到 reviews/ 目录 */
function saveNodeReviewFile(
  config: ReviewConfig,
  elementType: "claim" | "warrant" | "ground",
  content: string,
  result: { errors: string[]; warnings: string[] },
  reviewedAt: string
): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `create_${elementType}_${timestamp}.json`;
  const filepath = join(config.reviewDir, filename);

  mkdirSync(config.reviewDir, { recursive: true });
  writeFileSync(filepath, JSON.stringify({
    type: "create",
    elementType,
    content,
    reviewedAt,
    ...result,
  }, null, 2), "utf-8");
}

// =============================================================================
// 节点定义检查（content 变化时触发）
// =============================================================================

/**
 * 对 content 执行节点定义审查。
 * create 时阻断（errors 非空 → 不入库），update 时非阻断（仅报告）。
 * 审查结果保存到 reviews/ 目录。
 */
export async function reviewNodeDefinition(
  config: ReviewConfig,
  elementType: "claim" | "warrant" | "ground",
  content: string,
  qualifier?: string | null
): Promise<{ errors: string[]; warnings: string[] }> {
  const cwd = dirname(dirname(config.dbPath));
  const reviewedAt = new Date().toISOString().slice(0, 19);
  let prompt: string;

  if (elementType === "claim") {
    prompt = buildClaimReviewPrompt({
      id: 0,
      content,
      qualifier: qualifier ?? null,
    });
  } else if (elementType === "warrant") {
    prompt = buildWarrantReviewPrompt({ id: 0, content });
  } else {
    prompt = buildGroundReviewPrompt({ id: 0, content });
  }

  let result: { errors: string[]; warnings: string[] };

  try {
    result = await callAndParse(config, prompt, [], cwd);
  } catch (error) {
    result = { errors: [`Reviewer error: ${error}`], warnings: [] };
  }

  // 保存审查结果到 reviews/ 目录
  saveNodeReviewFile(config, elementType, content, result, reviewedAt);

  return result;
}

// =============================================================================
// 结构预检
// =============================================================================

/**
 * 检查 Claim 的 argument 结构是否完整。
 * 返回错误消息数组（空数组表示通过）。
 */
export function structuralPreCheck(db: Database, claimId: number): string[] {
  const errors: string[] = [];

  const claimRow = repo.getNodeById(db, claimId);
  if (!claimRow) {
    errors.push(`Claim #${claimId} not found.`);
    return errors;
  }
  if (claimRow.type !== "claim") {
    errors.push(`Node #${claimId} is not a Claim (type: ${claimRow.type}).`);
    return errors;
  }

  const warrants = repo.findWarrantsByClaim(db, claimId);
  if (warrants.length === 0) {
    errors.push(`Claim #${claimId} has no Warrants. Create at least one Warrant first.`);
    return errors;
  }

  for (const w of warrants) {
    const wData = JSON.parse(w.data);
    const groundIds: number[] = wData.ground_ids || [];
    if (groundIds.length === 0) {
      errors.push(`Warrant #${w.id} has no Grounds.`);
      continue;
    }
    for (const gid of groundIds) {
      const gRow = repo.getNodeById(db, gid);
      if (!gRow) {
        errors.push(`Ground #${gid} (referenced by Warrant #${w.id}) not found.`);
      } else if (gRow.type !== "ground") {
        errors.push(`Node #${gid} (referenced by Warrant #${w.id}) is not a Ground (type: ${gRow.type}).`);
      }
    }
  }

  return errors;
}

// =============================================================================
// 逻辑链审查（论证图哈希变化时触发）
// =============================================================================

/**
 * 对 Claim 的 argument 执行逻辑链审查。
 * 由 auto-review 在论证图哈希变化时触发。
 */
export async function compileArgument(
  db: Database,
  config: ReviewConfig,
  claimId: number
): Promise<CompileResult> {
  const compiledAt = new Date().toISOString().slice(0, 19);
  const t0 = Date.now();
  log("review_dispatch", "OK", 0, `START chain review claim=#${claimId}`);

  // 1. 结构预检
  const structuralErrors = structuralPreCheck(db, claimId);
  if (structuralErrors.length > 0) {
    log("review_dispatch", "ERR", 0, `claim=#${claimId} → structural pre-check failed: ${structuralErrors.join("; ")}`);
    return {
      claimId,
      verdict: "failed" as CompileVerdict,
      summary: `Structural pre-check failed: ${structuralErrors.join("; ")}`,
      elementReviews: [{
        reviewer: "chain" as const,
        errors: structuralErrors,
        warnings: [],
      }],
      compiledAt,
    };
  }

  // 2. 运行逻辑链审查
  const { elementReviews } = await runChainReview(config, db, claimId);

  // 3. 汇总结果
  const hasError = elementReviews.some(r => r.errors.length > 0);
  const verdict: CompileVerdict = hasError ? "failed" : "passed";

  const totalErrors = elementReviews.reduce((sum, r) => sum + r.errors.length, 0);
  const totalWarnings = elementReviews.reduce((sum, r) => sum + r.warnings.length, 0);
  const summaryParts: string[] = [];
  if (hasError) {
    summaryParts.push(`Compile failed with ${totalErrors} error(s).`);
  } else if (totalWarnings > 0) {
    summaryParts.push(`Compile passed with ${totalWarnings} warning(s) noted.`);
  } else {
    summaryParts.push("Compile passed. Argument is logically sound.");
  }
  const summary = summaryParts.join(" ");

  // 4. 存储 compile_state（含 argument_hash）
  const argHash = computeArgumentHash(db, claimId);
  repo.saveCompileState(db, claimId, verdict, summary, argHash);

  // 5. 更新 compiled/stale 标志
  const claimRow = repo.getNodeById(db, claimId);
  if (claimRow) {
    const data = JSON.parse(claimRow.data);
    if (verdict === "passed") {
      data.compiled = true;
      data.compiled_at = compiledAt;
      data.stale = false;
    } else {
      if (data.compiled) {
        data.compiled = false;
      }
      data.stale = true;
    }
    repo.updateNodeFields(db, claimId, { data });
  }

  const elapsed = Date.now() - t0;
  log("review_dispatch", "OK", elapsed, `END claim=#${claimId} → verdict=${verdict}, "${summary.slice(0, 80)}"`);

  // 6. 保存审查结果到 reviews/ 目录
  for (const review of elementReviews) {
    try {
      saveChainReviewFile(config, claimId, review, compiledAt);
    } catch {
      // 保存失败不影响主流程
    }
  }

  return {
    claimId,
    verdict,
    summary,
    elementReviews,
    compiledAt,
  };
}

// =============================================================================
// 失效管理
// =============================================================================

/**
 * 根据被修改节点类型，向上查找直接受影响的 Claim ID（不含链式传播）。
 */
function findAffectedClaimIdsDirect(db: Database, nodeId: number): number[] {
  const row = repo.getNodeById(db, nodeId);
  if (!row) return [];
  const data = JSON.parse(row.data);
  const claimIds = new Set<number>();

  switch (row.type) {
    case "claim":
      claimIds.add(nodeId);
      break;

    case "warrant":
      if (data.claim_id) claimIds.add(data.claim_id);
      break;

    case "ground":
      const allWarrants = repo.listNodesByType(db, "warrant");
      for (const w of allWarrants) {
        const wData = JSON.parse(w.data);
        if ((wData.ground_ids || []).includes(nodeId) && wData.claim_id) {
          claimIds.add(wData.claim_id);
        }
      }
      break;

    case "backing": {
      const wRow = repo.getNodeById(db, data.warrant_id);
      if (wRow) {
        const wData = JSON.parse(wRow.data);
        if (wData.claim_id) claimIds.add(wData.claim_id);
      }
      break;
    }

    case "rebuttal":
      if (data.target_type === "claim") {
        claimIds.add(data.target_id);
      } else if (data.target_type === "warrant") {
        const wRow = repo.getNodeById(db, data.target_id);
        if (wRow) {
          const wData = JSON.parse(wRow.data);
          if (wData.claim_id) claimIds.add(wData.claim_id);
        }
      }
      break;
  }

  return [...claimIds];
}

/**
 * 根据被修改节点，向上查找所有受影响的 Claim ID（含链式推理 BFS 传播）。
 */
export function findAffectedClaimIds(db: Database, nodeId: number): number[] {
  const directIds = findAffectedClaimIdsDirect(db, nodeId);
  const allAffected = new Set<number>(directIds);
  const queue = [...directIds];

  while (queue.length > 0) {
    const claimId = queue.shift()!;
    const refGrounds = repo.findGroundsByRefClaim(db, claimId);
    for (const g of refGrounds) {
      const usingWarrants = findWarrantsUsingGround(db, g.id);
      for (const w of usingWarrants) {
        const wData = JSON.parse(w.data);
        if (wData.claim_id && !allAffected.has(wData.claim_id)) {
          allAffected.add(wData.claim_id);
          queue.push(wData.claim_id);
        }
      }
    }
  }

  return [...allAffected];
}

/**
 * 清除受影响 Claim 的 compiled 状态。
 */
export function invalidateCompiledClaims(db: Database, nodeId: number): string[] {
  const affectedIds = findAffectedClaimIds(db, nodeId);
  const warnings: string[] = [];

  for (const claimId of affectedIds) {
    const row = repo.getNodeById(db, claimId);
    if (!row || row.type !== "claim") continue;
    const data = JSON.parse(row.data);
    if (data.compiled) {
      repo.clearCompiledFlag(db, claimId);
      repo.deleteCompileState(db, claimId);
      warnings.push(WARNINGS.compileInvalidated(claimId, nodeId));
    }
  }

  return warnings;
}

// =============================================================================
// 自动验证
// =============================================================================

/**
 * 变更后自动验证。
 *
 * - 有 compile_state + argumentHash 未变 → no-change
 * - 有 compile_state + argumentHash 变了 → 自动触发逻辑链审查
 * - 无 compile_state + 结构完整 → 自动触发首次逻辑链审查
 * - 无 compile_state + 结构不完整 → 标记 stale
 * - 无 reviewConfig → 标记 stale
 */
export async function autoVerifyAfterMutation(
  db: Database,
  config: ReviewConfig | null,
  affectedClaimIds: number[]
): Promise<AutoVerifyResult[]> {
  log("auto_review", "OK", 0, `triggered for ${affectedClaimIds.length} claim(s): [${affectedClaimIds.join(", ")}]`);

  const promises = affectedClaimIds.map(async (claimId): Promise<AutoVerifyResult> => {
    const t0 = Date.now();
    const claimRow = repo.getNodeById(db, claimId);
    if (!claimRow || claimRow.type !== "claim") {
      return { claimId, action: "skipped", message: "Claim not found" };
    }

    const prevState = repo.getCompileState(db, claimId);
    const newArgHash = computeArgumentHash(db, claimId);

    // Case 1: 有 compile_state 且有 argumentHash
    if (prevState && prevState.argumentHash) {
      if (prevState.argumentHash === newArgHash) {
        log("auto_review", "OK", Date.now() - t0, `claim=#${claimId}: hash unchanged → no-change`);
        return { claimId, action: "no-change" };
      }
      // 哈希变化 → 需要重新审查
      if (!config) {
        log("auto_review", "OK", Date.now() - t0, `claim=#${claimId}: hash changed, no config → marked-stale`);
        repo.setClaimStale(db, claimId, true);
        if (prevState.verdict === "passed") {
          repo.clearCompiledFlag(db, claimId);
        }
        return { claimId, action: "marked-stale", message: "Review not configured" };
      }
      log("auto_review", "OK", 0, `claim=#${claimId}: hash changed → auto-review`);
      const compileResult = await compileArgument(db, config, claimId);
      return { claimId, action: "auto-reviewed", compileResult };
    }

    // Case 2: 从未审查过
    const structuralErrors = structuralPreCheck(db, claimId);
    if (structuralErrors.length === 0) {
      if (config) {
        log("auto_review", "OK", 0, `claim=#${claimId}: structure complete → first review`);
        const compileResult = await compileArgument(db, config, claimId);
        return { claimId, action: "auto-reviewed", compileResult };
      }
      log("auto_review", "OK", Date.now() - t0, `claim=#${claimId}: structure complete, no config → marked-stale`);
      repo.setClaimStale(db, claimId, true);
      return { claimId, action: "marked-stale", message: "Review not configured" };
    }

    // 结构不完整 → 标记 stale
    log("auto_review", "OK", Date.now() - t0, `claim=#${claimId}: structure incomplete → marked-stale`);
    const claimData = JSON.parse(claimRow.data);
    if (!claimData.stale) {
      repo.setClaimStale(db, claimId, true);
    }
    return { claimId, action: "marked-stale" };
  });

  const results = await Promise.all(promises);
  const summary = results.map(r => `claim=#${r.claimId}:${r.action}`).join(", ");
  log("auto_review", "OK", 0, `completed: ${summary}`);
  return results;
}

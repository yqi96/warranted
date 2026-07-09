/**
 * Toulmin MCP — Compile Service 层
 *
 * 编译编排：结构预检 → 两阶段审查 → 汇总 → 存储状态
 * 失效管理：节点修改时清除受影响 Claim 的 compiled 状态
 */

import type { Database } from "bun:sqlite";
import type { ReviewConfig } from "./review-config.ts";
import type {
  CompileResult,
  CompileVerdict,
  ElementReviewResult,
  AutoVerifyResult,
  NodeRow,
} from "./types.ts";
import * as repo from "./repo.ts";
import { runCompileReviewers } from "./compile-reviewers.ts";
import { computeArgumentHash } from "./merkle-hash.ts";
import { findWarrantsUsingGround } from "./service.ts";
import { WARNINGS } from "./content.ts";

// =============================================================================
// 结构预检
// =============================================================================

/**
 * 检查 Claim 的 argument 结构是否完整。
 * 返回错误消息数组（空数组表示通过）。
 */
export function structuralPreCheck(db: Database, claimId: number): string[] {
  const errors: string[] = [];

  // Claim 存在
  const claimRow = repo.getNodeById(db, claimId);
  if (!claimRow) {
    errors.push(`Claim #${claimId} not found.`);
    return errors;
  }
  if (claimRow.type !== "claim") {
    errors.push(`Node #${claimId} is not a Claim (type: ${claimRow.type}).`);
    return errors;
  }

  // 有 Warrant
  const warrants = repo.findWarrantsByClaim(db, claimId);
  if (warrants.length === 0) {
    errors.push(`Claim #${claimId} has no Warrants. Create at least one Warrant first.`);
    return errors;
  }

  // 每个 Warrant 有 Ground，且 Ground 节点存在
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
// Compile 主流程
// =============================================================================

/**
 * 编译 Claim 的完整 argument：
 * 1. 结构预检
 * 2. 两阶段 LLM 审查
 * 3. 汇总结果
 * 4. 存储 compile_state + 设置 compiled 标志
 */
export async function compileArgument(
  db: Database,
  config: ReviewConfig,
  claimId: number
): Promise<CompileResult> {
  const compiledAt = new Date().toISOString().slice(0, 19);

  // 1. 结构预检
  const structuralErrors = structuralPreCheck(db, claimId);
  if (structuralErrors.length > 0) {
    return {
      claimId,
      verdict: "failed" as CompileVerdict,
      summary: `Structural pre-check failed: ${structuralErrors.join("; ")}`,
      elementReviews: [{
        reviewer: "claim" as const,
        nodeId: claimId,
        verdict: "fail",
        summary: structuralErrors.join("; "),
        issues: structuralErrors.map(msg => ({
          severity: "major" as const,
          message: msg,
        })),
      }],
      compiledAt,
      skippedCount: 0,
      totalCount: 0,
    };
  }

  // 2. 加载上次的 node_hashes
  const prevState = repo.getCompileState(db, claimId);
  const previousHashes: Record<number, string> = prevState?.nodeHashes || {};

  // 3. 运行两阶段审查
  const { elementReviews, currentHashes } = await runCompileReviewers(
    config, db, claimId, previousHashes
  );

  // 4. 汇总结果
  const skippedCount = elementReviews.filter(r => r.skipped).length;
  const totalCount = elementReviews.length;
  const hasFailure = elementReviews.some(r => r.verdict === "fail");
  const verdict: CompileVerdict = hasFailure ? "failed" : "passed";

  // 汇总 summary
  const failedReviews = elementReviews.filter(r => r.verdict === "fail");
  const concernsReviews = elementReviews.filter(r => r.verdict === "concerns" && !r.skipped);
  const summaryParts: string[] = [];
  if (hasFailure) {
    summaryParts.push(`Compile failed with ${failedReviews.length} reviewer(s) reporting failures.`);
  } else if (concernsReviews.length > 0) {
    summaryParts.push(`Compile passed with ${concernsReviews.length} concern(s) noted.`);
  } else {
    summaryParts.push("Compile passed. All reviewers confirmed the argument is sound.");
  }
  if (skippedCount > 0) {
    summaryParts.push(`${skippedCount} reviewer(s) skipped (content unchanged).`);
  }
  const summary = summaryParts.join(" ");

  // 5. 存储 compile_state（含 argument_hash）
  const argHash = computeArgumentHash(db, claimId);
  repo.saveCompileState(db, claimId, verdict, summary, currentHashes, argHash);

  // 6. 如果 passed：设置 compiled 标志 + 清除 stale
  if (verdict === "passed") {
    const claimRow = repo.getNodeById(db, claimId);
    if (claimRow) {
      const data = JSON.parse(claimRow.data);
      data.compiled = true;
      data.compiled_at = compiledAt;
      data.stale = false;
      repo.updateNodeFields(db, claimId, { data });
    }
  }

  return {
    claimId,
    verdict,
    summary,
    elementReviews,
    compiledAt,
    skippedCount,
    totalCount,
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
      // 找到引用该 Ground 的所有 Warrant，再找其 Claim
      const allWarrants = repo.listNodesByType(db, "warrant");
      for (const w of allWarrants) {
        const wData = JSON.parse(w.data);
        if ((wData.ground_ids || []).includes(nodeId) && wData.claim_id) {
          claimIds.add(wData.claim_id);
        }
      }
      break;

    case "backing": {
      // Backing → Warrant → Claim
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
 *
 * 两步走：
 * 1. findAffectedClaimIdsDirect: 直接受影响（同结构内的 claim/warrant/ground/backing/rebuttal）
 * 2. BFS 链式传播：对每个受影响的 Claim，通过 Ground.ref_claim_id 向上找父 Claim
 */
export function findAffectedClaimIds(db: Database, nodeId: number): number[] {
  // Step 1: 直接受影响的 Claim
  const directIds = findAffectedClaimIdsDirect(db, nodeId);

  // Step 2: 通过链式推理向上传播（BFS）
  const allAffected = new Set<number>(directIds);
  const queue = [...directIds];

  while (queue.length > 0) {
    const claimId = queue.shift()!;
    // 找到所有 ref_claim_id = claimId 的 Ground（即引用该 Claim 作为证据的 Ground）
    const refGrounds = repo.findGroundsByRefClaim(db, claimId);
    for (const g of refGrounds) {
      // 找到引用该 Ground 的所有 Warrant
      const usingWarrants = findWarrantsUsingGround(db, g.id);
      for (const w of usingWarrants) {
        const wData = JSON.parse(w.data);
        if (wData.claim_id && !allAffected.has(wData.claim_id)) {
          allAffected.add(wData.claim_id);
          queue.push(wData.claim_id); // 继续向上传播
        }
      }
    }
  }

  return [...allAffected];
}

/**
 * 清除受影响 Claim 的 compiled 状态。
 * 返回需要通知 agent 的 Warning 消息。
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
 * 对每个受影响的 Claim：
 * - 已 compiled 且 argument hash 变化 → 自动触发两阶段审查（利用 smart skip）
 * - 已 compiled 且 argument hash 未变 → 跳过
 * - 未 compiled → 标记 stale
 * - 无 reviewConfig → 仅标记 stale，不调 LLM
 */
export async function autoVerifyAfterMutation(
  db: Database,
  config: ReviewConfig | null,
  affectedClaimIds: number[]
): Promise<AutoVerifyResult[]> {
  // 并行处理所有受影响的 Claim
  const promises = affectedClaimIds.map(async (claimId): Promise<AutoVerifyResult> => {
    const claimRow = repo.getNodeById(db, claimId);
    if (!claimRow || claimRow.type !== "claim") {
      return { claimId, action: "skipped", message: "Claim not found" };
    }

    const claimData = JSON.parse(claimRow.data);
    const prevState = repo.getCompileState(db, claimId);

    // 计算当前 argument hash
    const newArgHash = computeArgumentHash(db, claimId);

    // 已 compiled 的 Claim：比较 argument hash
    if (prevState && prevState.verdict === "passed" && prevState.argumentHash) {
      if (prevState.argumentHash === newArgHash) {
        // 哈希未变 — 无需任何操作
        return { claimId, action: "no-change" };
      }
      // 哈希变化 → 需要重新 review
      if (!config) {
        // 无 reviewConfig → 标记 stale
        repo.setClaimStale(db, claimId, true);
        repo.clearCompiledFlag(db, claimId);
        return { claimId, action: "marked-stale", message: "Review not configured" };
      }
      // 自动触发两阶段审查（利用 smart skip 只 review 变化节点）
      const compileResult = await compileArgument(db, config, claimId);
      return { claimId, action: "auto-reviewed", compileResult };
    }

    // 未 compiled 的 Claim → 标记 stale
    if (!claimData.stale) {
      repo.setClaimStale(db, claimId, true);
    }
    return { claimId, action: "marked-stale" };
  });

  return Promise.all(promises);
}
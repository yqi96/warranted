/**
 * Warranted — Compile Service 层
 *
 * compile 包含多项检查，不同时机触发：
 * - 节点定义检查：节点 content 变化时触发（reviewNodeDefinition），同步阻断
 * - 逻辑链检查：agent 显式调用 compile_arguments 时触发（首次或哈希变化时运行 LLM 审查）
 *
 * 失效管理：节点修改时将受影响 Claim 的 compile_status 设为 stale
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
import { runChainReview, loadArgumentContext } from "./compile-reviewers.ts";
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
  if (!config.reviewDir) return;
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
  if (!config.reviewDir) return;
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
 * content 变化时触发（create 和 update 均阻断：errors 非空 → 操作拒绝）。
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

  // 保存审查结果到 reviews/ 目录（--no-persist 时 reviewDir 为 null，跳过）
  if (config.reviewDir) {
    saveNodeReviewFile(config, elementType, content, result, reviewedAt);
  }

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
// 结构质量检查（确定性，无 LLM）
// =============================================================================

const HIGH_REBUTTAL_THRESHOLD = 4; // tunable: adjust based on observed distribution

/**
 * 对 Claim 的 argument 执行确定性结构质量检查（18条规则）。
 * Category A: 引用完整性 (ERROR)
 * Category B: 个体质量 (WARNING, B6去重)
 * Category C: 聚合质量 (WARNING/ERROR/INFO, C3包含C1+C2, C4状态感知)
 * Category D: 跨节点一致性 (INFO/WARNING, 1-hop chain)
 */
export function structuralQualityCheck(db: Database, claimId: number): ElementReviewResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];

  const ctx = loadArgumentContext(db, claimId);
  if (!ctx) return { reviewer: "structure", errors, warnings, infos };

  const claimData = ctx.claimData as { status?: string; [k: string]: unknown };

  // Build a set of ground IDs used in warrants (for C6 check)
  const usedGroundIds = new Set<number>();
  for (const wd of ctx.warrantDatas) {
    for (const gid of (wd.ground_ids || []) as number[]) {
      usedGroundIds.add(gid);
    }
  }

  // --- Category A: Referential Integrity (ref_claim_id) ---
  for (const gr of ctx.groundRows) {
    const gData = JSON.parse(gr.data) as { ref_claim_id?: number | null; [k: string]: unknown };
    const refId = gData.ref_claim_id;
    if (refId != null) {
      const refRow = repo.getNodeById(db, refId);
      if (!refRow) {
        errors.push(`Ground #${gr.id}: ref_claim_id=${refId} points to non-existent node`);
      } else if (refRow.type !== "claim") {
        errors.push(`Ground #${gr.id}: ref_claim_id=${refId} points to a ${refRow.type}, not a Claim`);
      }
    }
  }

  // --- Category B: Individual Quality (per ground and warrant) ---
  // B6 dedup: when ground is BOTH hypothesis AND pending → emit B6 only, not B1+B2
  for (const gr of ctx.groundRows) {
    const gData = JSON.parse(gr.data) as {
      source?: string;
      verification?: string;
      ref_claim_id?: number | null;
      [k: string]: unknown;
    };
    const isPending = gData.verification === "pending";
    const isHypothesis = gData.source === "hypothesis";
    const hasRefClaim = gData.ref_claim_id != null;

    if (isHypothesis && isPending && !hasRefClaim) {
      // B6: compound weakness (replaces B1+B2 to reduce noise)
      warnings.push(`Ground #${gr.id} is both hypothesis and unverified (compound weakness: future unverified result)`);
    } else {
      if (isPending) {
        // B1
        warnings.push(`Ground #${gr.id} has verification=pending`);
      }
      if (isHypothesis && !hasRefClaim) {
        // B2
        warnings.push(`Ground #${gr.id} has source=hypothesis without chain reasoning (ref_claim_id is null)`);
      }
    }
  }

  // B3, B4, B5 — also accumulate warrant rebuttal counts for C5
  const warrantRebuttalCounts = new Map<number, number>();
  for (const w of ctx.warrantRows) {
    const backings = repo.findBackingsByWarrant(db, w.id);
    if (backings.length === 0) {
      warnings.push(`Warrant #${w.id} has no Backing nodes`);
    }
    const warrantRebuttals = repo.findRebuttalsByTarget(db, w.id, "warrant");
    warrantRebuttalCounts.set(w.id, warrantRebuttals.length);
    if (warrantRebuttals.length > 0) {
      warnings.push(`Warrant #${w.id} has ${warrantRebuttals.length} active rebuttal(s)`);
    }
  }

  const claimRebuttals = repo.findRebuttalsByTarget(db, claimId, "claim");
  if (claimRebuttals.length > 0) {
    // B4
    warnings.push(`Claim #${claimId} has ${claimRebuttals.length} active rebuttal(s)`);
  }

  // --- Category C: Aggregate Quality ---

  // Helper: check if all grounds in a warrant are verified
  function allGroundsVerified(warrantIdx: number): boolean {
    const wd = ctx!.warrantDatas[warrantIdx];
    const gIds = (wd.ground_ids || []) as number[];
    if (gIds.length === 0) return false;
    return gIds.every(gid => {
      const gr = ctx!.groundRows.find(g => g.id === gid);
      if (!gr) return false;
      const gData = JSON.parse(gr.data) as { verification?: string };
      return gData.verification === "verified";
    });
  }

  let totalRebuttals = claimRebuttals.length;

  for (let i = 0; i < ctx.warrantRows.length; i++) {
    const w = ctx.warrantRows[i];
    const wd = ctx.warrantDatas[i];
    const gIds = (wd.ground_ids || []) as number[];

    totalRebuttals += warrantRebuttalCounts.get(w.id) ?? 0;

    if (gIds.length === 0) continue;

    const groundsForWarrant = gIds.map(gid => {
      const gr = ctx.groundRows.find(g => g.id === gid);
      if (!gr) return null;
      return JSON.parse(gr.data) as { source?: string; verification?: string; ref_claim_id?: number | null };
    }).filter(Boolean) as Array<{ source?: string; verification?: string; ref_claim_id?: number | null }>;

    const allPending = groundsForWarrant.every(g => g.verification === "pending");
    const allHypothesisNoRef = groundsForWarrant.every(g => g.source === "hypothesis" && g.ref_claim_id == null);
    const allHypothesisPendingNoRef = groundsForWarrant.every(
      g => g.source === "hypothesis" && g.verification === "pending" && g.ref_claim_id == null
    );

    if (allHypothesisPendingNoRef) {
      // C3: subsumes C1 and C2
      warnings.push(`Warrant #${w.id} is fully speculative: all grounds are hypothesis + pending (no verified evidence)`);
    } else {
      if (allPending) {
        // C1
        warnings.push(`Warrant #${w.id}: all grounds have verification=pending`);
      }
      if (allHypothesisNoRef) {
        // C2
        warnings.push(`Warrant #${w.id}: all grounds are hypothesis without chain reasoning`);
      }
    }
  }

  // C4: claim_no_verified_warrant (status-aware)
  const hasVerifiedWarrant = ctx.warrantRows.some((_, i) => allGroundsVerified(i));
  if (!hasVerifiedWarrant) {
    const claimStatus = claimData.status as string | undefined;
    if (claimStatus === "supported") {
      errors.push(
        `Claim #${claimId} is marked "${claimStatus}" but no warrant has all grounds verified — ` +
        `status contradicts evidence (grounds may have been reverted to pending after status was set)`
      );
    } else {
      warnings.push(`Claim #${claimId} has no warrant where all grounds are verified`);
    }
  }

  // C5: high rebuttal load
  if (totalRebuttals >= HIGH_REBUTTAL_THRESHOLD) {
    infos.push(`Claim #${claimId} has ${totalRebuttals} total rebuttal(s) across claim and warrants (threshold: ${HIGH_REBUTTAL_THRESHOLD})`);
  }

  // C6: associated orphan grounds (ref_claim_id=claimId but not in any warrant)
  const associatedGrounds = repo.findGroundsByRefClaim(db, claimId);
  for (const ag of associatedGrounds) {
    if (!usedGroundIds.has(ag.id)) {
      warnings.push(`Ground #${ag.id} references Claim #${claimId} (ref_claim_id) but is not attached to any warrant for this claim`);
    }
  }

  // --- Category D: Cross-Node Consistency (1-hop chain reasoning only) ---
  for (const gr of ctx.groundRows) {
    const gData = JSON.parse(gr.data) as { ref_claim_id?: number | null };
    const refId = gData.ref_claim_id;
    if (refId == null) continue;

    const refRow = repo.getNodeById(db, refId);
    if (!refRow || refRow.type !== "claim") continue; // A1/A2 already catches this

    const refData = JSON.parse(refRow.data) as {
      compile_status?: "passed" | "stale" | null;
      status?: string;
    };
    const refState = repo.getCompileState(db, refId);

    if (refData.compile_status === "stale") {
      // D1
      infos.push(`Ground #${gr.id} references Claim #${refId} which is stale`);
    }
    if (refData.status === "disputed") {
      // D2
      infos.push(`Ground #${gr.id} references Claim #${refId} with status=disputed`);
    }
    if (refData.status === "refuted") {
      // D3
      warnings.push(`Ground #${gr.id} references Claim #${refId} with status=refuted — evidence foundation has been invalidated`);
    }
    if (!refState && refData.compile_status !== "passed") {
      // D4
      infos.push(`Ground #${gr.id} references Claim #${refId} which has never been compiled`);
    }
  }

  return { reviewer: "structure", errors, warnings, infos };
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

  // Compute hash first so it's available at all early-abort sites
  const argHash = computeArgumentHash(db, claimId);

  // 1. 结构预检
  const structuralErrors = structuralPreCheck(db, claimId);
  if (structuralErrors.length > 0) {
    log("review_dispatch", "ERR", 0, `claim=#${claimId} → structural pre-check failed: ${structuralErrors.join("; ")}`);
    const preCheckResult: ElementReviewResult = {
      reviewer: "structure",
      errors: structuralErrors,
      warnings: [],
      infos: [],
    };
    repo.saveCompileState(db, claimId, "failed", `Structural pre-check failed: ${structuralErrors.join("; ")}`);
    return {
      claimId,
      verdict: "failed" as CompileVerdict,
      summary: `Structural pre-check failed: ${structuralErrors.join("; ")}`,
      elementReviews: [preCheckResult],
      compiledAt,
    };
  }

  // 1.5 结构质量检查（确定性，无 LLM）
  const qualityResult = structuralQualityCheck(db, claimId);
  if (qualityResult.errors.length > 0) {
    log("review_dispatch", "ERR", 0, `claim=#${claimId} → structural quality check failed`);
    const errSummary = `Structural quality check failed: ${qualityResult.errors.join("; ")}`;
    repo.saveCompileState(db, claimId, "failed", errSummary);
    return {
      claimId,
      verdict: "failed" as CompileVerdict,
      summary: errSummary,
      elementReviews: [qualityResult],
      compiledAt,
    };
  }

  // 2. 运行逻辑链审查
  const { elementReviews: chainReviews } = await runChainReview(config, db, claimId);

  // qualityResult is always elementReviews[0]
  const allReviews: ElementReviewResult[] = [qualityResult, ...chainReviews];

  // 3. 汇总结果（infos never contribute to verdict）
  const hasError = allReviews.some(r => r.errors.length > 0);
  const verdict: CompileVerdict = hasError ? "failed" : "passed";

  const totalErrors = allReviews.reduce((sum, r) => sum + r.errors.length, 0);
  const totalWarnings = allReviews.reduce((sum, r) => sum + r.warnings.length, 0);
  const summaryParts: string[] = [];
  if (hasError) {
    summaryParts.push(`Compile failed with ${totalErrors} error(s).`);
  } else if (totalWarnings > 0) {
    summaryParts.push(`Compile passed with ${totalWarnings} warning(s) noted.`);
  } else {
    summaryParts.push("Compile passed. Argument is logically sound.");
  }
  const summary = summaryParts.join(" ");

  // 4. 存储 compile_state（argument_hash 仅在 passed 时保存，确保 hash 代表"已验证通过的结构"）
  repo.saveCompileState(db, claimId, verdict, summary, verdict === "passed" ? argHash : undefined);

  // 5. 更新 compile_status 标志
  repo.setCompileStatus(db, claimId, verdict === "passed" ? "passed" : "stale");

  const elapsed = Date.now() - t0;
  log("review_dispatch", "OK", elapsed, `END claim=#${claimId} → verdict=${verdict}, "${summary.slice(0, 80)}"`);

  // 6. 保存审查结果到 reviews/ 目录（--no-persist 时 reviewDir 为 null，跳过）
  if (config.reviewDir) {
    for (const review of allReviews) {
      try {
        saveChainReviewFile(config, claimId, review, compiledAt);
      } catch {
        // 保存失败不影响主流程
      }
    }
  }

  return {
    claimId,
    verdict,
    summary,
    elementReviews: allReviews,
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
    if (data.compile_status === "passed") {
      warnings.push(WARNINGS.compileInvalidated(claimId, nodeId));
    }
    // Always clear compile_state on structural change — even after a failed compile,
    // the cached argumentHash is now stale and must not block future hash comparisons.
    repo.deleteCompileState(db, claimId);
    repo.setCompileStatus(db, claimId, "stale");
  }

  return warnings;
}

// =============================================================================
// Compile 调度
// =============================================================================

/**
 * Compile 调度器。由 compile_arguments 工具显式调用，不是 mutation 自动触发。
 * 名称 autoVerifyAfterMutation 是历史遗留，实际语义是"按需决定是否重新 compile"。
 *
 * - 有 compile_state + argumentHash 未变 → no-change（argumentHash 只在 passed 时保存）
 * - 有 compile_state + argumentHash 变了 → 触发逻辑链审查
 * - 无 compile_state + 结构完整 → 触发首次逻辑链审查
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
    // argumentHash 只在 compile passed 时保存，所以此处 prevState.argumentHash 非空
    // 意味着上次 compile 通过。hash 未变 → 无需重新审查。
    if (prevState && prevState.argumentHash) {
      if (prevState.argumentHash === newArgHash) {
        log("auto_review", "OK", Date.now() - t0, `claim=#${claimId}: hash unchanged → no-change`);
        return { claimId, action: "no-change" };
      }
      // 哈希变化 → 需要重新审查
      if (!config) {
        log("auto_review", "OK", Date.now() - t0, `claim=#${claimId}: hash changed, no config → marked-stale`);
        repo.setCompileStatus(db, claimId, "stale");
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
      repo.setCompileStatus(db, claimId, "stale");
      return { claimId, action: "marked-stale", message: "Review not configured" };
    }

    // 结构不完整 → 标记 stale
    log("auto_review", "OK", Date.now() - t0, `claim=#${claimId}: structure incomplete → marked-stale`);
    const claimData = JSON.parse(claimRow.data);
    if (claimData.compile_status !== "stale") {
      repo.setCompileStatus(db, claimId, "stale");
    }
    return { claimId, action: "marked-stale" };
  });

  const results = await Promise.all(promises);
  const summary = results.map(r => `claim=#${r.claimId}:${r.action}`).join(", ");
  log("auto_review", "OK", 0, `completed: ${summary}`);
  return results;
}

/**
 * Warranted — Compile Service 层
 *
 * compile 包含多项检查，均在 compile_arguments 被调用时触发：
 * - 节点定义检查（reviewNodeDefinition / runDefinitionReviews）：对 Claim + 每个 Warrant 的 content 审查
 * - 逻辑链检查（runChainReview）：对整个 argument 图的逻辑链条审查
 * 两者在 compileArgument 中并行执行（Promise.all）。当两者的 errors 重叠时，
 * 逻辑链结果会被降级为 advisory（见 compileArgument 中的降级逻辑）。
 *
 * 失效管理：节点修改时把受影响 Claim 的 compile_state 从 passed 降级为 stale
 */

import type { Database } from "bun:sqlite";
import type { ReviewConfig } from "./review-config.ts";
import type {
  CompileResult,
  CompileStateVerdict,
  CompileVerdict,
  ElementReviewResult,
  AutoVerifyResult,
  NodeRow,
} from "./types.ts";
import * as repo from "./repo.ts";
import { runChainReview, loadArgumentContext } from "./compile-reviewers.ts";
import { computeArgumentHash } from "./merkle-hash.ts";
import { findWarrantsUsingGround, isClaimOrStatementVerified, describeUnverifiedGround, hasVerifiedRebuttal, hasWarrantWithAllGroundsVerified } from "./service.ts";
import { WARNINGS } from "./content/index.ts";
import { log } from "./logger.ts";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { reviewCwd } from "./review-config.ts";
import { callAndParse } from "./review-llm.ts";
import {
  buildClaimReviewPrompt,
  buildWarrantReviewPrompt,
} from "./compile-prompts.ts";
import { mapLimit } from "./concurrency.ts";

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
  elementType: "claim" | "warrant",
  nodeId: number,
  claimId: number,
  content: string,
  result: { errors: string[]; warnings: string[] },
  reviewedAt: string
): void {
  if (!config.reviewDir) return;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `compile_${elementType}${nodeId}_definition_${timestamp}.json`;
  const filepath = join(config.reviewDir, filename);

  mkdirSync(config.reviewDir, { recursive: true });
  writeFileSync(filepath, JSON.stringify({
    type: "definition",
    elementType,
    claimId,
    nodeId,
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
 * 由 runDefinitionReviews 在 compile 时对 Claim + 每个 Warrant 调用。
 * 审查结果保存到 reviews/ 目录。
 */
export async function reviewNodeDefinition(
  config: ReviewConfig,
  elementType: "claim" | "warrant",
  content: string,
  qualifier?: string | null,
  options?: { nodeId?: number; claimId?: number }
): Promise<{ errors: string[]; warnings: string[] }> {
  const cwd = reviewCwd(config);
  const reviewedAt = new Date().toISOString().slice(0, 19);
  const nodeId = options?.nodeId ?? 0;
  const claimId = options?.claimId ?? 0;
  let prompt: string;

  if (elementType === "claim") {
    prompt = buildClaimReviewPrompt({
      id: nodeId,
      content,
      qualifier: qualifier ?? null,
    });
  } else {
    prompt = buildWarrantReviewPrompt({ id: nodeId, content });
  }

  let result: { errors: string[]; warnings: string[] };

  try {
    result = await callAndParse(config, prompt, [], cwd);
  } catch (error) {
    result = { errors: [`Reviewer error: ${error}`], warnings: [] };
  }

  // 保存审查结果到 reviews/ 目录（--no-persist 时 reviewDir 为 null，跳过）
  if (config.reviewDir) {
    saveNodeReviewFile(config, elementType, nodeId, claimId, content, result, reviewedAt);
  }

  return result;
}

/**
 * 对 Claim 及其所有 Warrant 并行执行节点定义审查。
 * 由 compileArgument 与 runChainReview 并行调用（Promise.all）。
 */
export async function runDefinitionReviews(
  config: ReviewConfig,
  db: Database,
  claimId: number
): Promise<ElementReviewResult[]> {
  const ctx = loadArgumentContext(db, claimId);
  if (!ctx) return [];

  const claimQualifier = ctx.claimData.qualifier as string | null | undefined;

  const tasks: Array<Promise<ElementReviewResult>> = [
    reviewNodeDefinition(config, "claim", ctx.claimRow.content, claimQualifier, { nodeId: ctx.claimRow.id, claimId })
      .then(result => ({ reviewer: "claim" as const, nodeId: ctx.claimRow.id, ...result })),
    ...ctx.warrantRows.map(w =>
      reviewNodeDefinition(config, "warrant", w.content, undefined, { nodeId: w.id, claimId })
        .then(result => ({ reviewer: "warrant" as const, nodeId: w.id, ...result }))
    ),
  ];

  return Promise.all(tasks);
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
      } else if (gRow.type !== "statement" && gRow.type !== "claim") {
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
 * 对 Claim 的 argument 执行确定性结构质量检查（7条规则）。
 * Category B: 个体质量 (WARNING)
 * Category C: 聚合质量 (WARNING/ERROR/INFO, C4状态感知)
 */
export function structuralQualityCheck(db: Database, claimId: number): ElementReviewResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];

  const ctx = loadArgumentContext(db, claimId);
  if (!ctx) return { reviewer: "structure", errors, warnings, infos };

  const claimData = ctx.claimData as { status?: string; [k: string]: unknown };

  // --- Category B: Individual Quality (per ground and warrant) ---
  for (const gr of ctx.groundRows) {
    if (gr.type === "claim") {
      // Companion 5 + §5: claim-type Grounds get status-branched warning
      const gData = JSON.parse(gr.data) as { status?: string; [k: string]: unknown };
      const gStatus = gData.status || "proposed";
      if (gStatus === "proposed") {
        warnings.push(`Ground Claim #${gr.id} has no verdict yet — settle it before this Claim can be`);
      } else if (gStatus === "refuted") {
        warnings.push(`Ground Claim #${gr.id} is refuted and cannot support this Claim — reground on what survives it`);
      } else if (gStatus === "disputed") {
        warnings.push(`Ground Claim #${gr.id} is disputed — this Warrant must state what it draws from a contested conclusion`);
      }
      continue;
    }
    const gData = JSON.parse(gr.data) as {
      source?: string;
      verification?: string;
      [k: string]: unknown;
    };
    if (gData.verification === "pending") {
      // B1
      warnings.push(`Ground #${gr.id} has verification=pending`);
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
      return isClaimOrStatementVerified(gr);
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
      if (gr.type === "claim") return null; // skip claim-type grounds for aggregate checks
      return JSON.parse(gr.data) as { source?: string; verification?: string };
    }).filter(Boolean) as Array<{ source?: string; verification?: string }>;

    const allPending = groundsForWarrant.length > 0 && groundsForWarrant.every(g => g.verification === "pending");
    if (allPending) {
      // C1
      warnings.push(`Warrant #${w.id}: all grounds have verification=pending`);
    }
  }

  // C4: claim_no_verified_warrant (status-aware)
  const hasVerifiedWarrant = ctx.warrantRows.some((_, i) => allGroundsVerified(i));
  if (!hasVerifiedWarrant) {
    const blockers = ctx.warrantRows.map((w, i) => {
      const gIds = (ctx!.warrantDatas[i].ground_ids || []) as number[];
      const unverified = gIds
        .map(gid => ctx!.groundRows.find(g => g.id === gid))
        .filter((g): g is NodeRow => !!g && !isClaimOrStatementVerified(g));
      return unverified.length > 0
        ? `Warrant #${w.id}: ${unverified.map(describeUnverifiedGround).join(", ")}`
        : null;
    }).filter(Boolean).join("; ");

    const claimStatus = claimData.status as string | undefined;
    if (claimStatus === "supported") {
      errors.push(
        `Claim #${claimId} is marked "${claimStatus}" but no warrant has all grounds verified — ${blockers}` +
        ` (grounds may have been reverted to pending after status was set)`
      );
    } else {
      warnings.push(`Claim #${claimId} has no warrant where all grounds are verified — ${blockers}`);
    }
  }

  // C5: high rebuttal load
  if (totalRebuttals >= HIGH_REBUTTAL_THRESHOLD) {
    infos.push(`Claim #${claimId} has ${totalRebuttals} total rebuttal(s) across claim and warrants (threshold: ${HIGH_REBUTTAL_THRESHOLD})`);
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

  // 2. 并行运行节点定义审查 + 逻辑链审查
  const [definitionReviews, { elementReviews: chainReviews }] = await Promise.all([
    runDefinitionReviews(config, db, claimId),
    runChainReview(config, db, claimId),
  ]);

  // 2.5 降级逻辑：定义审查与逻辑链审查的 error 有重叠风险时，链审查结果降级为 advisory
  // （不影响 hasError/verdict，只影响渲染 —— 避免同一问题被报告两次造成困惑）
  const hasDefinitionError = definitionReviews.some(r => r.errors.length > 0);
  if (hasDefinitionError) {
    for (const chainResult of chainReviews) {
      if (chainResult.errors.length > 0) {
        chainResult.advisory = true;
      }
    }
  }

  // qualityResult is always elementReviews[0]
  const allReviews: ElementReviewResult[] = [qualityResult, ...definitionReviews, ...chainReviews];

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

  // 4. 存储 compile_state —— 编译状态的唯一存储。
  //    verdict 直接落盘（passed / failed），不再翻译成第二套词汇。structuralPreCheck /
  //    structuralQualityCheck 的 early return 也各自走 saveCompileState，因此"编译失败"
  //    不存在漏记的路径可言。
  //    argument_hash 仅在 passed 时保存，确保 hash 代表"已验证通过的结构"。
  repo.saveCompileState(db, claimId, verdict, summary, verdict === "passed" ? argHash : undefined);

  const elapsed = Date.now() - t0;
  log("review_dispatch", "OK", elapsed, `END claim=#${claimId} → verdict=${verdict}, "${summary.slice(0, 80)}"`);

  // 6. 保存审查结果到 reviews/ 目录（--no-persist 时 reviewDir 为 null，跳过）
  // claim/warrant 条目已在 reviewNodeDefinition 内部保存为 compile_{elementType}{nodeId}_definition_ 文件，
  // 此处只需为 chain/structure 条目写入 compile_claim{id}_chain_ 文件，避免重复写入且命名错误。
  if (config.reviewDir) {
    for (const review of allReviews) {
      if (review.reviewer === "claim" || review.reviewer === "warrant") continue;
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
      // Also find warrants that use this claim as a ground (chain reasoning)
      {
        const groundWarrantsForClaim = db.prepare("SELECT n.* FROM nodes n JOIN warrant_grounds wg ON n.id = wg.warrant_id WHERE wg.ground_id = ?").all(nodeId) as NodeRow[];
        for (const w of groundWarrantsForClaim) { const d = JSON.parse(w.data); if (d.claim_id) claimIds.add(d.claim_id); }
      }
      break;

    case "warrant":
      if (data.claim_id) claimIds.add(data.claim_id);
      break;

    case "statement": {
      // As ground for warrants
      const groundWarrants = db.prepare("SELECT n.* FROM nodes n JOIN warrant_grounds wg ON n.id = wg.warrant_id WHERE wg.ground_id = ?").all(nodeId) as NodeRow[];
      for (const w of groundWarrants) { const d = JSON.parse(w.data); if (d.claim_id) claimIds.add(d.claim_id); }
      // As backing for warrants
      const backingWarrants = db.prepare("SELECT n.* FROM nodes n JOIN warrant_backings wb ON n.id = wb.warrant_id WHERE wb.statement_id = ?").all(nodeId) as NodeRow[];
      for (const w of backingWarrants) { const d = JSON.parse(w.data); if (d.claim_id) claimIds.add(d.claim_id); }
      // As rebuttal
      const targets = db.prepare("SELECT * FROM rebuttal_targets WHERE statement_id = ?").all(nodeId) as Array<{target_id:number, target_type:string}>;
      for (const t of targets) {
        if (t.target_type === "claim") claimIds.add(t.target_id);
        else { const w = repo.getNodeById(db, t.target_id); if (w) { const d=JSON.parse(w.data); if(d.claim_id) claimIds.add(d.claim_id); } }
      }
      break;
    }
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
    // Find warrants that use this claim directly as a ground (claim nodes in warrant_grounds)
    const usingWarrants = db.prepare(
      "SELECT n.* FROM nodes n JOIN warrant_grounds wg ON n.id = wg.warrant_id WHERE wg.ground_id = ?"
    ).all(claimId) as NodeRow[];
    for (const w of usingWarrants) {
      const wData = JSON.parse(w.data);
      if (wData.claim_id && !allAffected.has(wData.claim_id)) {
        allAffected.add(wData.claim_id);
        queue.push(wData.claim_id);
      }
    }
  }

  return [...allAffected];
}

/**
 * 清除受影响 Claim 的 compiled 状态。
 *
 * 曾经有一个 skipNodeIds 参数，唯一的用途是让"下层 status 变更"那条路不要把起点自身
 * 失效掉。D28 把 status 变更整条路挪到了 revertUnsupportedClaimStatuses，参数随之没有
 * 调用者。走到这里的都是真的结构变动，起点自身该失效就是该失效，没有例外要开。
 */
export function invalidateCompiledClaims(db: Database, nodeId: number): string[] {
  const affectedIds = findAffectedClaimIds(db, nodeId);
  const warnings: string[] = [];

  for (const claimId of affectedIds) {
    const row = repo.getNodeById(db, claimId);
    if (!row || row.type !== "claim") continue;
    const data = JSON.parse(row.data);
    if (repo.getCompileState(db, claimId)?.verdict === "passed") {
      warnings.push(WARNINGS.compileInvalidated(claimId, nodeId));
    }

    // Revert non-proposed status — a stale compile invalidates the basis for the verdict
    const currentStatus = data.status || "proposed";
    if (currentStatus === "supported" || currentStatus === "disputed" || currentStatus === "refuted") {
      repo.setClaimStatus(db, claimId, "proposed");
      warnings.push(WARNINGS.statusReverted(claimId, currentStatus, nodeId));
    }

    // 结构变动 → passed 降级为 stale，同时清空缓存的 argumentHash，使其不再挡住后续哈希比对。
    // 不再删整行：删掉会让这个主张被 get_stats 误算成"从未编译过"。failed 保持 failed
    // ——它的 argumentHash 本就为空，不存在挡住比对的问题，而且比 stale 信息量更大。
    repo.markCompileStale(db, claimId);
  }

  return warnings;
}

/**
 * 一次「论证的形式没变、但 status 的结构依据可能垮了」的改动之后，回退受影响 Claim 的
 * status —— **不动 compile 记录**。
 *
 * 两个触发点：撤回一个 Statement 的核实状态（D27）；一条 Claim 的 status 实际改变（D28，
 * 按规则 C′，它作为上层 Ground 算不算已核实，取决于它自身的 status）。
 *
 * 为什么和 invalidateCompiledClaims 分成两条路：
 *
 * compile 审的是论证的形式（这些 Ground 经过这条 Warrant 能否推到这条 Claim），
 * status 承载的是主 agent 对"证据够不够"的判断。撤回一条 Statement 的核实状态、
 * 或者把一条下层 Claim 从 supported 改成 proposed，上层论证的形式一个字没变
 * ——同一批节点、同一批指向关系全在——所以 compile 的 passed 依然是它当初审过的
 * 那件事的真实结论。把它标成 stale 会是一句假话（论证没变过），还会让下一次 compile
 * 白跑一趟去审同一条论证。
 * 垮掉的只是 status 的结构依据（A1 要求某条 Warrant 的 Ground 全部已核实；
 * A3/A4 要求存在已核实的 Rebuttal），所以只有 status 退回 proposed。
 *
 * 下层 status 只影响 compile 的 warnings，不影响 verdict，这一点是可查的：
 * structuralQualityCheck 对 claim 型 Ground 的 proposed/refuted/disputed 三个分支
 * 全部 warnings.push（本文件 §Category B），没有一个进 errors。所以下层改判确实不可能
 * 翻转上层的 verdict，"需要重新审逻辑"这句话没有依据。
 *
 * 保留 verdict=passed 还有个具体好处：A0 要求非 proposed 的 status 必须有 passed 的
 * compile 记录。记录留着，那个 Statement 重新核实、或者那条下层 Claim 重新定案之后，
 * agent 可以直接把 status 标回去，不必为一条没变过的论证再跑一次 compile。
 * 对照 invalidateCompiledClaims：结构变动同时废掉形式审查和充分性判断，两个都重置；
 * 这条路只废掉充分性判断，所以只重置那一个。
 *
 * 复检而不是无条件回退：一条 Claim 可能有多条 Warrant，A1 只要求其中一条的 Ground
 * 全部已核实，所以撤回其中一条 Ground 未必动摇它；被撤回的 Statement 也可能是
 * Backing（今天没有任何门禁读 Backing 的核实状态）。无条件回退会抹掉 agent 一个
 * 依然站得住的判断。因此对每条受影响的 Claim，按它**当前**的 status 复检对应的那道门，
 * 只有确实不成立才回退。
 *
 * 向上传播同理：一条 Claim 退回 proposed 后，按规则 C′ 它作为上层 Claim 的 Ground
 * 也不再算已核实，上层失去的同样是充分性依据而非逻辑；但只有真的退了的 Claim 才继续
 * 往上传，没退的不传。
 *
 * `skipNodeIds` 用来排除起点自身：status 变更那条路的起点就是刚被 agent 定了状态的
 * Claim，不该在同一次调用里把它自己的判断复检掉。排除它不影响向上传播——它的上层是
 * 由 findAffectedClaimIdsDirect 直接播种进队列的，不经过它。
 *
 * 警告文案报的是**就近**的原因而不是最初的那个：对祖父层来说，"下层 Claim 不再算已核实的
 * 证据"是真的，"某个 Statement 的核实被撤回了"隔了一层，落到具体某个 Warrant 上就成了
 * 一句对不上的话。所以队列里带着每一跳的起因节点。
 */
export function revertUnsupportedClaimStatuses(
  db: Database,
  nodeId: number,
  skipNodeIds?: Set<number>
): string[] {
  const warnings: string[] = [];
  const queue: Array<{ claimId: number; causeId: number }> =
    findAffectedClaimIdsDirect(db, nodeId).map(claimId => ({ claimId, causeId: nodeId }));
  const visited = new Set<number>(queue.map(q => q.claimId));

  while (queue.length > 0) {
    const { claimId, causeId } = queue.shift()!;
    if (skipNodeIds?.has(claimId)) continue;
    const row = repo.getNodeById(db, claimId);
    if (!row || row.type !== "claim") continue;
    const currentStatus = (JSON.parse(row.data).status || "proposed") as string;
    if (currentStatus === "proposed") continue;

    const gateStillHolds =
      currentStatus === "supported"
        ? hasWarrantWithAllGroundsVerified(db, claimId).satisfied
        : hasVerifiedRebuttal(db, claimId);
    if (gateStillHolds) continue;

    repo.setClaimStatus(db, claimId, "proposed");
    const causeIsClaim = repo.getNodeById(db, causeId)?.type === "claim";
    warnings.push(
      causeIsClaim
        ? WARNINGS.statusRevertedGroundClaimUnsettled(claimId, currentStatus, causeId)
        : WARNINGS.statusRevertedVerificationWithdrawn(claimId, currentStatus, causeId)
    );

    // 只有真的退了才往上传：上层是通过"这条 Claim 算不算已核实的 Ground"受影响的。
    const usingWarrants = db.prepare(
      "SELECT n.* FROM nodes n JOIN warrant_grounds wg ON n.id = wg.warrant_id WHERE wg.ground_id = ?"
    ).all(claimId) as NodeRow[];
    for (const w of usingWarrants) {
      const parentId = JSON.parse(w.data).claim_id;
      if (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        queue.push({ claimId: parentId, causeId: claimId });
      }
    }
  }

  return warnings;
}

// =============================================================================
// Compile 调度
// =============================================================================

/**
 * 只跑不需要模型的那些检查。返回 null 表示都通过了。
 *
 * 三条路共用它，是为了让"哪条检查失败对应哪个 action"只有一处定义：
 * 结构预检失败 = 结构缺东西，质量检查失败 = 结构齐全但检查没过。
 * 曾经这两种结局共用一个 marked-stale，渲染层只能猜，于是统一印成
 * "incomplete structure"，对后者是假话（D25）。
 */
function nonModelCheck(
  db: Database,
  claimId: number
): { action: "structure-incomplete" | "check-failed"; message: string } | null {
  const structuralErrors = structuralPreCheck(db, claimId);
  if (structuralErrors.length > 0) {
    return { action: "structure-incomplete", message: structuralErrors.join("; ") };
  }
  const qualityResult = structuralQualityCheck(db, claimId);
  if (qualityResult.errors.length > 0) {
    return {
      action: "check-failed",
      message: `Structural quality check failed: ${qualityResult.errors.join("; ")}`,
    };
  }
  return null;
}

/** compile_state 里给"未经模型审查直接通过"记录的摘要。 */
const UNREVIEWED_PASS_SUMMARY =
  "Passed without logic review: no review model configured, only the deterministic structural checks ran.";

/**
 * 没有配审查模型时的结局：不需要模型的检查照跑照挡，全过就记为通过。
 *
 * 这是一个有意的取舍。A0 只看"有没有一条通过的 compile 记录"，不看那条记录是模型审
 * 出来的还是这里默认给的，所以没配模型的用户能照常把主张推进到 supported，代价是逻辑
 * 本身（证据经这条推理到底支不支撑主张）没人看过。挡得住的只有结构。
 *
 * 一个例外：已经存着 failed 的不覆盖。failed 是模型真审过、真否掉了，是实打实的结论；
 * 默认通过是"没人审过"时的兜底。拿兜底盖掉一个真结论等于把信息抹了。
 */
function passWithoutReviewModel(
  db: Database,
  claimId: number,
  prevVerdict: CompileStateVerdict | null,
  argHash: string,
  t0: number
): AutoVerifyResult {
  const failure = nonModelCheck(db, claimId);
  if (failure) {
    const staled = repo.markCompileStale(db, claimId);
    log("auto_review", "OK", Date.now() - t0, `claim=#${claimId}: no config, ${failure.action}`);
    return { claimId, action: failure.action, message: failure.message, staled };
  }
  if (prevVerdict === "failed") {
    log("auto_review", "OK", Date.now() - t0, `claim=#${claimId}: no config, stored failed verdict kept`);
    return {
      claimId,
      action: "check-failed",
      message:
        "a previous compile rejected this argument, and no review model is configured to re-review it",
      staled: false,
    };
  }
  repo.saveCompileState(db, claimId, "passed", UNREVIEWED_PASS_SUMMARY, argHash);
  log("auto_review", "OK", Date.now() - t0, `claim=#${claimId}: no config, structural checks passed → passed-unreviewed`);
  return { claimId, action: "passed-unreviewed" };
}

/**
 * Compile 调度器。由 compile_arguments 工具显式调用，不是 mutation 自动触发。
 * 按需决定是否重新 compile：
 *
 * - 有 compile_state + argumentHash 未变 → 复查不需模型的检查，全过则 no-change
 * - 有 compile_state + argumentHash 变了 → 触发逻辑链审查
 * - 无 compile_state + 结构完整 → 触发首次逻辑链审查
 * - 无 compile_state + 结构不完整 → structure-incomplete
 * - 无 reviewConfig → 跑完不需模型的检查后默认通过（passWithoutReviewModel）
 *
 * config === null 不再报错也不再一律标 stale。原先 tools.ts 在调用前就先失败返回，
 * 使这条路只有测试能走到；现在它是正式路径：没配模型的用户照常能用，只是逻辑没人审。
 */
export async function compileClaims(
  db: Database,
  config: ReviewConfig | null,
  affectedClaimIds: number[]
): Promise<AutoVerifyResult[]> {
  log("auto_review", "OK", 0, `triggered for ${affectedClaimIds.length} claim(s): [${affectedClaimIds.join(", ")}]`);

  // §4: use mapLimit to cap concurrency
  const results = await mapLimit(affectedClaimIds, undefined, async (claimId): Promise<AutoVerifyResult> => {
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
        // §3: hash 未变不代表结构未变（verification 不入 hash），
        // 运行结构检查确保 Ground 退回 pending 等场景不被短路掩盖
        const failure = nonModelCheck(db, claimId);
        if (failure) {
          const staled = repo.markCompileStale(db, claimId);
          log("auto_review", "OK", Date.now() - t0, `claim=#${claimId}: hash unchanged but ${failure.action}`);
          return { claimId, action: failure.action, message: failure.message, staled };
        }

        log("auto_review", "OK", Date.now() - t0, `claim=#${claimId}: hash unchanged → no-change`);
        return { claimId, action: "no-change" };
      }
      // 哈希变化 → 需要重新审查
      if (!config) return passWithoutReviewModel(db, claimId, prevState.verdict, newArgHash, t0);
      log("auto_review", "OK", 0, `claim=#${claimId}: hash changed → auto-review`);
      const compileResult = await compileArgument(db, config, claimId);
      return { claimId, action: "auto-reviewed", compileResult };
    }

    // Case 2: 从未审查过（或审过但没留下结构指纹）
    if (!config) return passWithoutReviewModel(db, claimId, prevState?.verdict ?? null, newArgHash, t0);

    // 有模型时这里只跑结构预检，不跑质量检查：质量检查失败该由 compileArgument 处理，
    // 它会把 verdict='failed' 落盘，比在这里拦下、compile_state 一片空白信息量更大。
    const structuralErrors = structuralPreCheck(db, claimId);
    if (structuralErrors.length === 0) {
      log("auto_review", "OK", 0, `claim=#${claimId}: structure complete → first review`);
      const compileResult = await compileArgument(db, config, claimId);
      return { claimId, action: "auto-reviewed", compileResult };
    }

    // 结构不完整 → 不花模型调用
    log("auto_review", "OK", Date.now() - t0, `claim=#${claimId}: structure incomplete`);
    const staled = repo.markCompileStale(db, claimId);
    return {
      claimId,
      action: "structure-incomplete",
      message: structuralErrors.join("; "),
      staled,
    };
  });

  const summary = results.map(r => `claim=#${r.claimId}:${r.action}`).join(", ");
  log("auto_review", "OK", 0, `completed: ${summary}`);
  return results;
}

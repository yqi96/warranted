/**
 * Warranted — Compile 审查执行器
 *
 * compile 包含多项检查，均在 agent 显式调用 compile_arguments 时触发：
 * - 节点定义检查：对 Claim + 每个 Warrant 的 content 审查（在 compile-service.reviewNodeDefinition 中实现）
 * - 逻辑链检查：对整个 argument 图的逻辑链条审查（本文件实现）
 * 两者在 compile-service.compileArgument 中并行执行（Promise.all）。
 *
 * 本文件只负责逻辑链审查（reviewChain）。
 */

import type { Database } from "bun:sqlite";
import { reviewCwd } from "./review-config.ts";
import type { ReviewConfig } from "./review-config.ts";
import type { NodeRow, ElementReviewResult } from "./types.ts";
import * as repo from "./repo.ts";
import { callAndParse } from "./review-llm.ts";
import { buildChainReviewPrompt } from "./compile-prompts.ts";
import { log } from "./logger.ts";

// =============================================================================
// 参数收集
// =============================================================================

/** 加载 Claim 的完整 argument 子图 */
export interface ArgumentContext {
  claimRow: NodeRow;
  claimData: Record<string, unknown>;
  warrantRows: NodeRow[];
  warrantDatas: Array<Record<string, unknown>>;
  groundRows: NodeRow[];
  backingRows: NodeRow[];
  rebuttalRows: Array<{ row: NodeRow; targetType: "claim" | "warrant"; targetId: number }>;
}

export function loadArgumentContext(db: Database, claimId: number): ArgumentContext | null {
  const claimRow = repo.getNodeById(db, claimId);
  if (!claimRow || claimRow.type !== "claim") return null;

  const claimData = JSON.parse(claimRow.data);
  const warrantRows = repo.findWarrantsByClaim(db, claimId);
  const warrantDatas = warrantRows.map(w => JSON.parse(w.data));

  // 收集所有 Ground（去重）
  const groundIdSet = new Set<number>();
  for (const wd of warrantDatas) {
    for (const gid of (wd.ground_ids || []) as number[]) {
      groundIdSet.add(gid);
    }
  }

  const groundRows: NodeRow[] = [];
  for (const gid of groundIdSet) {
    const gRow = repo.getNodeById(db, gid);
    if (gRow && (gRow.type === "statement" || gRow.type === "claim")) {
      groundRows.push(gRow);
    }
  }

  // Backings & Rebuttals
  const backingRows: NodeRow[] = [];
  const rebuttalRows: Array<{ row: NodeRow; targetType: "claim" | "warrant"; targetId: number }> = [];
  for (const w of warrantRows) {
    backingRows.push(...repo.findBackingsByWarrant(db, w.id));
    for (const r of repo.findRebuttalsByTarget(db, w.id, "warrant")) {
      rebuttalRows.push({ row: r, targetType: "warrant", targetId: w.id });
    }
  }
  for (const r of repo.findRebuttalsByTarget(db, claimId, "claim")) {
    rebuttalRows.push({ row: r, targetType: "claim", targetId: claimId });
  }

  return {
    claimRow,
    claimData,
    warrantRows,
    warrantDatas,
    groundRows,
    backingRows,
    rebuttalRows,
  };
}

// =============================================================================
// 逻辑链审查
// =============================================================================


async function reviewChain(
  config: ReviewConfig,
  ctx: ArgumentContext,
  cwd: string,
  db: Database
): Promise<ElementReviewResult> {
  const prompt = buildChainReviewPrompt({
    claim: {
      id: ctx.claimRow.id,
      content: ctx.claimRow.content,
      qualifier: ctx.claimData.qualifier as string | null | undefined,
    },
    warrants: ctx.warrantRows.map((w, i) => {
      const wData = ctx.warrantDatas[i];
      const groundIds = (wData.ground_ids || []) as number[];
      return {
        id: w.id,
        content: w.content,
        grounds: groundIds.map(gid => {
          const gIdx = ctx.groundRows.findIndex(g => g.id === gid);
          if (gIdx === -1) return { id: gid, content: "(not found)", type: "statement" as const };
          const gRow = ctx.groundRows[gIdx];
          return {
            id: gid,
            content: gRow.content,
            type: gRow.type === "claim" ? ("claim" as const) : ("statement" as const),
          };
        }),
        backings: repo.findBackingsByWarrant(db, w.id)
          .map(b => ({ id: b.id, content: b.content })),
      };
    }),
    rebuttals: ctx.rebuttalRows.map(rr => ({
      id: rr.row.id,
      content: rr.row.content,
      targetType: rr.targetType,
      targetId: rr.targetId,
    })),
  });

  try {
    const t0 = Date.now();
    log("chain_reviewer", "OK", 0, `START chain_reviewer: claim=#${ctx.claimRow.id}`);
    const { errors, warnings } = await callAndParse(config, prompt, [], cwd);
    const elapsed = Date.now() - t0;
    log("chain_reviewer", "OK", elapsed, `END chain_reviewer: claim=#${ctx.claimRow.id} → ${errors.length} error(s), ${warnings.length} warning(s)`);
    return {
      reviewer: "chain",
      errors,
      warnings,
    };
  } catch (error) {
    log("chain_reviewer", "ERR", 0, `claim=#${ctx.claimRow.id}: ${error}`);
    return {
      reviewer: "chain",
      errors: [`Reviewer error: ${error}`],
      warnings: [],
    };
  }
}

// =============================================================================
// 主入口：逻辑链审查
// =============================================================================

/**
 * 运行逻辑链审查。
 * 由 compileArgument 调用，是 compile_arguments 工具的一部分。
 */
export async function runChainReview(
  config: ReviewConfig,
  db: Database,
  claimId: number
): Promise<{ elementReviews: ElementReviewResult[] }> {
  const ctx = loadArgumentContext(db, claimId);
  if (!ctx) {
    return {
      elementReviews: [{
        reviewer: "chain",
        errors: [`Claim #${claimId} not found.`],
        warnings: [],
      }],
    };
  }

  const cwd = reviewCwd(config);

  log("chain_review", "OK", 0, `claim=#${claimId} → starting chain review`);
  const t1 = Date.now();
  const chainResult = await reviewChain(config, ctx, cwd, db);
  const chainElapsed = Date.now() - t1;

  const chainStatus = chainResult.errors.length > 0 ? "ERROR" : chainResult.warnings.length > 0 ? "WARN" : "PASS";
  log("chain_review", "OK", chainElapsed,
    `claim=#${claimId} → chain: ${chainStatus}, ${chainResult.errors.length} error(s), ${chainResult.warnings.length} warning(s)`
  );

  return { elementReviews: [chainResult] };
}

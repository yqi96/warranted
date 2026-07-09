/**
 * Toulmin MCP — Compile 审查执行器
 *
 * 两阶段串行审查：
 * 阶段一：并行审查各要素定义是否符合（Claim/Warrant/Ground）
 * 阶段二：仅当阶段一全部通过后，审查整体逻辑链
 *
 * 基于 per-node 内容哈希实现智能重编译。
 */

import type { Database } from "bun:sqlite";
import { dirname } from "path";
import type { ReviewConfig } from "./review-config.ts";
import type { NodeRow, ElementReviewResult } from "./types.ts";
import * as repo from "./repo.ts";
import { callAgent, parseLLMResponse } from "./review-llm.ts";
import {
  buildClaimReviewPrompt,
  buildWarrantReviewPrompt,
  buildGroundReviewPrompt,
  buildChainReviewPrompt,
} from "./compile-prompts.ts";
import { computeNodeHash } from "./merkle-hash.ts";
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
  groundDatas: Array<Record<string, unknown>>;
  backingRows: NodeRow[];
  rebuttalRows: NodeRow[];
  /** 所有节点的当前哈希 */
  currentHashes: Record<number, string>;
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
  const groundDatas: Array<Record<string, unknown>> = [];
  for (const gid of groundIdSet) {
    const gRow = repo.getNodeById(db, gid);
    if (gRow && gRow.type === "ground") {
      groundRows.push(gRow);
      groundDatas.push(JSON.parse(gRow.data));
    }
  }

  // Backings & Rebuttals
  const backingRows: NodeRow[] = [];
  const rebuttalRows: NodeRow[] = [];
  for (const w of warrantRows) {
    backingRows.push(...repo.findBackingsByWarrant(db, w.id));
    rebuttalRows.push(...repo.findRebuttalsByTarget(db, w.id, "warrant"));
  }
  rebuttalRows.push(...repo.findRebuttalsByTarget(db, claimId, "claim"));

  // 计算所有节点哈希
  const currentHashes: Record<number, string> = {};
  for (const row of [claimRow, ...warrantRows, ...groundRows, ...backingRows, ...rebuttalRows]) {
    currentHashes[row.id] = computeNodeHash(row);
  }

  return {
    claimRow,
    claimData,
    warrantRows,
    warrantDatas,
    groundRows,
    groundDatas,
    backingRows,
    rebuttalRows,
    currentHashes,
  };
}

// =============================================================================
// 阶段一：要素定义审查
// =============================================================================

function skippedResult(reviewer: "claim" | "warrant" | "ground", nodeId: number): ElementReviewResult {
  return {
    reviewer,
    nodeId,
    verdict: "pass",
    summary: "Skipped — content unchanged since last compile.",
    issues: [],
    skipped: true,
  };
}

async function reviewClaim(
  config: ReviewConfig,
  ctx: ArgumentContext,
  cwd: string
): Promise<ElementReviewResult> {
  const prompt = buildClaimReviewPrompt({
    id: ctx.claimRow.id,
    content: ctx.claimRow.content,
    status: (ctx.claimData.status as string) || "proposed",
    qualifier: ctx.claimData.qualifier as string | null | undefined,
  });

  try {
    const raw = await callAgent(config, prompt, [], cwd);
    const parsed = parseLLMResponse(raw, "concerns");
    return {
      reviewer: "claim",
      nodeId: ctx.claimRow.id,
      verdict: (parsed.verdict as string) || "concerns",
      summary: (parsed.summary as string) || "",
      issues: ((parsed.issues as Array<any>) || []).map(i => ({
        severity: i.severity || "info",
        element: i.element,
        nodeId: i.nodeId,
        message: i.message || "",
      })),
    };
  } catch (error) {
    log("compile_claim_review", "ERR", 0, `claim=#${ctx.claimRow.id}: ${error}`);
    return {
      reviewer: "claim",
      nodeId: ctx.claimRow.id,
      verdict: "concerns",
      summary: `Claim review failed due to error: ${error}`,
      issues: [{ severity: "info", message: `Reviewer error: ${error}` }],
    };
  }
}

async function reviewWarrant(
  config: ReviewConfig,
  ctx: ArgumentContext,
  warrantIdx: number,
  cwd: string
): Promise<ElementReviewResult> {
  const wRow = ctx.warrantRows[warrantIdx];
  const wData = ctx.warrantDatas[warrantIdx];
  const groundContents = ((wData.ground_ids || []) as number[]).map(gid => {
    const gRow = ctx.groundRows.find(g => g.id === gid);
    return { id: gid, content: gRow?.content || "(not found)" };
  });

  const prompt = buildWarrantReviewPrompt({
    id: wRow.id,
    content: wRow.content,
    claimContent: ctx.claimRow.content,
    claimId: ctx.claimRow.id,
    groundContents,
  });

  try {
    const raw = await callAgent(config, prompt, [], cwd);
    const parsed = parseLLMResponse(raw, "concerns");
    return {
      reviewer: "warrant",
      nodeId: wRow.id,
      verdict: (parsed.verdict as string) || "concerns",
      summary: (parsed.summary as string) || "",
      issues: ((parsed.issues as Array<any>) || []).map(i => ({
        severity: i.severity || "info",
        element: i.element,
        nodeId: i.nodeId,
        message: i.message || "",
      })),
    };
  } catch (error) {
    log("compile_warrant_review", "ERR", 0, `warrant=#${wRow.id}: ${error}`);
    return {
      reviewer: "warrant",
      nodeId: wRow.id,
      verdict: "concerns",
      summary: `Warrant review failed due to error: ${error}`,
      issues: [{ severity: "info", message: `Reviewer error: ${error}` }],
    };
  }
}

async function reviewGround(
  config: ReviewConfig,
  ctx: ArgumentContext,
  groundIdx: number,
  cwd: string
): Promise<ElementReviewResult> {
  const gRow = ctx.groundRows[groundIdx];
  const gData = ctx.groundDatas[groundIdx];

  const prompt = buildGroundReviewPrompt({
    id: gRow.id,
    content: gRow.content,
    source: (gData.source as string) || "unknown",
    verification: (gData.verification as string) || "pending",
  });

  try {
    const raw = await callAgent(config, prompt, [], cwd);
    const parsed = parseLLMResponse(raw, "concerns");
    return {
      reviewer: "ground",
      nodeId: gRow.id,
      verdict: (parsed.verdict as string) || "concerns",
      summary: (parsed.summary as string) || "",
      issues: ((parsed.issues as Array<any>) || []).map(i => ({
        severity: i.severity || "info",
        element: i.element,
        nodeId: i.nodeId,
        message: i.message || "",
      })),
    };
  } catch (error) {
    log("compile_ground_review", "ERR", 0, `ground=#${gRow.id}: ${error}`);
    return {
      reviewer: "ground",
      nodeId: gRow.id,
      verdict: "concerns",
      summary: `Ground review failed due to error: ${error}`,
      issues: [{ severity: "info", message: `Reviewer error: ${error}` }],
    };
  }
}

// =============================================================================
// 阶段二：逻辑链审查
// =============================================================================

async function reviewChain(
  config: ReviewConfig,
  ctx: ArgumentContext,
  cwd: string
): Promise<ElementReviewResult> {
  const prompt = buildChainReviewPrompt({
    claim: {
      id: ctx.claimRow.id,
      content: ctx.claimRow.content,
      status: (ctx.claimData.status as string) || "proposed",
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
          if (gIdx === -1) return { id: gid, content: "(not found)", source: "unknown", verification: "unknown" };
          const gData = ctx.groundDatas[gIdx];
          return {
            id: gid,
            content: ctx.groundRows[gIdx].content,
            source: (gData.source as string) || "unknown",
            verification: (gData.verification as string) || "pending",
          };
        }),
        backings: ctx.backingRows
          .filter(b => {
            const bData = JSON.parse(b.data);
            return bData.warrant_id === w.id;
          })
          .map(b => ({ id: b.id, content: b.content })),
      };
    }),
    rebuttals: ctx.rebuttalRows.map(r => {
      const rData = JSON.parse(r.data);
      return {
        id: r.id,
        content: r.content,
        targetType: rData.target_type as string,
      };
    }),
  });

  try {
    const raw = await callAgent(config, prompt, [], cwd);
    const parsed = parseLLMResponse(raw, "concerns");
    return {
      reviewer: "chain",
      verdict: (parsed.verdict as string) || "concerns",
      summary: (parsed.summary as string) || "",
      issues: ((parsed.issues as Array<any>) || []).map(i => ({
        severity: i.severity || "info",
        element: i.element,
        nodeId: i.nodeId,
        message: i.message || "",
      })),
    };
  } catch (error) {
    log("compile_chain_review", "ERR", 0, `claim=#${ctx.claimRow.id}: ${error}`);
    return {
      reviewer: "chain",
      verdict: "concerns",
      summary: `Chain review failed due to error: ${error}`,
      issues: [{ severity: "info", message: `Reviewer error: ${error}` }],
    };
  }
}

// =============================================================================
// 主入口：两阶段编译审查
// =============================================================================

/**
 * 运行两阶段编译审查。
 * @returns elementReviews + currentHashes
 */
export async function runCompileReviewers(
  config: ReviewConfig,
  db: Database,
  claimId: number,
  previousHashes: Record<number, string>
): Promise<{ elementReviews: ElementReviewResult[]; currentHashes: Record<number, string> }> {
  const ctx = loadArgumentContext(db, claimId);
  if (!ctx) {
    return {
      elementReviews: [{
        reviewer: "claim",
        nodeId: claimId,
        verdict: "fail",
        summary: `Claim #${claimId} not found.`,
        issues: [{ severity: "major", message: "Claim not found" }],
      }],
      currentHashes: {},
    };
  }

  const cwd = dirname(dirname(config.dbPath)); // .toulmin 的父目录

  // 判断某个节点是否需要审查
  const needsReview = (nodeId: number): boolean => {
    if (!previousHashes || Object.keys(previousHashes).length === 0) return true;
    const prev = previousHashes[nodeId];
    const curr = ctx.currentHashes[nodeId];
    if (!prev || !curr) return true;
    return prev !== curr;
  };

  // ===========================================================================
  // 阶段一：要素定义审查（并行）
  // ===========================================================================
  const stage1Promises: Promise<ElementReviewResult>[] = [];

  // Claim reviewer
  if (needsReview(ctx.claimRow.id)) {
    stage1Promises.push(reviewClaim(config, ctx, cwd));
  } else {
    stage1Promises.push(Promise.resolve(skippedResult("claim", ctx.claimRow.id)));
  }

  // Warrant reviewers
  for (let i = 0; i < ctx.warrantRows.length; i++) {
    if (needsReview(ctx.warrantRows[i].id)) {
      stage1Promises.push(reviewWarrant(config, ctx, i, cwd));
    } else {
      stage1Promises.push(Promise.resolve(skippedResult("warrant", ctx.warrantRows[i].id)));
    }
  }

  // Ground reviewers
  for (let i = 0; i < ctx.groundRows.length; i++) {
    if (needsReview(ctx.groundRows[i].id)) {
      stage1Promises.push(reviewGround(config, ctx, i, cwd));
    } else {
      stage1Promises.push(Promise.resolve(skippedResult("ground", ctx.groundRows[i].id)));
    }
  }

  const stage1Results = await Promise.all(stage1Promises);

  // 检查阶段一是否有 fail
  const hasFailure = stage1Results.some(r => r.verdict === "fail");

  if (hasFailure) {
    // 阶段一有 fail → 不进入阶段二
    log("compile_stage1", "ERR", 0,
      `claim=#${claimId} → failed, skipping chain review`
    );
    return { elementReviews: stage1Results, currentHashes: ctx.currentHashes };
  }

  // ===========================================================================
  // 阶段二：逻辑链审查（始终运行）
  // ===========================================================================
  const chainResult = await reviewChain(config, ctx, cwd);
  const allResults = [...stage1Results, chainResult];

  log("compile_stage2", "OK ", 0,
    `claim=#${claimId} → chain verdict=${chainResult.verdict}`
  );

  return { elementReviews: allResults, currentHashes: ctx.currentHashes };
}

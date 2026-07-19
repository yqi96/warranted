/**
 * Warranted — Merkle Tree 哈希计算
 *
 * 两层哈希体系：
 * - Layer 1: computeNodeHash — per-node 内容哈希（仅 content），用于 smart skip
 * - Layer 2: computeArgumentHash — Claim 级 Merkle Root，递归包含链式引用的 subclaim 哈希
 *
 * 只哈希 content 不哈希 data 的原因：
 * - data 中的状态字段（status、verification 等）不影响逻辑链
 * - 结构字段（ground_ids、ref_claim_id 等）由 computeArgumentHash 从 DB 实时读取遍历
 * - compile_status 在 data 中，不入哈希则无需剥离，避免自我触发
 */

import type { Database } from "bun:sqlite";
import { createHash } from "crypto";
import type { NodeRow } from "./types.ts";
import * as repo from "./repo.ts";

// =============================================================================
// Layer 1: Per-Node Hash（仅 content）
// =============================================================================

/** 计算节点的内容哈希（SHA-256），只覆盖 content 字段 */
export function computeNodeHash(row: NodeRow): string {
  return createHash("sha256").update(row.content).digest("hex");
}

// =============================================================================
// Layer 2: Argument Hash（Merkle Root，递归）
// =============================================================================

/** 哨兵值，标记某 Claim 正在计算中（循环防御） */
const COMPUTING_SENTINEL = "__computing__";

/**
 * 计算 Claim 的 argument 哈希（Merkle Root）。
 * 递归包含所有组成节点 + ref_claim_id 指向的 subclaim 的 argument 哈希。
 *
 * @param db   数据库
 * @param claimId  Claim 节点 ID
 * @param memo 缓存 Map<claimId, argumentHash>，避免重复计算 + 防御循环
 * @returns Merkle Root 哈希，或空字符串（Claim 不存在）
 */
export function computeArgumentHash(
  db: Database,
  claimId: number,
  memo: Map<number, string> = new Map()
): string {
  // 1. 检查 memo
  if (memo.has(claimId)) {
    const cached = memo.get(claimId)!;
    if (cached === COMPUTING_SENTINEL) {
      // 防御性循环检测（canReachThroughChain 在创建时已阻止循环，
      // 但哈希层做二次防御）
      return createHash("sha256").update("cycle").digest("hex");
    }
    return cached;
  }

  // 2. 标记为计算中（循环防御）
  memo.set(claimId, COMPUTING_SENTINEL);

  // 3. 加载 Claim 节点
  const claimRow = repo.getNodeById(db, claimId);
  if (!claimRow || claimRow.type !== "claim") {
    memo.set(claimId, "");
    return "";
  }
  const claimNodeHash = computeNodeHash(claimRow);

  // 4. Warrants
  const warrantRows = repo.findWarrantsByClaim(db, claimId);
  const warrantHashes = warrantRows.map(w => {
    const warrantNodeHash = computeNodeHash(w);
    const wData = JSON.parse(w.data);
    const groundIds: number[] = wData.ground_ids || [];

    // 5. Grounds（递归关键点）
    const groundHashes = groundIds.map(gid => {
      const gRow = repo.getNodeById(db, gid);
      if (!gRow || gRow.type !== "ground") return "";

      const groundNodeHash = computeNodeHash(gRow);
      const gData = JSON.parse(gRow.data);
      const refClaimId = gData.ref_claim_id;

      if (refClaimId !== null && refClaimId !== undefined) {
        // 递归：Ground 的哈希包含 subclaim 的 argument 哈希
        const refArgHash = computeArgumentHash(db, refClaimId, memo);
        return createHash("sha256").update(
          JSON.stringify({ node: groundNodeHash, refArg: refArgHash })
        ).digest("hex");
      }

      return groundNodeHash;
    }).sort(); // 排序确保顺序无关

    // 6. Backings
    const backingRows = repo.findBackingsByWarrant(db, w.id);
    const backingHashes = backingRows.map(b => computeNodeHash(b)).sort();

    return createHash("sha256").update(
      JSON.stringify({
        node: warrantNodeHash,
        grounds: groundHashes,
        backings: backingHashes,
      })
    ).digest("hex");
  }).sort();

  // 7. Rebuttals（针对该 Claim 及其 Warrants，去重）
  const rebuttalIds = new Set<number>();
  const rebuttalHashes: string[] = [];
  for (const r of repo.findRebuttalsByTarget(db, claimId, "claim")) {
    if (!rebuttalIds.has(r.id)) {
      rebuttalIds.add(r.id);
      rebuttalHashes.push(computeNodeHash(r));
    }
  }
  for (const w of warrantRows) {
    for (const r of repo.findRebuttalsByTarget(db, w.id, "warrant")) {
      if (!rebuttalIds.has(r.id)) {
        rebuttalIds.add(r.id);
        rebuttalHashes.push(computeNodeHash(r));
      }
    }
  }
  rebuttalHashes.sort();

  // 8. Merkle Root
  const root = createHash("sha256").update(
    JSON.stringify({
      claim: claimNodeHash,
      warrants: warrantHashes,
      rebuttals: rebuttalHashes,
    })
  ).digest("hex");

  memo.set(claimId, root);
  return root;
}

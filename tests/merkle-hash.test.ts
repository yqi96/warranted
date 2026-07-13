/**
 * Toulmin MCP — Merkle Tree 哈希计算测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestDb,
  cleanupDb,
  makeClaim,
  makeGround,
  makeWarrant,
  makeBacking,
  makeRebuttal,
  seedBasicArgument,
  makeChainReasoning,
} from "./helpers.ts";
import { computeNodeHash, computeArgumentHash } from "../src/merkle-hash.ts";
import * as repo from "../src/repo.ts";
import type { Database } from "bun:sqlite";

let db: Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  cleanupDb(db);
});

// =============================================================================
// computeNodeHash
// =============================================================================

describe("computeNodeHash", () => {
  test("只哈希 content（相同内容 → 相同哈希）", () => {
    const row = repo.getNodeById(db, makeClaim(db, "Hello").id)!;
    const hash1 = computeNodeHash(row);
    const hash2 = computeNodeHash(row);
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64); // SHA-256 hex
  });

  test("不同 content 产生不同哈希", () => {
    const row1 = repo.getNodeById(db, makeClaim(db, "Hello").id)!;
    const row2 = repo.getNodeById(db, makeClaim(db, "World").id)!;
    expect(computeNodeHash(row1)).not.toBe(computeNodeHash(row2));
  });

  test("status 变化不影响哈希（只哈希 content）", () => {
    const claim = makeClaim(db, "Same content");
    const row1 = repo.getNodeById(db, claim.id)!;
    const hash1 = computeNodeHash(row1);

    // 修改 status（在 data 中）
    const data = JSON.parse(row1.data);
    data.status = "supported";
    repo.updateNodeFields(db, claim.id, { data });
    const row2 = repo.getNodeById(db, claim.id)!;
    const hash2 = computeNodeHash(row2);

    expect(hash1).toBe(hash2);
  });

  test("compiled 标志变化不影响哈希", () => {
    const claim = makeClaim(db, "Same content");
    const row1 = repo.getNodeById(db, claim.id)!;
    const hash1 = computeNodeHash(row1);

    const data = JSON.parse(row1.data);
    data.compiled = true;
    data.compiled_at = "2025-01-01";
    repo.updateNodeFields(db, claim.id, { data });
    const row2 = repo.getNodeById(db, claim.id)!;
    const hash2 = computeNodeHash(row2);

    expect(hash1).toBe(hash2);
  });
});

// =============================================================================
// computeArgumentHash — 基础
// =============================================================================

describe("computeArgumentHash 基础", () => {
  test("包含完整 argument 的哈希非空", () => {
    const { claim } = seedBasicArgument(db);
    const hash = computeArgumentHash(db, claim.id);
    expect(hash).toBeTruthy();
    expect(hash.length).toBe(64);
  });

  test("不存在的 Claim 返回空字符串", () => {
    const hash = computeArgumentHash(db, 999);
    expect(hash).toBe("");
  });

  test("确定性：相同结构 → 相同哈希", () => {
    const { claim } = seedBasicArgument(db);
    const hash1 = computeArgumentHash(db, claim.id);
    const hash2 = computeArgumentHash(db, claim.id);
    expect(hash1).toBe(hash2);
  });

  test("content 修改 → 哈希变化", () => {
    const { claim } = seedBasicArgument(db);
    const hash1 = computeArgumentHash(db, claim.id);

    repo.updateNodeFields(db, claim.id, { content: "Modified claim" });
    const hash2 = computeArgumentHash(db, claim.id);

    expect(hash1).not.toBe(hash2);
  });

  test("status 修改 → 哈希不变", () => {
    const { claim } = seedBasicArgument(db);
    const hash1 = computeArgumentHash(db, claim.id);

    const data = JSON.parse(repo.getNodeById(db, claim.id)!.data);
    data.status = "supported";
    repo.updateNodeFields(db, claim.id, { data });
    const hash2 = computeArgumentHash(db, claim.id);

    expect(hash1).toBe(hash2);
  });
});

// =============================================================================
// computeArgumentHash — 结构变更检测
// =============================================================================

describe("computeArgumentHash 结构变更", () => {
  test("新增 Warrant → 哈希变化", () => {
    const { claim, ground1 } = seedBasicArgument(db);
    const hash1 = computeArgumentHash(db, claim.id);

    makeWarrant(db, claim.id, [ground1.id], "Additional warrant");
    const hash2 = computeArgumentHash(db, claim.id);

    expect(hash1).not.toBe(hash2);
  });

  test("新增 Backing → 哈希变化", () => {
    const { claim, warrant } = seedBasicArgument(db);
    const hash1 = computeArgumentHash(db, claim.id);

    makeBacking(db, warrant.id, "New backing");
    const hash2 = computeArgumentHash(db, claim.id);

    expect(hash1).not.toBe(hash2);
  });

  test("新增 Rebuttal → 哈希变化", () => {
    const { claim } = seedBasicArgument(db);
    const hash1 = computeArgumentHash(db, claim.id);

    makeRebuttal(db, claim.id, "claim", "Counter-argument");
    const hash2 = computeArgumentHash(db, claim.id);

    expect(hash1).not.toBe(hash2);
  });

  test("排序无关：相同结构不同创建顺序 → 相同哈希", () => {
    // Structure 1
    const claim1 = makeClaim(db, "Same claim");
    const g1 = makeGround(db, { content: "Ground A" });
    const g2 = makeGround(db, { content: "Ground B" });
    makeWarrant(db, claim1.id, [g1.id, g2.id], "Warrant");

    // Structure 2 (same content, different ground order)
    const claim2 = makeClaim(db, "Same claim");
    const g3 = makeGround(db, { content: "Ground A" });
    const g4 = makeGround(db, { content: "Ground B" });
    makeWarrant(db, claim2.id, [g4.id, g3.id], "Warrant"); // reversed order

    expect(computeArgumentHash(db, claim1.id)).toBe(computeArgumentHash(db, claim2.id));
  });
});

// =============================================================================
// computeArgumentHash — 链式推理递归
// =============================================================================

describe("computeArgumentHash 链式推理", () => {
  test("subclaim content 变 → parent 哈希变化", () => {
    // Create subclaim with its own argument
    const subClaim = makeClaim(db, "Sub claim original");
    const subGround = makeGround(db, { content: "Sub ground" });
    makeWarrant(db, subClaim.id, [subGround.id], "Sub warrant");

    // Create parent claim with chain reasoning to subclaim
    const parentClaim = makeClaim(db, "Parent claim");
    makeChainReasoning(db, parentClaim.id, subClaim.id);

    const hash1 = computeArgumentHash(db, parentClaim.id);

    // Modify subclaim content
    repo.updateNodeFields(db, subClaim.id, { content: "Sub claim modified" });
    const hash2 = computeArgumentHash(db, parentClaim.id);

    expect(hash1).not.toBe(hash2);
  });

  test("subclaim content 不变 → parent 哈希不变", () => {
    const subClaim = makeClaim(db, "Sub claim");
    const subGround = makeGround(db, { content: "Sub ground" });
    makeWarrant(db, subClaim.id, [subGround.id], "Sub warrant");

    const parentClaim = makeClaim(db, "Parent claim");
    makeChainReasoning(db, parentClaim.id, subClaim.id);

    const hash1 = computeArgumentHash(db, parentClaim.id);

    // Don't change anything
    const hash2 = computeArgumentHash(db, parentClaim.id);

    expect(hash1).toBe(hash2);
  });

  test("subclaim status 变 → parent 哈希不变（只哈希 content）", () => {
    const subClaim = makeClaim(db, "Sub claim");
    const subGround = makeGround(db, { content: "Sub ground" });
    makeWarrant(db, subClaim.id, [subGround.id], "Sub warrant");

    const parentClaim = makeClaim(db, "Parent claim");
    makeChainReasoning(db, parentClaim.id, subClaim.id);

    const hash1 = computeArgumentHash(db, parentClaim.id);

    // Change subclaim status (in data, not content)
    const data = JSON.parse(repo.getNodeById(db, subClaim.id)!.data);
    data.status = "validated";
    repo.updateNodeFields(db, subClaim.id, { data });
    const hash2 = computeArgumentHash(db, parentClaim.id);

    expect(hash1).toBe(hash2);
  });

  test("memoization：同一 subclaim 被多个 parent 引用只计算一次", () => {
    const subClaim = makeClaim(db, "Shared subclaim");
    const subGround = makeGround(db, { content: "Sub ground" });
    makeWarrant(db, subClaim.id, [subGround.id], "Sub warrant");

    const parent1 = makeClaim(db, "Parent 1");
    makeChainReasoning(db, parent1.id, subClaim.id);

    const parent2 = makeClaim(db, "Parent 2");
    makeChainReasoning(db, parent2.id, subClaim.id);

    const memo = new Map<number, string>();
    const hash1 = computeArgumentHash(db, parent1.id, memo);
    const hash2 = computeArgumentHash(db, parent2.id, memo);

    // Both should produce valid hashes
    expect(hash1).toBeTruthy();
    expect(hash2).toBeTruthy();
    // subClaim should be in memo (computed once)
    expect(memo.has(subClaim.id)).toBe(true);
  });
});

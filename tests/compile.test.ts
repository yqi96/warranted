/**
 * Compile 功能测试
 *
 * 测试结构预检、哈希计算、失效逻辑、compile 状态持久化。
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
} from "./helpers.ts";
import { structuralPreCheck, findAffectedClaimIds, invalidateCompiledClaims } from "../src/compile-service.ts";
import { loadArgumentContext } from "../src/compile-reviewers.ts";
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
// 结构预检
// =============================================================================

describe("structuralPreCheck", () => {
  test("Claim 不存在时返回错误", () => {
    const errors = structuralPreCheck(db, 999);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("not found");
  });

  test("非 Claim 类型节点返回错误", () => {
    const ground = makeGround(db);
    const errors = structuralPreCheck(db, ground.id);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("is not a Claim");
  });

  test("Claim 无 Warrant 时返回错误", () => {
    const claim = makeClaim(db, "Test claim");
    const errors = structuralPreCheck(db, claim.id);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("no Warrants");
  });

  test("Warrant 无 Ground 时返回错误", () => {
    const claim = makeClaim(db, "Test claim");
    makeWarrant(db, claim.id, [], "Test warrant");
    const errors = structuralPreCheck(db, claim.id);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("no Grounds");
  });

  test("Warrant 引用不存在的 Ground 时返回错误", () => {
    const claim = makeClaim(db, "Test claim");
    // Manually create warrant with non-existent ground ID
    const now = new Date().toISOString().slice(0, 19);
    const data = JSON.stringify({ claim_id: claim.id, ground_ids: [999] });
    db.prepare("INSERT INTO nodes (type, content, data, created_at, updated_at) VALUES ('warrant', 'test', ?, ?, ?)").run(data, now, now);
    const errors = structuralPreCheck(db, claim.id);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("not found");
  });

  test("完整论证结构通过预检", () => {
    const { claim } = seedBasicArgument(db);
    const errors = structuralPreCheck(db, claim.id);
    expect(errors.length).toBe(0);
  });
});

// =============================================================================
// 哈希计算
// =============================================================================

describe("computeNodeHash", () => {
  test("相同内容产生相同哈希", () => {
    const row = repo.getNodeById(db, makeClaim(db, "Hello").id)!;
    const hash1 = computeNodeHash(row);
    const hash2 = computeNodeHash(row);
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64); // SHA-256 hex
  });

  test("不同内容产生不同哈希", () => {
    const row1 = repo.getNodeById(db, makeClaim(db, "Hello").id)!;
    const row2 = repo.getNodeById(db, makeClaim(db, "World").id)!;
    expect(computeNodeHash(row1)).not.toBe(computeNodeHash(row2));
  });

  test("content 修改后哈希变化", () => {
    const claim = makeClaim(db, "Original");
    const row1 = repo.getNodeById(db, claim.id)!;
    const hash1 = computeNodeHash(row1);

    repo.updateNodeFields(db, claim.id, { content: "Modified" });
    const row2 = repo.getNodeById(db, claim.id)!;
    const hash2 = computeNodeHash(row2);

    expect(hash1).not.toBe(hash2);
  });

  test("data 修改不影响哈希（只哈希 content）", () => {
    const claim = makeClaim(db, "Same content");
    const row1 = repo.getNodeById(db, claim.id)!;
    const hash1 = computeNodeHash(row1);

    const data = JSON.parse(row1.data);
    data.qualifier = "probably";
    repo.updateNodeFields(db, claim.id, { data });
    const row2 = repo.getNodeById(db, claim.id)!;
    const hash2 = computeNodeHash(row2);

    expect(hash1).toBe(hash2);
  });
});

// =============================================================================
// Argument 上下文加载
// =============================================================================

describe("loadArgumentContext", () => {
  test("加载完整论证子图", () => {
    const { claim, ground1, ground2, warrant, backing } = seedBasicArgument(db);
    const ctx = loadArgumentContext(db, claim.id);
    expect(ctx).not.toBeNull();
    expect(ctx!.claimRow.id).toBe(claim.id);
    expect(ctx!.warrantRows.length).toBe(1);
    expect(ctx!.warrantRows[0].id).toBe(warrant.id);
    expect(ctx!.groundRows.length).toBe(2);
    expect(ctx!.backingRows.length).toBe(1);
  });

  test("不存在的 Claim 返回 null", () => {
    const ctx = loadArgumentContext(db, 999);
    expect(ctx).toBeNull();
  });
});

// =============================================================================
// 失效管理：findAffectedClaimIds
// =============================================================================

describe("findAffectedClaimIds", () => {
  test("修改 Claim 自身受影响", () => {
    const { claim } = seedBasicArgument(db);
    const affected = findAffectedClaimIds(db, claim.id);
    expect(affected).toContain(claim.id);
  });

  test("修改 Warrant 影响其 Claim", () => {
    const { claim, warrant } = seedBasicArgument(db);
    const affected = findAffectedClaimIds(db, warrant.id);
    expect(affected).toContain(claim.id);
  });

  test("修改 Ground 影响引用它的 Warrant 的 Claim", () => {
    const { claim, ground1 } = seedBasicArgument(db);
    const affected = findAffectedClaimIds(db, ground1.id);
    expect(affected).toContain(claim.id);
  });

  test("修改 Backing 影响其 Warrant 的 Claim", () => {
    const { claim, backing } = seedBasicArgument(db);
    const affected = findAffectedClaimIds(db, backing.id);
    expect(affected).toContain(claim.id);
  });

  test("修改 Rebuttal(target=claim) 影响 Claim", () => {
    const { claim } = seedBasicArgument(db);
    const rebuttal = makeRebuttal(db, claim.id, "claim", "Counter argument");
    const affected = findAffectedClaimIds(db, rebuttal.id);
    expect(affected).toContain(claim.id);
  });

  test("修改 Rebuttal(target=warrant) 影响 Claim", () => {
    const { claim, warrant } = seedBasicArgument(db);
    const rebuttal = makeRebuttal(db, warrant.id, "warrant", "Counter argument");
    const affected = findAffectedClaimIds(db, rebuttal.id);
    expect(affected).toContain(claim.id);
  });
});

// =============================================================================
// Compile 状态持久化
// =============================================================================

describe("compile_state CRUD", () => {
  test("saveCompileState + getCompileState", () => {
    const claim = makeClaim(db, "Test");
    repo.saveCompileState(db, claim.id, "passed", "All good");
    const state = repo.getCompileState(db, claim.id);
    expect(state).not.toBeNull();
    expect(state!.claimId).toBe(claim.id);
    expect(state!.verdict).toBe("passed");
    expect(state!.summary).toBe("All good");
  });

  test("getCompileState 不存在时返回 null", () => {
    const state = repo.getCompileState(db, 999);
    expect(state).toBeNull();
  });

  test("deleteCompileState 删除后查询为 null", () => {
    const claim = makeClaim(db, "Test");
    repo.saveCompileState(db, claim.id, "passed", "");
    repo.deleteCompileState(db, claim.id);
    expect(repo.getCompileState(db, claim.id)).toBeNull();
  });

  test("saveCompileState 覆盖更新（INSERT OR REPLACE）", () => {
    const claim = makeClaim(db, "Test");
    repo.saveCompileState(db, claim.id, "failed", "First");
    repo.saveCompileState(db, claim.id, "passed", "Second");
    const state = repo.getCompileState(db, claim.id);
    expect(state!.verdict).toBe("passed");
    expect(state!.summary).toBe("Second");
  });
});

// =============================================================================
// invalidateCompiledClaims
// =============================================================================

describe("invalidateCompiledClaims", () => {
  test("修改 compiled Claim 的节点后清除 compiled 状态", () => {
    const { claim, ground1 } = seedBasicArgument(db);

    // 手动设置 compile_status = "passed"
    repo.setCompileStatus(db, claim.id, "passed");

    // 保存 compile_state
    repo.saveCompileState(db, claim.id, "passed", "OK");

    // 修改 ground → 触发失效
    const warnings = invalidateCompiledClaims(db, ground1.id);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("compiled status has been cleared");

    // 验证 compile_status 已变为 stale
    const updatedClaim = repo.getNodeById(db, claim.id)!;
    const updatedData = JSON.parse(updatedClaim.data);
    expect(updatedData.compile_status).toBe("stale");

    // 验证 compile_state 已删除
    expect(repo.getCompileState(db, claim.id)).toBeNull();
  });

  test("修改非 compiled Claim 的节点后无警告，但仍标记 compile_status=stale", () => {
    const { claim, ground1 } = seedBasicArgument(db);
    const warnings = invalidateCompiledClaims(db, ground1.id);
    expect(warnings.length).toBe(0);
    const updatedClaim = repo.getNodeById(db, claim.id)!;
    expect(JSON.parse(updatedClaim.data).compile_status).toBe("stale");
  });

  test("【回归】API 失败后(compile_status=stale)移除 ground 应清除残留 compile_state", () => {
    const { claim, ground1 } = seedBasicArgument(db);

    // 模拟 API 失败场景：compile_state 存在但 compile_status=stale（无 argumentHash）
    repo.saveCompileState(db, claim.id, "failed", "Reviewer error: API timeout");
    repo.setCompileStatus(db, claim.id, "stale");

    // 移除 ground（触发 invalidateCompiledClaims）
    invalidateCompiledClaims(db, ground1.id);

    // compile_state 应被清除，否则下次 compile_arguments 可能误判
    expect(repo.getCompileState(db, claim.id)).toBeNull();
    expect(JSON.parse(repo.getNodeById(db, claim.id)!.data).compile_status).toBe("stale");
  });

  test("【回归】已通过 compile 后移除 refclaim ground，compile_state 正确清除", () => {
    // 构造带 refclaim ground 的参数
    const subClaim = makeClaim(db, "Sub claim");
    const subGround = makeGround(db, { content: "Sub ground evidence" });
    makeWarrant(db, subClaim.id, [subGround.id], "Sub warrant");

    const parentClaim = makeClaim(db, "Parent claim");
    // refclaim ground：ground 的 ref_claim_id 指向 subClaim
    const refGround = makeGround(db, { content: "Chain reasoning", refClaimId: subClaim.id });
    makeWarrant(db, parentClaim.id, [refGround.id], "Parent warrant");

    // 标记 parentClaim 为已 compiled
    const argHash = computeArgumentHash(db, parentClaim.id);
    repo.setCompileStatus(db, parentClaim.id, "passed");
    repo.saveCompileState(db, parentClaim.id, "passed", "ok", argHash);

    // 移除 refclaim ground
    invalidateCompiledClaims(db, refGround.id);

    // compile_state 应被清除，compile_status 应变为 stale
    expect(repo.getCompileState(db, parentClaim.id)).toBeNull();
    const updatedData = JSON.parse(repo.getNodeById(db, parentClaim.id)!.data);
    expect(updatedData.compile_status).toBe("stale");
  });

  test("孤立节点不设置无关 Claim 的 compile_status", () => {
    const claim = makeClaim(db);
    const orphanGround = makeGround(db, { content: "Orphan ground" });
    invalidateCompiledClaims(db, orphanGround.id);
    const claimRow = repo.getNodeById(db, claim.id)!;
    expect(JSON.parse(claimRow.data).compile_status).toBeUndefined();
  });

  test("修改不相关节点不影响任何 Claim", () => {
    const { claim } = seedBasicArgument(db);

    // 设置 compile_status = "passed"
    repo.setCompileStatus(db, claim.id, "passed");

    // 创建一个独立的 ground（不属于任何 warrant）
    const orphanGround = makeGround(db, { content: "Orphan ground" });
    const warnings = invalidateCompiledClaims(db, orphanGround.id);
    expect(warnings.length).toBe(0);

    // Claim 仍然 compile_status = "passed"
    const updatedClaim = repo.getNodeById(db, claim.id)!;
    expect(JSON.parse(updatedClaim.data).compile_status).toBe("passed");
  });
});

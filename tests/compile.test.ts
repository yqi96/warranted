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
  compileVerdictOf,
} from "./helpers.ts";
import { structuralPreCheck, findAffectedClaimIds, invalidateCompiledClaims } from "../src/compile-service.ts";
import { loadArgumentContext } from "../src/compile-reviewers.ts";
import { buildChainReviewPrompt } from "../src/compile-prompts.ts";
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
// Rebuttal 目标解析（连接派生 — 角色来自关系表，非 node data）
// =============================================================================

describe("rebuttal target resolution (connection-derived)", () => {
  // Seed: claim -> warrant(ground); one rebuttal statement linked to BOTH the
  // warrant and the claim via rebuttal_targets. Node data carries no target_type.
  function seedDualTargetRebuttal() {
    const claim = makeClaim(db, "Test claim");
    const ground = makeGround(db, { content: "Ground one" });
    const warrant = makeWarrant(db, claim.id, [ground.id]);
    const reb = makeRebuttal(db, warrant.id, "warrant", "A counter-condition");
    // Add the second edge: same rebuttal also challenges the claim directly.
    db.prepare(
      "INSERT OR IGNORE INTO rebuttal_targets (statement_id, target_id, target_type) VALUES (?, ?, ?)"
    ).run(reb.id, claim.id, "claim");
    return { claim, ground, warrant, reb };
  }

  test("loadArgumentContext 从关系表带出 targetType/targetId（node data 不含 target_type）", () => {
    const { claim, warrant, reb } = seedDualTargetRebuttal();

    const rebRow = repo.getNodeById(db, reb.id)!;
    expect(JSON.parse(rebRow.data).target_type).toBeUndefined();

    const ctx = loadArgumentContext(db, claim.id)!;
    expect(ctx).not.toBeNull();
    expect(ctx.rebuttalRows.length).toBe(2);

    const warrantEntry = ctx.rebuttalRows.find(r => r.targetType === "warrant");
    const claimEntry = ctx.rebuttalRows.find(r => r.targetType === "claim");
    expect(warrantEntry).toBeDefined();
    expect(warrantEntry!.targetId).toBe(warrant.id);
    expect(warrantEntry!.row.id).toBe(reb.id);
    expect(claimEntry).toBeDefined();
    expect(claimEntry!.targetId).toBe(claim.id);
    expect(claimEntry!.row.id).toBe(reb.id);
  });

  test("buildChainReviewPrompt 渲染具体 target，绝不出现 'targets undefined'", () => {
    const { claim, ground, warrant } = seedDualTargetRebuttal();
    const ctx = loadArgumentContext(db, claim.id)!;

    const prompt = buildChainReviewPrompt({
      claim: { id: ctx.claimRow.id, content: ctx.claimRow.content },
      warrants: ctx.warrantRows.map(w => ({
        id: w.id,
        content: w.content,
        grounds: [{ id: ground.id, content: ground.content, type: "statement" as const, verification: "verified" }],
        backings: [],
      })),
      rebuttals: ctx.rebuttalRows.map(rr => ({
        id: rr.row.id,
        content: rr.row.content,
        targetType: rr.targetType,
        targetId: rr.targetId,
      })),
    });

    expect(prompt).toContain(`targets warrant #${warrant.id}`);
    expect(prompt).toContain(`targets claim #${claim.id}`);
    expect(prompt).not.toContain("targets undefined");
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
  test("修改 compiled Claim 的节点后，passed 降级为 stale 并清空结构指纹", () => {
    const { claim, ground1 } = seedBasicArgument(db);

    const argHash = computeArgumentHash(db, claim.id);
    repo.saveCompileState(db, claim.id, "passed", "OK", argHash);

    // 修改 ground → 触发失效
    const warnings = invalidateCompiledClaims(db, ground1.id);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("compiled status has been cleared");

    // 行保留下来，verdict 降级为 stale —— 不删行，否则会被 get_stats 误算成"从未编译过"
    const after = repo.getCompileState(db, claim.id);
    expect(after).not.toBeNull();
    expect(after!.verdict).toBe("stale");
    // 关键：指纹必须清空，否则下次 compile 会走"哈希未变"短路，跳过重新审查
    expect(after!.argumentHash ?? null).toBeNull();
  });

  test("从未编译过的 Claim：无警告，也不会被降级成 stale", () => {
    const { claim, ground1 } = seedBasicArgument(db);
    const warnings = invalidateCompiledClaims(db, ground1.id);
    expect(warnings.length).toBe(0);
    // 没通过过就没有可降级的东西，仍然是"从未编译"
    expect(compileVerdictOf(db, claim.id)).toBeNull();
  });

  test("stale 状态下再次移除 ground：保持 stale，且始终不带指纹", () => {
    const { claim, ground1 } = seedBasicArgument(db);

    // 上一次审查因 API 报错未能完成，只留下 stale，没有指纹
    repo.saveCompileState(db, claim.id, "stale", "Reviewer error: API timeout");

    invalidateCompiledClaims(db, ground1.id);

    const after = repo.getCompileState(db, claim.id);
    expect(after!.verdict).toBe("stale");
    expect(after!.argumentHash ?? null).toBeNull();
  });

  test("failed 不被降级为 stale —— failed 信息量更大，且一样挡住状态转换", () => {
    const { claim, ground1 } = seedBasicArgument(db);
    repo.saveCompileState(db, claim.id, "failed", "C4: ground not verified");

    invalidateCompiledClaims(db, ground1.id);

    expect(compileVerdictOf(db, claim.id)).toBe("failed");
  });

  test("【回归】已通过 compile 后移除链式 ground，父 Claim 的指纹被清空", () => {
    // 构造带 ground 的参数
    const subClaim = makeClaim(db, "Sub claim");
    const subGround = makeGround(db, { content: "Sub ground evidence" });
    makeWarrant(db, subClaim.id, [subGround.id], "Sub warrant");

    const parentClaim = makeClaim(db, "Parent claim");
    // 直接使用 subClaim 作为 ground（链式推理）
    const chainGround = makeGround(db, { content: "Chain reasoning evidence" });
    makeWarrant(db, parentClaim.id, [chainGround.id], "Parent warrant");

    // 标记 parentClaim 为已 compiled
    const argHash = computeArgumentHash(db, parentClaim.id);
    repo.saveCompileState(db, parentClaim.id, "passed", "ok", argHash);

    // 移除 chain ground
    invalidateCompiledClaims(db, chainGround.id);

    const after = repo.getCompileState(db, parentClaim.id);
    expect(after!.verdict).toBe("stale");
    expect(after!.argumentHash ?? null).toBeNull();
  });

  test("孤立节点不影响无关 Claim 的编译状态", () => {
    const claim = makeClaim(db);
    const orphanGround = makeGround(db, { content: "Orphan ground" });
    invalidateCompiledClaims(db, orphanGround.id);
    expect(compileVerdictOf(db, claim.id)).toBeNull();
  });

  test("修改不相关节点不影响任何 Claim", () => {
    const { claim } = seedBasicArgument(db);

    const argHash = computeArgumentHash(db, claim.id);
    repo.saveCompileState(db, claim.id, "passed", "ok", argHash);

    // 创建一个独立的 ground（不属于任何 warrant）
    const orphanGround = makeGround(db, { content: "Orphan ground" });
    const warnings = invalidateCompiledClaims(db, orphanGround.id);
    expect(warnings.length).toBe(0);

    // 仍然 passed，指纹也还在
    const after = repo.getCompileState(db, claim.id);
    expect(after!.verdict).toBe("passed");
    expect(after!.argumentHash).toBe(argHash);
  });
});

// =============================================================================
// BFS 链式传播 — claim-type ground
// =============================================================================

describe("BFS 链式传播 — claim-type ground", () => {
  test("修改 sub-claim content → 父 Claim 失效（一跳）", () => {
    const subClaim = makeClaim(db, "Sub claim");
    const parentClaim = makeClaim(db, "Parent claim");
    // sub-claim 作为父 Claim warrant 的 ground
    makeWarrant(db, parentClaim.id, [subClaim.id], "Chain warrant");

    repo.saveCompileState(db, parentClaim.id, "passed", "ok");

    const affected = findAffectedClaimIds(db, subClaim.id);
    expect(affected).toContain(subClaim.id);
    expect(affected).toContain(parentClaim.id);
  });

  test("修改 sub-claim 的 ground statement → 父 Claim 也失效（二跳）", () => {
    const subGround = makeGround(db, { content: "Sub-level evidence" });
    const subClaim = makeClaim(db, "Sub claim");
    makeWarrant(db, subClaim.id, [subGround.id], "Sub warrant");

    const parentClaim = makeClaim(db, "Parent claim");
    makeWarrant(db, parentClaim.id, [subClaim.id], "Chain warrant");

    repo.saveCompileState(db, parentClaim.id, "passed", "ok");

    // 修改 sub-claim 的 ground → sub-claim 失效 → BFS → 父 Claim 也失效
    const affected = findAffectedClaimIds(db, subGround.id);
    expect(affected).toContain(subClaim.id);
    expect(affected).toContain(parentClaim.id);
  });

  test("三层链：A ← B(ground:C) ← D(ground:stmt) → 修改 stmt 传播到 A", () => {
    const stmt = makeGround(db, { content: "Base evidence" });
    const claimC = makeClaim(db, "Claim C");
    makeWarrant(db, claimC.id, [stmt.id], "Warrant C");

    const claimB = makeClaim(db, "Claim B");
    makeWarrant(db, claimB.id, [claimC.id], "Warrant B");

    const claimA = makeClaim(db, "Claim A");
    makeWarrant(db, claimA.id, [claimB.id], "Warrant A");

    repo.saveCompileState(db, claimA.id, "passed", "ok");

    const affected = findAffectedClaimIds(db, stmt.id);
    expect(affected).toContain(claimC.id);
    expect(affected).toContain(claimB.id);
    expect(affected).toContain(claimA.id);
  });

  test("invalidateCompiledClaims: 修改 sub-claim → 父 Claim 降级为 stale", () => {
    const subClaim = makeClaim(db, "Sub claim");
    const parentClaim = makeClaim(db, "Parent claim");
    makeWarrant(db, parentClaim.id, [subClaim.id], "Chain warrant");

    repo.saveCompileState(db, parentClaim.id, "passed", "ok");

    invalidateCompiledClaims(db, subClaim.id);

    expect(compileVerdictOf(db, parentClaim.id)).toBe("stale");
  });
});

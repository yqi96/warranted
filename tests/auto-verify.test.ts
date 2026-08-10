/**
 * Toulmin MCP — 自动验证测试
 *
 * 测试 compileClaims 的逻辑分支（不含 LLM 调用）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestDb,
  cleanupDb,
  makeClaim,
  makeGround,
  makeWarrant,
  makeRebuttal,
  seedBasicArgument,
  makeCompiledClaim,
  makeChainReasoning,
  compileVerdictOf,
} from "./helpers.ts";
import { compileClaims, findAffectedClaimIds } from "../src/compile-service.ts";
import { computeArgumentHash } from "../src/merkle-hash.ts";
import * as repo from "../src/repo.ts";
import type { NodeData } from "../src/types.ts";
import type { Database } from "bun:sqlite";

let db: Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  cleanupDb(db);
});

/**
 * 直接改底层字段，绕过 service.updateNode。
 *
 * service.updateNode 在撤回核实时会连带把 Claim 的 status 退回 proposed（D28），
 * 而下面两条测试要的正是"status 还是 supported、证据却退回了 pending"这个组合 ——
 * C4 只在 status === supported 时报 error。
 */
function setVerificationRaw(id: number, verification: "pending" | "verified"): void {
  const row = repo.getNodeById(db, id)!;
  const data = JSON.parse(row.data) as Record<string, unknown>;
  repo.updateNodeFields(db, id, { data: { ...data, verification } as NodeData });
}

// =============================================================================
// compileClaims — 无 LLM 分支
//
// D25/D26 之后这一组的预期变了两处，都是设计决定，不是修 bug：
//
// 1. 五种结局不再共用 "marked-stale"。structure-incomplete = 结构缺东西，
//    check-failed = 结构齐全但检查没过，passed-unreviewed = 没配模型、只跑了
//    不需要模型的检查就记为通过。
// 2. 没配审查模型不再一律标 stale，而是默认通过。代价是逻辑没人审——A0 只看
//    "有没有一条通过的记录"，不看那条记录是模型审的还是默认给的。已经存着
//    failed 的不覆盖：那是模型真否掉过的结论，不能被兜底盖掉。
// =============================================================================

describe("compileClaims", () => {
  test("已 compiled 且哈希未变 → no-change", async () => {
    const { claim } = seedBasicArgument(db);
    const argHash = computeArgumentHash(db, claim.id);

    // 将 claim 标记为 compiled 并存储正确的 argument_hash
    repo.saveCompileState(db, claim.id, "passed", "ok", argHash);

    const results = await compileClaims(db, null, [claim.id]);

    expect(results.length).toBe(1);
    expect(results[0].action).toBe("no-change");
  });

  test("未 compiled 且结构不完整 → structure-incomplete，不留下 stale 记录", async () => {
    const claim = makeClaim(db, "Uncompiled claim");
    // 不写 compile_state

    const results = await compileClaims(db, null, [claim.id]);

    expect(results.length).toBe(1);
    expect(results[0].action).toBe("structure-incomplete");
    // 从没通过过，就没有 passed 的行可降级，staled 必须是 false 而不是"走到了这个分支"
    expect(results[0].staled).toBe(false);

    // 从没通过过，就不会被降级成 stale —— 仍然是"从未编译"。
    // A0 照样挡得住（不是 passed 就过不去），信息还比 stale 准确。
    expect(compileVerdictOf(db, claim.id)).toBeNull();
  });

  test("已 compiled 但哈希变化且无 config → 默认通过，不是 stale", async () => {
    const { claim } = seedBasicArgument(db);
    const argHash = computeArgumentHash(db, claim.id);

    // Mark as compiled with old hash
    repo.saveCompileState(db, claim.id, "passed", "ok", argHash);

    // Modify content → hash will change
    repo.updateNodeFields(db, claim.id, { content: "Modified claim" });

    const results = await compileClaims(db, null, [claim.id]);

    expect(results.length).toBe(1);
    expect(results[0].action).toBe("passed-unreviewed");

    // 结构检查都过了 → 记为通过，并存下新的结构指纹
    expect(compileVerdictOf(db, claim.id)).toBe("passed");
    expect(repo.getCompileState(db, claim.id)?.argumentHash).toBe(
      computeArgumentHash(db, claim.id)
    );
  });

  test("默认通过之后再跑一次 → no-change（新指纹确实存下来了）", async () => {
    const { claim } = seedBasicArgument(db);

    const first = await compileClaims(db, null, [claim.id]);
    expect(first[0].action).toBe("passed-unreviewed");

    const second = await compileClaims(db, null, [claim.id]);
    expect(second[0].action).toBe("no-change");
  });

  test("不存在的 Claim → skipped", async () => {
    const results = await compileClaims(db, null, [999]);

    expect(results.length).toBe(1);
    expect(results[0].action).toBe("skipped");
  });

  test("多个 Claim 并行处理", async () => {
    const claim1 = makeClaim(db, "Claim 1");
    const claim2 = makeClaim(db, "Claim 2");
    const claim3 = makeClaim(db, "Claim 3");

    const results = await compileClaims(db, null, [claim1.id, claim2.id, claim3.id]);

    expect(results.length).toBe(3);
    expect(results.every(r => r.action === "structure-incomplete")).toBe(true);
  });

  test("stale 已设置时不重复设置", async () => {
    const claim = makeClaim(db, "Already stale");
    repo.saveCompileState(db, claim.id, "stale", "");

    const results = await compileClaims(db, null, [claim.id]);

    expect(results[0].action).toBe("structure-incomplete");
    // 本来就是 stale，保持 stale；这次没有 passed 的行被改动
    expect(results[0].staled).toBe(false);
    expect(compileVerdictOf(db, claim.id)).toBe("stale");
  });

  // ===========================================================================
  // Case 2: 从未审查过 → 结构完整性检测
  // ===========================================================================

  test("未审查 + 结构完整 + 无 config → 默认通过", async () => {
    const { claim } = seedBasicArgument(db);
    // 不写 compile_state

    const results = await compileClaims(db, null, [claim.id]);

    expect(results[0].action).toBe("passed-unreviewed");
    expect(compileVerdictOf(db, claim.id)).toBe("passed");
    // 摘要必须说清这条通过没经过逻辑审查，否则日后没人分得清它和真审过的
    expect(repo.getCompileState(db, claim.id)?.summary).toContain("without logic review");
  });

  test("未审查 + 结构不完整（无 warrant）→ structure-incomplete", async () => {
    const claim = makeClaim(db, "Bare claim, no warrant");

    const results = await compileClaims(db, null, [claim.id]);

    expect(results[0].action).toBe("structure-incomplete");
    expect(results[0].message).toContain("has no Warrants");

    expect(compileVerdictOf(db, claim.id)).toBeNull();
  });

  test("未审查 + 结构不完整（warrant 无 ground）→ structure-incomplete", async () => {
    const claim = makeClaim(db, "Claim with empty warrant");
    // 创建 warrant 但不关联 ground
    makeWarrant(db, claim.id, [], "Warrant without grounds");

    const results = await compileClaims(db, null, [claim.id]);

    expect(results[0].action).toBe("structure-incomplete");
    expect(results[0].message).toContain("has no Grounds");
  });

  // ===========================================================================
  // Case 1 扩展：argumentHash 只代表"上次通过时的哈希"
  // ===========================================================================

  test("failed review (无 argumentHash) + 结构完整 + 无 config → 保留 failed，不默认通过", async () => {
    const { claim } = seedBasicArgument(db);

    // 失败的 compile_state 不保存 argumentHash（生产代码行为）
    repo.saveCompileState(db, claim.id, "failed", "Structural error");

    const results = await compileClaims(db, null, [claim.id]);

    // 无 argumentHash → 不进 Case 1 → 走 Case 2 → 无 config → 但已存 failed，不覆盖
    expect(results[0].action).toBe("check-failed");
    expect(results[0].message).toContain("no review model is configured");
    expect(compileVerdictOf(db, claim.id)).toBe("failed");
  });

  test("failed review (旧数据带 argumentHash) + 哈希未变 → no-change", async () => {
    const { claim } = seedBasicArgument(db);
    const argHash = computeArgumentHash(db, claim.id);

    // 模拟旧数据：带 hash 的 failed 状态（新代码不会产生此状态）
    repo.saveCompileState(db, claim.id, "failed", "Issues found", argHash);

    const results = await compileClaims(db, null, [claim.id]);

    // prevState.argumentHash 非空 → Case 1 → hash 未变 → no-change
    expect(results[0].action).toBe("no-change");
  });

  test("failed review + 哈希变化 + 无 config → 保留 failed（不覆盖，也不降级）", async () => {
    const { claim } = seedBasicArgument(db);
    const argHash = computeArgumentHash(db, claim.id);

    // 存储 failed compile_state
    repo.saveCompileState(db, claim.id, "failed", "Issues found", argHash);

    // 修改 content → 哈希变化
    repo.updateNodeFields(db, claim.id, { content: "Modified claim" });

    const results = await compileClaims(db, null, [claim.id]);

    expect(results[0].action).toBe("check-failed");
    expect(results[0].staled).toBe(false);

    // failed 保持 failed：模型真否掉过，兜底的默认通过不能盖掉它。
    expect(compileVerdictOf(db, claim.id)).toBe("failed");
  });

  test("passed review + 哈希变化 + 无 config → 重新记为通过（未经审查）", async () => {
    const { claim } = seedBasicArgument(db);
    const argHash = computeArgumentHash(db, claim.id);

    // 存储 passed compile_state
    repo.saveCompileState(db, claim.id, "passed", "ok", argHash);

    // 修改 content → 哈希变化
    repo.updateNodeFields(db, claim.id, { content: "Modified claim" });

    const results = await compileClaims(db, null, [claim.id]);

    expect(results[0].action).toBe("passed-unreviewed");
    expect(compileVerdictOf(db, claim.id)).toBe("passed");
  });

  // ===========================================================================
  // D26：staled 取的是 SQL 实际改动的行数，不是"走到了哪个分支"
  // ===========================================================================

  test("check-failed 且原本 passed → staled 为 true", async () => {
    const { claim, ground1 } = seedBasicArgument(db);
    const argHash = computeArgumentHash(db, claim.id);
    repo.saveCompileState(db, claim.id, "passed", "ok", argHash);

    // status=supported 但证据退回 pending → C4 报 error；哈希不变（verification 不入 hash）
    repo.setClaimStatus(db, claim.id, "supported");
    setVerificationRaw(ground1.id, "pending");

    const results = await compileClaims(db, null, [claim.id]);

    expect(results[0].action).toBe("check-failed");
    expect(results[0].staled).toBe(true);
    expect(compileVerdictOf(db, claim.id)).toBe("stale");
  });

  test("同一个分支、原本 failed → staled 为 false", async () => {
    const { claim, ground1 } = seedBasicArgument(db);
    const argHash = computeArgumentHash(db, claim.id);
    // 旧数据形态：failed 却带着 hash，才能走到"哈希未变"这条短路
    repo.saveCompileState(db, claim.id, "failed", "Issues found", argHash);

    repo.setClaimStatus(db, claim.id, "supported");
    setVerificationRaw(ground1.id, "pending");

    const results = await compileClaims(db, null, [claim.id]);

    expect(results[0].action).toBe("check-failed");
    // 同一个返回点，只因为存的 verdict 不同就什么都没标 —— 所以 staled 必须是量出来的
    expect(results[0].staled).toBe(false);
    expect(compileVerdictOf(db, claim.id)).toBe("failed");
  });
});

// =============================================================================
// findAffectedClaimIds — 链式推理传播
// =============================================================================

describe("findAffectedClaimIds 链式传播", () => {
  test("直接受影响的 Claim（无链式引用）", () => {
    const { claim, ground1 } = seedBasicArgument(db);

    // 修改 ground → 应该找到 claim
    const affected = findAffectedClaimIds(db, ground1.id);

    expect(affected).toContain(claim.id);
    expect(affected.length).toBe(1); // 只有直接 parent
  });

  test("链式传播 1 级：subclaim 变 → parent 被发现", () => {
    // Create subclaim with argument
    const subClaim = makeClaim(db, "Sub claim");
    const subGround = makeGround(db, { content: "Sub ground" });
    makeWarrant(db, subClaim.id, [subGround.id], "Sub warrant");

    // Create parent claim with chain reasoning
    const parentClaim = makeClaim(db, "Parent claim");
    makeChainReasoning(db, parentClaim.id, subClaim.id);

    // Modify subclaim → should find both subClaim and parentClaim
    const affected = findAffectedClaimIds(db, subClaim.id);

    expect(affected).toContain(subClaim.id);
    expect(affected).toContain(parentClaim.id);
  });

  test("链式传播多级：C3 变 → C2, C1 全部发现", () => {
    // C3 (bottom)
    const c3 = makeClaim(db, "C3");
    const g3 = makeGround(db, { content: "G3" });
    makeWarrant(db, c3.id, [g3.id], "W3");

    // C2 (references C3)
    const c2 = makeClaim(db, "C2");
    makeChainReasoning(db, c2.id, c3.id);

    // C1 (references C2)
    const c1 = makeClaim(db, "C1");
    makeChainReasoning(db, c1.id, c2.id);

    // Modify C3 → should find C3, C2, C1
    const affected = findAffectedClaimIds(db, c3.id);

    expect(affected).toContain(c3.id);
    expect(affected).toContain(c2.id);
    expect(affected).toContain(c1.id);
  });

  test("无链式引用时只返回直接受影响的 Claim", () => {
    const claim1 = makeClaim(db, "Claim 1");
    const g1 = makeGround(db, { content: "G1" });
    makeWarrant(db, claim1.id, [g1.id], "W1");

    const claim2 = makeClaim(db, "Claim 2");
    const g2 = makeGround(db, { content: "G2" });
    makeWarrant(db, claim2.id, [g2.id], "W2");

    // Modify g1 → should only find claim1, not claim2
    const affected = findAffectedClaimIds(db, g1.id);

    expect(affected).toContain(claim1.id);
    expect(affected).not.toContain(claim2.id);
  });

  test("Warrant 修改 → 找到其 Claim", () => {
    const { claim, warrant } = seedBasicArgument(db);

    const affected = findAffectedClaimIds(db, warrant.id);

    expect(affected).toContain(claim.id);
  });

  test("Backing 修改 → 找到其 Warrant 的 Claim", () => {
    const { claim, backing } = seedBasicArgument(db);

    const affected = findAffectedClaimIds(db, backing.id);

    expect(affected).toContain(claim.id);
  });

  test("Rebuttal 修改 → 找到目标 Claim", () => {
    const { claim } = seedBasicArgument(db);
    const rebuttal = makeRebuttal(db, claim.id, "claim", "Counter");

    const affected = findAffectedClaimIds(db, rebuttal.id);

    expect(affected).toContain(claim.id);
  });
});

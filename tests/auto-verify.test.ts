/**
 * Toulmin MCP — 自动验证测试
 *
 * 测试 autoVerifyAfterMutation 的逻辑分支（不含 LLM 调用）。
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
} from "./helpers.ts";
import { autoVerifyAfterMutation, findAffectedClaimIds } from "../src/compile-service.ts";
import { computeArgumentHash } from "../src/merkle-hash.ts";
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
// autoVerifyAfterMutation — 无 LLM 分支
// =============================================================================

describe("autoVerifyAfterMutation", () => {
  test("已 compiled 且哈希未变 → no-change", async () => {
    const { claim } = seedBasicArgument(db);
    const argHash = computeArgumentHash(db, claim.id);

    // 将 claim 标记为 compiled 并存储正确的 argument_hash
    repo.setCompileStatus(db, claim.id, "passed");
    repo.saveCompileState(db, claim.id, "passed", "ok", argHash);

    const results = await autoVerifyAfterMutation(db, null, [claim.id]);

    expect(results.length).toBe(1);
    expect(results[0].action).toBe("no-change");
  });

  test("未 compiled 的 Claim → marked-stale", async () => {
    const claim = makeClaim(db, "Uncompiled claim");
    // Don't set compile_status, don't save compile_state

    const results = await autoVerifyAfterMutation(db, null, [claim.id]);

    expect(results.length).toBe(1);
    expect(results[0].action).toBe("marked-stale");

    // Verify compile_status is set to stale
    const data = JSON.parse(repo.getNodeById(db, claim.id)!.data);
    expect(data.compile_status).toBe("stale");
  });

  test("已 compiled 但哈希变化且无 config → marked-stale", async () => {
    const { claim } = seedBasicArgument(db);
    const argHash = computeArgumentHash(db, claim.id);

    // Mark as compiled with old hash
    repo.setCompileStatus(db, claim.id, "passed");
    repo.saveCompileState(db, claim.id, "passed", "ok", argHash);

    // Modify content → hash will change
    repo.updateNodeFields(db, claim.id, { content: "Modified claim" });

    const results = await autoVerifyAfterMutation(db, null, [claim.id]);

    expect(results.length).toBe(1);
    expect(results[0].action).toBe("marked-stale");
    expect(results[0].message).toContain("Review not configured");

    // Verify compile_status is now stale
    const updatedData = JSON.parse(repo.getNodeById(db, claim.id)!.data);
    expect(updatedData.compile_status).toBe("stale");
  });

  test("不存在的 Claim → skipped", async () => {
    const results = await autoVerifyAfterMutation(db, null, [999]);

    expect(results.length).toBe(1);
    expect(results[0].action).toBe("skipped");
  });

  test("多个 Claim 并行处理", async () => {
    const claim1 = makeClaim(db, "Claim 1");
    const claim2 = makeClaim(db, "Claim 2");
    const claim3 = makeClaim(db, "Claim 3");

    const results = await autoVerifyAfterMutation(db, null, [claim1.id, claim2.id, claim3.id]);

    expect(results.length).toBe(3);
    expect(results.every(r => r.action === "marked-stale")).toBe(true);
  });

  test("stale 已设置时不重复设置", async () => {
    const claim = makeClaim(db, "Already stale");
    repo.setCompileStatus(db, claim.id, "stale");

    const results = await autoVerifyAfterMutation(db, null, [claim.id]);

    expect(results[0].action).toBe("marked-stale");
    // compile_status should still be stale
    const updatedData = JSON.parse(repo.getNodeById(db, claim.id)!.data);
    expect(updatedData.compile_status).toBe("stale");
  });

  // ===========================================================================
  // Case 2: 从未审查过 → 结构完整性检测
  // ===========================================================================

  test("未审查 + 结构完整 + 无 config → marked-stale", async () => {
    const { claim } = seedBasicArgument(db);
    // 不设置 compile_state，不设置 compile_status

    const results = await autoVerifyAfterMutation(db, null, [claim.id]);

    expect(results[0].action).toBe("marked-stale");
    expect(results[0].message).toContain("Review not configured");

    const data = JSON.parse(repo.getNodeById(db, claim.id)!.data);
    expect(data.compile_status).toBe("stale");
  });

  test("未审查 + 结构不完整（无 warrant）→ marked-stale", async () => {
    const claim = makeClaim(db, "Bare claim, no warrant");

    const results = await autoVerifyAfterMutation(db, null, [claim.id]);

    expect(results[0].action).toBe("marked-stale");

    const data = JSON.parse(repo.getNodeById(db, claim.id)!.data);
    expect(data.compile_status).toBe("stale");
  });

  test("未审查 + 结构不完整（warrant 无 ground）→ marked-stale", async () => {
    const claim = makeClaim(db, "Claim with empty warrant");
    // 创建 warrant 但不关联 ground
    makeWarrant(db, claim.id, [], "Warrant without grounds");

    const results = await autoVerifyAfterMutation(db, null, [claim.id]);

    expect(results[0].action).toBe("marked-stale");
  });

  // ===========================================================================
  // Case 1 扩展：argumentHash 只代表"上次通过时的哈希"
  // ===========================================================================

  test("failed review (无 argumentHash) + 结构完整 + 无 config → marked-stale", async () => {
    const { claim } = seedBasicArgument(db);

    // 失败的 compile_state 不保存 argumentHash（生产代码行为）
    repo.saveCompileState(db, claim.id, "failed", "Structural error");

    const results = await autoVerifyAfterMutation(db, null, [claim.id]);

    // 无 argumentHash → 不进 Case 1 → 走 Case 2 → 结构完整 + 无 config → marked-stale
    expect(results[0].action).toBe("marked-stale");
    expect(results[0].message).toContain("Review not configured");
  });

  test("failed review (旧数据带 argumentHash) + 哈希未变 → no-change", async () => {
    const { claim } = seedBasicArgument(db);
    const argHash = computeArgumentHash(db, claim.id);

    // 模拟旧数据：带 hash 的 failed 状态（新代码不会产生此状态）
    repo.saveCompileState(db, claim.id, "failed", "Issues found", argHash);

    const results = await autoVerifyAfterMutation(db, null, [claim.id]);

    // prevState.argumentHash 非空 → Case 1 → hash 未变 → no-change
    expect(results[0].action).toBe("no-change");
  });

  test("failed review + 哈希变化 + 无 config → marked-stale（不清除 compiled）", async () => {
    const { claim } = seedBasicArgument(db);
    const argHash = computeArgumentHash(db, claim.id);

    // 存储 failed compile_state
    repo.saveCompileState(db, claim.id, "failed", "Issues found", argHash);

    // 修改 content → 哈希变化
    repo.updateNodeFields(db, claim.id, { content: "Modified claim" });

    const results = await autoVerifyAfterMutation(db, null, [claim.id]);

    expect(results[0].action).toBe("marked-stale");
    expect(results[0].message).toContain("Review not configured");

    // verdict=failed 时 compile_status 设置为 stale
    const data = JSON.parse(repo.getNodeById(db, claim.id)!.data);
    expect(data.compile_status).toBe("stale");
  });

  test("passed review + 哈希变化 + 无 config → 清除 compiled + marked-stale", async () => {
    const { claim } = seedBasicArgument(db);
    const argHash = computeArgumentHash(db, claim.id);

    // 存储 passed compile_state
    repo.setCompileStatus(db, claim.id, "passed");
    repo.saveCompileState(db, claim.id, "passed", "ok", argHash);

    // 修改 content → 哈希变化
    repo.updateNodeFields(db, claim.id, { content: "Modified claim" });

    const results = await autoVerifyAfterMutation(db, null, [claim.id]);

    expect(results[0].action).toBe("marked-stale");

    // passed review 时应将 compile_status 设置为 stale
    const updatedData = JSON.parse(repo.getNodeById(db, claim.id)!.data);
    expect(updatedData.compile_status).toBe("stale");
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

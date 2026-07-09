/**
 * Toulmin MCP — 自动验证测试
 *
 * 测试 autoVerifyAfterMutation 的逻辑分支（不含 LLM 调用）。
 */

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
    const data = JSON.parse(repo.getNodeById(db, claim.id)!.data);
    data.compiled = true;
    data.compiled_at = "2025-01-01";
    repo.updateNodeFields(db, claim.id, { data });
    repo.saveCompileState(db, claim.id, "passed", "ok", {}, argHash);

    const results = await autoVerifyAfterMutation(db, null, [claim.id]);

    expect(results.length).toBe(1);
    expect(results[0].action).toBe("no-change");
  });

  test("未 compiled 的 Claim → marked-stale", async () => {
    const claim = makeClaim(db, "Uncompiled claim");
    // Don't set compiled, don't save compile_state

    const results = await autoVerifyAfterMutation(db, null, [claim.id]);

    expect(results.length).toBe(1);
    expect(results[0].action).toBe("marked-stale");

    // Verify stale flag is set
    const data = JSON.parse(repo.getNodeById(db, claim.id)!.data);
    expect(data.stale).toBe(true);
  });

  test("已 compiled 但哈希变化且无 config → marked-stale", async () => {
    const { claim } = seedBasicArgument(db);
    const argHash = computeArgumentHash(db, claim.id);

    // Mark as compiled with old hash
    const data = JSON.parse(repo.getNodeById(db, claim.id)!.data);
    data.compiled = true;
    data.compiled_at = "2025-01-01";
    repo.updateNodeFields(db, claim.id, { data });
    repo.saveCompileState(db, claim.id, "passed", "ok", {}, argHash);

    // Modify content → hash will change
    repo.updateNodeFields(db, claim.id, { content: "Modified claim" });

    const results = await autoVerifyAfterMutation(db, null, [claim.id]);

    expect(results.length).toBe(1);
    expect(results[0].action).toBe("marked-stale");
    expect(results[0].message).toContain("Review not configured");

    // Verify compiled flag is cleared
    const updatedData = JSON.parse(repo.getNodeById(db, claim.id)!.data);
    expect(updatedData.compiled).toBe(false);
    expect(updatedData.stale).toBe(true);
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
    const data = JSON.parse(repo.getNodeById(db, claim.id)!.data);
    data.stale = true;
    repo.updateNodeFields(db, claim.id, { data });

    const results = await autoVerifyAfterMutation(db, null, [claim.id]);

    expect(results[0].action).toBe("marked-stale");
    // stale should still be true
    const updatedData = JSON.parse(repo.getNodeById(db, claim.id)!.data);
    expect(updatedData.stale).toBe(true);
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

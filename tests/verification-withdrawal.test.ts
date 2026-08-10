/**
 * Warranted — 撤回核实状态后的 status 回退
 *
 * 守的是一条分工：compile 审论证的形式，status 承载"证据够不够"的判断。
 * 撤回一个 Statement 的核实状态不改变论证的形式（节点和指向关系全在），
 * 所以 compile 记录保持不动；垮掉的是 status 的结构依据，所以只有 status 回退。
 *
 * 这条路和 invalidateCompiledClaims 走的不是同一条：那条是结构变动，形式和
 * 充分性判断同时失效，两个都重置。两条路的区别本身就是下面要断言的东西。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  createTestDb, cleanupDb, makeGround, makeWarrant, makeRebuttal,
  makeCompiledClaim, makeChainReasoning, compileVerdictOf,
} from "./helpers.ts";
import { registerTools } from "../src/tools.ts";
import * as repo from "../src/repo.ts";

let db: Database;
let tools: Record<string, { schema: any; handler: Function }>;

function createMockServer() {
  const registered: Record<string, { schema: any; handler: Function }> = {};
  return {
    registerTool(name: string, config: any, handler: Function) {
      registered[name] = { schema: config.inputSchema, handler };
    },
    _tools: registered,
  };
}

beforeEach(() => {
  db = createTestDb();
  const server = createMockServer();
  registerTools(server, db);
  tools = server._tools;
});

afterEach(() => {
  cleanupDb(db);
});

function statusOf(db: Database, claimId: number): string {
  const row = repo.getNodeById(db, claimId)!;
  return JSON.parse(row.data).status || "proposed";
}

/** 给 compile_state 写入 argument_hash，用来断言撤回核实没有清空它。 */
function argumentHashOf(db: Database, claimId: number): string | null {
  const row = db.prepare("SELECT argument_hash FROM compile_state WHERE claim_id = ?")
    .get(claimId) as { argument_hash: string | null } | null;
  return row?.argument_hash ?? null;
}

/** 一条已 compile、已标记 supported 的完整论证。 */
async function makeSupportedClaim(db: Database, tools: Record<string, any>) {
  const claim = makeCompiledClaim(db, "Supported claim", "hash-abc");
  const ground = makeGround(db, { content: "Evidence", verification: "verified", attachments: ["/log.txt"] });
  const warrant = makeWarrant(db, claim.id, [ground.id]);
  const res = await tools.update_node.handler({ node_id: claim.id, status: "supported" });
  expect(res.isError).toBeFalsy();
  expect(statusOf(db, claim.id)).toBe("supported");
  return { claim, ground, warrant };
}

// =============================================================================

describe("撤回核实 — status 回退，compile 记录不动", () => {
  test("W1: 撤回 Ground 的核实 → 依赖它的 supported Claim 退回 proposed", async () => {
    const { claim, ground } = await makeSupportedClaim(db, tools);

    const result = await tools.update_node.handler({ node_id: ground.id, verification: "pending" });

    expect(result.isError).toBeFalsy();
    expect(statusOf(db, claim.id)).toBe("proposed");
  });

  test("W2: 同一次撤回不动 compile 记录 —— verdict 仍是 passed，argument_hash 仍在", async () => {
    const { claim, ground } = await makeSupportedClaim(db, tools);
    expect(argumentHashOf(db, claim.id)).toBe("hash-abc");

    await tools.update_node.handler({ node_id: ground.id, verification: "pending" });

    expect(compileVerdictOf(db, claim.id)).toBe("passed");
    expect(argumentHashOf(db, claim.id)).toBe("hash-abc");
  });

  test("W3: 警告明确说不要重跑 compile", async () => {
    const { claim, ground } = await makeSupportedClaim(db, tools);

    const result = await tools.update_node.handler({ node_id: ground.id, verification: "pending" });
    const text = result.content[0].text;

    expect(text).toContain(`Claim #${claim.id} status reverted from "supported" to "proposed"`);
    expect(text).toContain("do NOT re-run compile_arguments");
    // 结构失效那条路的文案不该出现——它要求重跑 compile，正好相反
    expect(text).not.toContain("compiled status has been cleared");
    expect(text).not.toContain("Re-run compile_arguments and re-assess status when ready");
  });

  test("W4: 警告不带重复的 Warning: 前缀", async () => {
    const { ground } = await makeSupportedClaim(db, tools);

    const result = await tools.update_node.handler({ node_id: ground.id, verification: "pending" });

    // H2 的 revertGroundVerification 走 formatReviewIssues，文案自带前缀，
    // 以前会被前缀两次
    expect(result.content[0].text).not.toContain("Warning: Warning:");
  });

  test("W5: 撤回后重新核实，可以直接标回 supported —— 不必先重跑 compile", async () => {
    const { claim, ground } = await makeSupportedClaim(db, tools);
    await tools.update_node.handler({ node_id: ground.id, verification: "pending" });
    expect(statusOf(db, claim.id)).toBe("proposed");

    await tools.update_node.handler({ node_id: ground.id, verification: "verified" });
    // A0 要求 passed 的 compile 记录；记录留着，所以这一步不需要 compile_arguments
    const result = await tools.update_node.handler({ node_id: claim.id, status: "supported" });

    expect(result.isError).toBeFalsy();
    expect(statusOf(db, claim.id)).toBe("supported");
  });
});

describe("撤回核实 — 只在门禁真的不成立时回退", () => {
  test("W6: 另一条 Warrant 的 Ground 全部已核实 → 不回退", async () => {
    const claim = makeCompiledClaim(db, "Claim with two warrants", "hash-two");
    const groundA = makeGround(db, { content: "Evidence A", verification: "verified", attachments: ["/a.txt"] });
    const groundB = makeGround(db, { content: "Evidence B", verification: "verified", attachments: ["/b.txt"] });
    makeWarrant(db, claim.id, [groundA.id], "Warrant A");
    makeWarrant(db, claim.id, [groundB.id], "Warrant B");
    await tools.update_node.handler({ node_id: claim.id, status: "supported" });
    expect(statusOf(db, claim.id)).toBe("supported");

    // A1 只要求"某一条 Warrant 的 Ground 全部已核实"，Warrant B 依然满足
    const result = await tools.update_node.handler({ node_id: groundA.id, verification: "pending" });

    expect(statusOf(db, claim.id)).toBe("supported");
    expect(result.content[0].text).not.toContain("status reverted");
  });

  test("W7: 撤回 Backing 的核实 → 不回退（今天没有门禁读 Backing 的核实状态）", async () => {
    const { claim, warrant } = await makeSupportedClaim(db, tools);
    const backing = makeGround(db, { content: "Backing", verification: "verified", attachments: ["/b.txt"] });
    db.prepare("INSERT OR IGNORE INTO warrant_backings (warrant_id, statement_id) VALUES (?, ?)")
      .run(warrant.id, backing.id);

    const result = await tools.update_node.handler({ node_id: backing.id, verification: "pending" });

    expect(statusOf(db, claim.id)).toBe("supported");
    expect(result.content[0].text).not.toContain("status reverted");
  });

  test("W8: 本来就是 pending 的 Statement 再写一次 pending → 什么都不回退", async () => {
    const claim = makeCompiledClaim(db, "Claim", "hash-x");
    const verified = makeGround(db, { content: "Verified", verification: "verified", attachments: ["/v.txt"] });
    const pending = makeGround(db, { content: "Pending", verification: "pending" });
    makeWarrant(db, claim.id, [verified.id], "Warrant A");
    makeWarrant(db, claim.id, [pending.id], "Warrant B");
    await tools.update_node.handler({ node_id: claim.id, status: "supported" });

    const result = await tools.update_node.handler({ node_id: pending.id, verification: "pending" });

    expect(statusOf(db, claim.id)).toBe("supported");
    expect(result.content[0].text).not.toContain("status reverted");
  });
});

describe("撤回核实 — Rebuttal 侧对称", () => {
  test("W9: 撤回 Rebuttal 的核实 → disputed 退回 proposed，compile 记录不动", async () => {
    const claim = makeCompiledClaim(db, "Contested claim", "hash-r");
    const ground = makeGround(db, { content: "Evidence", verification: "verified", attachments: ["/e.txt"] });
    makeWarrant(db, claim.id, [ground.id]);
    const rebuttal = makeRebuttal(db, claim.id, "claim", "Counter-evidence", ["/c.txt"], "verified");
    await tools.update_node.handler({ node_id: claim.id, status: "disputed" });
    expect(statusOf(db, claim.id)).toBe("disputed");

    // A3/A4 要求存在已核实的 Rebuttal —— 撤回它，依据就没了
    const result = await tools.update_node.handler({ node_id: rebuttal.id, verification: "pending" });

    expect(statusOf(db, claim.id)).toBe("proposed");
    expect(compileVerdictOf(db, claim.id)).toBe("passed");
    expect(result.content[0].text).toContain("do NOT re-run compile_arguments");
  });

  test("W10: 撤回 Rebuttal 的核实 → refuted 退回 proposed", async () => {
    const claim = makeCompiledClaim(db, "Refuted claim", "hash-r2");
    const ground = makeGround(db, { content: "Evidence", verification: "verified", attachments: ["/e.txt"] });
    makeWarrant(db, claim.id, [ground.id]);
    const rebuttal = makeRebuttal(db, claim.id, "claim", "Disproof", ["/d.txt"], "verified");
    await tools.update_node.handler({ node_id: claim.id, status: "refuted" });

    await tools.update_node.handler({ node_id: rebuttal.id, verification: "pending" });

    expect(statusOf(db, claim.id)).toBe("proposed");
    expect(compileVerdictOf(db, claim.id)).toBe("passed");
  });

  test("W11: 还有另一条已核实的 Rebuttal → disputed 不回退", async () => {
    const claim = makeCompiledClaim(db, "Contested claim", "hash-r3");
    const ground = makeGround(db, { content: "Evidence", verification: "verified", attachments: ["/e.txt"] });
    makeWarrant(db, claim.id, [ground.id]);
    const r1 = makeRebuttal(db, claim.id, "claim", "Counter 1", ["/c1.txt"], "verified");
    makeRebuttal(db, claim.id, "claim", "Counter 2", ["/c2.txt"], "verified");
    await tools.update_node.handler({ node_id: claim.id, status: "disputed" });

    await tools.update_node.handler({ node_id: r1.id, verification: "pending" });

    expect(statusOf(db, claim.id)).toBe("disputed");
  });
});

describe("撤回核实 — 向上传播", () => {
  test("W12: 子 Claim 退回 proposed → 父 Claim 也退回，两者 compile 记录都不动", async () => {
    // 子：Claim ← Warrant ← Ground(verified)
    const child = makeCompiledClaim(db, "Sub-claim", "hash-child");
    const ground = makeGround(db, { content: "Evidence", verification: "verified", attachments: ["/e.txt"] });
    makeWarrant(db, child.id, [ground.id], "Sub warrant");
    await tools.update_node.handler({ node_id: child.id, status: "supported" });

    // 父：Claim ← Warrant ← 子 Claim（链式推理）
    const parent = makeCompiledClaim(db, "Root claim", "hash-parent");
    makeChainReasoning(db, parent.id, child.id);
    await tools.update_node.handler({ node_id: parent.id, status: "supported" });
    expect(statusOf(db, parent.id)).toBe("supported");

    const result = await tools.update_node.handler({ node_id: ground.id, verification: "pending" });

    // 子退回后按规则 C′ 不再算已核实的 Ground，父的 A1 也不成立了
    expect(statusOf(db, child.id)).toBe("proposed");
    expect(statusOf(db, parent.id)).toBe("proposed");
    expect(compileVerdictOf(db, child.id)).toBe("passed");
    expect(compileVerdictOf(db, parent.id)).toBe("passed");
    expect(argumentHashOf(db, parent.id)).toBe("hash-parent");
    expect(result.content[0].text).toContain(`Claim #${parent.id} status reverted`);
  });

  test("W13: 子 Claim 没退 → 父 Claim 不受影响", async () => {
    const child = makeCompiledClaim(db, "Sub-claim", "hash-child");
    const groundA = makeGround(db, { content: "Evidence A", verification: "verified", attachments: ["/a.txt"] });
    const groundB = makeGround(db, { content: "Evidence B", verification: "verified", attachments: ["/b.txt"] });
    makeWarrant(db, child.id, [groundA.id], "Sub warrant A");
    makeWarrant(db, child.id, [groundB.id], "Sub warrant B");
    await tools.update_node.handler({ node_id: child.id, status: "supported" });

    const parent = makeCompiledClaim(db, "Root claim", "hash-parent");
    makeChainReasoning(db, parent.id, child.id);
    await tools.update_node.handler({ node_id: parent.id, status: "supported" });

    // 子还有 Warrant B 撑着，不退；父也就不该受影响
    await tools.update_node.handler({ node_id: groundA.id, verification: "pending" });

    expect(statusOf(db, child.id)).toBe("supported");
    expect(statusOf(db, parent.id)).toBe("supported");
  });
});

describe("撤回核实 — 与结构变动同时发生", () => {
  test("W14: 同一次调用还改了正文 → 走结构失效那条路，compile 记录标 stale，status 只回退一次", async () => {
    const { claim, ground } = await makeSupportedClaim(db, tools);

    const result = await tools.update_node.handler({
      node_id: ground.id,
      content: "Rewritten evidence",
      verification: "pending",
    });

    // 正文变了，论证的形式确实变了，这时该 stale
    expect(compileVerdictOf(db, claim.id)).toBe("stale");
    expect(statusOf(db, claim.id)).toBe("proposed");
    // 结构那条路已经把 status 退了，撤回核实这条路的复检会跳过，不重复报警
    const revertCount = result.content[0].text.split("status reverted").length - 1;
    expect(revertCount).toBe(1);
  });
});

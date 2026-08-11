/**
 * Warranted — compile 没通过之后的 status 回退
 *
 * 守的是 A0 那条结构规则：非 proposed 的 status 必须有一条通过的 compile 记录。
 * 以前这条规则只在写入那一刻查一次，于是"先定成 supported、之后 compile 没过"会留下
 * A0 自己都不允许的组合。现在 compile 跑完会补这一刀，规则随时都成立。
 *
 * 和 verification-withdrawal 那条路的区别是这里要断言的重点：那条是"论证的形式没变，
 * 不要重跑 compile"，这条正相反——是 compile 自己没通过，重跑正是下一步。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  createTestDb, cleanupDb, makeGround, makeWarrant,
  makeCompiledClaim, makeChainReasoning, compileVerdictOf,
} from "./helpers.ts";
import { registerTools } from "../src/tools.ts";
import { hasWarrantWithAllGroundsVerified } from "../src/service.ts";
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
  // reviewConfig=null：不需要模型也能走到"结构检查没过"的结局，回退与模型无关。
  registerTools(server, db);
  tools = server._tools;
});

afterEach(() => cleanupDb(db));

function statusOf(claimId: number): string {
  const row = repo.getNodeById(db, claimId)!;
  return JSON.parse(row.data).status ?? "proposed";
}

async function compile(ids: number[]): Promise<string> {
  const res = await tools.compile_arguments.handler({ claim_ids: ids });
  return res.content[0].text as string;
}

describe("compile 没通过 → status 退回 proposed", () => {
  test("supported 的 Claim 在 compile 落成 stale 之后退回 proposed 并报警告", async () => {
    // 有一条 passed 记录、状态已定成 supported，但结构其实是残的（没有 Warrant）。
    // 指纹给一个对不上的值，逼它重新判定而不是走 no-change。
    const claim = makeCompiledClaim(db, "Verdict outlives its compile", "outdated-hash");
    repo.setClaimStatus(db, claim.id, "supported");

    const text = await compile([claim.id]);

    expect(statusOf(claim.id)).toBe("proposed");
    expect(compileVerdictOf(db, claim.id)).toBe("stale");
    expect(text).toContain(`Claim #${claim.id} status reverted from "supported" to "proposed"`);
    expect(text).toContain('compile verdict is now "stale"');
    expect(text).toContain("re-run compile_arguments");
  });

  test("compile 通过时不动 status", async () => {
    const claim = makeCompiledClaim(db, "Well-founded claim");
    const ground = makeGround(db, { content: "Verified evidence", verification: "verified" });
    makeWarrant(db, claim.id, [ground.id]);

    // 第一次 compile 把结构指纹存下来，之后才定状态。
    await compile([claim.id]);
    repo.setClaimStatus(db, claim.id, "supported");

    const text = await compile([claim.id]);

    expect(statusOf(claim.id)).toBe("supported");
    expect(compileVerdictOf(db, claim.id)).toBe("passed");
    expect(text).not.toContain("reverted");
  });

  test("回退沿规则 C′ 往上传：上层 Claim 的依据跟着垮", async () => {
    const child = makeCompiledClaim(db, "Lower claim", "outdated-hash");
    repo.setClaimStatus(db, child.id, "supported");

    const parent = makeCompiledClaim(db, "Upper claim", "parent-hash");
    makeChainReasoning(db, parent.id, child.id);
    repo.setClaimStatus(db, parent.id, "supported");

    // 只 compile 下层：上层是被"这条 Claim 不再算已核实的证据"连带的。
    const text = await compile([child.id]);

    expect(statusOf(child.id)).toBe("proposed");
    expect(statusOf(parent.id)).toBe("proposed");
    // 上层报的是就近的原因，不是"compile 没通过"。
    expect(text).toContain(`Claim #${parent.id} status reverted from "supported" to "proposed"`);
    expect(text).toContain(`Claim #${child.id}, used as a Ground here, no longer counts as verified evidence`);
    // 上层的论证形式一个字没变，它的 compile 记录不该被动。
    expect(compileVerdictOf(db, parent.id)).toBe("passed");
  });

  test("本来就是 proposed 的 Claim 不报回退警告", async () => {
    const claim = makeCompiledClaim(db, "Never settled", "outdated-hash");

    const text = await compile([claim.id]);

    expect(statusOf(claim.id)).toBe("proposed");
    expect(text).not.toContain("reverted");
  });
});

describe("A1 判据：不满足时必须说出为什么", () => {
  // blockers 会被调用点拼在破折号后面，空数组就会印出一句以 "— " 结尾的半句话。
  test("一条 Warrant 都没有", () => {
    const claim = makeCompiledClaim(db, "No warrants at all");
    const result = hasWarrantWithAllGroundsVerified(db, claim.id);
    expect(result.satisfied).toBe(false);
    expect(result.blockers).toEqual([`Claim #${claim.id} has no Warrants`]);
  });

  test("Warrant 存在但没挂 Ground", () => {
    const claim = makeCompiledClaim(db, "Warrant without grounds");
    const warrant = makeWarrant(db, claim.id, []);
    const result = hasWarrantWithAllGroundsVerified(db, claim.id);
    expect(result.satisfied).toBe(false);
    expect(result.blockers).toEqual([`Warrant #${warrant.id}: no Grounds attached`]);
  });

  test("Ground 没核实时仍然指名是哪条 Warrant 的哪个 Ground", () => {
    const claim = makeCompiledClaim(db, "Pending ground");
    const ground = makeGround(db, { content: "Not yet verified", verification: "pending" });
    const warrant = makeWarrant(db, claim.id, [ground.id]);
    const result = hasWarrantWithAllGroundsVerified(db, claim.id);
    expect(result.satisfied).toBe(false);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]).toContain(`Warrant #${warrant.id}`);
    expect(result.blockers[0]).toContain(`#${ground.id}`);
  });
});

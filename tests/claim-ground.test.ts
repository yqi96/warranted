/**
 * Toulmin MCP — claim 型 Ground（多层 DAG）的判定规则
 *
 * 对应设计文档 `.omc/plans/0.5.0/pr2.5-correctness.md`。
 *
 * 本文件锁死的是 **rule C′**：
 *   claim 型 Ground 算"已验证" ⟺ 它自身的 status ∈ {supported, disputed}。
 *
 * 与之竞争的 **rule B**（只认 supported）在 S1 / S3 下与 C′ 同为绿，
 * **S2 是两者唯一的分道处** —— 一个诚实记录了证据冲突的图（某个下层结论
 * disputed），在 rule B 下永远无法向上定案，于是它逼着使用者要么删掉
 * Rebuttal、要么谎报 status。删掉 S2 的三条断言，rule C′ 就会被下一个人
 * 当成笔误改回 B（这已经发生过一次，见 commit 3f41b42）。
 *
 * refuted 被排除在外是有理由的、不是遗漏：它是唯一有便宜替代结构的状态
 * （改挂"该族存在"的窄 Claim），disputed 没有退路。
 *
 * ── 本文件覆盖的验收项（pr2.5-correctness.md §8）─────────────────────
 *   S1–S5（判据本身 + 配套 1/4/5）、§1.6.1 的 null-config 不变式守卫、
 *   §3.3 的 hash 短路、§2 的 rebuttal_for 失效、§4 的 mapLimit 并发上限。
 * PR2.5 落地后全绿；S2 若变红，说明有人把判据改回了 rule B。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  createTestDb,
  cleanupDb,
  makeClaim,
  makeGround,
  makeWarrant,
  makeBacking,
  makeRebuttal,
} from "./helpers.ts";
import * as repo from "../src/repo.ts";
import * as service from "../src/service.ts";
import * as compileService from "../src/compile-service.ts";
import { computeArgumentHash } from "../src/merkle-hash.ts";
import { mapLimit } from "../src/concurrency.ts";
import { registerTools } from "../src/tools.ts";
import type { ClaimNode, WarrantNode } from "../src/types.ts";

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

// =============================================================================
// 本地辅助
// =============================================================================

function dataOf(nodeId: number): any {
  const row = repo.getNodeById(db, nodeId);
  if (!row) throw new Error(`node #${nodeId} not found`);
  return JSON.parse(row.data);
}

/** 把一个 Claim 置为"已 compile 通过"（含与当前图一致的 argumentHash）。 */
function markCompiled(claimId: number): void {
  repo.saveCompileState(db, claimId, "passed", "test compile", computeArgumentHash(db, claimId));
  repo.setCompileStatus(db, claimId, "passed");
}

interface TwoLayer {
  root: ClaimNode;
  rootWarrant: WarrantNode;
  subA: ClaimNode;
  subB: ClaimNode;
}

/**
 * 两层 DAG：
 *   root ← W_root ← [subA, subB]           （claim 型 Ground）
 *   subA ← W_A ← gA(verified statement)
 *   subB ← W_B ← gB(verified statement)
 *
 * 只建结构，不定任何 status —— 定状态的顺序由各用例自己控制（自底向上）。
 */
function buildTwoLayer(): TwoLayer {
  const subA = makeClaim(db, "子结论 A：方法在数据集 1 上有效");
  const gA = makeGround(db, {
    content: "数据集 1 实验记录",
    source: "observed",
    verification: "verified",
    attachments: ["/data/exp-a.csv"],
  });
  const wA = makeWarrant(db, subA.id, [gA.id], "A 的论证");
  makeBacking(db, wA.id, "A 的方法论依据", ["/papers/a.pdf"]);

  const subB = makeClaim(db, "子结论 B：方法在数据集 2 上有效");
  const gB = makeGround(db, {
    content: "数据集 2 实验记录",
    source: "observed",
    verification: "verified",
    attachments: ["/data/exp-b.csv"],
  });
  const wB = makeWarrant(db, subB.id, [gB.id], "B 的论证");
  makeBacking(db, wB.id, "B 的方法论依据", ["/papers/b.pdf"]);

  const root = makeClaim(db, "根结论：方法具有跨数据集有效性");
  const rootWarrant = makeWarrant(db, root.id, [subA.id, subB.id], "两个数据集一致 → 跨数据集有效");
  makeBacking(db, rootWarrant.id, "跨数据集一致性方法论", ["/papers/methodology.pdf"]);

  return { root, rootWarrant, subA, subB };
}

/** 把一个子 Claim 定成 supported（先 compile 再定状态）。 */
function settleSupported(claimId: number): void {
  markCompiled(claimId);
  service.updateNode(db, claimId, { status: "supported" });
}

/** 把一个子 Claim 定成 disputed / refuted（需要先有 Rebuttal）。 */
function settleContested(claimId: number, status: "disputed" | "refuted"): void {
  makeRebuttal(db, claimId, "claim", `针对 #${claimId} 的反驳`, ["/data/counter.csv"]);
  markCompiled(claimId);
  service.updateNode(db, claimId, { status });
}

// =============================================================================
// S1 — 子 Claim 全 supported ⇒ 根可以 supported
// =============================================================================

describe("S1：子 Claim 全 supported，根可以 supported", () => {
  test("根成功标为 supported", () => {
    const { root, subA, subB } = buildTwoLayer();
    settleSupported(subA.id);
    settleSupported(subB.id);
    markCompiled(root.id);

    expect(() => service.updateNode(db, root.id, { status: "supported" })).not.toThrow();
    expect(dataOf(root.id).status).toBe("supported");
  });

  test("isGroundVerified 对 supported 的 claim 型 Ground 返回 true", () => {
    const { subA } = buildTwoLayer();
    settleSupported(subA.id);
    expect(service.isGroundVerified(repo.getNodeById(db, subA.id)!)).toBe(true);
  });

  test("子 Claim 还是 proposed 时根不能 supported", () => {
    const { root, subA, subB } = buildTwoLayer();
    settleSupported(subA.id);
    // subB 保持 proposed
    markCompiled(root.id);

    expect(() => service.updateNode(db, root.id, { status: "supported" })).toThrow();
    expect(dataOf(root.id).status).toBe("proposed");
  });
});

// =============================================================================
// S2 — rule B 与 rule C′ 的唯一分道处
// =============================================================================

describe("S2：一个子 Claim disputed、其余 supported（rule C′ 的分道处）", () => {
  test("【rule C′】根仍然可以 supported —— disputed 的子结论算已验证", () => {
    const { root, subA, subB } = buildTwoLayer();
    settleSupported(subA.id);
    settleContested(subB.id, "disputed");
    markCompiled(root.id);

    expect(() => service.updateNode(db, root.id, { status: "supported" })).not.toThrow();
    expect(dataOf(root.id).status).toBe("supported");
  });

  test("【rule C′】isGroundVerified 对 disputed 的 claim 型 Ground 返回 true", () => {
    const { subB } = buildTwoLayer();
    settleContested(subB.id, "disputed");
    expect(service.isGroundVerified(repo.getNodeById(db, subB.id)!)).toBe(true);
  });

  test("根自身没有 Rebuttal 时不能 disputed（A3 不因下层争议而放松）", () => {
    const { root, subA, subB } = buildTwoLayer();
    settleSupported(subA.id);
    settleContested(subB.id, "disputed");
    markCompiled(root.id);

    expect(() => service.updateNode(db, root.id, { status: "disputed" })).toThrow(
      /no Rebuttals exist targeting this Claim/
    );
    expect(dataOf(root.id).status).toBe("proposed");
  });

  test("根自身有 Rebuttal 时才能 disputed", () => {
    const { root, subA, subB } = buildTwoLayer();
    settleSupported(subA.id);
    settleContested(subB.id, "disputed");
    makeRebuttal(db, root.id, "claim", "针对根结论的反驳", ["/data/root-counter.csv"]);
    markCompiled(root.id);

    expect(() => service.updateNode(db, root.id, { status: "disputed" })).not.toThrow();
    expect(dataOf(root.id).status).toBe("disputed");
  });
});

// =============================================================================
// S3 — refuted 的子 Claim 不能承重
// =============================================================================

describe("S3：一个子 Claim refuted，根不能 supported", () => {
  test("根标 supported 抛错", () => {
    const { root, subA, subB } = buildTwoLayer();
    settleSupported(subA.id);
    settleContested(subB.id, "refuted");
    markCompiled(root.id);

    expect(() => service.updateNode(db, root.id, { status: "supported" })).toThrow();
    expect(dataOf(root.id).status).toBe("proposed");
  });

  test("isGroundVerified 对 refuted 的 claim 型 Ground 返回 false", () => {
    const { subB } = buildTwoLayer();
    settleContested(subB.id, "refuted");
    expect(service.isGroundVerified(repo.getNodeById(db, subB.id)!)).toBe(false);
  });

  test("改挂一条能存活的窄 Claim 之后根可以 supported（refuted 的替代结构存在）", () => {
    const { root, rootWarrant, subA, subB } = buildTwoLayer();
    settleSupported(subA.id);
    settleContested(subB.id, "refuted");

    // 用"该族存在"的窄 Claim 替换被推翻的那条 —— 这正是 refuted 与 disputed 的区别
    const narrow = makeClaim(db, "子结论 B′：方法在数据集 2 的子集上有效");
    const gN = makeGround(db, {
      content: "数据集 2 子集实验记录",
      source: "observed",
      verification: "verified",
      attachments: ["/data/exp-b-subset.csv"],
    });
    makeWarrant(db, narrow.id, [gN.id], "B′ 的论证");
    settleSupported(narrow.id);

    service.updateNode(db, rootWarrant.id, {
      ground_ids: { add: [narrow.id], remove: [subB.id] },
    });
    markCompiled(root.id);

    expect(() => service.updateNode(db, root.id, { status: "supported" })).not.toThrow();
  });
});

// =============================================================================
// S4 — 配套 1：claim status 变更纳入向上失效
// =============================================================================

describe("S4：根 supported 之后下层降级，根退回 proposed（配套 1）", () => {
  test("下层 supported → proposed 会把根打回 proposed + stale", async () => {
    const { root, subA, subB } = buildTwoLayer();
    settleSupported(subA.id);
    settleSupported(subB.id);
    markCompiled(root.id);
    service.updateNode(db, root.id, { status: "supported" });
    expect(dataOf(root.id).status).toBe("supported");

    await tools.update_node.handler({ node_id: subA.id, status: "proposed" });

    expect(dataOf(root.id).status).toBe("proposed");
    expect(dataOf(root.id).compile_status).toBe("stale");
  });

  test("排除起点自身：被改状态的那个 Claim 自己的 compile 不被撤销", async () => {
    const { root, subA, subB } = buildTwoLayer();
    settleSupported(subA.id);
    settleSupported(subB.id);
    markCompiled(root.id);
    service.updateNode(db, root.id, { status: "supported" });

    await tools.update_node.handler({ node_id: subA.id, status: "proposed" });

    // 起点自身若不排除，"定状态"这个动作会把刚设好的 status 自我撤销
    expect(dataOf(subA.id).status).toBe("proposed");
    expect(dataOf(subA.id).compile_status).toBe("passed");
  });

  test("排除起点只对纯 status 变更成立：同一次调用还改了 content 时起点照常失效", async () => {
    const { root, subA, subB } = buildTwoLayer();
    settleSupported(subA.id);
    settleSupported(subB.id);
    markCompiled(root.id);
    service.updateNode(db, root.id, { status: "supported" });

    // content 与 status 同批改动：content 改了就说明 subA 自己的 compile 依据已作废，
    // "排除起点"的豁免不能顺带把它一起放过。
    await tools.update_node.handler({
      node_id: subA.id,
      status: "proposed",
      content: "子结论 A（改写）：方法在数据集 1 上有效",
    });

    expect(dataOf(subA.id).compile_status).toBe("stale");
    expect(repo.getCompileState(db, subA.id)).toBeNull();
    expect(dataOf(root.id).compile_status).toBe("stale");
  });

  test("排除起点只对纯 status 变更成立：同一次调用还改了 ground_ids 时起点照常失效", async () => {
    const { root, subA, subB } = buildTwoLayer();
    settleSupported(subA.id);
    settleSupported(subB.id);
    markCompiled(root.id);
    service.updateNode(db, root.id, { status: "supported" });

    const extra = makeGround(db, {
      content: "数据集 1 的补充实验记录",
      source: "observed",
      verification: "verified",
      attachments: ["/data/exp-a2.csv"],
    });
    const wA = repo.findWarrantsByClaim(db, subA.id)[0];

    await tools.update_node.handler({
      node_id: wA.id,
      ground_ids: { add: [extra.id] },
    });
    markCompiled(subA.id);
    service.updateNode(db, subA.id, { status: "supported" });
    markCompiled(root.id);
    service.updateNode(db, root.id, { status: "supported" });

    await tools.update_node.handler({
      node_id: subA.id,
      status: "proposed",
      rebuttal_ids: { add: [makeGround(db, {
        content: "对子结论 A 的反例",
        source: "observed",
        verification: "verified",
        attachments: ["/data/counter-a.csv"],
      }).id] },
    });

    expect(dataOf(subA.id).compile_status).toBe("stale");
    expect(repo.getCompileState(db, subA.id)).toBeNull();
  });

  test("按新旧值实际变更触发，不按参数 presence：同值重述不失效根", async () => {
    const { root, subA, subB } = buildTwoLayer();
    settleSupported(subA.id);
    settleSupported(subB.id);
    markCompiled(root.id);
    service.updateNode(db, root.id, { status: "supported" });

    // 对一个已 supported 的下层 Claim 重述同一个值 —— 图状态没变，不该触发重编译
    await tools.update_node.handler({ node_id: subA.id, status: "supported" });

    expect(dataOf(root.id).status).toBe("supported");
    expect(dataOf(root.id).compile_status).toBe("passed");
  });

  test("下层升级（proposed → supported）同样触发向上失效", async () => {
    const { root, subA, subB } = buildTwoLayer();
    settleSupported(subA.id);
    settleSupported(subB.id);
    markCompiled(root.id);
    service.updateNode(db, root.id, { status: "supported" });

    // 先降级再升级：第二次也是实际值变更，根必须重新 compile 才能再定案
    await tools.update_node.handler({ node_id: subA.id, status: "proposed" });
    markCompiled(subA.id);
    await tools.update_node.handler({ node_id: subA.id, status: "supported" });

    expect(dataOf(root.id).compile_status).toBe("stale");
    expect(() => service.updateNode(db, root.id, { status: "supported" })).toThrow(
      /has not been compiled or is stale/
    );
  });

  test("多层传播：孙层降级会一路失效到根", async () => {
    const { root, subA, subB } = buildTwoLayer();
    // 在 subA 下面再插一层：subA ← W_A2 ← grandchild
    const grand = makeClaim(db, "孙层结论");
    const gG = makeGround(db, {
      content: "孙层证据",
      source: "observed",
      verification: "verified",
      attachments: ["/data/g.csv"],
    });
    makeWarrant(db, grand.id, [gG.id], "孙层论证");
    makeWarrant(db, subA.id, [grand.id], "subA 由孙层结论支撑");

    settleSupported(grand.id);
    settleSupported(subA.id);
    settleSupported(subB.id);
    markCompiled(root.id);
    service.updateNode(db, root.id, { status: "supported" });

    await tools.update_node.handler({ node_id: grand.id, status: "proposed" });

    expect(dataOf(subA.id).status).toBe("proposed");
    expect(dataOf(root.id).status).toBe("proposed");
  });
});

// =============================================================================
// S5 + 配套 5 — claim 型 Ground 按 status 分支出 warning
// =============================================================================

describe("S5：claim 型 Ground 的 compile warning 输出实际 status（配套 5）", () => {
  test("proposed 的子 Claim → 'has no verdict yet'", () => {
    const { root, subA, subB } = buildTwoLayer();
    settleSupported(subB.id);
    // subA 保持 proposed
    const result = compileService.structuralQualityCheck(db, root.id);
    const text = result.warnings.join("\n");

    expect(text).toContain(`Ground Claim #${subA.id} has no verdict yet`);
    expect(text).toContain("settle it");
  });

  test("refuted 的子 Claim → 'is refuted'，处方是改挂而不是补证据", () => {
    const { root, subA, subB } = buildTwoLayer();
    settleSupported(subA.id);
    settleContested(subB.id, "refuted");

    const text = compileService.structuralQualityCheck(db, root.id).warnings.join("\n");

    expect(text).toContain(`Ground Claim #${subB.id} is refuted`);
    expect(text).toContain("reground");
  });

  test("disputed 的子 Claim → 输出实际 status，且不得出现字面 'proposed'", () => {
    const { root, subA, subB } = buildTwoLayer();
    settleSupported(subA.id);
    settleContested(subB.id, "disputed");
    markCompiled(root.id);
    service.updateNode(db, root.id, { status: "supported" });

    const result = compileService.structuralQualityCheck(db, root.id);
    const text = [...result.errors, ...result.warnings, ...(result.infos ?? [])].join("\n");

    expect(text).toContain(`Ground Claim #${subB.id} is disputed`);
    // 硬编码 "proposed" 在 disputed 场景下是假话：节点指对了，理由是假的
    expect(text).not.toContain("proposed");
  });

  test("disputed 分支是 rule C′ 在确定性通道上的唯一留痕：它不挡路但必须在", () => {
    const { root, subA, subB } = buildTwoLayer();
    settleSupported(subA.id);
    settleContested(subB.id, "disputed");
    markCompiled(root.id);

    // 不挡路：C′ 下这条 Ground 通过判定，C4 不报错
    const result = compileService.structuralQualityCheck(db, root.id);
    expect(result.errors).toEqual([]);
    // 但仍要留痕
    expect(result.warnings.join("\n")).toContain(`#${subB.id} is disputed`);
  });

  test("全部子 Claim 都满足判据时不出 claim 型 Ground 的 warning", () => {
    const { root, subA, subB } = buildTwoLayer();
    settleSupported(subA.id);
    settleSupported(subB.id);

    const text = compileService.structuralQualityCheck(db, root.id).warnings.join("\n");
    expect(text).not.toContain("Ground Claim #");
  });
});

// =============================================================================
// 配套 4 — A1 报错文案按 status 报，不是 "not supported"
// =============================================================================

describe("配套 4：A1 报错对 claim 型 Ground 给可执行的处方", () => {
  test("proposed 的子 Claim → 报错说 'has no verdict yet'", () => {
    const { root, subA, subB } = buildTwoLayer();
    settleSupported(subB.id);
    markCompiled(root.id);

    let message = "";
    try {
      service.updateNode(db, root.id, { status: "supported" });
    } catch (e) {
      message = (e as Error).message;
    }

    expect(message).toContain(`Ground Claim #${subA.id} has no verdict yet`);
    // "Verify the Grounds first." 在上层是不可执行的处方：Ground 全是 Claim，没有一条可以 verify
    expect(message).not.toContain("Verify the Grounds first");
  });

  test("refuted 的子 Claim → 报错说 'is refuted — reground'", () => {
    const { root, subA, subB } = buildTwoLayer();
    settleSupported(subA.id);
    settleContested(subB.id, "refuted");
    markCompiled(root.id);

    let message = "";
    try {
      service.updateNode(db, root.id, { status: "supported" });
    } catch (e) {
      message = (e as Error).message;
    }

    expect(message).toContain(`Ground Claim #${subB.id} is refuted`);
    expect(message).toContain("reground");
  });

  test("statement 型 Ground 的报错文案不变", () => {
    const claim = makeClaim(db, "单层结论");
    const g = makeGround(db, { content: "待验证据", verification: "pending" });
    makeWarrant(db, claim.id, [g.id], "论证");
    markCompiled(claim.id);

    let message = "";
    try {
      service.updateNode(db, claim.id, { status: "supported" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(`Ground #${g.id} not verified`);
  });
});

// =============================================================================
// §1.6.1 — 不变式守卫：未经链审查的 compile 不可能通过
// =============================================================================

describe("§1.6.1 不变式：config === null 的 compileClaims 不产生 compile_status = passed", () => {
  test("结构完整但无 reviewConfig → marked-stale，不是 passed", async () => {
    const claim = makeClaim(db, "结构完整的结论");
    const g = makeGround(db, {
      content: "证据",
      source: "observed",
      verification: "verified",
      attachments: ["/data/e.csv"],
    });
    const w = makeWarrant(db, claim.id, [g.id], "论证");
    makeBacking(db, w.id, "依据", ["/papers/x.pdf"]);

    const results = await compileService.compileClaims(db, null, [claim.id]);

    expect(results[0].action).toBe("marked-stale");
    expect(dataOf(claim.id).compile_status).not.toBe("passed");
  });

  test("结构不完整且无 reviewConfig → 同样不是 passed", async () => {
    const claim = makeClaim(db, "没有 Warrant 的结论");
    const results = await compileService.compileClaims(db, null, [claim.id]);

    expect(results[0].action).toBe("marked-stale");
    expect(dataOf(claim.id).compile_status).not.toBe("passed");
  });

  test("多层 DAG 上，null config 不会让任何一层变成 passed", async () => {
    const { root, subA, subB } = buildTwoLayer();
    const results = await compileService.compileClaims(db, null, [root.id, subA.id, subB.id]);

    for (const r of results) {
      expect(r.action).not.toBe("auto-reviewed");
    }
    for (const id of [root.id, subA.id, subB.id]) {
      expect(dataOf(id).compile_status).not.toBe("passed");
    }
  });

  test("A0 兜底：未 compile 的 Claim 无论如何过不了 status 迁移", async () => {
    const { root } = buildTwoLayer();
    await compileService.compileClaims(db, null, [root.id]);

    expect(() => service.updateNode(db, root.id, { status: "supported" })).toThrow(
      /has not been compiled or is stale/
    );
  });
});

// =============================================================================
// §3.3 — hash 短路路径也要跑结构检查
// =============================================================================

describe("§3.3：no-change 短路不得跳过结构检查", () => {
  test("Ground 退回 pending 之后 compile 必须报 C4 error", async () => {
    const claim = makeClaim(db, "被短路掩盖的结论");
    const g1 = makeGround(db, {
      content: "证据 1",
      source: "observed",
      verification: "verified",
      attachments: ["/data/1.csv"],
    });
    const g2 = makeGround(db, {
      content: "证据 2",
      source: "observed",
      verification: "verified",
      attachments: ["/data/2.csv"],
    });
    const w = makeWarrant(db, claim.id, [g1.id, g2.id], "论证");
    makeBacking(db, w.id, "依据", ["/papers/x.pdf"]);

    markCompiled(claim.id);
    service.updateNode(db, claim.id, { status: "supported" });
    expect(dataOf(claim.id).status).toBe("supported");

    // 显式把一条 Ground 退回 pending：H2 只出 warning，允许；
    // verification 不进 structuralChange、也不进 merkle hash ⇒ hash 未变
    service.updateNode(db, g1.id, { verification: "pending" });

    const results = await compileService.compileClaims(db, null, [claim.id]);
    const blob = JSON.stringify(results);

    expect(blob).toContain("no warrant has all grounds verified");
  });

  test("hash 确实未变（这正是短路成立的前提，不是测试布置失误）", () => {
    const claim = makeClaim(db, "结论");
    const g = makeGround(db, {
      content: "证据",
      source: "observed",
      verification: "verified",
      attachments: ["/data/1.csv"],
    });
    makeWarrant(db, claim.id, [g.id], "论证");

    const before = computeArgumentHash(db, claim.id);
    service.updateNode(db, g.id, { verification: "pending" });
    const after = computeArgumentHash(db, claim.id);

    // 哈希覆盖面是刻意窄的（content + 关系结构）。不要为了这条修复去加宽它。
    expect(after).toBe(before);
  });

  test("结构本身不完整时短路路径要报结构错误，不是静默 no-change", async () => {
    const claim = makeClaim(db, "只有 compile_state 没有 Warrant 的结论");
    markCompiled(claim.id);

    const results = await compileService.compileClaims(db, null, [claim.id]);
    const blob = JSON.stringify(results);

    expect(blob).toMatch(/Warrant/i);
  });

  test("图确实没变时仍然返回 no-change（修复不得把短路本身取消）", async () => {
    const claim = makeClaim(db, "健康的结论");
    const g = makeGround(db, {
      content: "证据",
      source: "observed",
      verification: "verified",
      attachments: ["/data/1.csv"],
    });
    const w = makeWarrant(db, claim.id, [g.id], "论证");
    makeBacking(db, w.id, "依据", ["/papers/x.pdf"]);
    markCompiled(claim.id);

    const results = await compileService.compileClaims(db, null, [claim.id]);
    expect(results[0].action).toBe("no-change");
  });
});

// =============================================================================
// §2 — create_statement(rebuttal_for=) 必须触发失效
// =============================================================================

describe("§2：create_statement(rebuttal_for=) 与 update_node 入口行为一致", () => {
  test("对已 compile 的 Claim 挂 Rebuttal → compile_status 变 stale", async () => {
    const claim = makeClaim(db, "被反驳的结论");
    const g = makeGround(db, {
      content: "证据",
      source: "observed",
      verification: "verified",
      attachments: ["/data/1.csv"],
    });
    const w = makeWarrant(db, claim.id, [g.id], "论证");
    makeBacking(db, w.id, "依据", ["/papers/x.pdf"]);
    markCompiled(claim.id);

    await tools.create_statement.handler({
      content: "反例：在数据集 3 上失效",
      source: "observed",
      attachments: ["/data/counter.csv"],
      rebuttal_for: { target_id: claim.id, target_type: "claim" },
    });

    expect(dataOf(claim.id).compile_status).toBe("stale");
  });

  test("已 supported 的 Claim 挂 Rebuttal → status 退回 proposed，不能基于旧 compile 标 disputed", async () => {
    const claim = makeClaim(db, "已定案的结论");
    const g = makeGround(db, {
      content: "证据",
      source: "observed",
      verification: "verified",
      attachments: ["/data/1.csv"],
    });
    const w = makeWarrant(db, claim.id, [g.id], "论证");
    makeBacking(db, w.id, "依据", ["/papers/x.pdf"]);
    markCompiled(claim.id);
    service.updateNode(db, claim.id, { status: "supported" });

    await tools.create_statement.handler({
      content: "反例",
      source: "observed",
      attachments: ["/data/counter.csv"],
      rebuttal_for: { target_id: claim.id, target_type: "claim" },
    });

    expect(dataOf(claim.id).status).toBe("proposed");
    // 最狠的一条：链审查从未看见这条 Rebuttal，却可以据此把 Claim 标成 disputed
    expect(() => service.updateNode(db, claim.id, { status: "disputed" })).toThrow(
      /has not been compiled or is stale/
    );
  });

  test("挂在 Warrant 上的 Rebuttal 同样失效其 Claim", async () => {
    const claim = makeClaim(db, "结论");
    const g = makeGround(db, {
      content: "证据",
      source: "observed",
      verification: "verified",
      attachments: ["/data/1.csv"],
    });
    const w = makeWarrant(db, claim.id, [g.id], "论证");
    markCompiled(claim.id);

    await tools.create_statement.handler({
      content: "反驳这条推理规则",
      source: "observed",
      attachments: ["/data/counter.csv"],
      rebuttal_for: { target_id: w.id, target_type: "warrant" },
    });

    expect(dataOf(claim.id).compile_status).toBe("stale");
  });

  test("多层 DAG：挂在下层 Claim 上的 Rebuttal 一路失效到根", async () => {
    const { root, subA, subB } = buildTwoLayer();
    settleSupported(subA.id);
    settleSupported(subB.id);
    markCompiled(root.id);
    service.updateNode(db, root.id, { status: "supported" });

    await tools.create_statement.handler({
      content: "针对子结论 A 的反例",
      source: "observed",
      attachments: ["/data/counter.csv"],
      rebuttal_for: { target_id: subA.id, target_type: "claim" },
    });

    expect(dataOf(root.id).compile_status).toBe("stale");
    expect(dataOf(root.id).status).toBe("proposed");
  });

  test("update_node(rebuttal_ids={add}) 入口本来就会失效（对照组）", async () => {
    const claim = makeClaim(db, "结论");
    const g = makeGround(db, {
      content: "证据",
      source: "observed",
      verification: "verified",
      attachments: ["/data/1.csv"],
    });
    makeWarrant(db, claim.id, [g.id], "论证");
    const reb = makeGround(db, {
      content: "独立的反驳陈述",
      source: "observed",
      verification: "pending",
    });
    markCompiled(claim.id);

    await tools.update_node.handler({ node_id: claim.id, rebuttal_ids: { add: [reb.id] } });

    expect(dataOf(claim.id).compile_status).toBe("stale");
  });
});

// =============================================================================
// §4 — mapLimit 并发上限
// =============================================================================
// 静态 import：`src/concurrency.ts` 已是 PR2.5 交付物，落地前用的条件跳过
// 脚手架已撤。改名或删导出会让整个文件加载失败，而不是让这组悄悄跳过。

describe("§4：mapLimit 并发上限", () => {
  function makeTracker() {
    let inFlight = 0;
    let peak = 0;
    return {
      get peak() {
        return peak;
      },
      async run<T>(value: T, delayMs = 5): Promise<T> {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise(r => setTimeout(r, delayMs));
        inFlight--;
        return value;
      },
    };
  }

  test("并发峰值不超过 limit", async () => {
    const tracker = makeTracker();
    const items = Array.from({ length: 20 }, (_, i) => i);

    const results = await mapLimit(items, 4, (x: number) => tracker.run(x));

    expect(tracker.peak).toBeLessThanOrEqual(4);
    expect(results).toEqual(items);
  });

  test("limit 大于条目数时全部并发，结果顺序仍与输入一致", async () => {
    const tracker = makeTracker();
    const items = [1, 2, 3];

    const results = await mapLimit(items, 10, (x: number) => tracker.run(x, 10 - x));

    expect(tracker.peak).toBe(3);
    expect(results).toEqual([1, 2, 3]);
  });

  test("limit = 1 时严格串行", async () => {
    const tracker = makeTracker();
    const results = await mapLimit([1, 2, 3, 4], 1, (x: number) => tracker.run(x));

    expect(tracker.peak).toBe(1);
    expect(results).toEqual([1, 2, 3, 4]);
  });

  test("空数组直接返回空", async () => {
    expect(await mapLimit([], 4, async (x: any) => x)).toEqual([]);
  });

  test("某一条抛错不会让并发槽泄漏", async () => {
    const tracker = makeTracker();
    const items = Array.from({ length: 12 }, (_, i) => i);

    await mapLimit(items, 3, async (x: number) => {
      if (x % 4 === 0) throw new Error(`boom ${x}`);
      return tracker.run(x);
    }).catch(() => undefined);

    expect(tracker.peak).toBeLessThanOrEqual(3);
  });

  test("默认 limit 为 4", async () => {
    const tracker = makeTracker();
    const items = Array.from({ length: 12 }, (_, i) => i);

    await mapLimit(items, undefined, (x: number) => tracker.run(x));

    expect(tracker.peak).toBeLessThanOrEqual(4);
  });
});

/**
 * Toulmin MCP — Claim 担任 Backing / Rebuttal 角色
 *
 * 角色由关系表决定，不由节点类型决定。`warrant_grounds` 早就接受 claim，
 * `warrant_backings` 与 `rebuttal_targets` 的列上也从来没有类型 CHECK ——
 * 挡住 claim 的一直是 service / tool 层的四道门，不是 schema。所以这个功能
 * 不需要迁移，老图天然兼容。
 *
 * ── 这份文件为什么分成五组 ────────────────────────────────────────────
 * "放宽写入门"只是功能的一部分。claim 型 Ground 落地时配了循环检测和失效传播；
 * Backing 和 Rebuttal 只放宽门的话，那两件会静默地给出错误结果 —— 不报错，只是
 * 结论过期了没人知道。
 *
 * 组 1 测门；组 2 测循环；组 3 测失效传播（含"哪些不该传"）；组 4 把哈希的覆盖面
 * 钉住，它的期望是"不变"，理由写在那一组的头上；组 5 测判定层（rule C′ 已经是
 * 双读的，这一组落地前就该是绿的，它守的是"别在这里重复实现一遍判据"）。
 *
 * ── 组 3 / 4 / 5 为什么绕开 service 直接写关系表 ───────────────────────
 * 那三件事的缺陷独立于写入门存在。如果这些用例走 service API，它们会先被
 * 类型门拒掉，于是在我修循环 / 失效 / 哈希的整个过程里都红着，而红的理由是
 * 门 —— 测不到要测的东西。直接 INSERT 把测量隔离开：组 3/4/5 红，就只可能
 * 是它自己那件事没做。同一个理由见 `helpers.ts` 里 makeGround 的注释。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  createTestDb,
  cleanupDb,
  makeClaim,
  makeGround,
  makeWarrant,
  compileVerdictOf,
} from "./helpers.ts";
import * as repo from "../src/repo.ts";
import * as service from "../src/service.ts";
import { computeArgumentHash } from "../src/merkle-hash.ts";
import { registerTools } from "../src/tools.ts";
import type { ClaimNode, StatementNode, WarrantNode } from "../src/types.ts";

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
}

/** 把一个 Claim 定成 supported。 */
function settleSupported(claimId: number): void {
  markCompiled(claimId);
  service.updateNode(db, claimId, { status: "supported" });
}

/** 绕开类型门，把一个 Claim 直接挂成某条 Warrant 的 Backing。见文件头说明。 */
function linkClaimAsBacking(warrantId: number, claimId: number): void {
  db.prepare("INSERT OR IGNORE INTO warrant_backings (warrant_id, statement_id) VALUES (?, ?)").run(
    warrantId,
    claimId
  );
}

/** 绕开类型门，把一个 Claim 直接挂成某个节点的 Rebuttal。见文件头说明。 */
function linkClaimAsRebuttal(
  claimId: number,
  targetId: number,
  targetType: "claim" | "warrant"
): void {
  db.prepare(
    "INSERT OR IGNORE INTO rebuttal_targets (statement_id, target_id, target_type) VALUES (?, ?, ?)"
  ).run(claimId, targetId, targetType);
}

function backingIdsOf(warrantId: number): number[] {
  return (
    db
      .prepare("SELECT statement_id AS id FROM warrant_backings WHERE warrant_id = ?")
      .all(warrantId) as Array<{ id: number }>
  ).map(r => r.id);
}

function rebuttalIdsOf(targetId: number): number[] {
  return (
    db
      .prepare("SELECT statement_id AS id FROM rebuttal_targets WHERE target_id = ?")
      .all(targetId) as Array<{ id: number }>
  ).map(r => r.id);
}

interface Fixture {
  /** 上层结论。 */
  host: ClaimNode;
  hostWarrant: WarrantNode;
  /** 要拿去当 Backing / Rebuttal 的下层结论 —— 它自己有完整论证。 */
  sub: ClaimNode;
  subWarrant: WarrantNode;
  /** sub 的证据。改它用来测"两跳"传播。 */
  subGround: StatementNode;
}

/**
 * host ← W_host ← 评测记录
 * sub  ← W_sub  ← 相关性分析
 *
 * 两条论证互不相干，各用例自己决定把 sub 挂成 host 的哪种角色。
 */
function build(): Fixture {
  const host = makeClaim(db, "上层结论：混合检索优于稠密检索");
  const hostGround = makeGround(db, {
    content: "评测集上两种检索的召回率对比",
    source: "observed",
    verification: "verified",
    attachments: ["/data/recall.csv"],
  });
  const hostWarrant = makeWarrant(
    db,
    host.id,
    [hostGround.id],
    "同一评测集上更高的召回率意味着更好的检索"
  );

  const sub = makeClaim(db, "下层结论：该评测集的召回率指标与人工相关性判断一致");
  const subGround = makeGround(db, {
    content: "人工标注与召回率指标的相关性分析",
    source: "observed",
    verification: "verified",
    attachments: ["/data/corr.csv"],
  });
  const subWarrant = makeWarrant(db, sub.id, [subGround.id], "指标与人工判断高相关说明指标可用");

  return { host, hostWarrant, sub, subWarrant, subGround };
}

// =============================================================================
// 组 1 — 写入门：四处放宽到"statement 或 claim"
// =============================================================================

describe("组 1：写入门接受 claim 型 Backing / Rebuttal", () => {
  test("create_warrant(backing_ids=[claimId]) 成功建立关系", async () => {
    const { host, sub } = build();

    const result = await tools.create_warrant.handler({
      claim_id: host.id,
      content: "另一条推理，其权威性由下层结论承担",
      ground_ids: [],
      backing_ids: [sub.id],
    });
    const text = result.content[0].text;

    expect(text).toContain("Created warrant");
    const warrantId = Number(text.match(/#(\d+)/)![1]);
    expect(backingIdsOf(warrantId)).toContain(sub.id);
  });

  test("update_node(warrant, backing_ids={add}) 接受 claim", () => {
    const { hostWarrant, sub } = build();

    expect(() =>
      service.updateNode(db, hostWarrant.id, { backing_ids: { add: [sub.id] } })
    ).not.toThrow();
    expect(backingIdsOf(hostWarrant.id)).toContain(sub.id);
  });

  test("update_node(claim, rebuttal_ids={add}) 接受 claim", () => {
    const { host, sub } = build();

    expect(() =>
      service.updateNode(db, host.id, { rebuttal_ids: { add: [sub.id] } })
    ).not.toThrow();
    expect(rebuttalIdsOf(host.id)).toContain(sub.id);
  });

  test("update_node(warrant, rebuttal_ids={add}) 接受 claim，target_type 记为 warrant", () => {
    const { hostWarrant, sub } = build();

    expect(() =>
      service.updateNode(db, hostWarrant.id, { rebuttal_ids: { add: [sub.id] } })
    ).not.toThrow();
    const row = db
      .prepare("SELECT target_type FROM rebuttal_targets WHERE statement_id = ? AND target_id = ?")
      .get(sub.id, hostWarrant.id) as { target_type: string } | null;
    expect(row?.target_type).toBe("warrant");
  });

  // 门是放宽到两种类型，不是拆掉。下面两条是这次改动的边界，不是陪衬。
  test("warrant 节点仍然不能当 Backing", () => {
    const { hostWarrant, subWarrant } = build();

    expect(() =>
      service.updateNode(db, hostWarrant.id, { backing_ids: { add: [subWarrant.id] } })
    ).toThrow();
  });

  test("warrant 节点仍然不能当 Rebuttal", () => {
    const { host, subWarrant } = build();

    expect(() =>
      service.updateNode(db, host.id, { rebuttal_ids: { add: [subWarrant.id] } })
    ).toThrow();
  });

  test("不存在的节点 id 照旧报 not found", () => {
    const { hostWarrant } = build();

    expect(() =>
      service.updateNode(db, hostWarrant.id, { backing_ids: { add: [99999] } })
    ).toThrow(/99999/);
  });

  // tools.ts 里那份重复的类型预检删掉之后，service 抛的错要照样能到用户手上。
  test("工具层删掉重复预检后，非法类型仍然返回失败而不是静默成功", async () => {
    const { host, subWarrant } = build();

    const result = await tools.create_warrant.handler({
      claim_id: host.id,
      content: "推理",
      ground_ids: [],
      backing_ids: [subWarrant.id],
    });

    expect(result.content[0].text).not.toContain("Created warrant");
    expect(result.content[0].text).toContain(String(subWarrant.id));
  });
});

// =============================================================================
// 组 2 — 循环检测：wouldCreateCycle 现在只走 warrant_grounds
//
// 环的判据与 Ground 一致：要定 A 的案得先知道 B 的结论，要定 B 的案得先知道 A 的。
// 谁都动不了。Backing 和 Rebuttal 一样会造出这种死锁，所以用同一条规则。
// 注意"claim 反驳上游 claim"本身不是环 —— 只有依赖成圈才是。
// =============================================================================

describe("组 2：claim 型 Backing / Rebuttal 的循环检测", () => {
  test("自反驳：一个 Claim 不能反驳自己", () => {
    const { host } = build();

    expect(() =>
      service.updateNode(db, host.id, { rebuttal_ids: { add: [host.id] } })
    ).toThrow(/[Cc]ircular/);
  });

  test("经 Backing 成环：sub 已是 host 的 Backing，再把 host 挂成 sub 的 Ground", () => {
    const { host, hostWarrant, sub, subWarrant } = build();
    linkClaimAsBacking(hostWarrant.id, sub.id);

    // host 依赖 sub（Backing）。再让 sub 依赖 host（Ground）就成环。
    // 现在 wouldCreateCycle 从 host 出发只找 claim 型 Ground，找不到 Backing 上的 sub。
    expect(() =>
      service.updateNode(db, subWarrant.id, { ground_ids: { add: [host.id] } })
    ).toThrow(/[Cc]ircular/);
  });

  test("经 Backing 成环（反向顺序）：sub 已靠 host，再把 sub 挂成 host 的 Backing", () => {
    const { host, hostWarrant, sub } = build();
    makeWarrant(db, sub.id, [host.id], "sub 也可由 host 支撑");

    expect(() =>
      service.updateNode(db, hostWarrant.id, { backing_ids: { add: [sub.id] } })
    ).toThrow(/[Cc]ircular/);
  });

  test("经 Rebuttal 成环：sub 已靠 host，再把 sub 挂成 host 的 Rebuttal", () => {
    const { host, sub } = build();
    makeWarrant(db, sub.id, [host.id], "sub 也可由 host 支撑");

    expect(() =>
      service.updateNode(db, host.id, { rebuttal_ids: { add: [sub.id] } })
    ).toThrow(/[Cc]ircular/);
  });

  test("经 Rebuttal 成环：反驳挂在 Warrant 上也算", () => {
    const { host, hostWarrant, sub } = build();
    makeWarrant(db, sub.id, [host.id], "sub 也可由 host 支撑");

    expect(() =>
      service.updateNode(db, hostWarrant.id, { rebuttal_ids: { add: [sub.id] } })
    ).toThrow(/[Cc]ircular/);
  });

  test("create_warrant 的 backing_ids 同样查环", async () => {
    const { host, sub } = build();
    makeWarrant(db, sub.id, [host.id], "sub 也可由 host 支撑");

    const result = await tools.create_warrant.handler({
      claim_id: host.id,
      content: "新推理",
      ground_ids: [],
      backing_ids: [sub.id],
    });

    expect(result.content[0].text).toMatch(/[Cc]ircular/);
  });

  // 纯 Rebuttal 成环：sub 已反驳 host，再让 host 反驳 sub，两者互为对方的核实前提。
  // 这条闭合只经 rebuttal 边，不经 ground —— 它守的是 wouldCreateCycle 的 rebuttal 下探。
  test("经 Rebuttal 成环：两条 claim 互相反驳", () => {
    const { host, sub } = build();
    linkClaimAsRebuttal(sub.id, host.id, "claim"); // 已有：sub 反驳 host

    expect(() =>
      service.updateNode(db, sub.id, { rebuttal_ids: { add: [host.id] } })
    ).toThrow(/[Cc]ircular/);
  });

  // 不能为了查环把不成环的正当结构也挡掉。
  test("不成环的下层结论当 Backing 照常允许", () => {
    const { hostWarrant, sub } = build();

    expect(() =>
      service.updateNode(db, hostWarrant.id, { backing_ids: { add: [sub.id] } })
    ).not.toThrow();
  });

  test("反驳一个与自己无依赖关系的 Claim 不算环", () => {
    const { host, sub } = build();

    expect(() =>
      service.updateNode(db, host.id, { rebuttal_ids: { add: [sub.id] } })
    ).not.toThrow();
  });
});

// =============================================================================
// 组 3 — 失效传播：compile-service 的 case "claim" 只反查了 ground 一种角色
//
// 判据是**上层审查的输入变了没有**，不是"上层依赖了什么"。argumentHash 全仓只有
// 一个用途：决定 compile 要不要重跑（compile-service.ts 的 prevState.argumentHash
// 比对）。状态门读的是 verdict === "passed"，不读哈希。所以哈希该覆盖的正好是
// 审查看得见的那些东西，多一点都是白跑一次模型调用。
//
// 下层 claim 自己的 content 印进上层的审查 prompt（三种角色都印，见
// compile-prompts.ts 的 buildChainReviewPrompt），所以它变了上层要重审 → stale。
// 下层的**子证据**不印，所以它变了上层不重审 → 保持 passed，上层失去的充分性
// 由状态那条路（revertUnsupportedClaimStatuses）承担，不花 API 额度。
//
// 缺了传播的后果是静默的：改了一个 claim 型 Backing 的内容，上层 claim 的 compile
// 还挂着 passed，于是一个没人重新审过的论证继续支撑着一个 supported 的结论。
// =============================================================================

describe("组 3：claim 型 Backing / Rebuttal 变动要传播失效", () => {
  test("改 claim 型 Backing 的内容 → 上层 compile 变 stale", async () => {
    const { host, hostWarrant, sub } = build();
    linkClaimAsBacking(hostWarrant.id, sub.id);
    markCompiled(host.id);

    await tools.update_node.handler({
      node_id: sub.id,
      content: "下层结论（改写）：该评测集的召回率指标与人工判断大体一致",
    });

    expect(compileVerdictOf(db, host.id)).toBe("stale");
  });

  // 反过来的一条：子证据在上层审查的视野之外，所以上层 compile 不该动。
  // 上层失去的是充分性依据，那个由状态那条路承担（见组 3 末尾）。
  test("改 claim 型 Backing 的子证据 → 上层 compile 保持 passed（不越级失效）", async () => {
    const { host, hostWarrant, sub, subGround } = build();
    linkClaimAsBacking(hostWarrant.id, sub.id);
    markCompiled(host.id);

    await tools.update_node.handler({
      node_id: subGround.id,
      content: "人工标注与召回率指标的相关性分析（重算）",
    });

    expect(compileVerdictOf(db, host.id)).toBe("passed");
  });

  test("改 claim 型 Rebuttal 的内容 → 被反驳的 Claim 变 stale", async () => {
    const { host, sub } = build();
    linkClaimAsRebuttal(sub.id, host.id, "claim");
    markCompiled(host.id);

    await tools.update_node.handler({ node_id: sub.id, content: "下层结论（改写）" });

    expect(compileVerdictOf(db, host.id)).toBe("stale");
  });

  test("改挂在 Warrant 上的 claim 型 Rebuttal → 该 Warrant 的 Claim 变 stale", async () => {
    const { host, hostWarrant, sub } = build();
    linkClaimAsRebuttal(sub.id, hostWarrant.id, "warrant");
    markCompiled(host.id);

    await tools.update_node.handler({ node_id: sub.id, content: "下层结论（改写）" });

    expect(compileVerdictOf(db, host.id)).toBe("stale");
  });

  test("已 supported 的上层：claim 型 Backing 变动后不能再基于旧 compile 定案", async () => {
    const { host, hostWarrant, sub } = build();
    linkClaimAsBacking(hostWarrant.id, sub.id);
    settleSupported(host.id);
    expect(dataOf(host.id).status).toBe("supported");

    await tools.update_node.handler({ node_id: sub.id, content: "下层结论（改写）" });

    expect(compileVerdictOf(db, host.id)).toBe("stale");
    expect(() => service.updateNode(db, host.id, { status: "supported" })).toThrow(
      /changed after it last passed compile/
    );
  });

  // ── 状态那条路：只退 status，不动 compile ──────────────────────────────
  //
  // 一条 claim 型 Rebuttal 从 supported 退回 proposed，按 rule C′ 它就不再算已核实的
  // 反驳。上游那个 disputed 于是失去结构依据，要退回 proposed。但上游论证的形式一个字
  // 没变，compile 的 passed 仍是它当初审过那件事的真实结论，所以不动。
  test("claim 型 Rebuttal 被降级 → 上游 disputed 退回 proposed，compile 保持 passed", async () => {
    const { host, sub } = build();
    linkClaimAsRebuttal(sub.id, host.id, "claim");
    settleSupported(sub.id);
    markCompiled(host.id);
    service.updateNode(db, host.id, { status: "disputed" });
    expect(dataOf(host.id).status).toBe("disputed");

    await tools.update_node.handler({ node_id: sub.id, status: "proposed" });

    expect(dataOf(host.id).status).toBe("proposed");
    expect(compileVerdictOf(db, host.id)).toBe("passed");
  });

  // 刻意的不对称：today 没有任何门读 Backing 的核实状态
  // （compile-service.ts 里 revertUnsupportedClaimStatuses 的注释写明了这一点）。
  // 所以 claim 型 Backing 降级不该动上层的 status。这条和上一条一起把边界钉住：
  // 补 rebuttal 一侧，不补 backing 一侧。
  test("claim 型 Backing 被降级 → 上层 supported 不动（没有门读 Backing）", () => {
    const { host, hostWarrant, sub } = build();
    linkClaimAsBacking(hostWarrant.id, sub.id);
    settleSupported(sub.id);
    settleSupported(host.id);

    service.updateNode(db, sub.id, { status: "proposed" });

    expect(dataOf(host.id).status).toBe("supported");
    expect(compileVerdictOf(db, host.id)).toBe("passed");
  });

  // 传播要按角色实际存在来走，不能"只要动了 claim 就把全图标脏"。
  test("与上层毫无关系的 Claim 变动不牵连上层", async () => {
    const { host, sub } = build();
    markCompiled(host.id);

    await tools.update_node.handler({ node_id: sub.id, content: "无关结论（改写）" });

    expect(compileVerdictOf(db, host.id)).toBe("passed");
  });
});

// =============================================================================
// 组 4 — Merkle 哈希：claim 型 Backing / Rebuttal 的子树**不该**进上层哈希
//
// 这一组的期望是反的，说明理由，否则以后必然有人把它当缺陷去"修"。
//
// 哈希的唯一消费者是"compile 要不要重跑"。上层的审查输入里，Backing 只有
// {id, content}，Rebuttal 只有 {id, content, targetType, targetId} —— 子证据、
// 下层 warrant 全都不在（compile-prompts.ts 的 ChainReviewData）。所以让哈希递归
// 进它们的子树，只会造出"哈希说变了、审查看到的没变"的重跑：审同一份输入，得同一个
// 结论，白花一次 API 调用。
//
// 那"下层垮了上层怎么办"由状态那条路承担，见组 3 末尾两条。
//
// 已上线的 claim 型 Ground 递归（merkle-hash.ts 的 refArg）按同一判据也偏宽，那是
// 单独一项，不在这次范围里 —— 所以现在 Ground 侧与这里行为不一致，是已知的。
// =============================================================================

describe("组 4：claim 型 Backing / Rebuttal 的子树不进上层哈希", () => {
  test("claim 型 Backing 的子证据变了 → 上层 argumentHash 不变", () => {
    const { host, hostWarrant, sub, subGround } = build();
    linkClaimAsBacking(hostWarrant.id, sub.id);

    const before = computeArgumentHash(db, host.id);
    service.updateNode(db, subGround.id, { content: "相关性分析（重算）" });
    const after = computeArgumentHash(db, host.id);

    expect(after).toBe(before);
  });

  test("claim 型 Backing 的下层推理换了 → 上层 argumentHash 不变", () => {
    const { host, hostWarrant, sub, subWarrant } = build();
    linkClaimAsBacking(hostWarrant.id, sub.id);

    const before = computeArgumentHash(db, host.id);
    service.updateNode(db, subWarrant.id, { content: "换一条推理规则" });
    const after = computeArgumentHash(db, host.id);

    expect(after).toBe(before);
  });

  test("claim 型 Rebuttal 的子证据变了 → 被反驳 Claim 的 argumentHash 不变", () => {
    const { host, sub, subGround } = build();
    linkClaimAsRebuttal(sub.id, host.id, "claim");

    const before = computeArgumentHash(db, host.id);
    service.updateNode(db, subGround.id, { content: "相关性分析（重算）" });
    const after = computeArgumentHash(db, host.id);

    expect(after).toBe(before);
  });

  // 边界的另一半：它们**自己的 content** 必须进哈希 —— 那是印进上层审查 prompt 的东西。
  // 上面三条与这两条合起来才是判据，单看上面三条会读成"backing/rebuttal 不进哈希"。
  test("claim 型 Backing 自己的 content 变了 → 上层 argumentHash 变", () => {
    const { host, hostWarrant, sub } = build();
    linkClaimAsBacking(hostWarrant.id, sub.id);

    const before = computeArgumentHash(db, host.id);
    service.updateNode(db, sub.id, { content: "下层结论（改写）" });
    const after = computeArgumentHash(db, host.id);

    expect(after).not.toBe(before);
  });

  test("claim 型 Rebuttal 自己的 content 变了 → 被反驳 Claim 的 argumentHash 变", () => {
    const { host, sub } = build();
    linkClaimAsRebuttal(sub.id, host.id, "claim");

    const before = computeArgumentHash(db, host.id);
    service.updateNode(db, sub.id, { content: "下层结论（改写）" });
    const after = computeArgumentHash(db, host.id);

    expect(after).not.toBe(before);
  });

  test("对照：statement 型 Backing 的哈希覆盖面不变宽", () => {
    const { host, hostWarrant } = build();
    const stmtBacking = makeGround(db, {
      content: "方法论依据",
      source: "literature",
      verification: "verified",
      attachments: ["/papers/m.pdf"],
    });
    linkClaimAsBacking(hostWarrant.id, stmtBacking.id);

    const before = computeArgumentHash(db, host.id);
    service.updateNode(db, stmtBacking.id, { verification: "pending" });
    const after = computeArgumentHash(db, host.id);

    // verification 刻意不进哈希（见 claim-ground.test.ts §3.3）。递归不改这条。
    expect(after).toBe(before);
  });

  test("环上算哈希不挂死（COMPUTING_SENTINEL 兜住递归）", () => {
    const { host, hostWarrant, sub } = build();
    // 直接写出一个环：host 靠 sub（Backing），sub 靠 host（Ground）。
    // 写入门会拒绝这种图，但迁移前的老图、或手改的库可能有，哈希不能因此挂死。
    linkClaimAsBacking(hostWarrant.id, sub.id);
    const cyc = makeWarrant(db, sub.id, [], "环");
    db.prepare("INSERT OR IGNORE INTO warrant_grounds (warrant_id, ground_id) VALUES (?, ?)").run(
      cyc.id,
      host.id
    );

    expect(() => computeArgumentHash(db, host.id)).not.toThrow();
  });
});

// =============================================================================
// 组 5 — 判定层：rule C′ 已经是双读的，这一组落地前就该绿
//
// 它守的是"不要在角色计数里重新实现一遍判据"。isClaimOrStatementVerified 只看
// 节点本身，角色由关系表决定 —— 所以 backing / rebuttal 的计数不需要任何新代码。
// 这组变红说明有人在 countRole 或它的调用点上加了类型分支。
// =============================================================================

describe("组 5：get_stats 的角色计数把 claim 算进去（应已为绿）", () => {
  test("claim 型 Backing 计入 total", () => {
    const { hostWarrant, sub } = build();
    linkClaimAsBacking(hostWarrant.id, sub.id);

    expect(service.getStats(db).scale.roles.backings.total).toBe(1);
  });

  test("proposed 的 claim 型 Backing 算 pending", () => {
    const { hostWarrant, sub } = build();
    linkClaimAsBacking(hostWarrant.id, sub.id);

    const backings = service.getStats(db).scale.roles.backings;
    expect(backings.verified).toBe(0);
    expect(backings.pending).toBe(1);
  });

  test("supported 的 claim 型 Backing 算 verified", () => {
    const { hostWarrant, sub } = build();
    linkClaimAsBacking(hostWarrant.id, sub.id);
    settleSupported(sub.id);

    expect(service.getStats(db).scale.roles.backings.verified).toBe(1);
  });

  test("claim 型 Rebuttal 同样按 rule C′ 计数", () => {
    const { host, sub } = build();
    linkClaimAsRebuttal(sub.id, host.id, "claim");
    settleSupported(sub.id);

    const rebuttals = service.getStats(db).scale.roles.rebuttals;
    expect(rebuttals.total).toBe(1);
    expect(rebuttals.verified).toBe(1);
  });

  test("search_nodes(node_type='backing') 能查到 claim 型 Backing", async () => {
    const { hostWarrant, sub } = build();
    linkClaimAsBacking(hostWarrant.id, sub.id);

    const result = await tools.search_nodes.handler({ keyword: "召回率指标", node_type: "backing" });

    expect(result.content[0].text).toContain(`#${sub.id}`);
  });
});

/**
 * Service 层(docs/api.md §2–§4)
 *
 * 组织方式对着工具面:一个工具一节。断言集中在三处不能漂的地方——
 * 硬拒只有 V1–V3、基线只有一个写入者、每次操作都留痕。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import * as svc from "../src/service.ts";
import * as repo from "../src/repo.ts";
import { ValidationError, NotFoundError } from "../src/errors.ts";
import { CheckCode } from "../src/types.ts";
import { createTestDb, cleanupDb, makeTempRoot, type TempRoot } from "./helpers.ts";

let db: Database;
let root: TempRoot;

beforeEach(() => {
  db = createTestDb();
  root = makeTempRoot();
});

afterEach(() => {
  cleanupDb(db);
  root.cleanup();
});

/** 最省事的一条命题:内容 + 理由,不带证据。 */
function create(content = "A proposition", extra: Record<string, unknown> = {}): number {
  return svc.createPropositions(db, root, [
    { content, warrant: "A domain-general principle", ...extra },
  ])[0]!.id;
}

function ops(nodeId?: number): string[] {
  return svc.getHistory(db, { id: nodeId, limit: 100 }).events.map((e) => e.op);
}

// =============================================================================
// create_propositions
// =============================================================================

describe("create_propositions", () => {
  test("新建的命题一律落 unestablished,没有 qualifier 入参", () => {
    const id = create();
    expect(repo.getProposition(db, id)!.qualifier).toBe("unestablished");
  });

  test("批量:一次调用建多条,各自返回 id 与警告", () => {
    const out = svc.createPropositions(db, root, [{ content: "one" }, { content: "two" }]);
    expect(out).toHaveLength(2);
    expect(out[0]!.id).not.toBe(out[1]!.id);
  });

  test("V1 content 为空拒绝,只有空格也拒绝", () => {
    expect(() => svc.createPropositions(db, root, [{ content: "" }])).toThrow(ValidationError);
    expect(() => svc.createPropositions(db, root, [{ content: "   " }])).toThrow(ValidationError);
  });

  test("V2 引用不存在的命题拒绝", () => {
    expect(() =>
      svc.createPropositions(db, root, [{ content: "x", evidence: { nodes: [999] } }])
    ).toThrow(ValidationError);
  });

  test("V3 附件不存在拒绝;URL 也拒绝", () => {
    expect(() =>
      svc.createPropositions(db, root, [{ content: "x", evidence: { attachments: ["nope.md"] } }])
    ).toThrow(ValidationError);
    expect(() =>
      svc.createPropositions(db, root, [
        { content: "x", evidence: { attachments: ["https://example.com/p.pdf"] } },
      ])
    ).toThrow(ValidationError);
  });

  test("空 warrant 不是硬拒——姿态原则零例外", () => {
    const out = svc.createPropositions(db, root, [{ content: "no warrant here" }]);
    expect(out[0]!.id).toBeGreaterThan(0);
    // 而且落 unestablished 时一条红都不标。
    expect(out[0]!.warnings).toEqual([]);
  });

  test("留痕:一条 create 事件,载荷含内容与槽位", () => {
    const path = root.file("e.md");
    const id = create("recorded", { evidence: { attachments: [path] }, note: "why" });
    const ev = svc.getHistory(db, { id }).events.find((e) => e.op === "create")!;
    expect(ev.by).toBe("tool");
    expect(ev.note).toBe("why");
    expect((ev.payload as any).evidence.attachments).toEqual([path]);
  });

  test("attacks.slot=content:反驳挂到目标的反驳槽", () => {
    const target = create("target");
    const out = svc.createPropositions(db, root, [
      { content: "counterexample", attacks: { node: target, slot: "content" } },
    ]);
    expect(repo.getRebuttals(db, target)).toEqual([out[0]!.id]);
    expect(out[0]!.promoted).toBeUndefined();
  });

  test("attacks.slot=warrant:内联理由自动晋升,并在返回体里显式报告", () => {
    const target = create("target");
    const out = svc.createPropositions(db, root, [
      { content: "the principle fails here", attacks: { node: target, slot: "warrant" } },
    ]);

    const promoted = out[0]!.promoted;
    expect(promoted).toBeDefined();
    expect(promoted!.from_node).toBe(target);

    // 原槽位改为指向晋升出来的命题,内联文本清空(DB 的 XOR CHECK 也不允许并存)。
    const row = repo.getProposition(db, target)!;
    expect(row.warrant_node_id).toBe(promoted!.new_id);
    expect(row.warrant_text).toBeNull();

    // 反驳挂在晋升后的命题上,不在原命题上。
    expect(repo.getRebuttals(db, promoted!.new_id)).toEqual([out[0]!.id]);
    expect(repo.getRebuttals(db, target)).toEqual([]);
  });

  test("自动晋升出来的命题:空理由 + unestablished + by=system,完全合法", () => {
    const target = create("target");
    const out = svc.createPropositions(db, root, [
      { content: "attack", attacks: { node: target, slot: "warrant" } },
    ]);
    const newId = out[0]!.promoted!.new_id;

    const row = repo.getProposition(db, newId)!;
    expect(row.warrant_text).toBeNull();
    expect(row.qualifier).toBe("unestablished");

    const ev = svc.getHistory(db, { id: newId }).events.find((e) => e.op === "promote")!;
    expect(ev.by).toBe("system");
  });

  test("attacks.slot=warrant 且理由已晋升:直接攻击那条命题,不再晋升一次", () => {
    const target = create("target");
    const first = svc.createPropositions(db, root, [
      { content: "attack one", attacks: { node: target, slot: "warrant" } },
    ]);
    const warrantNode = first[0]!.promoted!.new_id;

    const second = svc.createPropositions(db, root, [
      { content: "attack two", attacks: { node: target, slot: "warrant" } },
    ]);
    expect(second[0]!.promoted).toBeUndefined();
    expect(repo.getRebuttals(db, warrantNode)).toEqual(
      [first[0]!.id, second[0]!.id].sort((a, b) => a - b)
    );
  });

  test("攻击一个空理由槽:拒绝,因为指名的对象不存在(V2 那一类)", () => {
    const target = svc.createPropositions(db, root, [{ content: "no warrant" }])[0]!.id;
    expect(() =>
      svc.createPropositions(db, root, [
        { content: "attack", attacks: { node: target, slot: "warrant" } },
      ])
    ).toThrow(ValidationError);
  });
});

// =============================================================================
// update_proposition
// =============================================================================

describe("update_proposition", () => {
  test("改 content,事件载荷是字段级 diff", () => {
    const id = create("before");
    svc.updateProposition(db, root, { id, content: "after" });
    const ev = svc.getHistory(db, { id }).events.find((e) => e.op === "update")!;
    expect((ev.payload as any).content).toEqual({ old: "before", new: "after" });
  });

  test("证据与反驳一律 add/remove", () => {
    const a = create("a");
    const b = create("b");
    const id = create("holder");
    svc.updateProposition(db, root, { id, evidence: { add_nodes: [a, b] } });
    expect(repo.getEvidenceNodes(db, id)).toEqual([a, b].sort((x, y) => x - y));

    svc.updateProposition(db, root, { id, evidence: { remove_nodes: [a] } });
    expect(repo.getEvidenceNodes(db, id)).toEqual([b]);
  });

  test("成员 diff 事后比,记的是实际变成了什么", () => {
    const a = create("a");
    const id = create("holder");
    svc.updateProposition(db, root, { id, evidence: { add_nodes: [a] } });
    const ev = svc.getHistory(db, { id }).events.find((e) => e.op === "update")!;
    expect((ev.payload as any)["evidence.nodes"]).toEqual({ old: [], new: [a] });
  });

  test("重复 add 同一个成员不产生第二条 update 事件(什么都没变)", () => {
    const a = create("a");
    const id = create("holder");
    svc.updateProposition(db, root, { id, evidence: { add_nodes: [a] } });
    svc.updateProposition(db, root, { id, evidence: { add_nodes: [a] } });
    expect(ops(id).filter((o) => o === "update")).toHaveLength(1);
  });

  test("理由已晋升时拒绝改 warrant,并指出该改哪条命题", () => {
    const target = create("target");
    const out = svc.createPropositions(db, root, [
      { content: "attack", attacks: { node: target, slot: "warrant" } },
    ]);
    const newId = out[0]!.promoted!.new_id;

    expect(() => svc.updateProposition(db, root, { id: target, warrant: "new text" })).toThrow(
      new RegExp(String(newId))
    );
  });

  test("不接受 qualifier:改内容与重新判定在事件流里长得不一样", () => {
    const id = create();
    // 类型层面已经没有这个字段;这里断言的是它确实没被偷偷读进去。
    svc.updateProposition(db, root, { id, content: "changed", ...({ qualifier: "certainly" } as any) });
    expect(repo.getProposition(db, id)!.qualifier).toBe("unestablished");
    expect(repo.getBaselineHead(db, id)).toBeNull();
  });

  test("改动已定案的命题却没留 note:温和提示,不拦截", () => {
    const id = create();
    svc.setQualifier(db, root, [{ id, qualifier: "possibly" }]);
    const res = svc.updateProposition(db, root, { id, content: "reworded" });
    expect(res.notices?.join(" ")).toContain("note");
  });

  test("留了 note 就不提示", () => {
    const id = create();
    svc.setQualifier(db, root, [{ id, qualifier: "possibly" }]);
    const res = svc.updateProposition(db, root, { id, content: "reworded", note: "new data" });
    expect(res.notices).toBeUndefined();
  });

  test("不存在的命题抛 NotFoundError", () => {
    expect(() => svc.updateProposition(db, root, { id: 999, content: "x" })).toThrow(NotFoundError);
  });
});

// =============================================================================
// set_qualifier
// =============================================================================

describe("set_qualifier", () => {
  test("落基线:引用的 (content hash, qualifier) 被快照下来", () => {
    const ev = create("evidence");
    svc.setQualifier(db, root, [{ id: ev, qualifier: "certainly" }]);
    const id = create("conclusion", { evidence: { nodes: [ev] } });
    svc.setQualifier(db, root, [{ id, qualifier: "probably" }]);

    const refs = repo.getBaselineRefs(db, id);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.refId).toBe(ev);
    expect(refs[0]!.refRole).toBe("evidence");
    expect(refs[0]!.qualifier).toBe("certainly");
  });

  test("它是基线唯一的写入者:create / update 都不写", () => {
    const id = create();
    expect(repo.getBaselineHead(db, id)).toBeNull();
    svc.updateProposition(db, root, { id, content: "still nothing" });
    expect(repo.getBaselineHead(db, id)).toBeNull();
    svc.setQualifier(db, root, [{ id, qualifier: "possibly" }]);
    expect(repo.getBaselineHead(db, id)).not.toBeNull();
  });

  test("结构检查违反不拦截,只返回警告", () => {
    const id = svc.createPropositions(db, root, [{ content: "bare" }])[0]!.id;
    const res = svc.setQualifier(db, root, [{ id, qualifier: "certainly" }]);
    expect(repo.getProposition(db, id)!.qualifier).toBe("certainly");
    expect(res[0]!.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining([CheckCode.EvidenceEmpty, CheckCode.WarrantEmpty])
    );
  });

  test("返回上一档与新档位", () => {
    const id = create();
    svc.setQualifier(db, root, [{ id, qualifier: "possibly" }]);
    const res = svc.setQualifier(db, root, [{ id, qualifier: "probably" }]);
    expect(res[0]!.previous).toBe("possibly");
    expect(res[0]!.qualifier).toBe("probably");
  });

  test("非法档位拒绝", () => {
    const id = create();
    expect(() => svc.setQualifier(db, root, [{ id, qualifier: "verified" as any }])).toThrow(
      ValidationError
    );
  });

  test("留痕:qualifier 事件记 old → new", () => {
    const id = create();
    svc.setQualifier(db, root, [{ id, qualifier: "possibly", note: "two independent runs" }]);
    const ev = svc.getHistory(db, { id }).events.find((e) => e.op === "qualifier")!;
    expect(ev.payload).toEqual({ old: "unestablished", new: "possibly" });
    expect(ev.note).toBe("two independent runs");
  });

  test("重设 qualifier 会覆盖基线,而不是叠加", () => {
    const ev1 = create("e1");
    const ev2 = create("e2");
    const id = create("c", { evidence: { nodes: [ev1] } });
    svc.setQualifier(db, root, [{ id, qualifier: "possibly" }]);

    svc.updateProposition(db, root, {
      id,
      evidence: { remove_nodes: [ev1], add_nodes: [ev2] },
    });
    svc.setQualifier(db, root, [{ id, qualifier: "possibly" }]);

    const refs = repo.getBaselineRefs(db, id);
    expect(refs.map((r) => r.refId)).toEqual([ev2]);
  });
});

// =============================================================================
// promote_warrant
// =============================================================================

describe("promote_warrant", () => {
  test("内联文本原样成为新命题的 content,原槽位改为指向它", () => {
    const id = create("conclusion", { warrant: "The principle" });
    const res = svc.promoteWarrant(db, root, { id });
    expect(repo.getProposition(db, res.newId)!.content).toBe("The principle");
    expect(repo.getProposition(db, id)!.warrant_node_id).toBe(res.newId);
  });

  test("可以给晋升出来的命题带上自己的理由与依据(backing)", () => {
    const path = root.file("backing.md");
    const id = create("conclusion", { warrant: "The principle" });
    const res = svc.promoteWarrant(db, root, {
      id,
      warrant: "Why this principle holds",
      evidence: { attachments: [path] },
    });
    expect(repo.getProposition(db, res.newId)!.warrant_text).toBe("Why this principle holds");
    expect(repo.getAttachments(db, res.newId)).toEqual([path]);
  });

  test("空理由槽拒绝晋升;已晋升的再晋升也拒绝", () => {
    const bare = svc.createPropositions(db, root, [{ content: "bare" }])[0]!.id;
    expect(() => svc.promoteWarrant(db, root, { id: bare })).toThrow(ValidationError);

    const id = create("c", { warrant: "P" });
    svc.promoteWarrant(db, root, { id });
    expect(() => svc.promoteWarrant(db, root, { id })).toThrow(ValidationError);
  });

  test("晋升出的命题落 unestablished,由 set_qualifier 判定", () => {
    const id = create("c", { warrant: "P" });
    const res = svc.promoteWarrant(db, root, { id });
    expect(repo.getProposition(db, res.newId)!.qualifier).toBe("unestablished");
  });
});

// =============================================================================
// delete_proposition
// =============================================================================

describe("delete_proposition", () => {
  test("墓碑:整节点 before 快照进事件流,并活过节点本身", () => {
    const id = create("doomed");
    svc.deleteProposition(db, root, { id, note: "superseded" });

    expect(repo.getProposition(db, id)).toBeNull();
    const ev = svc.getHistory(db, { id }).events.find((e) => e.op === "delete")!;
    expect((ev.payload as any).before.content).toBe("doomed");
    expect(ev.note).toBe("superseded");
  });

  test("被引用时列出受影响的命题,并把引用从它们的槽里摘掉", () => {
    const ev = create("evidence");
    const user = create("uses it", { evidence: { nodes: [ev] } });

    const res = svc.deleteProposition(db, root, { id: ev });
    expect(res.affected).toEqual([user]);
    expect(repo.getEvidenceNodes(db, user)).toEqual([]);
    expect(res.notices?.join(" ")).toContain(`#${user}`);
  });

  test("受影响的命题被标为该重查:已阅警告全部复燃", () => {
    const evPath = root.file("e.md");
    const ev = create("evidence", { evidence: { attachments: [evPath] } });
    svc.setQualifier(db, root, [{ id: ev, qualifier: "certainly" }]);

    const user = create("uses it", { evidence: { nodes: [ev] } });
    svc.setQualifier(db, root, [{ id: user, qualifier: "probably" }]);
    expect(svc.propositionView(db, root, user).warnings).toEqual([]);

    svc.deleteProposition(db, root, { id: ev });
    const after = svc.propositionView(db, root, user).warnings;
    expect(after.map((w) => w.code)).toEqual(
      expect.arrayContaining([CheckCode.SelfChanged, CheckCode.RefGone])
    );
    expect(after.every((w) => w.state === "pending")).toBe(true);
  });

  test("没有 cascade:被删命题引用的东西一个都不动", () => {
    const inner = create("inner");
    const outer = create("outer", { evidence: { nodes: [inner] } });
    svc.deleteProposition(db, root, { id: outer });
    expect(repo.getProposition(db, inner)).not.toBeNull();
  });

  test("删掉一条被当作理由的命题:引用方的理由槽变空", () => {
    const id = create("c", { warrant: "P" });
    const res = svc.promoteWarrant(db, root, { id });
    const del = svc.deleteProposition(db, root, { id: res.newId });

    expect(del.affected).toEqual([id]);
    expect(svc.propositionView(db, root, id).warrant).toEqual({ kind: "empty" });
  });
});

// =============================================================================
// get_argument / find_propositions / get_stats
// =============================================================================

describe("读取", () => {
  test("depth=0 只读这一条", () => {
    const ev = create("evidence");
    const id = create("conclusion", { evidence: { nodes: [ev] } });
    const res = svc.getArgument(db, root, { id, depth: 0 });
    expect(res.neighbors).toEqual([]);
  });

  test("depth=1 拿到直接证据、反驳与晋升后的理由", () => {
    const ev = create("evidence");
    const id = create("conclusion", { evidence: { nodes: [ev] }, warrant: "P" });
    const w = svc.promoteWarrant(db, root, { id }).newId;
    const reb = svc.createPropositions(db, root, [
      { content: "counter", attacks: { node: id, slot: "content" } },
    ])[0]!.id;

    const res = svc.getArgument(db, root, { id, depth: 1 });
    expect(res.neighbors.map((n) => n.id).sort((a, b) => a - b)).toEqual(
      [ev, w, reb].sort((a, b) => a - b)
    );
  });

  test("邻域不重复:环状引用不会把同一条命题拉两遍", () => {
    const a = create("a");
    const b = create("b", { evidence: { nodes: [a] } });
    svc.updateProposition(db, root, { id: a, evidence: { add_nodes: [b] } });
    const res = svc.getArgument(db, root, { id: a, depth: 5 });
    expect(res.neighbors.map((n) => n.id)).toEqual([b]);
  });

  test("每条命题都带 warnings 与 findings,不需要开关", () => {
    const id = create();
    const view = svc.propositionView(db, root, id);
    expect(Array.isArray(view.warnings)).toBe(true);
    expect(Array.isArray(view.findings)).toBe(true);
  });

  test("find_propositions 按档位筛", () => {
    const a = create("alpha");
    create("beta");
    svc.setQualifier(db, root, [{ id: a, qualifier: "certainly" }]);
    const res = svc.findPropositions(db, root, { qualifier: ["certainly"] });
    expect(res.items.map((i) => i.id)).toEqual([a]);
    expect(res.total).toBe(1);
  });

  test("find_propositions 按关键词筛(trigram 要求 ≥3 字符)", () => {
    const a = create("photosynthesis rate increases");
    create("unrelated");
    const res = svc.findPropositions(db, root, { query: "photosynthesis" });
    expect(res.items.map((i) => i.id)).toEqual([a]);
  });

  test("has_unresolved 只留有待处理警告或意见的,total 跟着过滤后的数量走", () => {
    const clean = create("clean one");
    const dirty = svc.createPropositions(db, root, [{ content: "bare" }])[0]!.id;
    svc.setQualifier(db, root, [{ id: dirty, qualifier: "possibly" }]);

    const res = svc.findPropositions(db, root, { has_unresolved: true });
    expect(res.items.map((i) => i.id)).toEqual([dirty]);
    expect(res.total).toBe(1);
    expect(res.items.map((i) => i.id)).not.toContain(clean);
  });

  test("get_stats:红点清单 + 各档计数 + 失踪附件", () => {
    const path = root.file("evidence.md");
    const id = create("with evidence", { evidence: { attachments: [path] } });
    svc.setQualifier(db, root, [{ id, qualifier: "possibly" }]);
    root.unlink(path);

    const stats = svc.getStats(db, root);
    expect(stats.total).toBe(1);
    expect(stats.byQualifier.possibly).toBe(1);
    expect(stats.attachments).toEqual({ total: 1, missing: [path] });
    expect(stats.unresolvedWarnings[0]!.codes).toContain(CheckCode.AttachmentMissing);
  });

  test("get_history 不带 id 时给全图最近事件", () => {
    create("one");
    create("two");
    expect(svc.getHistory(db, {}).total).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// dismiss
// =============================================================================

describe("dismiss", () => {
  test("驳回一条警告,必写理由", () => {
    const id = svc.createPropositions(db, root, [{ content: "bare" }])[0]!.id;
    svc.setQualifier(db, root, [{ id, qualifier: "possibly" }]);
    const w = svc.propositionView(db, root, id).warnings[0]!;

    const res = svc.dismiss(db, root, [{ id: w.id, reason: "evidence is in the ticket system" }]);
    expect(res[0]).toMatchObject({ target: "warning", ok: true });
    expect(svc.propositionView(db, root, id).warnings.find((x) => x.id === w.id)!.state).toBe(
      "acknowledged"
    );
  });

  test("空理由拒绝——理由是这个动作全部的审计价值", () => {
    const id = svc.createPropositions(db, root, [{ content: "bare" }])[0]!.id;
    svc.setQualifier(db, root, [{ id, qualifier: "possibly" }]);
    const w = svc.propositionView(db, root, id).warnings[0]!;
    expect(() => svc.dismiss(db, root, [{ id: w.id, reason: "  " }])).toThrow(ValidationError);
  });

  test("驳回是降级不是删除:警告还在,只是不再 pending", () => {
    const id = svc.createPropositions(db, root, [{ content: "bare" }])[0]!.id;
    svc.setQualifier(db, root, [{ id, qualifier: "possibly" }]);
    const before = svc.propositionView(db, root, id).warnings;
    svc.dismiss(db, root, [{ id: before[0]!.id, reason: "fine" }]);
    expect(svc.propositionView(db, root, id).warnings).toHaveLength(before.length);
  });

  test("过期的 id 不抛异常,据实说明它为什么对不上", () => {
    const res = svc.dismiss(db, root, [{ id: "w_deadbeefdeadbeef", reason: "stale" }]);
    expect(res[0]!.ok).toBe(false);
    expect(res[0]!.target).toBe("unknown");
    expect(res[0]!.message).toContain("re-arm");
  });

  test("dismiss 只 append 一条事件,不改原对象", () => {
    const id = svc.createPropositions(db, root, [{ content: "bare" }])[0]!.id;
    svc.setQualifier(db, root, [{ id, qualifier: "possibly" }]);
    const w = svc.propositionView(db, root, id).warnings[0]!;
    svc.dismiss(db, root, [{ id: w.id, reason: "fine" }]);

    const ev = svc.getHistory(db, {}).events.find((e) => e.op === "dismiss")!;
    expect(ev.targetKey).toBe(w.id);
    expect((ev.payload as any).reason).toBe("fine");
  });
});

// =============================================================================
// review 落库
// =============================================================================

describe("recordReview", () => {
  test("答'是'也留痕:findings 为空照样写事件", () => {
    const id = create();
    const res = svc.recordReview(db, {
      nodeId: id,
      Q1: "n/a",
      Q2: "pass",
      findings: [],
      model: "test-model",
      protocolHash: "abc123",
    });
    expect(res.findings).toEqual([]);
    const ev = svc.getHistory(db, { id }).events.find((e) => e.op === "review")!;
    expect((ev.payload as any).Q1).toBe("n/a");
  });

  test("finding id 在落库那一刻生成,含 review 事件 id", () => {
    const id = create();
    const res = svc.recordReview(db, {
      nodeId: id,
      Q1: "n/a",
      Q2: "fail",
      findings: [
        {
          nodeId: id,
          question: "Q2",
          confidence: "high",
          content: "The warrant does not reach the content.",
          citation: { nodeId: id, slot: "content", quote: "A proposition" },
        },
      ],
      model: "test-model",
      protocolHash: "abc123",
    });
    expect(res.findings[0]!.id).toBe(`f_${res.eventId}_1`);
    expect(svc.propositionView(db, root, id).findings[0]!.state).toBe("pending");
  });

  test("新一次 review 取代上一批 findings", () => {
    const id = create();
    const draft = (content: string) => ({
      nodeId: id,
      question: "Q2" as const,
      confidence: "low" as const,
      content,
      citation: { nodeId: id, slot: "content" as const, quote: "A proposition" },
    });

    svc.recordReview(db, {
      nodeId: id,
      Q1: "n/a",
      Q2: "fail",
      findings: [draft("first round")],
      model: "m",
      protocolHash: "h",
    });
    svc.recordReview(db, {
      nodeId: id,
      Q1: "n/a",
      Q2: "fail",
      findings: [draft("second round")],
      model: "m",
      protocolHash: "h",
    });

    const current = svc.propositionView(db, root, id).findings;
    expect(current).toHaveLength(1);
    expect(current[0]!.content).toBe("second round");
    // 被取代的那批不消失,事件流里读得到。
    expect(ops(id).filter((o) => o === "review")).toHaveLength(2);
  });

  test("finding 不随图变化过期:改 content 之后仍然待处理", () => {
    const id = create();
    svc.recordReview(db, {
      nodeId: id,
      Q1: "n/a",
      Q2: "fail",
      findings: [
        {
          nodeId: id,
          question: "Q2",
          confidence: "high",
          content: "does not follow",
          citation: { nodeId: id, slot: "content", quote: "A proposition" },
        },
      ],
      model: "m",
      protocolHash: "h",
    });

    svc.updateProposition(db, root, { id, content: "reworded to dodge the objection" });
    const findings = svc.propositionView(db, root, id).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]!.state).toBe("pending");
  });

  test("finding 可以被驳回,理由与时间留痕", () => {
    const id = create();
    const res = svc.recordReview(db, {
      nodeId: id,
      Q1: "n/a",
      Q2: "fail",
      findings: [
        {
          nodeId: id,
          question: "Q2",
          confidence: "low",
          content: "does not follow",
          citation: { nodeId: id, slot: "content", quote: "A proposition" },
        },
      ],
      model: "m",
      protocolHash: "h",
    });

    const out = svc.dismiss(db, root, [
      { id: res.findings[0]!.id, reason: "the reviewer misread the scope" },
    ]);
    expect(out[0]).toMatchObject({ target: "finding", ok: true });

    const f = svc.propositionView(db, root, id).findings[0]!;
    expect(f.state).toBe("acknowledged");
    expect(f.dismissal!.reason).toContain("misread");
  });

  test("带未处理 finding 判档:醒目提示,但不拦截", () => {
    const id = create();
    svc.recordReview(db, {
      nodeId: id,
      Q1: "n/a",
      Q2: "fail",
      findings: [
        {
          nodeId: id,
          question: "Q2",
          confidence: "high",
          content: "does not follow",
          citation: { nodeId: id, slot: "content", quote: "A proposition" },
        },
      ],
      model: "m",
      protocolHash: "h",
    });

    const res = svc.setQualifier(db, root, [{ id, qualifier: "probably" }]);
    expect(repo.getProposition(db, id)!.qualifier).toBe("probably");
    expect(res[0]!.notices?.join(" ")).toContain("unresolved");
  });
});

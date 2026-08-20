/**
 * 结构检查(design.md §3.1 / §3.1c)
 *
 * 这套用例的组织方式对着判据表:一档一节,加上基线比对与可寻址性两节。
 * 每条断言都指向表里的一格,读用例应该能读出"表长什么样"。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import * as repo from "../src/repo.ts";
import {
  computeWarnings,
  checkContext,
  isInsideRoot,
  attachmentExists,
} from "../src/structural-check.ts";
import { CheckCode } from "../src/types.ts";
import {
  createTestDb,
  cleanupDb,
  makeProposition,
  makeTempRoot,
  pointWarrantAt,
  settle,
  dismiss,
  type TempRoot,
} from "./helpers.ts";

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

/** 只取判据编号,断言里不必逐条比整个对象。 */
function codes(nodeId: number): string[] {
  return computeWarnings(db, root, nodeId).map((w) => w.code);
}

function pending(nodeId: number) {
  return computeWarnings(db, root, nodeId).filter((w) => w.state === "pending");
}

// =============================================================================
// unestablished:一条都不查
// =============================================================================

describe("unestablished", () => {
  test("空证据、空理由、什么都没有,也不标红", () => {
    const id = makeProposition(db, { warrant: "", attachments: [], evidence: [] });
    expect(codes(id)).toEqual([]);
  });

  test("默认档位就是 unestablished(create 不接受 qualifier)", () => {
    const id = makeProposition(db);
    expect(repo.getProposition(db, id)!.qualifier).toBe("unestablished");
  });
});

// =============================================================================
// possibly:证据非空 / 附件存在 / 理由非空,但不查引用链
// =============================================================================

describe("possibly", () => {
  test("S1 证据槽两边都空才算空", () => {
    const id = makeProposition(db);
    settle(db, id, "possibly");
    expect(codes(id)).toContain(CheckCode.EvidenceEmpty);
  });

  test("S1 只挂了附件也算非空", () => {
    const id = makeProposition(db, { attachments: [root.file("a.md")] });
    settle(db, id, "possibly");
    expect(codes(id)).not.toContain(CheckCode.EvidenceEmpty);
  });

  test("S1 只挂了命题也算非空", () => {
    const ev = makeProposition(db);
    const id = makeProposition(db, { evidence: [ev] });
    settle(db, id, "possibly");
    expect(codes(id)).not.toContain(CheckCode.EvidenceEmpty);
  });

  test("S2 写硬读软:写入时在,之后被删,读时标红并指出是哪个文件", () => {
    const path = root.file("gone.md");
    const id = makeProposition(db, { attachments: [path] });
    settle(db, id, "possibly");
    expect(codes(id)).not.toContain(CheckCode.AttachmentMissing);

    root.unlink(path);
    const w = computeWarnings(db, root, id).find((x) => x.code === CheckCode.AttachmentMissing);
    expect(w).toBeDefined();
    expect(w!.trigger).toBe(path);
    expect(w!.message).toContain(path);
  });

  test("S2 命中时不再叠一条 S5:文件都不在了,说它不可移植是噪音", () => {
    const id = makeProposition(db, { attachments: ["../outside-and-missing.md"] });
    settle(db, id, "possibly");
    const c = codes(id);
    expect(c).toContain(CheckCode.AttachmentMissing);
    expect(c).not.toContain(CheckCode.AttachmentOutOfRoot);
  });

  test("S3 理由为空(曾经的 V4,现在是表内判据)", () => {
    const id = makeProposition(db, { warrant: "", attachments: [root.file("a.md")] });
    settle(db, id, "possibly");
    expect(codes(id)).toContain(CheckCode.WarrantEmpty);
  });

  test("S3 晋升后的理由算非空", () => {
    const w = makeProposition(db, { content: "The promoted warrant" });
    const id = makeProposition(db, { warrant: "", attachments: [root.file("a.md")] });
    pointWarrantAt(db, id, w);
    settle(db, id, "possibly");
    expect(codes(id)).not.toContain(CheckCode.WarrantEmpty);
  });

  test("S4 不在 possibly 上跑:引用链的可信度要求实质起点在 probably", () => {
    const ev = makeProposition(db); // unestablished
    const id = makeProposition(db, { evidence: [ev] });
    settle(db, id, "possibly");
    expect(codes(id)).not.toContain(CheckCode.EvidenceUnestablished);
  });

  test("空理由、unestablished 的证据撑一条 possibly,全程不标红(design.md §3.1 认下的代价)", () => {
    const ev = makeProposition(db, { warrant: "" });
    const id = makeProposition(db, { evidence: [ev] });
    settle(db, id, "possibly");
    expect(codes(id)).toEqual([]);
  });
});

// =============================================================================
// probably / certainly:加查引用链
// =============================================================================

describe("probably / certainly", () => {
  test("S4 引用一条 unestablished 的证据要标红,并指出是哪一条", () => {
    const ev = makeProposition(db);
    const id = makeProposition(db, { evidence: [ev] });
    settle(db, id, "probably");
    const w = computeWarnings(db, root, id).find(
      (x) => x.code === CheckCode.EvidenceUnestablished
    );
    expect(w).toBeDefined();
    expect(w!.trigger).toBe(`evidence:${ev}`);
  });

  test("S4 refuted 的命题可以当证据——用的是'它被推翻'这个事实", () => {
    const ev = makeProposition(db, { rebuttals: [makeProposition(db)] });
    settle(db, ev, "refuted");
    const id = makeProposition(db, { evidence: [ev] });
    settle(db, id, "certainly");
    expect(codes(id)).not.toContain(CheckCode.EvidenceUnestablished);
  });

  test("S4 晋升后的 warrant 也算直接引用(api.md §2.1-②的自动追讨路径)", () => {
    const w = makeProposition(db, { content: "System-promoted warrant" });
    const id = makeProposition(db, { attachments: [root.file("a.md")] });
    pointWarrantAt(db, id, w);
    settle(db, id, "probably");
    const hit = computeWarnings(db, root, id).find(
      (x) => x.code === CheckCode.EvidenceUnestablished
    );
    expect(hit).toBeDefined();
    expect(hit!.trigger).toBe(`warrant:${w}`);
  });

  test("S4 不看反驳:攻击侧走 A2 的正向三档,不走这个闸", () => {
    const reb = makeProposition(db); // unestablished
    const id = makeProposition(db, { attachments: [root.file("a.md")], rebuttals: [reb] });
    settle(db, id, "certainly");
    expect(codes(id)).not.toContain(CheckCode.EvidenceUnestablished);
  });

  test("正向命题带正向三档的反驳不标红:力度归 L3 判", () => {
    const reb = makeProposition(db, { attachments: [root.file("r.md")] });
    settle(db, reb, "certainly");
    const id = makeProposition(db, { attachments: [root.file("a.md")], rebuttals: [reb] });
    settle(db, id, "probably");
    expect(codes(id)).toEqual([]);
  });
});

// =============================================================================
// refuted:只查攻击侧
// =============================================================================

describe("refuted", () => {
  test("A1 反驳槽为空", () => {
    const id = makeProposition(db);
    settle(db, id, "refuted");
    expect(codes(id)).toContain(CheckCode.RebuttalEmpty);
  });

  test("A2 反驳自己没落在正向三档", () => {
    const reb = makeProposition(db); // unestablished
    const id = makeProposition(db, { rebuttals: [reb] });
    settle(db, id, "refuted");
    const w = computeWarnings(db, root, id).find(
      (x) => x.code === CheckCode.RebuttalNotPositive
    );
    expect(w).toBeDefined();
    expect(w!.trigger).toBe(`rebuttal:${reb}`);
  });

  test("A2 被推翻的反驳打不动人:攻击力随它自己被推翻一起消解", () => {
    const inner = makeProposition(db, { rebuttals: [makeProposition(db)] });
    settle(db, inner, "refuted");
    const id = makeProposition(db, { rebuttals: [inner] });
    settle(db, id, "refuted");
    expect(codes(id)).toContain(CheckCode.RebuttalNotPositive);
  });

  test("refuted 不查支撑侧:空证据、空理由都不响", () => {
    const reb = makeProposition(db);
    settle(db, reb, "possibly");
    const id = makeProposition(db, { warrant: "", rebuttals: [reb] });
    settle(db, id, "refuted");
    expect(codes(id)).toEqual([]);
  });
});

// =============================================================================
// 基线比对(R 族)
// =============================================================================

describe("基线比对", () => {
  test("R0 判断之后改 content", () => {
    const id = makeProposition(db, { attachments: [root.file("a.md")] });
    settle(db, id, "probably");
    expect(codes(id)).toEqual([]);

    repo.updatePropositionFields(db, id, { content: "Rewritten" });
    expect(codes(id)).toContain(CheckCode.SelfChanged);
  });

  test("R0 成员清单变化也算自己变了", () => {
    const id = makeProposition(db, { attachments: [root.file("a.md")] });
    settle(db, id, "probably");
    repo.addAttachments(db, id, [root.file("b.md")]);
    expect(codes(id)).toContain(CheckCode.SelfChanged);
  });

  test("R0 改了又改回来,判为未变(比的是状态,不是有没有发生过写事件)", () => {
    const id = makeProposition(db, { content: "Original", attachments: [root.file("a.md")] });
    settle(db, id, "probably");
    repo.updatePropositionFields(db, id, { content: "Detour" });
    repo.updatePropositionFields(db, id, { content: "Original" });
    expect(codes(id)).toEqual([]);
  });

  test("R1 判断时依据的引用被删了", () => {
    const ev = makeProposition(db, { attachments: [root.file("e.md")] });
    settle(db, ev, "certainly");
    const id = makeProposition(db, { evidence: [ev] });
    settle(db, id, "probably");

    repo.deleteProposition(db, ev);
    const w = computeWarnings(db, root, id);
    expect(w.map((x) => x.code)).toContain(CheckCode.RefGone);
    expect(w.find((x) => x.code === CheckCode.RefGone)!.trigger).toBe(`evidence:${ev}`);
  });

  test("R2 引用的 content 被改写", () => {
    const ev = makeProposition(db, { attachments: [root.file("e.md")] });
    settle(db, ev, "certainly");
    const id = makeProposition(db, { evidence: [ev] });
    settle(db, id, "probably");

    repo.updatePropositionFields(db, ev, { content: "Different claim entirely" });
    expect(codes(id)).toContain(CheckCode.RefContentChanged);
  });

  test("R3 引用从 certainly 掉到 refuted:闸放行,基线比对抓", () => {
    const ev = makeProposition(db, { attachments: [root.file("e.md")] });
    settle(db, ev, "certainly");
    const id = makeProposition(db, { evidence: [ev] });
    settle(db, id, "probably");

    settle(db, ev, "refuted");
    const c = codes(id);
    expect(c).toContain(CheckCode.RefQualifierChanged);
    // 闸只问"能不能用",refuted 能用,所以 S4 不响——同一件事不判两次。
    expect(c).not.toContain(CheckCode.EvidenceUnestablished);
  });

  test("R 族不按档位放宽:possibly 的引用被改写照样标红", () => {
    const ev = makeProposition(db, { attachments: [root.file("e.md")] });
    settle(db, ev, "possibly");
    const id = makeProposition(db, { evidence: [ev] });
    settle(db, id, "possibly");
    expect(codes(id)).toEqual([]);

    repo.updatePropositionFields(db, ev, { content: "Rewritten" });
    expect(codes(id)).toContain(CheckCode.RefContentChanged);
  });

  test("R 族在 refuted 上照跑:反驳被改写要重看", () => {
    const reb = makeProposition(db, { attachments: [root.file("r.md")] });
    settle(db, reb, "certainly");
    const id = makeProposition(db, { rebuttals: [reb] });
    settle(db, id, "refuted");
    expect(codes(id)).toEqual([]);

    repo.updatePropositionFields(db, reb, { content: "Not actually a counterexample" });
    expect(codes(id)).toContain(CheckCode.RefContentChanged);
  });

  test("unestablished 没有基线,R 族整族跳过,也不为'缺基线'另发警告", () => {
    const ev = makeProposition(db);
    const id = makeProposition(db, { evidence: [ev] });
    repo.updatePropositionFields(db, ev, { content: "Changed" });
    expect(codes(id)).toEqual([]);
  });

  test("R2 与 R3 各说各的事,可以同时成立", () => {
    const ev = makeProposition(db, { attachments: [root.file("e.md")] });
    settle(db, ev, "certainly");
    const id = makeProposition(db, { evidence: [ev] });
    settle(db, id, "probably");

    repo.updatePropositionFields(db, ev, { content: "Rewritten" });
    settle(db, ev, "possibly");
    const c = codes(id);
    expect(c).toContain(CheckCode.RefContentChanged);
    expect(c).toContain(CheckCode.RefQualifierChanged);
  });
});

// =============================================================================
// 可寻址性与复燃(api.md §5)
// =============================================================================

describe("警告 id 与复燃", () => {
  test("id 稳定:同一状态重复计算得到同一个 id", () => {
    const id = makeProposition(db);
    settle(db, id, "possibly");
    const a = computeWarnings(db, root, id).map((w) => w.id);
    const b = computeWarnings(db, root, id).map((w) => w.id);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  test("同一命题上不同判据的 id 不同", () => {
    const id = makeProposition(db, { warrant: "" });
    settle(db, id, "possibly");
    const ids = computeWarnings(db, root, id).map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("dismiss 把警告降为 acknowledged,附理由与时间,不删除", () => {
    const id = makeProposition(db);
    settle(db, id, "possibly");
    const target = computeWarnings(db, root, id)[0]!;
    dismiss(db, target.id, "evidence lives in the ticket system, deliberately not attached");

    const after = computeWarnings(db, root, id).find((w) => w.id === target.id)!;
    expect(after.state).toBe("acknowledged");
    expect(after.dismissal!.reason).toContain("ticket system");
    expect(after.dismissal!.at).toBeTruthy();
  });

  test("复燃:本命题一变,已阅警告全部回到 pending", () => {
    const id = makeProposition(db, { warrant: "" });
    settle(db, id, "possibly");
    for (const w of computeWarnings(db, root, id)) dismiss(db, w.id);
    expect(pending(id)).toHaveLength(0);

    repo.updatePropositionFields(db, id, { content: "Rewritten" });
    // 一条 dismiss 都不再命中——判据即 id 的指纹,不需要单独的复燃实现。
    expect(pending(id).length).toBeGreaterThan(0);
    expect(computeWarnings(db, root, id).every((w) => w.state === "pending")).toBe(true);
  });

  test("复燃:引用节点改判,已阅警告一样复燃", () => {
    const ev = makeProposition(db);
    const id = makeProposition(db, { evidence: [ev], warrant: "" });
    settle(db, id, "possibly");
    for (const w of computeWarnings(db, root, id)) dismiss(db, w.id);
    expect(pending(id)).toHaveLength(0);

    settle(db, ev, "certainly");
    expect(pending(id).length).toBeGreaterThan(0);
  });

  test("驳回一条只降级一条", () => {
    const id = makeProposition(db, { warrant: "" });
    settle(db, id, "possibly");
    const all = computeWarnings(db, root, id);
    expect(all.length).toBeGreaterThan(1);
    dismiss(db, all[0]!.id);

    const after = computeWarnings(db, root, id);
    expect(after.filter((w) => w.state === "acknowledged")).toHaveLength(1);
    expect(after.filter((w) => w.state === "pending")).toHaveLength(all.length - 1);
  });

  test("同一 id 被驳回多次,理由以最新一条为准", () => {
    const id = makeProposition(db);
    settle(db, id, "possibly");
    const target = computeWarnings(db, root, id)[0]!;
    dismiss(db, target.id, "first reason");
    dismiss(db, target.id, "second reason");
    const after = computeWarnings(db, root, id).find((w) => w.id === target.id)!;
    expect(after.dismissal!.reason).toBe("second reason");
  });
});

// =============================================================================
// 附件路径解析:写读同一个基准
// =============================================================================

describe("附件路径解析", () => {
  test("相对路径从项目根解析", () => {
    const p = root.file("inside.md");
    expect(attachmentExists(root, p)).toBe(true);
    expect(isInsideRoot(root, p)).toBe(true);
  });

  test("根外路径判为不可移植", () => {
    expect(isInsideRoot(root, "../elsewhere.md")).toBe(false);
  });

  test("前缀相同但不是子目录的兄弟目录不算在根内", () => {
    const sibling = `${root.root}-sibling/file.md`;
    expect(isInsideRoot(root, sibling)).toBe(false);
  });

  test("基准 = 数据库文件的祖父目录(与审查子进程的 cwd 同源)", () => {
    expect(checkContext("/proj/.toulmin/graph.db").root).toBe("/proj");
  });
});

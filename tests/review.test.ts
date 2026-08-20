/**
 * review 通道(design.md §2.2 / api.md §4.1)
 *
 * 不起子进程:这一层能测的是**输入边界**与 **F1–F4**,两者都不需要真跑一次审查。
 * 真正调 LLM 的那段只在 `runReview` 里,它的可测部分已经拆成 `interpretResponse`。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import * as svc from "../src/service.ts";
import { buildInput, interpretResponse, runReview } from "../src/review-run.ts";
import { buildReviewPrompt, protocolHash } from "../src/review-prompts.ts";
import { validateFindings } from "../src/review-validate.ts";
import { ReviewUnavailableError } from "../src/errors.ts";
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

function create(content: string, extra: Record<string, unknown> = {}): number {
  return svc.createPropositions(db, root, [{ content, ...extra }])[0]!.id;
}

// =============================================================================
// 输入边界(design.md §2.2)
// =============================================================================

describe("输入边界", () => {
  test("引用节点的 qualifier 进:前提的极性是前提的一部分", () => {
    const ev = create("Assume X holds");
    svc.setQualifier(db, root, [{ id: ev, qualifier: "refuted" }]);
    const id = create("Therefore Y", { evidence: { nodes: [ev] } });

    const input = buildInput(db, id);
    expect(input.evidenceNodes).toEqual([
      { id: ev, content: "Assume X holds", qualifier: "refuted" },
    ]);
    expect(buildReviewPrompt(input)).toContain(`#${ev} [refuted]`);
  });

  test("被审查命题自己的 qualifier 不进——字段不存在,不是 prompt 里少说一句", () => {
    const id = create("The conclusion");
    svc.setQualifier(db, root, [{ id, qualifier: "certainly" }]);

    const input = buildInput(db, id);
    expect(Object.keys(input)).not.toContain("qualifier");
    expect(buildReviewPrompt(input)).not.toContain("certainly");
  });

  test("范围是单条:证据的证据不进视野", () => {
    const deep = create("Deep background fact");
    const ev = create("Direct evidence", { evidence: { nodes: [deep] } });
    const id = create("Conclusion", { evidence: { nodes: [ev] } });

    const prompt = buildReviewPrompt(buildInput(db, id));
    expect(prompt).toContain("Direct evidence");
    expect(prompt).not.toContain("Deep background fact");
  });

  test("warrant 在入口就解成一句话:晋升与否是存储形态,不是论证的一部分", () => {
    const inline = create("A", { warrant: "The principle" });
    expect(buildInput(db, inline).warrant).toBe("The principle");

    svc.promoteWarrant(db, root, { id: inline });
    expect(buildInput(db, inline).warrant).toBe("The principle");
  });

  test("空 warrant 递成 null,prompt 里明说它是空的", () => {
    const id = create("A");
    expect(buildInput(db, id).warrant).toBeNull();
    expect(buildReviewPrompt(buildInput(db, id))).toContain("empty");
  });

  test("协议 hash 跟着 prompt 全文走,不跟着人手维护的版本号走", () => {
    const a = buildReviewPrompt(buildInput(db, create("A")));
    const b = buildReviewPrompt(buildInput(db, create("B")));
    expect(protocolHash(a)).not.toBe(protocolHash(b));
    expect(protocolHash(a)).toBe(protocolHash(a));
  });
});

// =============================================================================
// F1–F4 机械校验(api.md §4.1)
// =============================================================================

describe("F1–F4", () => {
  /** 一条完整的被审查视图:一个附件、一条证据命题、一句 warrant。 */
  function fixture() {
    const path = root.file("paper.md");
    const ev = create("Temperature rose in three independent datasets");
    svc.setQualifier(db, root, [{ id: ev, qualifier: "probably" }]);
    const id = create("The climate is warming systematically", {
      warrant: "Consistent movement across independent datasets indicates a systemic change",
      evidence: { attachments: [path], nodes: [ev] },
    });
    return { input: buildInput(db, id), id, ev, path };
  }

  const q1 = (over: Record<string, unknown> = {}) => ({
    question: "Q1",
    confidence: "high",
    content: "The attachment does not say this",
    citation: { attachment: "", locator: "p. 3", quote: "some text" },
    ...over,
  });

  const q2 = (over: Record<string, unknown> = {}) => ({
    question: "Q2",
    confidence: "high",
    content: "The warrant does not reach the content",
    citation: { node_id: 0, slot: "content", quote: "" },
    ...over,
  });

  test("F1 引证片段为空:拒收", () => {
    const { input, path } = fixture();
    const { accepted, rejected } = validateFindings(input, [
      q1({ citation: { attachment: path, locator: "p. 3", quote: "  " } }),
    ]);
    expect(accepted).toHaveLength(0);
    expect(rejected[0]!.failed).toBe("F1");
  });

  test("F2 Q1 引了不在附件槽里的文件:拒收,并指出是哪条命题的槽", () => {
    const { input, id } = fixture();
    const { rejected } = validateFindings(input, [
      q1({ citation: { attachment: "other.md", locator: "p. 1", quote: "text" } }),
    ]);
    expect(rejected[0]!.failed).toBe("F2");
    expect(rejected[0]!.detail).toContain(`#${id}`);
  });

  test("F2 引对了附件就收下,并挂到被审查的命题上", () => {
    const { input, id, path } = fixture();
    const { accepted } = validateFindings(input, [
      q1({ citation: { attachment: path, locator: "p. 3", quote: "verbatim from the paper" } }),
    ]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.nodeId).toBe(id);
    expect(accepted[0]!.question).toBe("Q1");
  });

  test("Q1 的 locator 缺失不拒收:它不在 F1–F4 里,空着比伪造一个好", () => {
    const { input, path } = fixture();
    const { accepted } = validateFindings(input, [
      q1({ citation: { attachment: path, quote: "verbatim" } }),
    ]);
    expect(accepted).toHaveLength(1);
    expect((accepted[0]!.citation as { locator: string }).locator).toBe("");
  });

  test("F3 Q2 引了视野外的命题:拒收", () => {
    const { input } = fixture();
    const outsider = create("Unrelated proposition");
    const { rejected } = validateFindings(input, [
      q2({ citation: { node_id: outsider, slot: "content", quote: "Unrelated" } }),
    ]);
    expect(rejected[0]!.failed).toBe("F3");
  });

  test("F3 引证据槽里的命题合法", () => {
    const { input, ev } = fixture();
    const { accepted } = validateFindings(input, [
      q2({ citation: { node_id: ev, slot: "content", quote: "three independent datasets" } }),
    ]);
    expect(accepted).toHaveLength(1);
  });

  test("F4 片段不是逐字子串:拒收——验不过 = 审查器在编", () => {
    const { input, id } = fixture();
    const { rejected } = validateFindings(input, [
      q2({
        citation: { node_id: id, slot: "warrant", quote: "datasets that agree prove causation" },
      }),
    ]);
    expect(rejected[0]!.failed).toBe("F4");
  });

  test("F4 逐字子串通过", () => {
    const { input, id } = fixture();
    const { accepted } = validateFindings(input, [
      q2({ citation: { node_id: id, slot: "warrant", quote: "indicates a systemic change" } }),
    ]);
    expect(accepted).toHaveLength(1);
    expect((accepted[0]!.citation as { slot: string }).slot).toBe("warrant");
  });

  test("F4 折叠空白,不放过改词:跨行复制来的片段照收", () => {
    const id = create("A sentence that\n   spans two lines in the graph");
    const input = buildInput(db, id);
    expect(
      validateFindings(input, [
        q2({ citation: { node_id: id, slot: "content", quote: "sentence that spans two" } }),
      ]).accepted
    ).toHaveLength(1);
    expect(
      validateFindings(input, [
        q2({ citation: { node_id: id, slot: "content", quote: "sentence which spans two" } }),
      ]).rejected[0]!.failed
    ).toBe("F4");
  });

  test("F4 引证据命题的 warrant:视野里没有,所以引不了", () => {
    const { input, ev } = fixture();
    const { rejected } = validateFindings(input, [
      q2({ citation: { node_id: ev, slot: "warrant", quote: "anything" } }),
    ]);
    expect(rejected[0]!.failed).toBe("F4");
  });

  test("F4 引一条空 warrant:同样引不了", () => {
    const id = create("No warrant here");
    const { rejected } = validateFindings(buildInput(db, id), [
      q2({ citation: { node_id: id, slot: "warrant", quote: "anything" } }),
    ]);
    expect(rejected[0]!.failed).toBe("F4");
  });

  test("形状不对的东西根本不是 finding:逐条报出哪里不对", () => {
    const { input, id } = fixture();
    const { accepted, rejected } = validateFindings(input, [
      { question: "Q3", confidence: "high", content: "x", citation: {} },
      q2({ confidence: "medium" }),
      q2({ content: "   " }),
      { question: "Q2", confidence: "low", content: "no citation at all" },
      q2({ citation: { node_id: id, slot: "evidence", quote: "The climate" } }),
      "not an object",
    ]);
    expect(accepted).toHaveLength(0);
    expect(rejected.map((r) => r.failed)).toEqual([
      "shape",
      "shape",
      "shape",
      "shape",
      "shape",
      "shape",
    ]);
  });

  test("拒收是逐条的:一条不合格不牵连同批的其他条", () => {
    const { input, id, path } = fixture();
    const { accepted, rejected } = validateFindings(input, [
      q1({ citation: { attachment: "not-attached.md", locator: "p. 1", quote: "x" } }),
      q1({ citation: { attachment: path, locator: "p. 2", quote: "real quote" } }),
      q2({ citation: { node_id: id, slot: "content", quote: "climate is warming" } }),
    ]);
    expect(accepted).toHaveLength(2);
    expect(rejected).toHaveLength(1);
  });

  test("拒收记录原样留着 raw:改 prompt 时要有依据", () => {
    const { input } = fixture();
    const bad = q1({ citation: { attachment: "nope.md", locator: "p. 1", quote: "x" } });
    const { rejected } = validateFindings(input, [bad]);
    expect(rejected[0]!.raw).toEqual(bad);
  });

  test("citation.node_id 与 nodeId 两种写法都认", () => {
    const { input, id } = fixture();
    const { accepted } = validateFindings(input, [
      q2({ citation: { nodeId: id, slot: "content", quote: "climate is warming" } }),
    ]);
    expect(accepted).toHaveLength(1);
  });
});

// =============================================================================
// 答复的收口
// =============================================================================

describe("interpretResponse", () => {
  test("没有附件时 Q1 一律 n/a,哪怕审查器报了 pass", () => {
    const input = buildInput(db, create("No attachments"));
    expect(interpretResponse(input, { Q1: "pass", Q2: "pass" }).Q1).toBe("n/a");
  });

  test("有附件时答非所问倒向 fail:说不清自己结论的审查器不该记成通过", () => {
    const id = create("With attachment", { evidence: { attachments: [root.file("a.md")] } });
    const input = buildInput(db, id);
    const r = interpretResponse(input, { Q1: "probably fine", Q2: undefined });
    expect(r.Q1).toBe("fail");
    expect(r.Q2).toBe("fail");
  });

  test("findings 缺失或不是数组,当空处理,不当解析失败", () => {
    const input = buildInput(db, create("A"));
    expect(interpretResponse(input, { Q1: "n/a", Q2: "pass" }).accepted).toEqual([]);
    expect(interpretResponse(input, { Q1: "n/a", Q2: "pass", findings: "none" }).rejected).toEqual([]);
  });
});

// =============================================================================
// 没配审查模型
// =============================================================================

describe("runReview 的前置条件", () => {
  test("没配模型直接失败,并说明配法——不发一条警告然后记成通过", async () => {
    const id = create("A");
    const err = await runReview(null, db, id).catch((e) => e);
    expect(err).toBeInstanceOf(ReviewUnavailableError);
    expect(err.message).toContain("--review-config");
    // 一条 review 事件都不该留下:没跑就是没跑。
    expect(svc.getHistory(db, { id }).events.some((e) => e.op === "review")).toBe(false);
  });

  test("失败信息要说清结构检查照跑,免得读成'什么把关都没有'", async () => {
    const err = await runReview(null, db, create("A")).catch((e) => e);
    expect(err.message).toContain("Structural checks");
  });
});

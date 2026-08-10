/**
 * Toulmin MCP — tag 近似匹配（漂移形态表）
 *
 * 对应 `.omc/plans/0.5.0/pr1-tags.md` §5.3。
 *
 * ── 这张表是给两类人看的 ─────────────────────────────────────────────
 * 调阈值的人，和声明命名空间基数类别的人。**改阈值之前先让这张表红，
 * 否则你不知道自己放弃了哪一种形态。** 阈值调松 ⇒ 警告沦为噪音 ⇒ agent
 * 学会无视它 ⇒ 有界命名空间失去防漂移机制。
 *
 * 两条反例同样承重：同义词与"无关共词"**按设计不抓**。封闭词表防的是
 * 拼写与措辞漂移，不防概念漂移 —— 概念漂移的唯一防线是定期读一遍词表
 * 计数，那归协议层。把反例调成命中，等于把这条边界悄悄挪走。
 *
 * ── 门控 ─────────────────────────────────────────────────────────────
 * `src/tag-similarity.ts` 尚不存在 ⇒ 整份文件跳过；文件一出现即自动生效。
 * 设计文档没有钉死导出名，所以下面用一个薄适配层接受两种合理形态之一；
 * 两种都没有时 **抛错而不是跳过** —— 契约必须有一个落点。
 */

import { describe, test, expect } from "bun:test";

const MODULE = "../src/tag-similarity.ts";
const mod: any = await (async () => {
  try {
    const specifier = MODULE;
    return await import(specifier);
  } catch {
    return null;
  }
})();

const LANDED = !!mod;

/**
 * 适配层：只吸收"函数叫什么名字"这一个自由度，判定内容一律走真实实现。
 */
function isSimilar(a: string, b: string): boolean {
  if (typeof mod.isSimilarTag === "function") return !!mod.isSimilarTag(a, b);
  if (typeof mod.isSimilar === "function") return !!mod.isSimilar(a, b);
  if (typeof mod.findSimilarTags === "function") return mod.findSimilarTags(a, [b]).length > 0;
  throw new Error(
    "src/tag-similarity.ts 必须导出 isSimilarTag(a, b) 或 findSimilarTags(name, candidates) 之一"
  );
}

function rank(name: string, candidates: string[]): any[] {
  if (typeof mod.findSimilarTags === "function") return mod.findSimilarTags(name, candidates);
  throw new Error("src/tag-similarity.ts 必须导出 findSimilarTags(name, candidates) 用于排序与截断");
}

// =============================================================================
// 漂移形态表（§5.3）—— 一种形态一例
// =============================================================================

const DRIFT_FORMS: Array<{ form: string; a: string; b: string; hit: boolean; why: string }> = [
  {
    form: "缩写",
    a: "theme:retrieval-aug",
    b: "theme:retrieval-augmentation",
    hit: true,
    why: "token 集 Jaccard = 1/3、整串 Lev = 9，两条都不命中 —— token 级模糊等价是缺的那一环",
  },
  {
    form: "单复数",
    a: "theme:memory-mechanism",
    b: "theme:memory-mechanisms",
    hit: true,
    why: "token 内前缀关系",
  },
  {
    form: "加减词",
    a: "theme:long-context",
    b: "theme:long-context-modeling",
    hit: true,
    why: "模糊 Jaccard = 2/3 ≥ 0.5",
  },
  {
    form: "词序",
    a: "theme:cache-eviction",
    b: "theme:eviction-cache",
    hit: true,
    why: "token 集判定与顺序无关",
  },
  {
    form: "拼写错",
    a: "theme:retreival-aug",
    b: "theme:retrieval-aug",
    hit: true,
    why: "token 内 Levenshtein ≤ 1 且双方 ≥ 5 字符",
  },
  {
    form: "连字符",
    a: "theme:long_context",
    b: "theme:long-context",
    hit: true,
    why: "- 与 _ 都是 token 分隔符",
  },
  {
    form: "反例：同义词",
    a: "theme:episodic-memory",
    b: "theme:long-term-recall",
    hit: false,
    why: "概念漂移按设计不抓 —— 这是机制的边界，不是缺陷",
  },
  {
    form: "反例：无关共词",
    a: "theme:memory-cache",
    b: "theme:memory-bandwidth",
    hit: false,
    why: "共享一个 token 不足以构成近似，否则 memory 家族会互相报警",
  },
];

describe.skipIf(!LANDED)("漂移形态表（阈值的验收基准）", () => {
  for (const { form, a, b, hit, why } of DRIFT_FORMS) {
    test(`${form}：${a} ~ ${b} ⇒ ${hit ? "命中" : "不命中"}（${why}）`, () => {
      expect(isSimilar(a, b)).toBe(hit);
    });
  }

  test("判定对称", () => {
    for (const { a, b, hit } of DRIFT_FORMS) {
      expect(isSimilar(b, a)).toBe(hit);
    }
  });

  test("自反：一个 tag 与它自己命中", () => {
    expect(isSimilar("theme:x-y", "theme:x-y")).toBe(true);
  });
});

// =============================================================================
// 边界（§5.2）
// =============================================================================

describe.skipIf(!LANDED)("边界", () => {
  test("只比同命名空间：theme:cache 与 run:cache 不构成近似", () => {
    expect(isSimilar("theme:cache", "run:cache")).toBe(false);
  });

  test("完全相同的成员段但命名空间不同，一律不命中", () => {
    expect(isSimilar("theme:retrieval-aug", "paper:retrieval-aug")).toBe(false);
  });

  test("短 token 的前缀关系不算等价（< 3 字符）", () => {
    // 前缀关系要求短方 ≥ 3 字符，否则 a-b 会与半个词表命中
    expect(isSimilar("theme:ab", "theme:abcdefgh")).toBe(false);
  });

  test("短 token 的 Levenshtein 不算等价（< 5 字符）", () => {
    expect(isSimilar("theme:cat", "theme:cut")).toBe(false);
  });

  test("整串 Levenshtein ≤ 2 兜底：跨 token 边界的笔误", () => {
    expect(isSimilar("theme:long-contex", "theme:long-context")).toBe(true);
  });
});

// =============================================================================
// 排序与截断（§5.2）
// =============================================================================

describe.skipIf(!LANDED)("排序与截断", () => {
  test("最多返回 3 条", () => {
    const results = rank("theme:retrieval-aug", [
      "theme:retrieval-augmentation",
      "theme:retrieval-augment",
      "theme:retrieval-augmented",
      "theme:retrieval-augmenting",
      "theme:retrieval-augmentations",
    ]);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  test("按 score 降序", () => {
    const results = rank("theme:retrieval-aug", [
      "theme:retrieval-augmentation",
      "theme:retrieval-aug2",
      "theme:cache-eviction",
    ]);
    const scores = results.map((r: any) => r.score ?? 0);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
  });

  test("没有近似项时返回空", () => {
    expect(rank("theme:retrieval-aug", ["theme:episodic-memory", "theme:cache-eviction"])).toEqual(
      []
    );
  });

  test("候选为空时返回空，不抛错", () => {
    expect(rank("theme:x", [])).toEqual([]);
  });

  test("不把自己算成近似项", () => {
    const results = rank("theme:x-y", ["theme:x-y"]);
    expect(results.map((r: any) => r.name ?? r)).not.toContain("theme:x-y");
  });
});

/**
 * Toulmin MCP — tag registry（封闭词表 + 命名空间基数类别）
 *
 * 对应设计文档 `.omc/plans/0.5.0/pr1-tags.md`（§8 的十条用例为骨架，另补边界）。
 *
 * ── 门控说明 ─────────────────────────────────────────────────────────
 * PR1 尚未实现 ⇒ `service.createTagService` 不存在 ⇒ 整份文件跳过。
 * 门控是**对实现求值的探针**，不是硬编码的 false 开关：`createTagService`
 * 一旦出现，这些用例立即生效并对真实实现打分。跳过状态无法比实现活得更久，
 * 也就不会出现"测试文件在，但它保护的东西早就没了"这种静默失守。
 *
 * ── 本文件锁死的三条 ─────────────────────────────────────────────────
 * 1. **tag 操作永不失效 compile**（§0.1 第一条不变量，第 5 组）。
 * 2. **近似检查的判别变量是命名空间的基数，不是 tag 名的来源**
 *    （第 8/9 组）。`metric:` 的名字来自外部标识符，按"名字来源"判会被
 *    跳过，按基数判要检查 —— 综述场景里两者完全共变，所以这个判别式
 *    只能在 `metric:` 这类例子上被观测到。
 * 3. **基数类别是一次声明，不是一次统计**，且不被后续调用静默改写（第 10 组）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb, cleanupDb, makeClaim, makeGround, makeWarrant, makeBacking, compileVerdictOf } from "./helpers.ts";
import * as repo from "../src/repo.ts";
import * as service from "../src/service.ts";
import { computeArgumentHash } from "../src/merkle-hash.ts";
import { ValidationError, TypeMismatchError } from "../src/errors.ts";

const svc = service as any;
const tagRepo = repo as any;

/** 探针：PR1 是否已落地。 */
const TAGS_LANDED = typeof svc.createTagService === "function";

let db: Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  cleanupDb(db);
});

function dataOf(nodeId: number): any {
  return JSON.parse(repo.getNodeById(db, nodeId)!.data);
}

function markCompiled(claimId: number): void {
  repo.saveCompileState(db, claimId, "passed", "test compile", computeArgumentHash(db, claimId));
}

/** 建一个已 compile 通过的完整论证，用于"tag 不失效 compile"组。 */
function seedCompiledClaim(): { claimId: number; groundId: number } {
  const claim = makeClaim(db, "结论");
  const g = makeGround(db, {
    content: "证据",
    source: "observed",
    verification: "verified",
    attachments: ["/data/1.csv"],
  });
  const w = makeWarrant(db, claim.id, [g.id], "论证");
  makeBacking(db, w.id, "依据", ["/papers/x.pdf"]);
  markCompiled(claim.id);
  return { claimId: claim.id, groundId: g.id };
}

// =============================================================================
// 1. 注册与格式校验
// =============================================================================

describe.skipIf(!TAGS_LANDED)("1. 注册与格式校验", () => {
  test("合法 tag 注册成功", () => {
    const { tag } = svc.createTagService(db, "theme:retrieval-aug", "检索增强");
    expect(tag.name).toBe("theme:retrieval-aug");
    expect(tag.description).toBe("检索增强");
    expect(tagRepo.getTag(db, "theme:retrieval-aug")).toBeTruthy();
  });

  test("大写字母 → ValidationError", () => {
    expect(() => svc.createTagService(db, "Theme:Retrieval", "x")).toThrow(ValidationError);
  });

  test("无命名空间 → ValidationError", () => {
    expect(() => svc.createTagService(db, "retrieval", "x")).toThrow(ValidationError);
  });

  test("非法字符 → ValidationError", () => {
    expect(() => svc.createTagService(db, "theme:retrieval aug", "x")).toThrow(ValidationError);
    expect(() => svc.createTagService(db, "theme:检索", "x")).toThrow(ValidationError);
  });

  test("报错消息带正确格式示例（这条报错是给 agent 看的，不是给日志看的）", () => {
    let message = "";
    try {
      svc.createTagService(db, "Theme:X", "x");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/[a-z0-9][a-z0-9_-]*:[a-z0-9]/);
  });

  test("空命名空间段或空成员段 → ValidationError", () => {
    expect(() => svc.createTagService(db, ":x", "x")).toThrow(ValidationError);
    expect(() => svc.createTagService(db, "theme:", "x")).toThrow(ValidationError);
    expect(() => svc.createTagService(db, "-theme:x", "x")).toThrow(ValidationError);
  });

  test("重复注册 → ValidationError", () => {
    svc.createTagService(db, "theme:x", "x");
    expect(() => svc.createTagService(db, "theme:x", "又一个 x")).toThrow(ValidationError);
  });

  test("claim_id 指向非 claim 节点 → TypeMismatchError", () => {
    const g = makeGround(db, { content: "证据" });
    expect(() => svc.createTagService(db, "theme:x", "x", g.id)).toThrow(TypeMismatchError);
  });

  test("claim_id 指向 claim 节点 → 落库", () => {
    const claim = makeClaim(db, "类目结论");
    const { tag } = svc.createTagService(db, "theme:x", "x", claim.id);
    expect(tag.claim_id).toBe(claim.id);
  });

  test("回填 claim_id 走同一条类型门（注册侧拦住的，更新侧不能放过去）", () => {
    svc.createTagService(db, "theme:x", "x");
    const g = makeGround(db, { content: "证据" });

    expect(() => svc.updateTagService(db, "theme:x", undefined, g.id)).toThrow(TypeMismatchError);
    expect(tagRepo.getTag(db, "theme:x").claim_id).toBeNull();

    const claim = makeClaim(db, "类目结论");
    svc.updateTagService(db, "theme:x", undefined, claim.id);
    expect(tagRepo.getTag(db, "theme:x").claim_id).toBe(claim.id);
  });
});

// =============================================================================
// 2. 硬门在"使用"侧：未注册 tag 创建节点 → 报错含近似建议
// =============================================================================

describe.skipIf(!TAGS_LANDED)("2. 未注册 tag 不能用于写入", () => {
  test("报错消息里出现近似的既有 tag 与它的节点数", () => {
    svc.createTagService(db, "theme:retrieval-aug", "检索增强");
    const n1 = makeGround(db, { content: "a" });
    tagRepo.addNodeTags(db, n1.id, ["theme:retrieval-aug"]);

    let message = "";
    try {
      service.createStatement(db, {
        content: "新证据",
        source: "observed",
        verification: "pending",
        tags: ["theme:retrieval-augmentation"],
      } as any);
    } catch (e) {
      message = (e as Error).message;
    }

    expect(message).toContain("theme:retrieval-augmentation");
    expect(message).toContain("is not registered");
    expect(message).toContain("theme:retrieval-aug");
    expect(message).toMatch(/1 node/);
  });

  test("已注册 tag 正常写入并可读回", () => {
    svc.createTagService(db, "theme:x", "x");
    const stmt = service.createStatement(db, {
      content: "证据",
      source: "observed",
      verification: "pending",
      tags: ["theme:x"],
    } as any);
    expect(tagRepo.getNodeTags(db, stmt.id)).toEqual(["theme:x"]);
  });

  test("createClaim 走同一条硬门", () => {
    expect(() => svc.createClaim(db, "结论", undefined, ["theme:未注册"])).toThrow();
  });

  test("update_node(tags={add}) 走同一条硬门", () => {
    const g = makeGround(db, { content: "证据" });
    expect(() => service.updateNode(db, g.id, { tags: { add: ["theme:nope"] } } as any)).toThrow(
      ValidationError
    );
  });

  test("一批 tag 里只要有一个未注册就整体拒绝（不部分挂上）", () => {
    svc.createTagService(db, "theme:x", "x");
    const g = makeGround(db, { content: "证据" });
    expect(() =>
      service.updateNode(db, g.id, { tags: { add: ["theme:x", "theme:nope"] } } as any)
    ).toThrow();
    expect(tagRepo.getNodeTags(db, g.id)).toEqual([]);
  });

  test("remove 不需要注册校验（清理不该被词表挡住）", () => {
    svc.createTagService(db, "theme:x", "x");
    const g = makeGround(db, { content: "证据" });
    service.updateNode(db, g.id, { tags: { add: ["theme:x"] } } as any);
    service.updateNode(db, g.id, { tags: { remove: ["theme:x"] } } as any);
    expect(tagRepo.getNodeTags(db, g.id)).toEqual([]);
  });

  test("近似计算只在失败路径上跑：正常写入不付聚合的钱（§4.3 的成本契约）", () => {
    // §4.3 把成本写成了契约："存在性先查，相似度只在缺失时算，所以正常写入路径
    // 一分钱都不付。" 契约的可观测形态是那条按 tag 聚合节点数的 JOIN + GROUP BY
    // 有没有被 prepare —— 它只服务于近似建议，正常路径上出现即违约。
    svc.createTagService(db, "theme:x", "x");
    const g = makeGround(db, { content: "证据" });

    const prepared: string[] = [];
    const origPrepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => {
      prepared.push(sql);
      return origPrepare(sql);
    };
    /** listTagsWithCount 的指纹：只有它按 tag 聚合节点数。 */
    const aggregated = () => prepared.some(s => s.includes("COUNT(nt.node_id)"));

    try {
      service.updateNode(db, g.id, { tags: { add: ["theme:x"] } } as any);
      expect(aggregated()).toBe(false);

      prepared.length = 0;
      expect(() => service.updateNode(db, g.id, { tags: { add: ["theme:nope"] } } as any)).toThrow(
        ValidationError
      );
      expect(aggregated()).toBe(true);
    } finally {
      (db as any).prepare = origPrepare;
    }
  });
});

// =============================================================================
// 3. rename 级联
// =============================================================================

describe.skipIf(!TAGS_LANDED)("3. rename_tag 级联", () => {
  test("两个节点都跟着改名，返回受影响节点数", () => {
    svc.createTagService(db, "theme:old", "旧名");
    const n1 = makeGround(db, { content: "a" });
    const n2 = makeGround(db, { content: "b" });
    tagRepo.addNodeTags(db, n1.id, ["theme:old"]);
    tagRepo.addNodeTags(db, n2.id, ["theme:old"]);

    const { moved } = svc.renameTagService(db, "theme:old", "theme:new");

    expect(moved).toBe(2);
    expect(tagRepo.getNodeTags(db, n1.id)).toEqual(["theme:new"]);
    expect(tagRepo.getNodeTags(db, n2.id)).toEqual(["theme:new"]);
    expect(tagRepo.getTag(db, "theme:old")).toBeNull();
  });

  test("from 不存在 → 报错", () => {
    expect(() => svc.renameTagService(db, "theme:none", "theme:x")).toThrow();
  });

  test("to 已存在 → 报错（改名不是合并）", () => {
    svc.createTagService(db, "theme:a", "a");
    svc.createTagService(db, "theme:b", "b");
    expect(() => svc.renameTagService(db, "theme:a", "theme:b")).toThrow();
  });

  test("to 格式非法 → 报错", () => {
    svc.createTagService(db, "theme:a", "a");
    expect(() => svc.renameTagService(db, "theme:a", "Theme:B")).toThrow(ValidationError);
  });

  test("rename 不动 compile_state", () => {
    const { claimId } = seedCompiledClaim();
    const before = repo.getCompileState(db, claimId);
    svc.createTagService(db, "theme:old", "x");
    tagRepo.addNodeTags(db, claimId, ["theme:old"]);

    svc.renameTagService(db, "theme:old", "theme:new");

    expect(repo.getCompileState(db, claimId)).toEqual(before!);
    expect(compileVerdictOf(db, claimId)).toBe("passed");
  });
});

// =============================================================================
// 4. merge
// =============================================================================

describe.skipIf(!TAGS_LANDED)("4. merge_tags", () => {
  test("重叠节点去重：同时挂 from + to 的节点合并后只剩一条", () => {
    svc.createTagService(db, "theme:from", "f");
    svc.createTagService(db, "theme:to", "t");
    const both = makeGround(db, { content: "两个都挂" });
    const onlyFrom = makeGround(db, { content: "只挂 from" });
    tagRepo.addNodeTags(db, both.id, ["theme:from", "theme:to"]);
    tagRepo.addNodeTags(db, onlyFrom.id, ["theme:from"]);

    const { moved } = svc.mergeTagsService(db, "theme:from", "theme:to");

    expect(tagRepo.getNodeTags(db, both.id)).toEqual(["theme:to"]);
    expect(tagRepo.getNodeTags(db, onlyFrom.id)).toEqual(["theme:to"]);
    expect(moved).toBe(2);
  });

  test("from 注销", () => {
    svc.createTagService(db, "theme:from", "f");
    svc.createTagService(db, "theme:to", "t");
    svc.mergeTagsService(db, "theme:from", "theme:to");
    expect(tagRepo.getTag(db, "theme:from")).toBeNull();
    expect(tagRepo.getTag(db, "theme:to")).toBeTruthy();
  });

  test("双方都必须存在", () => {
    svc.createTagService(db, "theme:to", "t");
    expect(() => svc.mergeTagsService(db, "theme:none", "theme:to")).toThrow();
    expect(() => svc.mergeTagsService(db, "theme:to", "theme:none")).toThrow();
  });

  test("from 有 claim_id 而 to 没有 → warning，且不自动改 Claim", () => {
    const claim = makeClaim(db, "类目结论");
    svc.createTagService(db, "theme:from", "f", claim.id);
    svc.createTagService(db, "theme:to", "t");

    const { warnings } = svc.mergeTagsService(db, "theme:from", "theme:to");

    expect(warnings.join("\n")).toMatch(/Claim/);
    // Claim 修订是论证行为，归 agent，不归词表维护工具
    expect(tagRepo.getTag(db, "theme:to").claim_id).toBeNull();
  });
});

// =============================================================================
// 5. tag 操作永不失效 compile（§0.1 第一条不变量）
// =============================================================================

describe.skipIf(!TAGS_LANDED)("5. tag 操作永不失效 compile", () => {
  test("打 tag / 改 tag / rename / merge 之后 compile_status 仍是 passed", () => {
    const { claimId } = seedCompiledClaim();
    const hashBefore = computeArgumentHash(db, claimId);

    svc.createTagService(db, "theme:a", "a");
    svc.createTagService(db, "theme:b", "b");
    service.updateNode(db, claimId, { tags: { add: ["theme:a", "theme:b"] } } as any);
    expect(compileVerdictOf(db, claimId)).toBe("passed");

    service.updateNode(db, claimId, { tags: { remove: ["theme:b"] } } as any);
    expect(compileVerdictOf(db, claimId)).toBe("passed");

    svc.renameTagService(db, "theme:a", "theme:a2");
    expect(compileVerdictOf(db, claimId)).toBe("passed");

    svc.createTagService(db, "theme:c", "c");
    svc.mergeTagsService(db, "theme:a2", "theme:c");
    expect(compileVerdictOf(db, claimId)).toBe("passed");

    // tag 不进 merkle hash：它不是论证结构
    expect(computeArgumentHash(db, claimId)).toBe(hashBefore);
  });

  test("tag 不落进 data JSON（不变量的存储形态）", () => {
    const { claimId } = seedCompiledClaim();
    svc.createTagService(db, "theme:a", "a");
    service.updateNode(db, claimId, { tags: { add: ["theme:a"] } } as any);

    expect(dataOf(claimId).tags).toBeUndefined();
    expect(tagRepo.getNodeTags(db, claimId)).toEqual(["theme:a"]);
  });

  test("已定案的 Claim 打 tag 不会把 status 打回 proposed", () => {
    const { claimId } = seedCompiledClaim();
    service.updateNode(db, claimId, { status: "supported" });
    svc.createTagService(db, "theme:a", "a");

    service.updateNode(db, claimId, { tags: { add: ["theme:a"] } } as any);

    expect(dataOf(claimId).status).toBe("supported");
    expect(compileVerdictOf(db, claimId)).toBe("passed");
  });
});

// =============================================================================
// 6. delete_node 级联
// =============================================================================

describe.skipIf(!TAGS_LANDED)("6. 删除节点的级联", () => {
  test("删节点清 node_tags，tag 本身留在词表里", () => {
    svc.createTagService(db, "theme:x", "x");
    const g = makeGround(db, { content: "证据" });
    tagRepo.addNodeTags(db, g.id, ["theme:x"]);

    service.deleteNode(db, g.id, true);

    expect(tagRepo.getTag(db, "theme:x")).toBeTruthy();
    expect(tagRepo.findNodesByTag(db, "theme:x")).toEqual([]);
  });

  test("删 Claim 把 tags.claim_id 置 NULL，不是删 tag", () => {
    const claim = makeClaim(db, "类目结论");
    svc.createTagService(db, "theme:x", "x", claim.id);

    service.deleteNode(db, claim.id, true);

    const tag = tagRepo.getTag(db, "theme:x");
    expect(tag).toBeTruthy();
    expect(tag.claim_id).toBeNull();
  });

  test("删 tag 不删节点", () => {
    svc.createTagService(db, "theme:x", "x");
    const g = makeGround(db, { content: "证据" });
    tagRepo.addNodeTags(db, g.id, ["theme:x"]);

    db.prepare("DELETE FROM tags WHERE name = ?").run("theme:x");

    expect(repo.getNodeById(db, g.id)).toBeTruthy();
    expect(tagRepo.getNodeTags(db, g.id)).toEqual([]);
  });
});

// =============================================================================
// 7. create_tags 逐条独立
// =============================================================================

describe.skipIf(!TAGS_LANDED)("7. create_tags 逐条独立（与 create_statements 的整批原子相反）", () => {
  test("一批 5 条里第 3 条非法 → 其余 4 条成功，failed 报第 3 条", () => {
    const result = svc.createTagsService(db, [
      { name: "paper:a1", description: "1" },
      { name: "paper:a2", description: "2" },
      { name: "PAPER:BAD", description: "3" },
      { name: "paper:a4", description: "4" },
      { name: "paper:a5", description: "5" },
    ]);

    expect(result.registered.length).toBe(4);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].name).toBe("PAPER:BAD");
    expect(result.failed[0].reason).toBeTruthy();
    expect(tagRepo.getTag(db, "paper:a5")).toBeTruthy();
  });

  test("批内重名条目单独失败，不影响其余", () => {
    svc.createTagService(db, "paper:dup", "已存在");
    const result = svc.createTagsService(db, [
      { name: "paper:dup", description: "再来一次" },
      { name: "paper:new", description: "新的" },
    ]);
    expect(result.failed.length).toBe(1);
    expect(result.registered.length).toBe(1);
  });

  test("上限 200：201 条 → 拒绝", () => {
    const tags = Array.from({ length: 201 }, (_, i) => ({
      name: `paper:p${i}`,
      description: `p${i}`,
    }));
    expect(() => svc.createTagsService(db, tags)).toThrow();
  });

  test("200 条恰好通过", () => {
    const tags = Array.from({ length: 200 }, (_, i) => ({
      name: `paper:p${i}`,
      description: `p${i}`,
    }));
    const result = svc.createTagsService(db, tags);
    expect(result.registered.length).toBe(200);
    expect(result.failed).toEqual([]);
  });

  test("重发一个部分成功的批次是安全的（注册幂等可判）", () => {
    const batch = [
      { name: "paper:a", description: "a" },
      { name: "PAPER:BAD", description: "bad" },
    ];
    svc.createTagsService(db, batch);
    const second = svc.createTagsService(db, batch);
    // 已存在的报"已存在"，不是静默覆盖
    expect(second.registered.length).toBe(0);
    expect(second.failed.length).toBe(2);
  });
});

// =============================================================================
// 8/9/10. 基数类别声明 —— 判别变量是基数，不是名字来源
// =============================================================================

describe.skipIf(!TAGS_LANDED)("8. 声明为 dense 的命名空间跳过近似检查", () => {
  test("批级声明 dense 后，后续成员无近似警告且不必重传参数", () => {
    const first = svc.createTagsService(
      db,
      [
        { name: "run:0041", description: "扫描 41" },
        { name: "run:0042", description: "扫描 42" },
      ],
      "dense"
    );
    expect(first.warnings).toEqual([]);

    expect(tagRepo.getNamespaceCardinality(db, "run")).toBe("dense");

    // 第 201 个不需要重复声明
    const later = svc.createTagService(db, "run:0043", "扫描 43");
    expect(later.warnings).toEqual([]);
  });

  test("paper: 出厂预声明为 dense（既有行为字面不变）", () => {
    expect(tagRepo.getNamespaceCardinality(db, "paper")).toBe("dense");

    svc.createTagService(db, "paper:smith2024", "Smith 2024");
    const { warnings } = svc.createTagService(db, "paper:smith2024a", "Smith 2024a");
    expect(warnings).toEqual([]);
  });
});

describe.skipIf(!TAGS_LANDED)("9. 未声明的命名空间默认跑检查", () => {
  test("metric:accuracy 之后注册 metric:acc → 产生近似警告", () => {
    // metric: 的名字来自外部标识符 —— 按"名字来源"判会被跳过，按基数判要检查。
    // 这一条就是这两条判据的分道处。
    svc.createTagService(db, "metric:accuracy", "准确率");
    const { warnings } = svc.createTagService(db, "metric:acc", "acc");

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join("\n")).toContain("metric:accuracy");
  });

  test("近似命中只是软警告，注册仍然成功（硬门在使用侧）", () => {
    svc.createTagService(db, "theme:retrieval-aug", "检索增强");
    const { tag, warnings } = svc.createTagService(db, "theme:retrieval-augmentation", "检索增强 2");

    expect(tag.name).toBe("theme:retrieval-augmentation");
    expect(tagRepo.getTag(db, "theme:retrieval-augmentation")).toBeTruthy();
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("警告文案带既有 tag 的节点数", () => {
    svc.createTagService(db, "theme:retrieval-aug", "检索增强");
    const n = makeGround(db, { content: "a" });
    tagRepo.addNodeTags(db, n.id, ["theme:retrieval-aug"]);

    const { warnings } = svc.createTagService(db, "theme:retrieval-augmentation", "x");
    expect(warnings.join("\n")).toMatch(/theme:retrieval-aug.*1 node/s);
  });

  test("只比同命名空间：theme:cache 与 run:cache 不构成近似", () => {
    svc.createTagService(db, "theme:cache", "缓存主题");
    const { warnings } = svc.createTagService(db, "run:cache", "缓存那次运行");
    expect(warnings).toEqual([]);
  });

  test("声明为 bounded 的命名空间跑检查", () => {
    svc.createTagService(db, "source-type:preprint", "预印本", undefined, "bounded");
    const { warnings } = svc.createTagService(db, "source-type:preprints", "复数形态");
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!TAGS_LANDED)("10. 重复声明不静默改写", () => {
  test("先 dense 后 bounded → warning，表里仍是 dense", () => {
    svc.createTagService(db, "run:0041", "扫描 41", undefined, "dense");
    const { warnings } = svc.createTagService(db, "run:0042", "扫描 42", undefined, "bounded");

    expect(warnings.join("\n")).toMatch(/already declared dense/i);
    expect(tagRepo.getNamespaceCardinality(db, "run")).toBe("dense");
  });

  test("传相同的值不报 warning", () => {
    svc.createTagService(db, "run:0041", "扫描 41", undefined, "dense");
    const { warnings } = svc.createTagService(db, "run:0042", "扫描 42", undefined, "dense");
    expect(warnings).toEqual([]);
  });

  test("未声明就不落库（不能把'没传'记成一个默认值）", () => {
    svc.createTagService(db, "metric:accuracy", "准确率");
    expect(tagRepo.getNamespaceCardinality(db, "metric")).toBeNull();
  });

  test("声明可以先于第一个 tag 存在", () => {
    tagRepo.setNamespaceCardinality(db, "run", "dense");
    const { warnings } = svc.createTagService(db, "run:0041", "扫描 41");
    expect(warnings).toEqual([]);
  });

  test("最后一个成员被删掉之后声明仍留着", () => {
    svc.createTagService(db, "run:0041", "扫描 41", undefined, "dense");
    db.prepare("DELETE FROM tags WHERE name = ?").run("run:0041");
    expect(tagRepo.getNamespaceCardinality(db, "run")).toBe("dense");
  });
});

// =============================================================================
// 11. 词表读取
// =============================================================================

describe.skipIf(!TAGS_LANDED)("11. listTagsWithCount", () => {
  test("按名字排序并带节点计数", () => {
    svc.createTagService(db, "theme:b", "b");
    svc.createTagService(db, "theme:a", "a");
    const n1 = makeGround(db, { content: "1" });
    const n2 = makeGround(db, { content: "2" });
    tagRepo.addNodeTags(db, n1.id, ["theme:a"]);
    tagRepo.addNodeTags(db, n2.id, ["theme:a"]);

    const rows = tagRepo.listTagsWithCount(db);
    expect(rows.map((r: any) => r.name)).toEqual(["theme:a", "theme:b"]);
    expect(rows[0].count).toBe(2);
    expect(rows[1].count).toBe(0);
  });

  test("count = 0 是可读的恢复信号：tag 存在但一个节点都没挂上", () => {
    svc.createTagService(db, "paper:unprocessed", "还没抽取的那篇");
    const rows = tagRepo.listTagsWithCount(db);
    expect(rows.find((r: any) => r.name === "paper:unprocessed").count).toBe(0);
  });

  test("addNodeTags 幂等", () => {
    svc.createTagService(db, "theme:x", "x");
    const g = makeGround(db, { content: "证据" });
    tagRepo.addNodeTags(db, g.id, ["theme:x"]);
    tagRepo.addNodeTags(db, g.id, ["theme:x"]);
    expect(tagRepo.getNodeTags(db, g.id)).toEqual(["theme:x"]);
  });

  test("findNodesByTag 支持类型过滤", () => {
    svc.createTagService(db, "theme:x", "x");
    const claim = makeClaim(db, "结论");
    const g = makeGround(db, { content: "证据" });
    tagRepo.addNodeTags(db, claim.id, ["theme:x"]);
    tagRepo.addNodeTags(db, g.id, ["theme:x"]);

    expect(tagRepo.findNodesByTag(db, "theme:x").length).toBe(2);
    expect(tagRepo.findNodesByTag(db, "theme:x", "claim").map((r: any) => r.id)).toEqual([claim.id]);
  });
});

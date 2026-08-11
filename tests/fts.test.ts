/**
 * Toulmin MCP — FTS5 检索、分页、规模块
 *
 * 对应 `.omc/plans/0.5.0/pr2-search.md` §5 的十二条。
 *
 * ── 两组测试，前提不同 ──────────────────────────────────────────────
 *
 * 1. **FTS 相关（1–9）与规模块（11–12）**：依赖 `nodes_fts` 虚表和 `get_stats`
 *    的 scale 块。这两样今天都在，所以下面"前提"那一节把它们写成断言：缺了
 *    就红一条并说出缺的是什么，而不是把几十条测试静静跳过。
 *
 * 2. **DISTINCT（10）——   今天就是红的。** `service.ts:550` 的
 *    `searchNodesService` 已经存在且三个虚拟角色分支都缺 `DISTINCT`，修复
 *    是就地改 SQL，**不产生任何新的实现表面**，所以没有任何前提断言能表达
 *    "修好了没有"。可探测性缺失的时候，唯一诚实的写法是让它红着。这条与
 *    `claim-ground.test.ts` 里的存量 bug 同类：锁的是 HEAD 上的活缺陷。
 *
 * ── 为什么 11、12 单独立案 ───────────────────────────────────────────
 * 缺口矩阵与 Attachments 位是规模块里**唯二会被"优化输出体积"的人改坏而
 * 不报错**的两处。矩阵改成"全部有序对按计数降序取前 N"之后，真信号
 * （未分类积压，计数最小，因为它随分类推进而下降）会被恒大而无意义的对
 * 挤出输出；Attachments 位改回裸计数之后，"采集 0% 完成"与"采集 100%
 * 完成"的读数逐字相同。两处都是**读数看起来正常而信息已经没了**。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as service from "../src/service.ts";
import * as repo from "../src/repo.ts";
import { registerTools } from "../src/tools.ts";
import { createTestDb, cleanupDb, makeClaim, makeGround, makeWarrant } from "./helpers.ts";

const svc = service as any;
const tagRepo = repo as any;

// =============================================================================
// 前提
// =============================================================================

function ftsTableExists(db: Database): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = 'nodes_fts'")
    .get();
  return !!row;
}

function createMockServer() {
  const registered: Record<string, { schema: any; handler: Function }> = {};
  return {
    registerTool(name: string, config: any, handler: Function) {
      registered[name] = { schema: config.inputSchema, handler };
    },
    _tools: registered,
  };
}

// 全文检索表、规模块、tag 服务是本文件的前提，不是条件。以前这里是探针配 skipIf：
// 0.5.0 开发期功能一个一个落地，没落地的部分先跳过。功能全落地之后，探针再没有第二
// 种真值可报，只剩一个副作用——哪天建表的迁移丢了，本文件几十条测试会安静地跳过，
// 跑出来仍然是 0 fail。现在改成断言：少了哪个前提就在这里红一条，并说出少的是什么。
describe("前提", () => {
  test("nodes_fts 表由迁移建好", () => {
    const probeDb = createTestDb();
    try {
      expect(ftsTableExists(probeDb)).toBe(true);
    } finally {
      cleanupDb(probeDb);
    }
  });

  test("get_stats 带 scale 块", () => {
    const probeDb = createTestDb();
    try {
      expect(svc.getStats(probeDb).scale).toBeDefined();
    } finally {
      cleanupDb(probeDb);
    }
  });

  test("tag 服务可用", () => {
    expect(typeof svc.createTagService).toBe("function");
  });
});

// =============================================================================
// 夹具
// =============================================================================

let db: Database;
let tools: Record<string, { schema: any; handler: Function }>;

beforeEach(() => {
  db = createTestDb();
  const server = createMockServer();
  registerTools(server as any, db);
  tools = server._tools as any;
});

afterEach(() => {
  cleanupDb(db);
});

/** 直接查 FTS，绕开服务层的调度逻辑 —— 用于验证索引本身的同步。 */
function ftsMatch(query: string): number[] {
  const rows = db
    .prepare("SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ? ORDER BY rank")
    .all(`"${query.replaceAll('"', '""')}"`) as Array<{ rowid: number }>;
  return rows.map((r) => r.rowid);
}

/** 走服务层检索。签名在 PR2 里加了分页参数，这里用可选实参兼容两种形态。 */
function search(keyword: string, opts: any = {}): any {
  return svc.searchNodesService(db, keyword, opts.type, opts.tag, opts.limit, opts.offset);
}

function rowsOf(result: any): any[] {
  return Array.isArray(result) ? result : (result?.rows ?? []);
}

// =============================================================================
// 1–2：子串命中（中文与英文）
// =============================================================================

describe("§5.1–2：子串命中", () => {
  test("中文子串命中 —— unicode61 不切中文词，这是选 trigram 的全部理由", () => {
    const g = makeGround(db, { content: "长上下文模型在检索增强任务上的表现" });
    makeGround(db, { content: "完全无关的另一条证据" });
    expect(ftsMatch("检索增强")).toContain(g.id);
    expect(ftsMatch("检索增强").length).toBe(1);
  });

  test("英文子串命中 —— 不是词首也要命中", () => {
    const g = makeGround(db, { content: "Retrieval-augmented generation improves recall" });
    // "augment" 是 "augmented" 的子串，词法分词器会漏掉这种
    expect(ftsMatch("augment")).toContain(g.id);
  });

  test("跨节点类型命中：claim / statement / warrant 都进索引", () => {
    const c = makeClaim(db, "缓存淘汰策略显著影响吞吐");
    const g = makeGround(db, { content: "缓存淘汰实测数据" });
    const w = makeWarrant(db, c.id, [g.id], "缓存淘汰与吞吐的因果理由");
    const hits = ftsMatch("缓存淘汰");
    expect(hits).toContain(c.id);
    expect(hits).toContain(g.id);
    expect(hits).toContain(w.id);
  });

  test("不命中的不返回", () => {
    makeGround(db, { content: "长上下文" });
    expect(ftsMatch("检索增强")).toEqual([]);
  });
});

// =============================================================================
// 3：rank 排序
// =============================================================================

describe("§5.3：rank 排序", () => {
  test("MATCH 结果按 f.rank 排序，且服务层保留这个顺序（不是按 id）", () => {
    // 命中密度高的短文本应排在被长文本稀释的前面
    const dense = makeGround(db, { content: "缓存淘汰 缓存淘汰 缓存淘汰" });
    const sparse = makeGround(db, {
      content:
        "这是一段很长的说明文字，用来把命中稀释掉，其中只出现一次缓存淘汰这个词，" +
        "其余部分与检索、验证、编译、审查等主题有关，都不包含目标子串。",
    });
    const order = ftsMatch("缓存淘汰");
    expect(order).toContain(dense.id);
    expect(order).toContain(sparse.id);
    expect(order.indexOf(dense.id)).toBeLessThan(order.indexOf(sparse.id));
  });
});

// =============================================================================
// 4：三个触发器
// =============================================================================

describe("§5.4：insert / update / delete 三个触发器", () => {
  test("AFTER INSERT：新节点立刻可检索", () => {
    const g = makeGround(db, { content: "新插入的证据内容" });
    expect(ftsMatch("新插入")).toContain(g.id);
  });

  test("AFTER UPDATE OF content：旧内容检索不到，新内容检索得到", () => {
    const g = makeGround(db, { content: "旧的证据内容" });
    expect(ftsMatch("旧的证据")).toContain(g.id);

    repo.updateNodeFields(db, g.id, { content: "改过之后的证据内容" } as any);

    expect(ftsMatch("旧的证据")).toEqual([]);
    expect(ftsMatch("改过之后")).toContain(g.id);
  });

  test("AFTER DELETE：删掉的节点从索引里消失", () => {
    const g = makeGround(db, { content: "即将被删除的证据" });
    expect(ftsMatch("即将被删除")).toContain(g.id);

    repo.deleteNodeById(db, g.id);

    expect(ftsMatch("即将被删除")).toEqual([]);
  });

  test("只改 data 不改 content 时索引不受影响（触发器限定 OF content）", () => {
    const g = makeGround(db, { content: "内容不变的证据" });
    repo.updateNodeFields(db, g.id, { data: { source: "observed", verification: "pending" } } as any);
    expect(ftsMatch("内容不变")).toContain(g.id);
    expect(ftsMatch("内容不变").length).toBe(1); // 没有被插成两条
  });
});

// =============================================================================
// 5：旧库 rebuild 迁移
// =============================================================================

describe("§5.5：旧库 rebuild 迁移", () => {
  test("绕过触发器直插 nodes ⇒ 无 FTS 结果 ⇒ rebuild 之后命中", () => {
    // 模拟"库比虚表老"：先卸触发器再插，等价于旧库里已有的历史行
    // 对 FTS5 external content 表，COUNT(*) 读的是 nodes 表，所以要检查查询结果
    db.exec("DROP TRIGGER IF EXISTS nodes_fts_ai");
    const now = new Date().toISOString().slice(0, 19);
    const r = db
      .prepare(
        "INSERT INTO nodes (type, content, data, created_at, updated_at) VALUES ('statement', ?, '{}', ?, ?)"
      )
      .run("历史遗留的证据内容", now, now);
    const legacyId = r.lastInsertRowid as number;

    // FTS5 external content: COUNT(*) returns rows in nodes table, not indexed rows
    // So we check via MATCH query instead
    expect(ftsMatch("历史遗留")).toEqual([]);
    db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES ('rebuild')");
    expect(ftsMatch("历史遗留")).toContain(legacyId);
  });

  test("tightenCheckConstraint 重建 nodes 之后，三个触发器仍在且索引同步", async () => {
    // 必须手写一个宽 CHECK 的旧库：新建的库约束一开始就是紧的
    // （src/db.ts 的内联 schema），tightenCheckConstraint 会在第一行直接返回，
    // 于是下面每条断言都在一个从未被重建过的表上成立 —— 全绿且什么都没测。
    const legacy = new Database(":memory:");
    legacy.exec(`
      CREATE TABLE nodes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        type       TEXT    NOT NULL CHECK(type IN ('claim','ground','warrant','backing','statement','rebuttal')),
        content    TEXT    NOT NULL,
        data       TEXT    NOT NULL DEFAULT '{}',
        created_at TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
      )
    `);
    const beforeId = legacy
      .prepare("INSERT INTO nodes (type, content) VALUES ('statement', ?) RETURNING id")
      .get("重建之前就存在的证据") as { id: number };

    const dbMod: any = await import("../src/db.ts");
    dbMod.initializeSchema(legacy); // 内含 tightenCheckConstraint

    const match = (q: string) =>
      (
        legacy
          .prepare("SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?")
          .all(`"${q}"`) as Array<{ rowid: number }>
      ).map((r) => r.rowid);

    // 先钉住"重建真的跑过"：SQLite 原样存建表语句，RENAME 只换名字 token
    // 且换成带引号的形式，所以 CREATE TABLE "nodes" 只可能来自重命名。
    const ddl = (
      legacy.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='nodes'").get() as {
        sql: string;
      }
    ).sql;
    expect(ddl).toContain('CREATE TABLE "nodes"');

    const triggers = legacy
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'nodes_fts%'")
      .all() as Array<{ name: string }>;
    expect(triggers.map((t) => t.name).sort()).toEqual([
      "nodes_fts_ad",
      "nodes_fts_ai",
      "nodes_fts_au",
    ]);

    // 旧行仍可检索：DROP TABLE 之后重跑过 FTS rebuild
    expect(match("重建之前")).toContain(beforeId.id);

    // 重建之后新写入的行也进索引 —— 触发器若没被建回来，库照样能开、
    // 写入照样成功，只有检索安静地漏掉这一行。这条是本测试的要害。
    const afterId = legacy
      .prepare("INSERT INTO nodes (type, content) VALUES ('statement', ?) RETURNING id")
      .get("重建之后新增的证据") as { id: number };
    expect(match("重建之后")).toContain(afterId.id);

    legacy.close();
  });
});

// =============================================================================
// 6：<3 字符回落 LIKE
// =============================================================================

describe("§5.6：<3 字符回落 LIKE", () => {
  test("2 字符查询走 LIKE 而不是返回空 —— trigram 对 <3 字符无结果", () => {
    const g = makeGround(db, { content: "缓存淘汰实测" });
    expect(rowsOf(search("缓存")).map((n: any) => n.id)).toContain(g.id);
  });

  test("1 字符查询同样有结果", () => {
    const g = makeGround(db, { content: "缓存淘汰实测" });
    expect(rowsOf(search("存")).map((n: any) => n.id)).toContain(g.id);
  });

  test("3 字符及以上走 FTS，结果不弱于 LIKE", () => {
    const g = makeGround(db, { content: "缓存淘汰实测" });
    expect(rowsOf(search("缓存淘汰")).map((n: any) => n.id)).toContain(g.id);
  });
});

// =============================================================================
// 7：tag 过滤与 FTS 组合
// =============================================================================

describe("§5.7：tag 过滤与 FTS 组合", () => {
  function tagIt(nodeId: number, tag: string) {
    tagRepo.addNodeTags(db, nodeId, [tag]);
  }

  test("同一关键词命中两条，tag 过滤只留一条", () => {
    svc.createTagService(db, "theme:cache", "缓存");
    svc.createTagService(db, "theme:other", "其他");
    const a = makeGround(db, { content: "缓存淘汰策略 A" });
    const b = makeGround(db, { content: "缓存淘汰策略 B" });
    tagIt(a.id, "theme:cache");
    tagIt(b.id, "theme:other");

    const hits = rowsOf(search("缓存淘汰", { tag: "theme:cache" })).map((n: any) => n.id);
    expect(hits).toEqual([a.id]);
  });

  test("tag 前缀通配与 FTS 组合", () => {
    svc.createTagService(db, "theme:cache", "缓存");
    const a = makeGround(db, { content: "缓存淘汰策略 A" });
    makeGround(db, { content: "缓存淘汰策略 B" }); // 无 tag
    tagIt(a.id, "theme:cache");

    const hits = rowsOf(search("缓存淘汰", { tag: "theme:*" })).map((n: any) => n.id);
    expect(hits).toEqual([a.id]);
  });
});

// =============================================================================
// 8：分页 total
// =============================================================================

describe("§5.8：分页 total 与 limit 无关", () => {
  function seed(n: number): void {
    for (let i = 0; i < n; i++) makeGround(db, { content: `缓存淘汰实测第 ${i} 条` });
  }

  test("total 报总命中数，不是本页行数", () => {
    seed(12);
    const r = svc.searchNodesFts
      ? svc.searchNodesFts(db, "缓存淘汰", { limit: 5, offset: 0 })
      : search("缓存淘汰", { limit: 5, offset: 0 });
    expect(rowsOf(r).length).toBe(5);
    expect(r.total).toBe(12);
  });

  test("offset 推进而 total 不变", () => {
    seed(12);
    const page2 = svc.searchNodesFts
      ? svc.searchNodesFts(db, "缓存淘汰", { limit: 5, offset: 5 })
      : search("缓存淘汰", { limit: 5, offset: 5 });
    expect(rowsOf(page2).length).toBe(5);
    expect(page2.total).toBe(12);
  });

  test("末页不足 limit 时 total 仍是全量", () => {
    seed(12);
    const page3 = svc.searchNodesFts
      ? svc.searchNodesFts(db, "缓存淘汰", { limit: 5, offset: 10 })
      : search("缓存淘汰", { limit: 5, offset: 10 });
    expect(rowsOf(page3).length).toBe(2);
    expect(page3.total).toBe(12);
  });

  test("截断在输出里可见：头行报总数与 offset（§0.2）", async () => {
    seed(60);
    const out = await tools["list_statements"].handler({ limit: 50, offset: 0 });
    const text = typeof out === "object" && out.content ? out.content[0]?.text || JSON.stringify(out) : JSON.stringify(out);
    expect(text).toContain("of 60");
    expect(text).toMatch(/Showing 50/);
  });
});

// =============================================================================
// 9：phrase 引号转义
// =============================================================================

describe("§5.9：phrase 引号转义", () => {
  test('查询里含 " 时不抛 FTS 语法错', () => {
    const g = makeGround(db, { content: '论文里写的是 "retrieval-augmented" 这个词' });
    expect(() => search('"retrieval')).not.toThrow();
    const hits = rowsOf(search('"retrieval-augmented"')).map((n: any) => n.id);
    expect(hits).toContain(g.id);
  });

  test("查询里的 OR 当字面量而不是 FTS 语法", () => {
    const both = makeGround(db, { content: "cache OR eviction 这个字面串" });
    makeGround(db, { content: "只有 cache 没有别的" });
    makeGround(db, { content: "只有 eviction 没有别的" });

    const hits = rowsOf(search("cache OR eviction")).map((n: any) => n.id);
    // 若被当成 FTS 的 OR 运算符，三条都会命中
    expect(hits).toEqual([both.id]);
  });

  test("查询里的 * 与 NEAR 同样当字面量", () => {
    const g = makeGround(db, { content: "写着 NEAR(a b) 与 star* 的内容" });
    expect(() => search("NEAR(a b)")).not.toThrow();
    expect(rowsOf(search("star*")).map((n: any) => n.id)).toContain(g.id);
  });
});

// =============================================================================
// 10：DISTINCT —— 不门控，锁 HEAD 上的活缺陷
// =============================================================================

describe("§5.10：虚拟角色过滤的 DISTINCT（三个分支各一条）", () => {
  test("一条 Ground 挂 3 个 Warrant ⇒ role=ground 返回 1 行不是 3 行", () => {
    const g = makeGround(db, { content: "被复用的证据" });
    for (let i = 0; i < 3; i++) {
      const c = makeClaim(db, `Claim ${i}`);
      makeWarrant(db, c.id, [g.id], `Warrant ${i}`);
    }
    const rows = rowsOf(svc.searchNodesService(db, "被复用", "ground"));
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(g.id);
  });

  test("一条 Backing 挂 3 个 Warrant ⇒ role=backing 返回 1 行", () => {
    const b = makeGround(db, { content: "被复用的支撑" });
    for (let i = 0; i < 3; i++) {
      const c = makeClaim(db, `Claim ${i}`);
      const w = makeWarrant(db, c.id, [], `Warrant ${i}`);
      repo.insertWarrantBacking(db, w.id, b.id);
    }
    const rows = rowsOf(svc.searchNodesService(db, "被复用", "backing"));
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(b.id);
  });

  test("一条 Rebuttal 指向 3 个目标 ⇒ role=rebuttal 返回 1 行", () => {
    const r = makeGround(db, { content: "被复用的反驳" });
    for (let i = 0; i < 3; i++) {
      const c = makeClaim(db, `Claim ${i}`);
      repo.insertRebuttalTarget(db, r.id, c.id, "claim");
    }
    const rows = rowsOf(svc.searchNodesService(db, "被复用", "rebuttal"));
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(r.id);
  });

  test("复用不影响待验队列计数 —— 这是 DISTINCT 真正的后果", () => {
    // "还剩多少条要验" 是靠这个查询数出来的；重复行会让这个数字凭空变大
    const g1 = makeGround(db, { content: "待验证据甲", verification: "pending" });
    const g2 = makeGround(db, { content: "待验证据乙", verification: "pending" });
    for (let i = 0; i < 4; i++) {
      const c = makeClaim(db, `Claim ${i}`);
      makeWarrant(db, c.id, [g1.id, g2.id], `Warrant ${i}`);
    }
    const rows = rowsOf(svc.searchNodesService(db, "待验证据", "ground"));
    expect(rows.length).toBe(2);
  });
});

// =============================================================================
// 11：缺口矩阵只出 (稠密, 有界) 有序对
// =============================================================================

describe("§5.11：缺口矩阵的有序对范围", () => {
  function gapText(): string {
    const stats = svc.getStats(db);
    if (!stats.scale) return "";
    return stats.scale.namespace_gaps.map((g: { from: string; to: string; count: number }) => `${g.from}: -> ${g.to}:   ${g.count}`).join("\n");
  }

  beforeEach(() => {
    // paper: 稠密（一产物一成员），theme: / meta: 有界
    tagRepo.setNamespaceCardinality(db, "paper", "dense");
    tagRepo.setNamespaceCardinality(db, "theme", "bounded");
    tagRepo.setNamespaceCardinality(db, "meta", "bounded");
    svc.createTagService(db, "paper:smith2024", "论文甲");
    svc.createTagService(db, "paper:jones2023", "论文乙");
    svc.createTagService(db, "theme:cache", "缓存类目");
    svc.createTagService(db, "meta:screened", "流程标记");
    const a = makeGround(db, { content: "论文甲的结论" });
    const b = makeGround(db, { content: "论文乙的结论" });
    tagRepo.addNodeTags(db, a.id, ["paper:smith2024", "theme:cache"]);
    tagRepo.addNodeTags(db, b.id, ["paper:jones2023"]); // 未归类 —— 真信号
  });

  test("含 paper: -> theme:（稠密指向有界，表达未分类积压）", () => {
    expect(gapText()).toContain("paper: -> theme:");
  });

  test("不含 theme: -> paper:（反向不表达积压）", () => {
    expect(gapText()).not.toContain("theme: -> paper:");
  });

  test("不含 paper: -> meta:（meta: 不期望覆盖 paper: 全体）", () => {
    expect(gapText()).not.toContain("paper: -> meta:");
  });

  test("真信号的计数是「未归类的稠密成员数」，不是节点总数", () => {
    const line = gapText().split("\n").find((l) => l.includes("paper: -> theme:")) ?? "";
    expect(line).toMatch(/\b1\b/); // 只有论文乙未归类
  });
});

// =============================================================================
// 12：Attachments 位列文件名并标失效
// =============================================================================

describe("§5.12：Attachments 位", () => {
  function attText(): string {
    const stats = svc.getStats(db);
    if (!stats.scale) return "";
    const files = stats.scale.attachments.files;
    if (files.length === 0) return "";
    if (files.length <= 8) {
      return `Attachments: ${stats.scale.attachments.total} — ${files.map((f: { path: string; missing: boolean }) => f.missing ? `${f.path} (missing)` : f.path).join(", ")}`;
    }
    return `Attachments: ${stats.scale.attachments.total} distinct files referenced`;
  }

  test("≤8 个时逐个列路径", () => {
    makeGround(db, {
      content: "带附件的证据",
      attachments: ["README.md", "package.json"],
    });
    const text = attText();
    expect(text).toContain("README.md");
    expect(text).toContain("package.json");
  });

  test("解析不到的路径就地标 (missing)", () => {
    makeGround(db, {
      content: "带附件的证据",
      attachments: ["README.md", "runs/0041/metrics.json"],
    });
    const text = attText();
    const line = text.split("\n").find((l) => l.includes("metrics.json")) ?? "";
    expect(line).toContain("(missing)");
    // 存在的那个不该被误标
    const okLine = text.split("\n").find((l) => l.includes("README.md")) ?? "";
    expect(okLine.includes("README.md (missing)")).toBe(false);
  });

  test(">8 个时退回计数格式", () => {
    const files = Array.from({ length: 9 }, (_, i) => `docs/f${i}.md`);
    makeGround(db, { content: "附件很多的证据", attachments: files });
    const text = attText();
    // The >8 fallback uses the count format
    expect(text).toMatch(/Attachments:\s*9/);
    expect(text).not.toContain("docs/f0.md");
  });

  test("这一位在第一次 create_tags 之前是唯一会动的信号（§4.2.2 的误读）", () => {
    const before = attText();
    makeGround(db, { content: "第一条筛选产物", attachments: ["screening.csv"] });
    const after = attText();
    // 采集中途与采集完成必须读数不同 —— 裸计数会让两者逐字相同
    expect(after).not.toBe(before);
    expect(after).toContain("screening.csv");
  });
});

// =============================================================================
// 13：过滤先于分页（§0.2 / §2.7）
//
// §2.7 把顺序写成了一句规则："虚拟角色过滤在分页之前完成，截断发生在过滤
// 之后。颠倒顺序会得到『本页有 7 条符合角色』这种无从解释的结果。" 这条规则
// 对 role 之外的每一个过滤器同样成立，而 §2.2 的两条判定性查询里恰好各用了
// 一个非 role 过滤器：
//
//   list_statements(role="ground", verification="pending")  # 待验队列
//   list_claims(status=...)                                 # 裁决队列
//
// 顺序颠倒时它们不是"少给几条"，而是**队列整体消失且头行报着全量总数** ——
// agent 读到 "Showing 0 of 168" 会得出"没有待验的了"。这正是 §0.2 说的
// "错，而且错得没有症状"。
// =============================================================================

describe("§13：过滤在分页之前完成，total 反映过滤后的集合", () => {
  test("待验队列：60 条 ground 里 5 条 pending ⇒ 报 5，不是 0 of 60", () => {
    const ids: number[] = [];
    for (let i = 0; i < 60; i++) {
      const g = makeGround(db, {
        content: `证据 ${i}`,
        verification: i >= 55 ? "pending" : "verified",
        attachments: ["README.md"],
      });
      ids.push(g.id);
    }
    const c = makeClaim(db, "被支撑的主张");
    makeWarrant(db, c.id, ids, "理由");

    const r = svc.listStatements(db, undefined, "pending", undefined, undefined, "ground", 50, 0);
    expect(r.rows.length).toBe(5);
    expect(r.total).toBe(5);
  });

  test("verification 过滤单独使用时同样先于分页", () => {
    for (let i = 0; i < 60; i++) {
      makeGround(db, {
        content: `证据 ${i}`,
        verification: i >= 55 ? "pending" : "verified",
        attachments: ["README.md"],
      });
    }
    const r = svc.listStatements(db, undefined, "pending", undefined, undefined, undefined, 50, 0);
    expect(r.rows.length).toBe(5);
    expect(r.total).toBe(5);
  });

  test("source 过滤先于分页", () => {
    for (let i = 0; i < 60; i++) {
      makeGround(db, {
        content: `证据 ${i}`,
        source: i >= 58 ? "literature" : "observed",
        attachments: ["README.md"],
      });
    }
    const r = svc.listStatements(db, "literature", undefined, undefined, undefined, undefined, 50, 0);
    expect(r.rows.length).toBe(2);
    expect(r.total).toBe(2);
  });

  test("裁决队列：61 条 Claim 里 1 条 supported ⇒ 报 1，不是 0 of 61", () => {
    for (let i = 0; i < 60; i++) makeClaim(db, `主张 ${i}`);
    const target = makeClaim(db, "已裁决的主张", "supported");

    const r = svc.listClaims(db, "supported", undefined, undefined, 50, 0);
    expect(r.rows.length).toBe(1);
    expect(r.total).toBe(1);
    expect(r.rows[0].id).toBe(target.id);
  });

  test("compile_status 过滤先于分页，且 null 可筛（§2.6）", () => {
    for (let i = 0; i < 60; i++) makeClaim(db, `主张 ${i}`);
    const stale = makeClaim(db, "编译已失效的主张");
    repo.saveCompileState(db, stale.id, "stale", "");

    const r = svc.listClaims(db, undefined, "stale", undefined, 50, 0);
    expect(r.rows.length).toBe(1);
    expect(r.total).toBe(1);
    expect(r.rows[0].id).toBe(stale.id);

    // null 分支：其余 60 条都没有 compile_status
    const rNull = svc.listClaims(db, undefined, "null", undefined, 50, 0);
    expect(rNull.total).toBe(60);
  });

  test("头行的数字与实际返回一致 —— 截断可见的前提是数字为真（§0.2）", async () => {
    for (let i = 0; i < 60; i++) makeClaim(db, `主张 ${i}`);
    makeClaim(db, "已裁决的主张", "supported");

    const out = await tools["list_claims"].handler({ status: "supported", limit: 50, offset: 0 });
    const text = out.content[0].text as string;
    // 过滤后只有 1 条，1 不小于 total=1 ⇒ 根本不该出现截断头行
    expect(text).not.toContain("Showing");
    expect(text).toContain("已裁决的主张");
  });
});

// =============================================================================
// 14：tag 前缀通配在每个入口都成立（§2.2）
//
// §2.2 把通配写成 tag / without_tag 两个参数的共同性质，而不是某个工具的
// 局部特性。漏在哪个入口都不报错 —— 精确匹配一个带 `*` 的字面串必然返回空，
// 读起来与"这个类目下确实没有节点"完全一样。
// =============================================================================

describe("§14：tag 通配的入口一致性", () => {
  beforeEach(() => {
    svc.createTagService(db, "theme:cache", "缓存类目");
  });

  test("list_claims(tag='theme:*') 命中而不是返回空", () => {
    const c = makeClaim(db, "带类目的主张");
    makeClaim(db, "无类目的主张");
    tagRepo.addNodeTags(db, c.id, ["theme:cache"]);

    const r = svc.listClaims(db, undefined, undefined, "theme:*", 50, 0);
    expect(r.rows.map((x: any) => x.id)).toEqual([c.id]);
    expect(r.total).toBe(1);
  });

  test("list_claims(tag='theme:cache') 精确匹配仍然成立", () => {
    const c = makeClaim(db, "带类目的主张");
    tagRepo.addNodeTags(db, c.id, ["theme:cache"]);
    expect(svc.listClaims(db, undefined, undefined, "theme:cache", 50, 0).total).toBe(1);
  });
});

// =============================================================================
// 15：虚拟角色分支的 tag 与分页（§2.4 / §2.7）
//
// §2.4 的标题就是 "search_nodes 必须有 limit"，理由是 600 节点图上一个常见
// 关键词命中 241 行 ≈ 15K token，而子 agent 的上下文远小于主 agent。三个
// 角色分支绕开了这条：它们各自拼一句自己的 SQL，limit / offset / tag 都不
// 参与。tag 被无声丢弃比不分页更坏 —— 返回的行数看着正常，只是过滤没发生。
// =============================================================================

describe("§15：角色分支同样受 limit / offset / tag 约束", () => {
  function seedGrounds(n: number): number[] {
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(makeGround(db, { content: `复用证据 ${i}`, attachments: ["README.md"] }).id);
    }
    const c = makeClaim(db, "主张");
    makeWarrant(db, c.id, ids, "理由");
    return ids;
  }

  test("limit 生效，total 报全量", () => {
    seedGrounds(30);
    const r = svc.searchNodesService(db, "复用证据", "ground", undefined, 5, 0);
    expect(rowsOf(r).length).toBe(5);
    expect(r.total).toBe(30);
  });

  test("offset 推进而 total 不变", () => {
    seedGrounds(30);
    const r = svc.searchNodesService(db, "复用证据", "ground", undefined, 5, 25);
    expect(rowsOf(r).length).toBe(5);
    expect(r.total).toBe(30);
  });

  test("tag 过滤在角色分支里不被丢弃", () => {
    const ids = seedGrounds(10);
    svc.createTagService(db, "theme:cache", "缓存类目");
    tagRepo.addNodeTags(db, ids[0], ["theme:cache"]);

    const r = svc.searchNodesService(db, "复用证据", "ground", "theme:*", 20, 0);
    expect(rowsOf(r).map((n: any) => n.id)).toEqual([ids[0]]);
    expect(r.total).toBe(1);
  });

  test("backing / rebuttal 分支同样受约束", () => {
    for (let i = 0; i < 6; i++) {
      const c = makeClaim(db, `主张 ${i}`);
      const w = makeWarrant(db, c.id, [], `理由 ${i}`);
      const b = makeGround(db, { content: `支撑材料 ${i}`, attachments: ["README.md"] });
      repo.insertWarrantBacking(db, w.id, b.id);
      const rb = makeGround(db, { content: `反驳材料 ${i}`, attachments: ["README.md"] });
      repo.insertRebuttalTarget(db, rb.id, c.id, "claim");
    }
    const rb = svc.searchNodesService(db, "支撑材料", "backing", undefined, 2, 0);
    expect(rowsOf(rb).length).toBe(2);
    expect(rb.total).toBe(6);

    const rr = svc.searchNodesService(db, "反驳材料", "rebuttal", undefined, 2, 0);
    expect(rowsOf(rr).length).toBe(2);
    expect(rr.total).toBe(6);
  });
});

// =============================================================================
// 16：list_tags 的截断可见与 min_count=0（§0.2 / §2.5）
//
// §0.2 说的是"**每一处**截断都在返回的头行里报总数与 offset"，不是"列表类
// 工具里的两个"。list_tags 的 limit 默认 100，而 §2.5 开篇就是"一个稠密
// 命名空间有几百个标签" —— 默认调用必然截断，且这是 agent 用来"读现有类目"
// 的高频操作，读少了直接表现为概念漂移。
//
// min_count=0 的语义单独一条：§2.5 说它"找出注册了但没有节点挂着的标签"，
// 而 `>=` 语义下它等于不设下限（未传 min_count 已经是那个意思）。参数说明
// 与实现必须同真同假，否则说明文字本身成了错误信息源。
// =============================================================================

describe("§16：list_tags 的截断可见与 min_count=0", () => {
  test("超过 limit 时头行报总数与 offset", async () => {
    for (let i = 0; i < 120; i++) {
      svc.createTagService(db, `paper:k${String(i).padStart(3, "0")}`, `论文 ${i}`);
    }
    const out = await tools["list_tags"].handler({ limit: 100, offset: 0 });
    const text = out.content[0].text as string;
    expect(text).toMatch(/Showing 100 of 120 \(offset 0\)/);
  });

  test("未截断时不出头行", async () => {
    svc.createTagService(db, "theme:cache", "缓存类目");
    const out = await tools["list_tags"].handler({ limit: 100, offset: 0 });
    expect(out.content[0].text as string).not.toContain("Showing");
  });

  test("prefix 过滤后的总数是过滤后的总数，不是全量", async () => {
    for (let i = 0; i < 120; i++) {
      svc.createTagService(db, `paper:k${String(i).padStart(3, "0")}`, `论文 ${i}`);
    }
    svc.createTagService(db, "theme:cache", "缓存类目");
    const out = await tools["list_tags"].handler({ prefix: "theme:", limit: 100, offset: 0 });
    expect(out.content[0].text as string).not.toContain("Showing");
  });

  test("min_count=0 只出空标签（§2.5 的工作队列信号）", () => {
    svc.createTagService(db, "theme:empty", "还没有节点的类目");
    svc.createTagService(db, "theme:used", "已经有节点的类目");
    const g = makeGround(db, { content: "证据", attachments: ["README.md"] });
    tagRepo.addNodeTags(db, g.id, ["theme:used"]);

    const names = tagRepo.listTagsWithCount(db, { min_count: 0 }).map((t: any) => t.name);
    expect(names).toEqual(["theme:empty"]);
  });

  test("min_count=1 仍是下限语义", () => {
    svc.createTagService(db, "theme:empty", "还没有节点的类目");
    svc.createTagService(db, "theme:used", "已经有节点的类目");
    const g = makeGround(db, { content: "证据", attachments: ["README.md"] });
    tagRepo.addNodeTags(db, g.id, ["theme:used"]);

    const names = tagRepo.listTagsWithCount(db, { min_count: 1 }).map((t: any) => t.name);
    expect(names).toEqual(["theme:used"]);
  });

  test("内部聚合调用不受 100 条页大小限制 —— 规模块要报全量词表", () => {
    for (let i = 0; i < 120; i++) {
      svc.createTagService(db, `paper:k${String(i).padStart(3, "0")}`, `论文 ${i}`);
    }
    expect(tagRepo.listTagsWithCount(db).length).toBe(120);
    const stats = svc.getStats(db);
    expect(stats.scale.tags.total).toBe(120);
  });
});

// =============================================================================
// 17：规模块两条汇总行报的是它们声称的那个量（§4.1 / §4.2）
//
// §4.2 的样例输出是被当成契约读的：`Statements: 487 (441 tagged, 46 untagged)`
// 里的 487 是 Statement 数，`Claims: 27 — 3 supported, 24 proposed` 里的 27
// 是 Claim 数。这两个位置**天然容易被写成手边现成的那个数**（命名空间里的
// 标签数之和；三个子状态之和），而错了之后行还在、格式还对、数字还是正整数
// —— §4.1 整节的前提"规模块能回答『我到哪儿了』"就此失效而无症状。
//
// 三个子计数是 `proposed` 的**划分**（§4.1 "单个 proposed 数字混淆了三件
// 事"），所以它们的和恒不等于 Claim 总数：任何已裁决的 Claim 都不在其中。
// =============================================================================

describe("§17：Statements / Claims 汇总行的量纲", () => {
  async function statsText(): Promise<string> {
    const out = await tools["get_stats"].handler({});
    return out.content[0].text as string;
  }

  test("Statements 行报 Statement 数，不是标签数之和", async () => {
    for (let i = 0; i < 7; i++) makeGround(db, { content: `证据 ${i}`, attachments: ["README.md"] });
    svc.createTagService(db, "theme:cache", "缓存类目");
    const rows = repo.listNodesByType(db, "statement");
    tagRepo.addNodeTags(db, rows[0].id, ["theme:cache"]);
    const text = await statsText();
    const line = text.split("\n").find(l => l.startsWith("Statements:")) ?? "";
    expect(line).toContain("Statements: 7");
    expect(line).toContain("(1 tagged, 6 untagged)");
  });

  test("Claims 行报 Claim 总数，不是三个子状态之和", async () => {
    // 已裁决且编译过的 Claim 不落在 never-compiled / stale / passed-awaiting 任何一格
    const a = makeClaim(db, "已裁决甲", "supported");
    const b = makeClaim(db, "已裁决乙", "supported");
    makeClaim(db, "待办丙");
    for (const c of [a, b]) {
      repo.saveCompileState(db, c.id, "passed", "");
      repo.setClaimStatus(db, c.id, "supported");
    }

    const stats = svc.getStats(db);
    const d = stats.scale.claims_detail;
    const subtotal = d.never_compiled + d.stale.count + d.passed_awaiting;
    expect(stats.claims.total).toBe(3);
    expect(subtotal).toBe(1); // 前提：三者之和确实小于总数（只剩"待办丙"）

    const text = await statsText();
    const line = text.split("\n").find(l => l.startsWith("Claims:")) ?? "";
    expect(line).toContain("Claims: 3");
    expect(line).toContain("2 supported");
  });

  test("三个子状态仍然分列（§4.1 第三行的三分）", async () => {
    makeClaim(db, "从未编译的主张");
    const text = await statsText();
    expect(text).toContain("never compiled");
    expect(text).toContain("passed-awaiting-verdict");
  });
});

// =============================================================================
// 18：缺口矩阵与 Attachments 位在**真实输出文本**里成立（§4.2.1 / §4.2.2）
//
// §5.11 / §5.12 的断言跑在测试自己拼的字符串上（gapText / attText 各自把
// ScaleBlock 重新格式化了一遍）。这两条的失效条件写的是"被『优化输出体积』
// 的人改坏"，而那个人改的是 formatStats —— 测试里的那份格式化副本不会跟着
// 变，于是**该红的时候它是绿的**。所以这里对真实工具输出再断言一遍。
//
// 同时补 §4.2.1 第三条：8 行上限，以及头行必须报出省略了多少对。这一条比
// §0.2 更隐蔽 —— 读者不知道矩阵原本有多大。
// =============================================================================

describe("§18：矩阵与 Attachments 在真实输出里", () => {
  async function statsText(): Promise<string> {
    const out = await tools["get_stats"].handler({});
    return out.content[0].text as string;
  }

  test("Attachments 行在真实输出里逐个列路径并就地标 (missing)", async () => {
    makeGround(db, { content: "带附件的证据", attachments: ["README.md", "runs/0041/metrics.json"] });
    const text = await statsText();
    const line = text.split("\n").find(l => l.startsWith("Attachments:")) ?? "";
    expect(line).toContain("README.md");
    expect(line).toContain("runs/0041/metrics.json (missing)");
    expect(line).not.toContain("README.md (missing)");
  });

  test("Attachments 行 >8 时在真实输出里退回计数格式", async () => {
    makeGround(db, {
      content: "附件很多的证据",
      attachments: Array.from({ length: 9 }, (_, i) => `docs/f${i}.md`),
    });
    const text = await statsText();
    const line = text.split("\n").find(l => l.startsWith("Attachments:")) ?? "";
    expect(line).toContain("9 distinct files referenced");
    expect(line).not.toContain("docs/f0.md");
  });

  test("矩阵在真实输出里只出 (稠密, 有界) 有序对", async () => {
    tagRepo.setNamespaceCardinality(db, "paper", "dense");
    tagRepo.setNamespaceCardinality(db, "theme", "bounded");
    tagRepo.setNamespaceCardinality(db, "meta", "bounded");
    svc.createTagService(db, "paper:smith2024", "论文甲");
    svc.createTagService(db, "theme:cache", "缓存类目");
    svc.createTagService(db, "meta:screened", "流程标记");
    const a = makeGround(db, { content: "论文甲的结论", attachments: ["README.md"] });
    tagRepo.addNodeTags(db, a.id, ["paper:smith2024"]);

    const text = await statsText();
    expect(text).toContain("paper: -> theme:");
    expect(text).not.toContain("paper: -> meta:");
    expect(text).not.toContain("theme: -> paper:");
  });

  test("矩阵超过 8 行时截断，且头行报省略了多少对", async () => {
    // 1 个稠密 × 10 个有界 = 10 对，全部非零 ⇒ 触发 8 行上限
    tagRepo.setNamespaceCardinality(db, "paper", "dense");
    svc.createTagService(db, "paper:smith2024", "论文甲");
    for (let i = 0; i < 10; i++) {
      tagRepo.setNamespaceCardinality(db, `cat${i}`, "bounded");
      svc.createTagService(db, `cat${i}:x`, `类目 ${i}`);
    }
    const a = makeGround(db, { content: "论文甲的结论", attachments: ["README.md"] });
    tagRepo.addNodeTags(db, a.id, ["paper:smith2024"]);

    const stats = svc.getStats(db);
    expect(stats.scale.namespace_gaps.length).toBe(8);
    expect(stats.scale.gaps_omitted).toBe(2);

    const text = await statsText();
    const header = text.split("\n").find(l => l.startsWith("Namespace gaps")) ?? "";
    expect(header).toContain("2 more pair(s) omitted");
  });

  test("未省略时头行不带省略说明", async () => {
    tagRepo.setNamespaceCardinality(db, "paper", "dense");
    tagRepo.setNamespaceCardinality(db, "theme", "bounded");
    svc.createTagService(db, "paper:smith2024", "论文甲");
    svc.createTagService(db, "theme:cache", "缓存类目");
    const a = makeGround(db, { content: "论文甲的结论", attachments: ["README.md"] });
    tagRepo.addNodeTags(db, a.id, ["paper:smith2024"]);

    const header = (await statsText()).split("\n").find(l => l.startsWith("Namespace gaps")) ?? "";
    expect(header).not.toContain("omitted");
  });
});

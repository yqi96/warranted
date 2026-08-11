/**
 * Toulmin MCP — 批量入口与写入路径校验
 *
 * 对应 `.omc/plans/0.5.0/pr3-batch.md` §9 的二十一条。
 *
 * ── 三档，前提与写法不同 ────────────────────────────────────────────
 *
 * A. **新工具（`create_statements` / `verify_statements` / `tag_nodes` /
 *    `update_tag`）** —— 这四个今天都注册了，写成下面"前提"那节的断言。
 *    少了哪一个就在那里红一条并点名，不再把依赖它的测试静静跳过。
 *
 * B. **两个入口统一（5 / 9 / 10 / 11 / 17 / 18）—— 今天就是红的。**
 *    这些条目修的是既有入口上的活缺陷：`create_statement` 的
 *    `?? "observed"`、`update_node` 的 attachments 分支无条件赋值、H1 只
 *    挂在 verification 分支里。修法都是就地改，**不产生新的实现表面**，
 *    所以没有任何前提断言能表达"修好了没有"。可探测性缺失时唯一诚实的
 *    写法是让它红着 —— 与 `fts.test.ts` 的 DISTINCT 同类。
 *
 *    §4.0.2 的活缺陷（测试 18）尤其要红着：它是一次调用、零信号，
 *    `update_node(<已 verified>, attachments=[])` 今天零报错零 warning。
 *
 * C. **注入式 review 断言（19 / 20 / 21）** —— 用 `mock.module` 替换
 *    `executeStatementReview`，**不起真实会话**。测试 20 尤其要按注入写：
 *    "`dontAsk` 下根外 `Read` 会不会被拒"是一条静态判不出来的前提，
 *    断言它会让这一例随 SDK 版本变红变绿，而它锁的那条接线与前提无关。
 *
 * ── 一条不测的 ───────────────────────────────────────────────────────
 * §4.3.2 的 live 探针（根外附件起一次真实 review 会话看 `deniedTools`）
 * 按设计需用户批准，**本文件不跑**。测试 8 的根外一例按"前提为假"的
 * 默认配置写成 warning；探针定案为真之后，它与 §4.3.2、§3.0.1 三处一起
 * 改判为拒绝。
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import * as service from "../src/service.ts";
import * as repo from "../src/repo.ts";
import { registerTools } from "../src/tools.ts";
import { createTestDb, cleanupDb, makeClaim, makeGround, makeWarrant, compileVerdictOf } from "./helpers.ts";
import { reviewCwd as _reviewCwd } from "../src/review-config.ts";

const svc = service as any;
const tagRepo = repo as any;

// =============================================================================
// 夹具
// =============================================================================

function createMockServer() {
  const registered: Record<string, { schema: any; handler: Function }> = {};
  return {
    registerTool(name: string, config: any, handler: Function) {
      registered[name] = { schema: config.inputSchema, handler };
    },
    _tools: registered,
  };
}

/** review cwd = dirname(dirname(dbPath))，所以 dbPath 要埋两层。 */
let workRoot: string;
let dbPath: string;

function makeReviewConfig(): any {
  return {
    enabled: true,
    provider: "anthropic",
    model: "test-model",
    apiKey: "test-key",
    maxTurns: 3,
    maxConcurrency: 4,
    reviewDir: null,
    auditDir: null,
    dbPath,
  };
}

let db: Database;
let tools: Record<string, { schema: any; handler: Function }>;

beforeEach(() => {
  workRoot = join(tmpdir(), `warranted-batch-${process.hrtime.bigint()}`);
  mkdirSync(join(workRoot, ".warranted"), { recursive: true });
  dbPath = join(workRoot, ".warranted", "graph.db");
  db = createTestDb();
  const server = createMockServer();
  registerTools(server as any, db, makeReviewConfig());
  tools = server._tools as any;
});

afterEach(() => {
  cleanupDb(db);
  rmSync(workRoot, { recursive: true, force: true });
});

/** 在 review cwd 之内造一个真实文件，返回相对路径。 */
function realAttachment(rel: string): string {
  const abs = join(workRoot, rel);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(abs, "evidence\n");
  return rel;
}

/** 在 review cwd 之外造一个真实文件，返回绝对路径。 */
function outOfRootAttachment(): string {
  const dir = join(tmpdir(), `warranted-outside-${process.hrtime.bigint()}`);
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, "zotero-paper.pdf");
  writeFileSync(abs, "pdf\n");
  return abs;
}

async function call(name: string, args: any): Promise<{ text: string; isError: boolean }> {
  const out: any = await tools[name].handler(args);
  return { text: out?.content?.[0]?.text ?? JSON.stringify(out), isError: !!out?.isError };
}

function statementCount(): number {
  return (db.prepare("SELECT count(*) c FROM nodes WHERE type = 'statement'").get() as any).c;
}

function dataOf(nodeId: number): any {
  return JSON.parse(repo.getNodeById(db, nodeId)!.data);
}

// =============================================================================
// 前提
// =============================================================================
//
// 这些能力是本文件的前提，不是条件。以前这里是一组探针，配 skipIf 用：0.5.0 开发期
// 功能一个一个落地，探针让还没落地的部分先跳过。功能全落地之后，探针再没有第二种
// 真值可报，只剩一个副作用——删掉 create_statements 的注册，本文件 19 条测试会安静
// 地跳过，跑出来仍然是 0 fail。现在改成断言：少了哪个能力就在这里红一条，并说出少
// 的是什么。

function registeredTools(): Record<string, { schema: any; handler: Function }> {
  const probeDb = createTestDb();
  try {
    const server = createMockServer();
    registerTools(server as any, probeDb, null);
    return server._tools as any;
  } finally {
    cleanupDb(probeDb);
  }
}

describe("前提", () => {
  test("本文件依赖的批量工具都已注册", () => {
    const names = Object.keys(registeredTools());
    for (const tool of ["create_statements", "verify_statements", "tag_nodes", "update_tag"]) {
      expect(names).toContain(tool);
    }
  });

  test("create_warrant 接受 backing_ids", () => {
    expect(Object.keys(registeredTools()["create_warrant"]!.schema)).toContain("backing_ids");
  });

  test("tag 服务与 reviewCwd 都可用", () => {
    expect(typeof svc.createTagService).toBe("function");
    expect(typeof _reviewCwd).toBe("function");
  });
});

/** PR1 的 tag 注册；PR3 单测里只当前置条件用。 */
function registerTag(name: string): void {
  svc.createTagService(db, name, `desc for ${name}`);
}

// =============================================================================
// 1–4：create_statements 的原子性与返回契约
// =============================================================================

describe("§9.1–4：整批原子与 validate-all 返回契约", () => {
  test("1. 3 条里第 2 条 tag 未注册 ⇒ 零条写入，错误点名 item[1]", async () => {
    registerTag("theme:cache");
    const before = statementCount();
    const r = await call("create_statements", {
      statements: [
        { content: "第一条", source: "observed", tags: ["theme:cache"] },
        { content: "第二条", source: "observed", tags: ["theme:never-registered"] },
        { content: "第三条", source: "observed", tags: ["theme:cache"] },
      ],
    });
    expect(r.isError).toBe(true);
    expect(statementCount()).toBe(before); // 零写入 —— 部分状态在物理上不存在
    expect(r.text).toContain("item[1]");
  });

  test("2. 多条失败要全部报告，不是只报第一条（§2.2 第 1 条）", async () => {
    // 没有这条断言，§2.1"原子 = 可预测的重试单元"的论证不成立：
    // 一次重试要能修完所有问题，前提是一次报告列全所有问题
    registerTag("theme:cache");
    const items = Array.from({ length: 12 }, (_, i) => ({
      content: `第 ${i} 条`,
      source: "observed" as const,
      tags: ["theme:cache"],
    }));
    (items[3] as any).tags = ["theme:unregistered"];
    (items[7] as any).source = "literature"; // 无附件 ⇒ §4.1
    (items[11] as any).attachments = ["papers/nope.pdf"]; // 解析不到 ⇒ §4.3

    const r = await call("create_statements", { statements: items });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("item[3]");
    expect(r.text).toContain("item[7]");
    expect(r.text).toContain("item[11]");
    expect(statementCount()).toBe(0);
  });

  test("3. 成功分支逐条携带 warning，批量路径不吞（§2.2 第 2 条）", async () => {
    // 委派场景里读到这段文本的是 subagent；吞掉逐条 warning，
    // 两级处置同时断掉 —— subagent 看不见，报告里也就无从转录
    registerTag("paper:smith2019a");
    registerTag("paper:jones2023");
    const r = await call("create_statements", {
      statements: [
        { content: "论文甲自述的结果", source: "observed", tags: ["paper:smith2019a"] },
        { content: "论文乙自述的结果", source: "observed", tags: ["paper:jones2023"] },
      ],
    });
    expect(r.isError).toBe(false);
    expect(statementCount()).toBe(2);
    expect(r.text).toContain("paper:smith2019a");
    expect(r.text).toContain("paper:jones2023");
    expect(r.text.match(/warning/gi)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test("4. 重发安全：修好第 1 条后原样重发 ⇒ 总数 3 不是 5", async () => {
    registerTag("theme:cache");
    const bad = [
      { content: "甲", source: "observed", tags: ["theme:nope"] },
      { content: "乙", source: "observed", tags: ["theme:cache"] },
      { content: "丙", source: "observed", tags: ["theme:cache"] },
    ];
    await call("create_statements", { statements: bad });
    expect(statementCount()).toBe(0);

    const fixed = [{ ...bad[0], tags: ["theme:cache"] }, bad[1], bad[2]];
    const r = await call("create_statements", { statements: fixed });
    expect(r.isError).toBe(false);
    expect(statementCount()).toBe(3);
  });

  test("上限 50：51 条被拒", async () => {
    const items = Array.from({ length: 51 }, (_, i) => ({
      content: `第 ${i} 条`,
      source: "observed" as const,
    }));
    const r = await call("create_statements", { statements: items });
    expect(r.isError).toBe(true);
    expect(statementCount()).toBe(0);
  });

  test("空数组被拒（min 1）", async () => {
    const r = await call("create_statements", { statements: [] });
    expect(r.isError).toBe(true);
  });

  test("单条 schema 不含 rebuttal_for（§2.6）", () => {
    const schema: any = tools["create_statements"].schema;
    expect(JSON.stringify(schema)).not.toContain("rebuttal_for");
  });
});

// =============================================================================
// 5：source 必填 —— 两个入口一致（单条侧今天是红的）
// =============================================================================

describe("§9.5：source 必填，两个入口一致", () => {
  test("create_statement（单数）省略 source ⇒ 拒绝，不再默认 observed", async () => {
    // 今天 tools.ts 的 handler 写着 `source: opts.source ?? "observed"`
    const r = await call("create_statement", { content: "没写来源的一条" });
    expect(r.isError).toBe(true);
    expect(statementCount()).toBe(0);
  });

  test("service.createStatement 直调省略 source ⇒ 抛错（校验落 service 层，§0.3）", () => {
    // 匹配理由，不只匹配"抛了"：createStatement 有四条互不相干的抛出路径，
    // 裸 toThrow() 会被其中任何一条喂绿
    expect(() =>
      svc.createStatement(db, { content: "没写来源的一条", verification: "pending" })
    ).toThrow(/source/i);
  });

  test("create_statements 省略 source ⇒ 拒绝", async () => {
    const r = await call("create_statements", { statements: [{ content: "没写来源的一条" }] });
    expect(r.isError).toBe(true);
    expect(statementCount()).toBe(0);
  });
});

// =============================================================================
// 6：§4.2 是 warning 不是拒绝
// =============================================================================

describe("§9.6：paper: + observed 是 warning 不是拒绝", () => {
  test("paper: tag + source=observed ⇒ 写入成功且带 warning", async () => {
    // 复现场景下这是正确用法：论文自述结果是待检验对象本身
    registerTag("paper:smith2019a");
    const r = await call("create_statements", {
      statements: [
        { content: "论文甲声称准确率 92%", source: "observed", tags: ["paper:smith2019a"] },
      ],
    });
    expect(r.isError).toBe(false);
    expect(statementCount()).toBe(1);
    expect(r.text.toLowerCase()).toContain("warning");
  });

  test("warning 文案是中立陈述，不是祈使句", () => {
    // 写成 "source should be literature" ⇒ 复现用户每建一个核心节点收一条
    // 假警告 ⇒ 几周后学会无视全部 warning ⇒ 通道本身失效
    registerTag("paper:smith2019a");
    return call("create_statements", {
      statements: [{ content: "论文甲声称准确率 92%", source: "observed", tags: ["paper:smith2019a"] }],
    }).then((r) => {
      expect(r.text).not.toMatch(/should be ["']?literature/i);
      expect(r.text).toMatch(/legitimate|both readings|reproduction/i);
    });
  });

  test("paper: tag + source=literature ⇒ 无该 warning", async () => {
    registerTag("paper:smith2019a");
    const att = realAttachment("papers/smith2019a.pdf");
    const r = await call("create_statements", {
      statements: [
        {
          content: "论文甲提出的命题",
          source: "literature",
          tags: ["paper:smith2019a"],
          attachments: [att],
        },
      ],
    });
    expect(r.isError).toBe(false);
    expect(r.text).not.toMatch(/legitimate|both readings/i);
  });

  test("作用域字面写死 paper:，run: + observed 不出该 warning", async () => {
    // 稠密类七个成员里六个的典型 source 就是 observed；
    // 把量词放宽到"稠密命名空间"，等于给实验与复现用户挂一条从未被论证过的 warning
    registerTag("run:0041");
    const r = await call("create_statements", {
      statements: [{ content: "第 41 次运行的输出", source: "observed", tags: ["run:0041"] }],
    });
    expect(r.isError).toBe(false);
    expect(r.text).not.toMatch(/legitimate|both readings/i);
  });
});

// =============================================================================
// 7 / 11：§4.1 硬门 —— literature 必须带附件（两个入口）
// =============================================================================

describe("§9.7 & §9.11：literature 无附件 ⇒ 拒绝", () => {
  test("create_statement（单数）⇒ 拒绝", async () => {
    const r = await call("create_statement", { content: "一条文献命题", source: "literature" });
    expect(r.isError).toBe(true);
    expect(statementCount()).toBe(0);
  });

  test("service.createStatement 直调 ⇒ 抛错", () => {
    // verification 显式给 pending：否则 undefined 会先撞上类型校验，
    // 这条测试就会因为一个与 §4.1 无关的理由变绿
    expect(() =>
      svc.createStatement(db, {
        content: "一条文献命题",
        source: "literature",
        verification: "pending",
        attachments: [],
      })
    ).toThrow(/attachment/i);
  });

  test("create_statements ⇒ 拒绝且零写入", async () => {
    const r = await call("create_statements", {
      statements: [{ content: "一条文献命题", source: "literature" }],
    });
    expect(r.isError).toBe(true);
    expect(statementCount()).toBe(0);
  });

  test("带得上附件就通过（摘要快照也算 —— 充分性归 verify 时判）", async () => {
    const att = realAttachment("papers/abstract-snapshot.md");
    const r = await call("create_statement", {
      content: "一条文献命题",
      source: "literature",
      attachments: [att],
    });
    expect(r.isError).toBe(false);
    expect(statementCount()).toBe(1);
  });

  test("observed 无附件仍然放行（这道门只管 literature）", async () => {
    const r = await call("create_statement", { content: "自己观察到的", source: "observed" });
    expect(r.isError).toBe(false);
  });
});

// =============================================================================
// 8 / 9 / 10：§4.3 路径可解析（三个入口 + 根外 + URL）
// =============================================================================

describe("§9.8–10：附件路径必须能从 review cwd 解析", () => {
  test("8a. 解析不到 ⇒ 拒绝", async () => {
    const r = await call("create_statement", {
      content: "带坏路径的证据",
      source: "observed",
      attachments: ["papers/does-not-exist.pdf"],
    });
    expect(r.isError).toBe(true);
    expect(statementCount()).toBe(0);
  });

  test("8b. 能解析 ⇒ 通过", async () => {
    const att = realAttachment("papers/exists.pdf");
    const r = await call("create_statement", {
      content: "带好路径的证据",
      source: "observed",
      attachments: [att],
    });
    expect(r.isError).toBe(false);
  });

  test("8c. 校验用的 cwd 与 review-sync 用的是同一个 reviewCwd(config)", async () => {
    // 抄第五遍的失效模式是这类修复里最坏的一种：
    // 校验算出的 cwd 与 reviewer 实际用的不一致时，校验放行而 verify 仍失败 —— 假绿校验器
    const mod: any = await import("../src/review-config.ts").catch(() => ({}));
    const fn = mod.reviewCwd ?? (service as any).reviewCwd;
    expect(typeof fn).toBe("function");
    expect(fn(makeReviewConfig())).toBe(workRoot);
  });

  test("8d. 根外绝对路径、文件真实存在 ⇒ 写入成功且带 warning（前提未定，默认取假）", async () => {
    // 前提被 live 探针证真之后，这一例与 §4.3.2、§3.0.1 三处一起改判为拒绝。
    // 本文件不跑那次探针 —— 它要花一次真实 SDK 调用，需用户批准。
    const abs = outOfRootAttachment();
    const r = await call("create_statement", {
      content: "Zotero 库里的论文",
      source: "literature",
      attachments: [abs],
    });
    expect(r.isError).toBe(false);
    expect(r.text.toLowerCase()).toContain("warning");
    rmSync(resolve(abs, ".."), { recursive: true, force: true });
  });

  test("9. 第三个入口：update_node(attachments=[坏路径]) ⇒ 同样拒绝", async () => {
    // 只过第 8 例而第 9 例红，就是"两条入口行为相反"的第三个实例还开着
    const g = makeGround(db, { content: "已有证据", verification: "pending", attachments: [] });
    const r = await call("update_node", { node_id: g.id, attachments: ["nope/x.pdf"] });
    expect(r.isError).toBe(true);
    expect(dataOf(g.id).attachments).toEqual([]);
  });

  test("10a. URL 不作数（创建侧）", async () => {
    const r = await call("create_statement", {
      content: "只给了链接",
      source: "literature",
      attachments: ["https://example.com/x.pdf"],
    });
    expect(r.isError).toBe(true);
  });

  test("10b. URL 不作数（update_node 侧）", async () => {
    const g = makeGround(db, { content: "已有证据", verification: "pending", attachments: [] });
    const r = await call("update_node", {
      node_id: g.id,
      attachments: ["https://example.com/x.pdf"],
    });
    expect(r.isError).toBe(true);
  });
});

// =============================================================================
// 17 / 18：检查块按结果状态判，不按参数出现判
// =============================================================================

describe("§9.17–18：检查块落在结果状态上", () => {
  test("17. update_node(source=\"literature\") 单参数调用、节点无附件 ⇒ 拒绝", async () => {
    // 这条会红在"把 §4.1 挂进 attachments 分支"的实现上 —— 那种实现下本次调用绕过检查
    const g = makeGround(db, {
      content: "一条既有证据",
      source: "observed",
      verification: "pending",
      attachments: [],
    });
    const r = await call("update_node", { node_id: g.id, source: "literature" });
    expect(r.isError).toBe(true);
    expect(dataOf(g.id).source).toBe("observed");
  });

  test("18a. update_node(attachments=[]) 打在已 verified 的节点上 ⇒ 拒绝", async () => {
    // 基准上：零报错、零 warning，产出 verified 且附件为空的 Statement。
    // 一次调用、零信号 —— 比 §3.1 那条残余洞轻重反了，所以两条都要修
    const att = realAttachment("evidence/log.txt");
    const g = makeGround(db, {
      content: "已验证的证据",
      verification: "verified",
      attachments: [att],
    });
    const r = await call("update_node", { node_id: g.id, attachments: [] });
    expect(r.isError).toBe(true);
    expect(dataOf(g.id).attachments).toEqual([att]);
    expect(dataOf(g.id).verification).toBe("verified");
  });

  test("18b. 对照：update_node(attachments=[], verification=\"verified\") 基准上已正确抛错", async () => {
    // 两条一起断言，才能证明修的是"结果状态"而不是"某个参数组合"。
    // 这一条今天就绿 —— H1 读的是 data.attachments，而 data 此时已被 attachments 分支改过
    const att = realAttachment("evidence/log2.txt");
    const g = makeGround(db, {
      content: "另一条证据",
      verification: "pending",
      attachments: [att],
    });
    const r = await call("update_node", {
      node_id: g.id,
      attachments: [],
      verification: "verified",
    });
    expect(r.isError).toBe(true);
  });

  test("18c. 合法的清空：节点是 pending 时可以把 attachments 置空", async () => {
    const att = realAttachment("evidence/log3.txt");
    const g = makeGround(db, {
      content: "待验证据",
      verification: "pending",
      attachments: [att],
    });
    const r = await call("update_node", { node_id: g.id, attachments: [] });
    expect(r.isError).toBe(false);
    expect(dataOf(g.id).attachments).toEqual([]);
  });
});

// =============================================================================
// 12 / 13：tag_nodes
// =============================================================================

describe("§9.12–13：tag_nodes", () => {
  test("12a. 未注册 tag ⇒ 整体拒绝且零写入", async () => {
    registerTag("theme:cache");
    const a = makeGround(db, { content: "证据甲" });
    const b = makeGround(db, { content: "证据乙" });
    const r = await call("tag_nodes", { node_ids: [a.id, b.id], add: ["theme:never"] });
    expect(r.isError).toBe(true);
    const cnt = (db.prepare("SELECT count(*) c FROM node_tags").get() as any).c;
    expect(cnt).toBe(0);
  });

  test("12b. 不存在的 node_id ⇒ 其余成功、失败 id 列出", async () => {
    registerTag("theme:cache");
    const a = makeGround(db, { content: "证据甲" });
    const r = await call("tag_nodes", { node_ids: [a.id, 99999], add: ["theme:cache"] });
    expect(r.text).toContain("99999");
    const cnt = (
      db.prepare("SELECT count(*) c FROM node_tags WHERE node_id = ?").get(a.id) as any
    ).c;
    expect(cnt).toBe(1);
  });

  test("13. 打 tag 不失效 compile", async () => {
    registerTag("theme:cache");
    const g = makeGround(db, { content: "证据" });
    const c = makeClaim(db, "一条主张");
    makeWarrant(db, c.id, [g.id], "理由");
    repo.saveCompileState(db, c.id, "passed", "");

    const r = await call("tag_nodes", { node_ids: [g.id], add: ["theme:cache"] });
    expect(r.isError).toBe(false);
    expect(compileVerdictOf(db, c.id)).toBe("passed");
    expect(dataOf(c.id).status).not.toBe("proposed_by_invalidation");
  });

  test("上限 200：201 个 node_id 被拒", async () => {
    registerTag("theme:cache");
    const ids = Array.from({ length: 201 }, (_, i) => i + 1);
    const r = await call("tag_nodes", { node_ids: ids, add: ["theme:cache"] });
    expect(r.isError).toBe(true);
  });
});

// =============================================================================
// 14 / 15 / 19 / 20 / 21：verify_statements
// =============================================================================

describe("§9.14–15 & 19–21：verify_statements", () => {
  /** 注入式替换审查实现 —— 不起真实会话。 */
  function stubReview(impl: (id: number) => any): void {
    mock.module("../src/review-sync.ts", () => ({
      executeStatementReview: async (_cfg: any, _db: any, id: number) => impl(id),
      reviewStatementEvidencePreCreate: async () => ({ errors: [], warnings: [] }),
      saveStatementReviewFile: () => {},
    }));
  }

  function seedPending(n: number): number[] {
    const att = realAttachment("evidence/shared.txt");
    return Array.from({ length: n }, (_, i) =>
      makeGround(db, {
        content: `待验证据 ${i}`,
        verification: "pending",
        attachments: [att],
      }).id
    );
  }

  test("14. 部分失败：通过的置 verified、失败的仍 pending，带进度行与可分类原因", async () => {
    const ids = seedPending(3);
    stubReview((id) =>
      id === ids[2]
        ? { errors: ["attachment content does not support the statement"], warnings: [] }
        : { errors: [], warnings: [] }
    );
    const r = await call("verify_statements", { ids });
    expect(dataOf(ids[0]).verification).toBe("verified");
    expect(dataOf(ids[1]).verification).toBe("verified");
    expect(dataOf(ids[2]).verification).toBe("pending");
    expect(r.text).toMatch(/Verified 2\/3/);
    expect(r.text).toContain("does not support");
  });

  test("15. 并发上限 ≤ 4", async () => {
    const ids = seedPending(12);
    let inFlight = 0;
    let peak = 0;
    stubReview(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((res) => setTimeout(res, 5));
      inFlight--;
      return { errors: [], warnings: [] };
    });
    await call("verify_statements", { ids });
    expect(peak).toBeLessThanOrEqual(4);
  });

  test("19a. 审查自身出错 ⇒ 仍 pending、报 review errored、不计入 Verified N/M", async () => {
    const ids = seedPending(3);
    stubReview((id) => {
      if (id === ids[1]) throw new Error("SDK timeout");
      return { errors: [], warnings: [] };
    });
    const r = await call("verify_statements", { ids });
    expect(dataOf(ids[1]).verification).toBe("pending");
    expect(r.text).toContain("review errored");
    expect(r.text).toMatch(/Verified 2\/3/);
  });

  test("19b. 第三种结局与「审查判定不通过」分开计数（处方相反）", async () => {
    // 第二种：这条证据有问题，去修 Statement 或换候选
    // 第三种：这次审查没做成，重试即可，Statement 本身还未被评价
    const ids = seedPending(3);
    stubReview((id) => {
      if (id === ids[0]) throw new Error("SDK timeout");
      if (id === ids[1]) return { errors: ["evidence mismatch"], warnings: [] };
      return { errors: [], warnings: [] };
    });
    const r = await call("verify_statements", { ids });
    const errored = r.text.match(/review errored/g)?.length ?? 0;
    expect(errored).toBe(1);
    expect(r.text).toContain("evidence mismatch");
    // 两类不得合并成一个数字
    expect(r.text).not.toMatch(/2 failed(?!.*errored)/);
  });

  test("20. deniedTools 非空视为审查失败（注入式，不依赖 SDK 语义）", async () => {
    // 断言的是接线，不是 SDK 语义 —— "dontAsk 下根外 Read 会不会被拒"
    // 是一条静态判不出来的前提，依赖它这一例会随 SDK 版本变红变绿
    const ids = seedPending(1);
    stubReview(() => ({ errors: [], warnings: [], deniedTools: ["Read"] }));
    const r = await call("verify_statements", { ids });
    expect(dataOf(ids[0]).verification).toBe("pending");
    expect(r.text).toContain("review errored");
  });

  test("19c. 审查以返回值报告基础设施失败（而非抛出）⇒ 同样不得置 verified", async () => {
    // 真实的 executeStatementReview 不抛 —— 它内部 catch 之后把失败放进返回值。
    // 消费侧只看 errors.length 时，一次「审查根本没做成」的返回（errors 为空）
    // 会一路走到成功分支被置 verified：花了钱、没拿到证据、图上与真通过同形
    const ids = seedPending(2);
    stubReview((id) =>
      id === ids[0]
        ? { errors: [], warnings: [], reviewError: "SDK timeout" }
        : { errors: [], warnings: [] }
    );
    const r = await call("verify_statements", { ids });
    expect(dataOf(ids[0]).verification).toBe("pending");
    expect(dataOf(ids[1]).verification).toBe("verified");
    expect(r.text).toContain("review errored");
    expect(r.text).toMatch(/Verified 1\/2/);
  });

  test("21. 提交前复查路径：创建后文件被挪走 ⇒ 可分类的 per-item 错误", async () => {
    const att = realAttachment("evidence/will-move.txt");
    const g = makeGround(db, {
      content: "证据会被挪走",
      verification: "pending",
      attachments: [att],
    });
    rmSync(join(workRoot, att), { force: true });
    expect(existsSync(join(workRoot, att))).toBe(false);

    let reviewCalled = false;
    stubReview(() => {
      reviewCalled = true;
      return { errors: [], warnings: [] };
    });
    const r = await call("verify_statements", { ids: [g.id] });
    expect(dataOf(g.id).verification).toBe("pending");
    expect(r.text).toMatch(/does not resolve|not found|missing/i);
    expect(reviewCalled).toBe(false); // 复查在提交审查之前，省掉一次昂贵调用
  });
});

// =============================================================================
// 19 的单条入口一半 —— 不门控，锁 tools.ts 的空 catch
// =============================================================================

describe("§9.19：单条入口的空 catch", () => {
  test("update_node(verification=\"verified\") 在审查抛异常时不得留下 verified", async () => {
    mock.module("../src/review-sync.ts", () => ({
      executeStatementReview: async () => {
        throw new Error("SDK timeout");
      },
      reviewStatementEvidencePreCreate: async () => ({ errors: [], warnings: [] }),
      saveStatementReviewFile: () => {},
    }));
    const att = realAttachment("evidence/single.txt");
    const g = makeGround(db, {
      content: "单条入口的证据",
      verification: "pending",
      attachments: [att],
    });
    const r = await call("update_node", { node_id: g.id, verification: "verified" });
    expect(dataOf(g.id).verification).toBe("pending");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/review errored/i);
  });

  test("单条入口：审查以返回值报告基础设施失败时同样不得留下 verified", async () => {
    // 真实实现不抛，它把失败放进返回值。只看 errors.length 的消费侧会把
    // 「审查根本没做成」当成一次干净通过 —— 这条锁的是那半段
    mock.module("../src/review-sync.ts", () => ({
      executeStatementReview: async () => ({ errors: [], warnings: [], reviewError: "SDK timeout" }),
      reviewStatementEvidencePreCreate: async () => ({ errors: [], warnings: [] }),
      saveStatementReviewFile: () => {},
    }));
    const att = realAttachment("evidence/single2.txt");
    const g = makeGround(db, {
      content: "另一条单条入口的证据",
      verification: "pending",
      attachments: [att],
    });
    const r = await call("update_node", { node_id: g.id, verification: "verified" });
    expect(dataOf(g.id).verification).toBe("pending");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/review errored/i);
  });
});

// =============================================================================
// 16：create_warrant(backing_ids=)
// =============================================================================

describe("§9.16：create_warrant 加 backing_ids", () => {
  test(
    "建时挂 Backing，该 Claim 不因此额外失效一次",
    async () => {
      // compile 之前挂：零成本。compile 之后挂：整条祖先链 × (2+N) 次 LLM 调用重跑
      const c = makeClaim(db, "一条主张");
      const g = makeGround(db, { content: "证据" });
      const b = makeGround(db, { content: "支撑" });
      const r = await call("create_warrant", {
        claim_id: c.id,
        content: "理由",
        ground_ids: [g.id],
        backing_ids: [b.id],
      });
      expect(r.isError).toBe(false);
      const w = repo.findWarrantsByClaim(db, c.id)[0];
      const backings = repo.findBackingsByWarrant(db, w.id);
      expect(backings.map((x) => x.id)).toEqual([b.id]);
      expect(r.text).not.toMatch(/invalidat/i); // 此时还没 compile 过，不该报失效
    }
  );
});

// =============================================================================
// update_tag（§6）
// =============================================================================

describe("§6：update_tag", () => {
  test("改描述", async () => {
    registerTag("paper:smith2019a");
    const r = await call("update_tag", {
      name: "paper:smith2019a",
      description: "读了全文之后判定该排除",
    });
    expect(r.isError).toBe(false);
    const tag = tagRepo.listTagsWithCount(db).find((t: any) => t.name === "paper:smith2019a");
    expect(tag.description).toContain("该排除");
  });

  test("回填 claim_id —— 这个指针是「该类目已综合」的恢复信号", async () => {
    registerTag("theme:cache");
    const c = makeClaim(db, "缓存类目的综合主张");
    const r = await call("update_tag", { name: "theme:cache", claim_id: c.id });
    expect(r.isError).toBe(false);
    const tag = tagRepo.listTagsWithCount(db).find((t: any) => t.name === "theme:cache");
    expect(tag.claim_id).toBe(c.id);
  });

  test("不存在的 tag ⇒ 报错", async () => {
    const r = await call("update_tag", { name: "theme:never", description: "x" });
    expect(r.isError).toBe(true);
  });

  test("update_tag 不失效 compile", async () => {
    registerTag("theme:cache");
    const c = makeClaim(db, "一条主张");
    const g = makeGround(db, { content: "证据" });
    makeWarrant(db, c.id, [g.id], "理由");
    repo.saveCompileState(db, c.id, "passed", "");
    await call("update_tag", { name: "theme:cache", claim_id: c.id });
    expect(compileVerdictOf(db, c.id)).toBe("passed");
  });
});

// =============================================================================
// §8：工具数
// =============================================================================

describe("§8：工具注册", () => {
  test(
    "PR1 + PR3 全部落地后共 21 个工具",
    () => {
      expect(Object.keys(tools).length).toBe(21);
    }
  );
});

// =============================================================================
// 回归：批量入口的 tag 校验必须走同一个 assertTagsRegistered
// =============================================================================

describe("回归：批量 tag 校验的近似建议", () => {
  // 近似建议是词表一致性机制的核心。批量入口自己手搓一遍存在性检查，
  // 报的是裸的 `Tag "x" is not registered.` —— 检查"过了没有"这一位是对的，
  // 而 agent 拿不到"你是不是想写 theme:cache"，于是继续注册第二个近义 tag。
  test("create_statements 的未注册 tag 报错带近似建议", async () => {
    registerTag("theme:cache");
    const r = await call("create_statements", {
      statements: [{ content: "一条", source: "observed", tags: ["theme:caches"] }],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Similar existing");
    expect(r.text).toContain("theme:cache");
    expect(r.text).toContain("create_tag");
    expect(statementCount()).toBe(0);
  });

  test("tag_nodes 的未注册 tag 报错带近似建议", async () => {
    registerTag("theme:cache");
    const g = makeGround(db, { content: "证据" });
    const r = await call("tag_nodes", { node_ids: [g.id], add: ["theme:caches"] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Similar existing");
    expect(r.text).toContain("theme:cache");
    expect((db.prepare("SELECT count(*) c FROM node_tags").get() as any).c).toBe(0);
  });
});

// =============================================================================
// 回归：validate-all 必须跑完每条校验，不能把一部分漏给写入阶段
// =============================================================================

describe("回归：validate-all 的完整性（§2.2 第 1 条）", () => {
  test("content 为空的一条也要在校验阶段点名 item[i]，且与其它失败一并列出", async () => {
    // 校验阶段只查了 source / tag / §4.1 / §4.3 时，content 为空要到写入阶段
    // 才被 service.createStatement 抛出 —— 那时事务回滚、异常直奔外层 catch，
    // 返回文本退化成一条没有下标的裸消息，其余失败项一条都没报。
    // 「原子 = 可预测的重试单元」的前提就是一次报告列全所有问题。
    registerTag("theme:cache");
    const r = await call("create_statements", {
      statements: [
        { content: "好的一条", source: "observed", tags: ["theme:cache"] },
        { content: "   ", source: "observed" },
        { content: "另一条", source: "observed", tags: ["theme:never-registered"] },
      ],
    });
    expect(r.isError).toBe(true);
    expect(statementCount()).toBe(0);
    expect(r.text).toContain("item[1]");
    expect(r.text).toContain("item[2]");
    expect(r.text).toMatch(/2 of 3 items failed/);
  });

  test("verification 取值非法同样在校验阶段点名", async () => {
    const r = await call("create_statements", {
      statements: [
        { content: "甲", source: "observed" },
        { content: "乙", source: "observed", verification: "maybe" },
      ],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("item[1]");
    expect(statementCount()).toBe(0);
  });
});

// =============================================================================
// 回归：根外判定按解析结果算，不按「以 / 开头」算
// =============================================================================

describe("回归：根外附件的判定与告警面（§4.3.2）", () => {
  test("根内的绝对路径不得报根外 warning", async () => {
    // 按 `p.startsWith('/')` 判根外，等于给每一个根内绝对路径挂一条假警告 ——
    // 与「近似检查跳过稠密命名空间」同一条原则：warning 变噪音之后通道本身失效
    const rel = realAttachment("papers/inside.pdf");
    const abs = join(workRoot, rel);
    const r = await call("create_statement", {
      content: "根内绝对路径",
      source: "literature",
      attachments: [abs],
    });
    expect(r.isError).toBe(false);
    expect(r.text.toLowerCase()).not.toContain("outside the review working directory");
  });

  test("批量入口同样给出根外 warning，不是只有单条入口给", async () => {
    const abs = outOfRootAttachment();
    const r = await call("create_statements", {
      statements: [{ content: "Zotero 库里的论文", source: "literature", attachments: [abs] }],
    });
    expect(r.isError).toBe(false);
    expect(statementCount()).toBe(1);
    expect(r.text.toLowerCase()).toContain("outside the review working directory");
    rmSync(resolve(abs, ".."), { recursive: true, force: true });
  });
});

// =============================================================================
// 回归：§4.1 落地后 hints 不得再说「无附件的 pending literature 是常态」
// =============================================================================

describe("回归：groundPendingLiterature 文案（§4.1.1）", () => {
  test("pending literature 的提示语不再教人「去补附件才能标 verified」", async () => {
    // §4.1 之后 literature 建节点时附件已经是硬性前提，此刻还缺的是审查而非归档。
    // 这条 hint 是三处成文承诺里唯一在创建当下、在上下文里说话的一处 ——
    // 留着它，用户跟的是当场提示，不是参数描述
    const att = realAttachment("papers/snapshot.md");
    const r = await call("create_statement", {
      content: "一条文献命题",
      source: "literature",
      attachments: [att],
    });
    expect(r.isError).toBe(false);
    expect(r.text).not.toMatch(/To mark it verified, attach the source file/i);
    expect(r.text).toMatch(/verify_statements|not yet reviewed/i);
  });
});


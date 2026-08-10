/**
 * Toulmin MCP — MCP 工具集成测试
 *
 * 通过 mock server 测试工具注册、参数校验和输出格式。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import { createTestDb, cleanupDb, makeClaim, makeGround, makeWarrant, makeBacking, makeRebuttal, makeCompiledClaim, seedBasicArgument } from "./helpers.ts";
import { registerTools } from "../src/tools.ts";
import type { ReviewConfig } from "../src/review-config.ts";
import * as repo from "../src/repo.ts";

let db: Database;
let tools: Record<string, { schema: any; handler: Function }>;

// Mock MCP server
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
// 工具注册验证
// =============================================================================

describe("工具注册", () => {
  test("注册了 21 个工具", () => {
    expect(Object.keys(tools).length).toBe(21);
  });

  test("所有必需工具已注册", () => {
    const expected = [
      "create_claim", "create_statement", "create_warrant",
      "list_claims", "list_statements", "get_argument", "get_node", "search_nodes",
      "get_stats", "update_node", "delete_node",
      "compile_arguments",
      "create_tag", "create_tags", "list_tags", "rename_tag", "merge_tags",
    ];
    for (const name of expected) {
      expect(tools[name]).toBeTruthy();
    }
  });
});

// =============================================================================
// create_claim 工具
// =============================================================================

describe("create_claim 工具", () => {
  test("成功创建并返回文本", async () => {
    const result = await tools.create_claim.handler({ content: "测试主张" });
    expect(result.content[0].text).toContain("Created claim #1");
  });

  test("空 content 返回错误文本", async () => {
    const result = await tools.create_claim.handler({ content: "" });
    expect(result.isError).toBe(true);
  });
});

// =============================================================================
// create_statement 工具
// =============================================================================

describe("create_statement 工具", () => {
  test("Mode A 成功创建", async () => {
    const result = await tools.create_statement.handler({
      content: "实验数据",
      source: "observed",
      verification: "verified",
      attachments: ["/data.csv"],
    });
    expect(result.content[0].text).toContain("Created statement #1");
  });

  test("source='hypothesis' 被 zod schema 拒绝（clean validation error, 非异常）", () => {
    const schema = z.object(tools.create_statement.schema);
    const result = schema.safeParse({ content: "实验数据", source: "hypothesis" });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// create_warrant 工具
// =============================================================================

describe("create_warrant 工具", () => {
  test("成功创建", async () => {
    const claim = makeClaim(db);
    const ground = makeGround(db);
    const result = await tools.create_warrant.handler({
      claim_id: claim.id,
      content: "推理规则",
      ground_ids: [ground.id],
    });
    expect(result.content[0].text).toContain("Created warrant");
  });

  test("claim_id 不存在返回错误", async () => {
    const result = await tools.create_warrant.handler({
      claim_id: 999,
      content: "规则",
    });
    expect(result.isError).toBe(true);
  });
});

// =============================================================================
// list_claims 工具
// =============================================================================

describe("list_claims 工具", () => {
  test("空数据库返回提示", async () => {
    const result = await tools.list_claims.handler({});
    expect(result.content[0].text).toContain("No claims found");
  });

  test("返回格式化列表", async () => {
    makeClaim(db, "主张A");
    makeClaim(db, "主张B");
    const result = await tools.list_claims.handler({});
    expect(result.content[0].text).toContain("主张A");
    expect(result.content[0].text).toContain("主张B");
  });

  test("按 status 过滤", async () => {
    makeClaim(db, "C1", "proposed");
    makeClaim(db, "C2", "supported");
    const result = await tools.list_claims.handler({ status: "supported" });
    expect(result.content[0].text).toContain("C2");
    expect(result.content[0].text).not.toContain("C1");
  });
});

// =============================================================================
// get_argument 工具
// =============================================================================

describe("get_argument 工具", () => {
  test("返回完整论证结构", async () => {
    const claim = makeClaim(db, "核心主张");
    const ground = makeGround(db, { content: "证据" });
    makeWarrant(db, claim.id, [ground.id], "推理规则");

    const result = await tools.get_argument.handler({ node_id: claim.id });
    expect(result.content[0].text).toContain("核心主张");
    expect(result.content[0].text).toContain("推理规则");
    expect(result.content[0].text).toContain("证据");
  });

  test("不存在节点返回错误", async () => {
    const result = await tools.get_argument.handler({ node_id: 999 });
    expect(result.isError).toBe(true);
  });
});

// =============================================================================
// get_stats 工具
// =============================================================================

describe("get_stats 工具", () => {
  test("返回统计信息", async () => {
    makeClaim(db, "C1");
    makeGround(db, { content: "G1" });
    const result = await tools.get_stats.handler({});
    expect(result.content[0].text).toContain("Claims: 1");
    expect(result.content[0].text).toContain("Grounds: 1");
  });
});

// =============================================================================
// search_nodes 工具
// =============================================================================

describe("search_nodes 工具", () => {
  test("搜索返回匹配结果", async () => {
    makeClaim(db, "ScaleOpt 优化器");
    const result = await tools.search_nodes.handler({ keyword: "ScaleOpt" });
    expect(result.content[0].text).toContain("ScaleOpt");
  });

  test("无匹配返回提示", async () => {
    const result = await tools.search_nodes.handler({ keyword: "不存在" });
    expect(result.content[0].text).toContain("No matching nodes");
  });
});

// =============================================================================
// update_node 工具
// =============================================================================

describe("update_node 工具", () => {
  test("更新成功", async () => {
    const claim = makeClaim(db, "原始");
    const result = await tools.update_node.handler({
      node_id: claim.id,
      content: "更新后",
    });
    expect(result.content[0].text).toContain("Updated");
  });

  test("source='hypothesis' 被 zod schema 拒绝（clean validation error, 非异常）", () => {
    const schema = z.object(tools.update_node.schema);
    const result = schema.safeParse({ node_id: 1, source: "hypothesis" });
    expect(result.success).toBe(false);
  });

  test("更新不存在节点返回错误", async () => {
    const result = await tools.update_node.handler({
      node_id: 999,
      content: "x",
    });
    expect(result.isError).toBe(true);
  });
});

// =============================================================================
// delete_node 工具
// =============================================================================

describe("delete_node 工具", () => {
  test("删除成功", async () => {
    const claim = makeClaim(db);
    const ground = makeGround(db);
    const result = await tools.delete_node.handler({ node_id: ground.id, cascade: false });
    expect(result.content[0].text).toContain("Deleted");
  });

  test("删除 Claim 无 cascade 返回错误", async () => {
    const claim = makeClaim(db);
    const result = await tools.delete_node.handler({ node_id: claim.id, cascade: false });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("cascade");
  });
});

// =============================================================================
// compile_arguments 工具
// =============================================================================

describe("compile_arguments 工具", () => {
  test("未配置 reviewConfig 时返回错误", async () => {
    const result = await tools.compile_arguments.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Review not configured");
  });

  test("有 reviewConfig 但无 Claim 时返回提示", async () => {
    const fakeConfig: ReviewConfig = {
      enabled: true,
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      apiKey: "sk-fake",
      debounceMs: 0,
      maxTurns: 1,
      reviewDir: "/tmp",
      auditDir: null,
      dbPath: ":memory:",
    };
    const db2 = createTestDb();
    const server2 = createMockServer();
    registerTools(server2, db2, fakeConfig);
    const result = await server2._tools.compile_arguments.handler({});
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("No claims to compile");
    cleanupDb(db2);
  });
});

// =============================================================================
// get_argument 工具 — stale 标识
// =============================================================================

describe("get_argument 工具 — stale 标识", () => {
  test("stale Claim 的输出包含 STALE 标识", async () => {
    const claim = makeClaim(db, "核心主张");
    repo.setCompileStatus(db, claim.id, "stale");

    const result = await tools.get_argument.handler({ node_id: claim.id });
    expect(result.content[0].text).toContain("⚠ STALE");
    expect(result.content[0].text).toContain("compile_arguments");
  });

  test("非 stale Claim 的输出不含 STALE 标识", async () => {
    const claim = makeClaim(db, "核心主张");
    const result = await tools.get_argument.handler({ node_id: claim.id });
    expect(result.content[0].text).not.toContain("⚠ STALE");
  });
});

// =============================================================================
// get_stats 工具 — stale_count
// =============================================================================

describe("get_stats 工具 — stale_count", () => {
  test("无 stale Claim 时统计不含 stale 后缀", async () => {
    makeClaim(db, "C1");
    const result = await tools.get_stats.handler({});
    expect(result.content[0].text).toContain("Claims: 1");
    expect(result.content[0].text).not.toContain("stale");
  });

  test("有 stale Claim 时统计含 stale 后缀", async () => {
    const claim = makeClaim(db, "C1");
    repo.setCompileStatus(db, claim.id, "stale");

    const result = await tools.get_stats.handler({});
    expect(result.content[0].text).toContain("Claims: 1 (1 stale)");
  });
});

// =============================================================================
// mutation 工具 — compile hint
// =============================================================================

describe("mutation 工具 — compile hint", () => {
  test("create_warrant 对 compiled Claim 返回 compile 提示", async () => {
    const claim = makeCompiledClaim(db, "已 compiled 的主张");
    const ground = makeGround(db);
    const result = await tools.create_warrant.handler({
      claim_id: claim.id,
      content: "新推理规则",
      ground_ids: [ground.id],
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("compile_arguments");
  });

  test("create_warrant 对非 compiled Claim 无 compile 提示", async () => {
    const claim = makeClaim(db, "非 compiled 主张");
    const ground = makeGround(db);
    const result = await tools.create_warrant.handler({
      claim_id: claim.id,
      content: "推理规则",
      ground_ids: [ground.id],
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toContain("compile_arguments");
  });

  test("delete_node 删除 compiled Claim 的 Ground 时返回 compile 提示", async () => {
    const claim = makeCompiledClaim(db, "已 compiled 的主张");
    const g1 = makeGround(db, { content: "G1" });
    const g2 = makeGround(db, { content: "G2" });
    makeWarrant(db, claim.id, [g1.id, g2.id]);

    const result = await tools.delete_node.handler({ node_id: g1.id, cascade: false });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("compile_arguments");
  });
});

// =============================================================================
// invalidateCompiledClaims — status reversion
// =============================================================================

describe("invalidateCompiledClaims — status reversion", () => {
  test("supported Claim reverts to proposed when argument chain mutated", async () => {
    const claim = makeCompiledClaim(db, "Supported claim");
    const claimData = JSON.parse(
      (db.prepare("SELECT data FROM nodes WHERE id = ?").get(claim.id) as { data: string }).data
    );
    claimData.status = "supported";
    db.prepare("UPDATE nodes SET data = ? WHERE id = ?").run(JSON.stringify(claimData), claim.id);

    const ground = makeGround(db);
    makeWarrant(db, claim.id, [ground.id]);

    const result = await tools.update_node.handler({ node_id: ground.id, content: "Modified ground" });

    expect(result.content[0].text).toContain('reverted from "supported" to "proposed"');
    const row = db.prepare("SELECT data FROM nodes WHERE id = ?").get(claim.id) as { data: string };
    expect(JSON.parse(row.data).status).toBe("proposed");
  });

  test("disputed Claim reverts to proposed when argument chain mutated", async () => {
    const claim = makeCompiledClaim(db, "Disputed claim");
    const claimData = JSON.parse(
      (db.prepare("SELECT data FROM nodes WHERE id = ?").get(claim.id) as { data: string }).data
    );
    claimData.status = "disputed";
    db.prepare("UPDATE nodes SET data = ? WHERE id = ?").run(JSON.stringify(claimData), claim.id);

    const ground = makeGround(db);
    makeWarrant(db, claim.id, [ground.id]);

    const result = await tools.update_node.handler({ node_id: ground.id, content: "Modified ground" });

    expect(result.content[0].text).toContain('reverted from "disputed" to "proposed"');
    const row = db.prepare("SELECT data FROM nodes WHERE id = ?").get(claim.id) as { data: string };
    expect(JSON.parse(row.data).status).toBe("proposed");
  });

  test("refuted Claim reverts to proposed when argument chain mutated", async () => {
    const claim = makeCompiledClaim(db, "Refuted claim");
    const claimData = JSON.parse(
      (db.prepare("SELECT data FROM nodes WHERE id = ?").get(claim.id) as { data: string }).data
    );
    claimData.status = "refuted";
    db.prepare("UPDATE nodes SET data = ? WHERE id = ?").run(JSON.stringify(claimData), claim.id);

    const ground = makeGround(db);
    makeWarrant(db, claim.id, [ground.id]);

    const result = await tools.update_node.handler({ node_id: ground.id, content: "Modified ground" });

    expect(result.content[0].text).toContain('reverted from "refuted" to "proposed"');
    const row = db.prepare("SELECT data FROM nodes WHERE id = ?").get(claim.id) as { data: string };
    expect(JSON.parse(row.data).status).toBe("proposed");
  });

  test("proposed Claim does NOT produce reversion warning", async () => {
    const claim = makeCompiledClaim(db, "Proposed claim");
    const ground = makeGround(db);
    makeWarrant(db, claim.id, [ground.id]);

    const result = await tools.update_node.handler({ node_id: ground.id, content: "Modified ground" });

    expect(result.content[0].text).toContain("compiled status has been cleared");
    expect(result.content[0].text).not.toContain("reverted from");
  });

  test("status reversion and compile invalidation both appear in output", async () => {
    const claim = makeCompiledClaim(db, "Full test claim");
    const claimData = JSON.parse(
      (db.prepare("SELECT data FROM nodes WHERE id = ?").get(claim.id) as { data: string }).data
    );
    claimData.status = "supported";
    db.prepare("UPDATE nodes SET data = ? WHERE id = ?").run(JSON.stringify(claimData), claim.id);

    const ground = makeGround(db);
    makeWarrant(db, claim.id, [ground.id]);

    const result = await tools.update_node.handler({ node_id: ground.id, content: "Modified" });

    expect(result.content[0].text).toContain("compiled status has been cleared");
    expect(result.content[0].text).toContain("reverted from");
    expect(result.content[0].text).toContain("compile_arguments");
  });
});

// =============================================================================
// list_statements 工具
// =============================================================================

describe("list_statements 工具", () => {
  test("空数据库返回 'No statements found.'", async () => {
    const result = await tools.list_statements.handler({});
    expect(result.content[0].text).toBe("No statements found.");
  });

  test("无过滤返回所有 statement，格式含 [source/verification]", async () => {
    makeGround(db, { content: "实验数据", source: "observed", verification: "verified" });
    makeGround(db, { content: "文献引用", source: "literature", verification: "pending" });
    const result = await tools.list_statements.handler({});
    const text = result.content[0].text;
    expect(text).toContain("[observed/verified]");
    expect(text).toContain("实验数据");
    expect(text).toContain("[literature/pending]");
    expect(text).toContain("文献引用");
  });

  test("输出行以 '#N ' 开头", async () => {
    makeGround(db, { content: "G1", source: "observed", verification: "verified" });
    const result = await tools.list_statements.handler({});
    expect(result.content[0].text).toMatch(/^#\d+ \[/);
  });

  test("source 过滤只返回匹配行", async () => {
    makeGround(db, { content: "G-obs", source: "observed", verification: "verified" });
    makeGround(db, { content: "G-lit", source: "literature", verification: "verified" });
    const result = await tools.list_statements.handler({ source: "literature" });
    const text = result.content[0].text;
    expect(text).toContain("G-lit");
    expect(text).not.toContain("G-obs");
  });

  test("source 逗号多值过滤，且排除无 source 字段的 statement（backing）", async () => {
    makeGround(db, { content: "G-obs", source: "observed", verification: "verified" });
    makeGround(db, { content: "G-lit", source: "literature", verification: "verified" });
    makeGround(db, { content: "G-pending", source: "observed", verification: "pending" });
    const claim = makeClaim(db, "Claim");
    const warrant = makeWarrant(db, claim.id, []);
    makeBacking(db, warrant.id, "B-no-source");
    const result = await tools.list_statements.handler({ source: "literature,observed" });
    const text = result.content[0].text;
    expect(text).toContain("G-obs");
    expect(text).toContain("G-lit");
    expect(text).toContain("G-pending");
    expect(text).not.toContain("B-no-source");
  });

  test("verification 过滤", async () => {
    makeGround(db, { content: "G-v", source: "observed", verification: "verified" });
    makeGround(db, { content: "G-p", source: "observed", verification: "pending" });
    const result = await tools.list_statements.handler({ verification: "pending" });
    const text = result.content[0].text;
    expect(text).toContain("G-p");
    expect(text).not.toContain("G-v");
  });

  test("source + verification AND 组合", async () => {
    makeGround(db, { content: "G-lit-v", source: "literature", verification: "verified" });
    makeGround(db, { content: "G-lit-p", source: "literature", verification: "pending" });
    makeGround(db, { content: "G-obs-v", source: "observed", verification: "verified" });
    const result = await tools.list_statements.handler({ source: "literature", verification: "verified" });
    const text = result.content[0].text;
    expect(text).toContain("G-lit-v");
    expect(text).not.toContain("G-lit-p");
    expect(text).not.toContain("G-obs-v");
  });

  test("无效 source 值返回 'No statements found.'", async () => {
    makeGround(db, { content: "G1", source: "observed", verification: "verified" });
    const result = await tools.list_statements.handler({ source: "invalid_source" });
    expect(result.content[0].text).toBe("No statements found.");
  });
});

// =============================================================================
// list_claims 工具 — formatNodeLine 重构后格式不变
// =============================================================================

describe("list_claims 工具 — formatNodeLine 重构后格式验证", () => {
  test("输出格式为 '#N [status] content'", async () => {
    makeClaim(db, "主张文本", "proposed");
    const result = await tools.list_claims.handler({});
    expect(result.content[0].text).toMatch(/^#\d+ \[proposed\] 主张文本/);
  });
});

// =============================================================================
// get_node 工具
// =============================================================================

describe("get_node 工具", () => {
  test("不存在节点返回 isError", async () => {
    const result = await tools.get_node.handler({ node_id: 999 });
    expect(result.isError).toBe(true);
  });

  test("claim 无 qualifier 时输出含 compile_status: null，不含 qualifier 行", async () => {
    const claim = makeClaim(db, "无 qualifier 的主张");
    const result = await tools.get_node.handler({ node_id: claim.id });
    const text = result.content[0].text;
    expect(text).toContain("compile_status: null");
    expect(text).not.toContain("qualifier:");
  });

  test("claim 有 qualifier 时输出含 qualifier 行", async () => {
    const claim = makeClaim(db, "有 qualifier 的主张");
    // Set qualifier directly
    const row = db.prepare("SELECT data FROM nodes WHERE id = ?").get(claim.id) as { data: string };
    const data = JSON.parse(row.data);
    data.qualifier = "仅在图像分类任务上验证";
    db.prepare("UPDATE nodes SET data = ? WHERE id = ?").run(JSON.stringify(data), claim.id);

    const result = await tools.get_node.handler({ node_id: claim.id });
    const text = result.content[0].text;
    expect(text).toContain("qualifier: 仅在图像分类任务上验证");
  });

  test("ground attachments 为空时输出 attachments: []", async () => {
    const ground = makeGround(db, { content: "无附件的证据", attachments: [] });
    const result = await tools.get_node.handler({ node_id: ground.id });
    const text = result.content[0].text;
    expect(text).toContain("attachments: []");
  });

  test("ground attachments 非空时逐行输出", async () => {
    const ground = makeGround(db, {
      content: "有附件的证据",
      attachments: ["/data/exp1.csv", "/data/exp2.csv"],
    });
    const result = await tools.get_node.handler({ node_id: ground.id });
    const text = result.content[0].text;
    expect(text).toContain("/data/exp1.csv");
    expect(text).toContain("/data/exp2.csv");
  });

  test("ground ref_claim_id 为 null 时不输出 ref_claim_id 行", async () => {
    const ground = makeGround(db, { content: "普通证据" });
    const result = await tools.get_node.handler({ node_id: ground.id });
    const text = result.content[0].text;
    expect(text).not.toContain("ref_claim_id:");
  });

  test("warrant ground_ids 输出为 [id1, id2] 格式", async () => {
    const claim = makeClaim(db, "主张");
    const g1 = makeGround(db, { content: "G1" });
    const g2 = makeGround(db, { content: "G2" });
    const warrant = makeWarrant(db, claim.id, [g1.id, g2.id], "推理规则");

    const result = await tools.get_node.handler({ node_id: warrant.id });
    const text = result.content[0].text;
    expect(text).toContain(`ground_ids: [${g1.id}, ${g2.id}]`);
  });

  test("backing 输出含 warrant_id 和 attachments", async () => {
    const claim = makeClaim(db, "主张");
    const warrant = makeWarrant(db, claim.id, [], "推理规则");
    const backing = makeBacking(db, warrant.id, "支撑材料", ["/papers/ref.pdf"]);

    const result = await tools.get_node.handler({ node_id: backing.id });
    const text = result.content[0].text;
    expect(text).toContain(`warrant_id: ${warrant.id}`);
    expect(text).toContain("/papers/ref.pdf");
  });

  test("rebuttal 输出含 target_type/target_id/attachments", async () => {
    const claim = makeClaim(db, "主张");
    const rebuttal = makeRebuttal(db, claim.id, "claim", "反驳内容", ["/rebuttal/doc.pdf"]);

    const result = await tools.get_node.handler({ node_id: rebuttal.id });
    const text = result.content[0].text;
    expect(text).toContain("target_type: claim");
    expect(text).toContain(`target_id: ${claim.id}`);
    expect(text).toContain("/rebuttal/doc.pdf");
  });
});

// =============================================================================
// create_statement — literature 跳过定义审查
// =============================================================================

describe("create_statement — literature 跳过定义审查", () => {
  const fakeConfig: ReviewConfig = {
    enabled: true,
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    apiKey: "sk-fake",
    debounceMs: 0,
    maxTurns: 1,
    reviewDir: "/tmp",
    auditDir: null,
    dbPath: ":memory:",
  };

  test("literature statement 跳过定义审查，直接创建成功", async () => {
    const db2 = createTestDb();
    const server2 = createMockServer();
    registerTools(server2, db2, fakeConfig);
    const result = await server2._tools.create_statement.handler({
      content: "Smith et al. (2023) report method A achieves 95% accuracy on benchmark B.",
      source: "literature",
      verification: "pending",
      attachments: ["package.json"],
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Created statement");
    cleanupDb(db2);
  });

  test("observed statement 无 reviewConfig 时直接创建成功（对照组）", async () => {
    // without reviewConfig both sources succeed; proves skip is source-conditional, not path-conditional
    const db2 = createTestDb();
    const server2 = createMockServer();
    registerTools(server2, db2); // no reviewConfig
    const result = await server2._tools.create_statement.handler({
      content: "观测数据：实验组准确率95%",
      source: "observed",
      verification: "pending",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Created statement");
    cleanupDb(db2);
  });
});

// =============================================================================
// create_claim — qualifier 和 hints
// =============================================================================

describe("create_claim — qualifier 和 hints", () => {
  test("成功创建时输出 claimNoWarrants hint", async () => {
    const result = await tools.create_claim.handler({ content: "新主张" });
    expect(result.content[0].text).toContain("This claim has no warrants yet");
  });

  test("无 reviewConfig 时输出 reviewSkipped hint", async () => {
    const result = await tools.create_claim.handler({ content: "新主张" });
    expect(result.content[0].text).toContain("Automatic review is not configured");
  });

  test("带 qualifier 创建时 qualifier 存入数据库", async () => {
    const result = await tools.create_claim.handler({ content: "量化主张", qualifier: "probably" });
    expect(result.isError).toBeFalsy();
    const id = parseInt(result.content[0].text.match(/#(\d+)/)?.[1] ?? "0");
    const row = db.prepare("SELECT data FROM nodes WHERE id = ?").get(id) as { data: string };
    expect(JSON.parse(row.data).qualifier).toBe("probably");
  });
});

// =============================================================================
// create_statement — verified 无附件 + source pending hints + rebuttal_for
// =============================================================================

describe("create_statement — verified 无附件返回错误", () => {
  test("verified 但无 attachments 返回 isError", async () => {
    const result = await tools.create_statement.handler({
      content: "无附件数据",
      source: "observed",
      verification: "verified",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("attachments");
  });
});

describe("create_statement — source pending hints", () => {
  test("literature pending 显示 literature hint", async () => {
    const result = await tools.create_statement.handler({
      content: "文献引用内容",
      source: "literature",
      verification: "pending",
      attachments: ["/tmp/paper.pdf"],
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("cites published work");
  });

  test("observed pending 显示 observed hint", async () => {
    const result = await tools.create_statement.handler({
      content: "实验观测内容",
      source: "observed",
      verification: "pending",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("self-produced experiment/observation");
  });
});

describe("create_statement — rebuttal_for", () => {
  test("rebuttal_for claim 创建 rebuttal 关联", async () => {
    const claim = makeClaim(db, "目标主张");
    const result = await tools.create_statement.handler({
      content: "反驳条件",
      source: "observed",
      verification: "pending",
      rebuttal_for: { target_id: claim.id, target_type: "claim" },
    });
    expect(result.isError).toBeFalsy();
    const stmtId = parseInt(result.content[0].text.match(/#(\d+)/)?.[1] ?? "0");
    const row = db.prepare(
      "SELECT * FROM rebuttal_targets WHERE statement_id = ? AND target_id = ?"
    ).get(stmtId, claim.id) as any;
    expect(row).toBeTruthy();
    expect(row.target_type).toBe("claim");
  });

  test("rebuttal_for warrant 创建 rebuttal 关联", async () => {
    const claim = makeClaim(db, "主张");
    const g = makeGround(db);
    const warrant = makeWarrant(db, claim.id, [g.id]);
    const result = await tools.create_statement.handler({
      content: "推理原则反驳",
      source: "observed",
      verification: "pending",
      rebuttal_for: { target_id: warrant.id, target_type: "warrant" },
    });
    expect(result.isError).toBeFalsy();
    const stmtId = parseInt(result.content[0].text.match(/#(\d+)/)?.[1] ?? "0");
    const row = db.prepare(
      "SELECT * FROM rebuttal_targets WHERE statement_id = ? AND target_type = 'warrant'"
    ).get(stmtId) as any;
    expect(row).toBeTruthy();
  });

  test("rebuttal_for 不存在目标返回错误", async () => {
    const result = await tools.create_statement.handler({
      content: "反驳",
      source: "observed",
      rebuttal_for: { target_id: 9999, target_type: "claim" },
    });
    expect(result.isError).toBe(true);
  });
});

// =============================================================================
// update_node — ground_ids 增量操作
// =============================================================================

describe("update_node — ground_ids 增量操作", () => {
  test("add 将 ground 添加至 warrant", async () => {
    const claim = makeClaim(db);
    const g1 = makeGround(db, { content: "G1" });
    const g2 = makeGround(db, { content: "G2" });
    const warrant = makeWarrant(db, claim.id, [g1.id]);

    const result = await tools.update_node.handler({
      node_id: warrant.id,
      ground_ids: { add: [g2.id] },
    });
    expect(result.isError).toBeFalsy();
    const row = db.prepare(
      "SELECT ground_id FROM warrant_grounds WHERE warrant_id = ? AND ground_id = ?"
    ).get(warrant.id, g2.id);
    expect(row).toBeTruthy();
  });

  test("remove 从 warrant 移除 ground", async () => {
    const claim = makeClaim(db);
    const g1 = makeGround(db, { content: "G1" });
    const g2 = makeGround(db, { content: "G2" });
    const warrant = makeWarrant(db, claim.id, [g1.id, g2.id]);

    const result = await tools.update_node.handler({
      node_id: warrant.id,
      ground_ids: { remove: [g1.id] },
    });
    expect(result.isError).toBeFalsy();
    const row = db.prepare(
      "SELECT ground_id FROM warrant_grounds WHERE warrant_id = ? AND ground_id = ?"
    ).get(warrant.id, g1.id);
    expect(row).toBeNull();
  });

  test("移除所有 ground 后 warrant groundIds 为空", async () => {
    const claim = makeClaim(db);
    const g = makeGround(db, { content: "G1" });
    const warrant = makeWarrant(db, claim.id, [g.id]);

    const result = await tools.update_node.handler({
      node_id: warrant.id,
      ground_ids: { remove: [g.id] },
    });
    expect(result.isError).toBeFalsy();
    const row = db.prepare("SELECT ground_id FROM warrant_grounds WHERE warrant_id = ?").all(warrant.id);
    expect(row).toHaveLength(0);
  });
});

// =============================================================================
// update_node — backing_ids 增量操作
// =============================================================================

describe("update_node — backing_ids 增量操作", () => {
  test("add 将 backing 添加至 warrant", async () => {
    const claim = makeClaim(db);
    const g = makeGround(db);
    const warrant = makeWarrant(db, claim.id, [g.id]);
    const backing = makeGround(db, { content: "支撑材料" });

    const result = await tools.update_node.handler({
      node_id: warrant.id,
      backing_ids: { add: [backing.id] },
    });
    expect(result.isError).toBeFalsy();
    const row = db.prepare(
      "SELECT statement_id FROM warrant_backings WHERE warrant_id = ? AND statement_id = ?"
    ).get(warrant.id, backing.id);
    expect(row).toBeTruthy();
  });
});

// =============================================================================
// update_node — rebuttal_ids 增量操作
// =============================================================================

describe("update_node — rebuttal_ids 增量操作", () => {
  test("add 将 rebuttal 关联至 claim", async () => {
    const claim = makeClaim(db);
    const rebuttalStmt = makeGround(db, { content: "反驳条件" });

    const result = await tools.update_node.handler({
      node_id: claim.id,
      rebuttal_ids: { add: [rebuttalStmt.id] },
    });
    expect(result.isError).toBeFalsy();
    const row = db.prepare(
      "SELECT statement_id FROM rebuttal_targets WHERE statement_id = ? AND target_id = ?"
    ).get(rebuttalStmt.id, claim.id);
    expect(row).toBeTruthy();
  });

  test("remove 从 claim 移除 rebuttal 关联", async () => {
    const claim = makeClaim(db);
    const rebuttal = makeRebuttal(db, claim.id, "claim", "反驳");

    const result = await tools.update_node.handler({
      node_id: claim.id,
      rebuttal_ids: { remove: [rebuttal.id] },
    });
    expect(result.isError).toBeFalsy();
    const row = db.prepare(
      "SELECT statement_id FROM rebuttal_targets WHERE statement_id = ? AND target_id = ?"
    ).get(rebuttal.id, claim.id);
    expect(row).toBeNull();
  });
});

// =============================================================================
// update_node — qualifier
// =============================================================================

describe("update_node — qualifier", () => {
  test("更新 claim qualifier 存入数据库", async () => {
    const claim = makeClaim(db, "主张");
    const result = await tools.update_node.handler({
      node_id: claim.id,
      qualifier: "probably",
    });
    expect(result.isError).toBeFalsy();
    const row = db.prepare("SELECT data FROM nodes WHERE id = ?").get(claim.id) as { data: string };
    expect(JSON.parse(row.data).qualifier).toBe("probably");
  });

  test("更新 statement 的 qualifier 返回错误", async () => {
    const stmt = makeGround(db, { content: "证据" });
    const result = await tools.update_node.handler({
      node_id: stmt.id,
      qualifier: "probably",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Only Claim");
  });
});

// =============================================================================
// update_node — status 转换前提检查
// =============================================================================

describe("update_node — status 转换", () => {
  test("→supported 未 compile 返回错误", async () => {
    const claim = makeClaim(db, "未编译主张");
    const result = await tools.update_node.handler({ node_id: claim.id, status: "supported" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("argument has not been compiled or is stale");
  });

  test("→disputed 未 compile 返回错误", async () => {
    const claim = makeClaim(db, "未编译主张");
    const result = await tools.update_node.handler({ node_id: claim.id, status: "disputed" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("argument has not been compiled or is stale");
  });

  test("→supported compile 通过但 ground 未验证返回错误", async () => {
    const claim = makeCompiledClaim(db, "已编译主张");
    const g = makeGround(db, { content: "未验证证据", verification: "pending" });
    makeWarrant(db, claim.id, [g.id]);

    const result = await tools.update_node.handler({ node_id: claim.id, status: "supported" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no Warrant has all Grounds verified");
  });

  test("→supported compile 通过且 ground 已验证成功", async () => {
    const claim = makeCompiledClaim(db, "已编译主张");
    const g = makeGround(db, { content: "已验证证据", verification: "verified", attachments: ["/data.csv"] });
    makeWarrant(db, claim.id, [g.id]);

    const result = await tools.update_node.handler({ node_id: claim.id, status: "supported" });
    expect(result.isError).toBeFalsy();
    const row = db.prepare("SELECT data FROM nodes WHERE id = ?").get(claim.id) as { data: string };
    expect(JSON.parse(row.data).status).toBe("supported");
  });

  test("→disputed compile 通过但无 rebuttal 返回错误", async () => {
    const claim = makeCompiledClaim(db, "已编译主张");
    const result = await tools.update_node.handler({ node_id: claim.id, status: "disputed" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no Rebuttals exist");
  });

  test("→disputed compile 通过且存在 rebuttal 成功", async () => {
    const claim = makeCompiledClaim(db, "已编译主张");
    makeRebuttal(db, claim.id, "claim", "反驳条件");

    const result = await tools.update_node.handler({ node_id: claim.id, status: "disputed" });
    expect(result.isError).toBeFalsy();
    const row = db.prepare("SELECT data FROM nodes WHERE id = ?").get(claim.id) as { data: string };
    expect(JSON.parse(row.data).status).toBe("disputed");
  });
});

// =============================================================================
// update_node — statement content 自动退回 verification
// =============================================================================

describe("update_node — statement content 自动退回 verification", () => {
  test("更新 verified statement 内容 → verification 退回 pending + hint", async () => {
    const stmt = makeGround(db, { content: "原始内容", verification: "verified", attachments: ["/data.csv"] });

    const result = await tools.update_node.handler({ node_id: stmt.id, content: "修改内容" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("content changed — verification reverted to pending");
    const row = db.prepare("SELECT data FROM nodes WHERE id = ?").get(stmt.id) as { data: string };
    expect(JSON.parse(row.data).verification).toBe("pending");
  });

  test("更新 pending statement 内容 → 无 verification 退回提示", async () => {
    const stmt = makeGround(db, { content: "原始内容", verification: "pending" });

    const result = await tools.update_node.handler({ node_id: stmt.id, content: "修改内容" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toContain("verification reverted");
  });
});

// =============================================================================
// delete_node — cascade + D1/D3 warnings
// =============================================================================

describe("delete_node — cascade=true 递归删除 claim", () => {
  test("cascade=true 删除 claim 及其 warrant", async () => {
    const claim = makeClaim(db, "要删除的主张");
    const g = makeGround(db, { content: "证据" });
    const warrant = makeWarrant(db, claim.id, [g.id]);

    const result = await tools.delete_node.handler({ node_id: claim.id, cascade: true });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain(`Deleted node #${claim.id}`);
    expect(db.prepare("SELECT id FROM nodes WHERE id = ?").get(claim.id)).toBeNull();
    expect(db.prepare("SELECT id FROM nodes WHERE id = ?").get(warrant.id)).toBeNull();
  });
});

describe("delete_node — D1 warning (ground 被 warrant 引用)", () => {
  test("删除被 warrant 引用的 ground 返回 D1 警告", async () => {
    const claim = makeClaim(db);
    const g = makeGround(db, { content: "被引用证据" });
    makeWarrant(db, claim.id, [g.id]);

    const result = await tools.delete_node.handler({ node_id: g.id, cascade: false });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("was referenced by Warrant");
    expect(result.content[0].text).toContain("has been removed from these Warrants");
  });

  test("删除未被引用的 statement 不含 D1 警告", async () => {
    const stmt = makeGround(db, { content: "孤立证据" });

    const result = await tools.delete_node.handler({ node_id: stmt.id, cascade: false });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toContain("was referenced by Warrant");
  });
});

describe("delete_node — 删除 warrant 时 claim status 被回退", () => {
  // D3 在 service 层检查，但 tools 层先调用 invalidateCompiledClaims，
  // 后者已将非 proposed 的 status 回退为 proposed，因此工具层输出的是 statusReverted 警告。
  test("删除 supported claim 的 warrant → 输出 status 回退警告且 claim 变为 proposed", async () => {
    const claim = makeClaim(db, "已支持主张", "supported");
    const g = makeGround(db, { content: "证据" });
    const warrant = makeWarrant(db, claim.id, [g.id]);

    const result = await tools.delete_node.handler({ node_id: warrant.id, cascade: false });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('reverted from "supported" to "proposed"');
    const row = db.prepare("SELECT data FROM nodes WHERE id = ?").get(claim.id) as { data: string };
    expect(JSON.parse(row.data).status).toBe("proposed");
  });

  test("删除 proposed claim 的 warrant → 无 status 回退警告", async () => {
    const claim = makeClaim(db, "提议主张", "proposed");
    const g = makeGround(db, { content: "证据" });
    const warrant = makeWarrant(db, claim.id, [g.id]);

    const result = await tools.delete_node.handler({ node_id: warrant.id, cascade: false });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toContain("reverted");
  });
});

// =============================================================================
// get_argument — warrant 和 statement 节点
// =============================================================================

describe("get_argument — warrant 节点", () => {
  test("warrant 节点返回 WarrantArgument 格式", async () => {
    const claim = makeClaim(db, "主张");
    const g = makeGround(db, { content: "证据" });
    const warrant = makeWarrant(db, claim.id, [g.id], "推理规则");

    const result = await tools.get_argument.handler({ node_id: warrant.id });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain(`## Warrant #${warrant.id}`);
    expect(text).toContain("推理规则");
    expect(text).toContain("Grounds:");
    expect(text).toContain("证据");
  });
});

describe("get_argument — statement 节点", () => {
  test("作为 ground 的 statement 显示 used_in_warrants", async () => {
    const claim = makeClaim(db, "核心主张");
    const g = makeGround(db, { content: "核心证据" });
    makeWarrant(db, claim.id, [g.id]);

    const result = await tools.get_argument.handler({ node_id: g.id });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("Used in warrants:");
    expect(text).toContain("核心主张");
  });

  test("未作为 ground 的 statement 不含 used_in_warrants", async () => {
    const stmt = makeGround(db, { content: "孤立证据" });

    const result = await tools.get_argument.handler({ node_id: stmt.id });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toContain("Used in warrants:");
  });
});

describe("get_argument — claim 含 rebuttal", () => {
  test("含 rebuttal 的 claim 输出 Rebuttals 段落", async () => {
    const claim = makeClaim(db, "核心主张");
    makeRebuttal(db, claim.id, "claim", "反驳条件");

    const result = await tools.get_argument.handler({ node_id: claim.id });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("### Rebuttals");
    expect(text).toContain("反驳条件");
  });
});

describe("get_argument — claim 含 qualifier", () => {
  test("含 qualifier 的 claim 输出 Qualifier 行", async () => {
    const claim = makeClaim(db, "量化主张");
    const data = JSON.parse(
      (db.prepare("SELECT data FROM nodes WHERE id = ?").get(claim.id) as { data: string }).data
    );
    data.qualifier = "probably";
    db.prepare("UPDATE nodes SET data = ? WHERE id = ?").run(JSON.stringify(data), claim.id);

    const result = await tools.get_argument.handler({ node_id: claim.id });
    expect(result.content[0].text).toContain("Qualifier: probably");
  });
});

// =============================================================================
// search_nodes — virtual type filters
// =============================================================================

describe("search_nodes — virtual type filters", () => {
  test("node_type='claim' 只返回 claim 节点", async () => {
    makeClaim(db, "UniqueKeyword claim");
    makeGround(db, { content: "UniqueKeyword ground" });

    const result = await tools.search_nodes.handler({ keyword: "UniqueKeyword", node_type: "claim" });
    const text = result.content[0].text;
    expect(text).toContain("UniqueKeyword claim");
    expect(text).not.toContain("UniqueKeyword ground");
  });

  test("node_type='ground' 只返回在 warrant_grounds 中的 statement", async () => {
    const claim = makeClaim(db);
    const g = makeGround(db, { content: "GroundFilter" });
    makeWarrant(db, claim.id, [g.id]);
    makeGround(db, { content: "GroundFilter standalone" }); // not linked to any warrant

    const result = await tools.search_nodes.handler({ keyword: "GroundFilter", node_type: "ground" });
    const text = result.content[0].text;
    expect(text).toContain("GroundFilter");
    expect(text).not.toContain("standalone");
  });

  test("node_type='backing' 只返回在 warrant_backings 中的 statement", async () => {
    const claim = makeClaim(db);
    const g = makeGround(db);
    const warrant = makeWarrant(db, claim.id, [g.id]);
    makeBacking(db, warrant.id, "BackingFilter");
    makeClaim(db, "BackingFilter claim"); // claim with same keyword, should not appear

    const result = await tools.search_nodes.handler({ keyword: "BackingFilter", node_type: "backing" });
    const text = result.content[0].text;
    expect(text).toContain("BackingFilter");
    expect(text).not.toContain("BackingFilter claim");
  });

  test("node_type='rebuttal' 只返回在 rebuttal_targets 中的 statement", async () => {
    const claim = makeClaim(db);
    makeRebuttal(db, claim.id, "claim", "RebuttalFilter");
    makeClaim(db, "RebuttalFilter claim"); // claim with same keyword, should not appear

    const result = await tools.search_nodes.handler({ keyword: "RebuttalFilter", node_type: "rebuttal" });
    const text = result.content[0].text;
    expect(text).toContain("RebuttalFilter");
    expect(text).not.toContain("RebuttalFilter claim");
  });
});

// =============================================================================
// list_claims — multi-value status filter
// =============================================================================

describe("list_claims — multi-value status filter", () => {
  test("status='proposed,supported' 返回两种状态，排除其他", async () => {
    makeClaim(db, "C-proposed", "proposed");
    makeClaim(db, "C-supported", "supported");
    makeClaim(db, "C-disputed", "disputed");

    const result = await tools.list_claims.handler({ status: "proposed,supported" });
    const text = result.content[0].text;
    expect(text).toContain("C-proposed");
    expect(text).toContain("C-supported");
    expect(text).not.toContain("C-disputed");
  });
});

// =============================================================================
// compile 失效 — 非结构性字段不触发失效（负面测试）
// =============================================================================

describe("compile 失效 — 非结构性字段变更不触发失效", () => {
  function makeCompiledChain(db: any) {
    const claim = makeCompiledClaim(db, "Compiled claim");
    const ground = makeGround(db, { content: "Evidence", source: "observed", verification: "verified" });
    const warrant = makeWarrant(db, claim.id, [ground.id]);
    return { claim, ground, warrant };
  }

  function compileStatus(db: any, claimId: number): string | null {
    const row = db.prepare("SELECT data FROM nodes WHERE id = ?").get(claimId) as { data: string };
    return JSON.parse(row.data).compile_status ?? null;
  }

  test("修改 statement verification → compile_status 保持 passed，无失效警告", async () => {
    const { claim, ground } = makeCompiledChain(db);

    const result = await tools.update_node.handler({
      node_id: ground.id,
      verification: "pending",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toContain("compiled status has been cleared");
    expect(compileStatus(db, claim.id)).toBe("passed");
  });

  test("修改 statement source → compile_status 保持 passed，无失效警告", async () => {
    const { claim, ground } = makeCompiledChain(db);
    // Add attachments first: literature source requires them
    const gRow = repo.getNodeById(db, ground.id);
    const gData = JSON.parse(gRow!.data);
    gData.attachments = ["/paper.pdf"];
    repo.updateNodeFields(db, ground.id, { data: gData });

    const result = await tools.update_node.handler({
      node_id: ground.id,
      source: "literature",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toContain("compiled status has been cleared");
    expect(compileStatus(db, claim.id)).toBe("passed");
  });

  test("修改 claim qualifier → compile_status 保持 passed，无失效警告", async () => {
    const { claim } = makeCompiledChain(db);

    const result = await tools.update_node.handler({
      node_id: claim.id,
      qualifier: "probably",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toContain("compiled status has been cleared");
    expect(compileStatus(db, claim.id)).toBe("passed");
  });
});

// =============================================================================
// compile 失效 — backing_ids / rebuttal_ids 变更触发失效（正面测试）
// =============================================================================

describe("compile 失效 — backing_ids 变更触发失效", () => {
  test("backing_ids add → compiled claim 失效", async () => {
    const claim = makeCompiledClaim(db, "Claim with backing");
    const ground = makeGround(db, { content: "Ground" });
    const warrant = makeWarrant(db, claim.id, [ground.id]);
    const newBacking = makeGround(db, { content: "New backing" });

    const result = await tools.update_node.handler({
      node_id: warrant.id,
      backing_ids: { add: [newBacking.id] },
    });

    expect(result.content[0].text).toContain("compiled status has been cleared");
    const row = db.prepare("SELECT data FROM nodes WHERE id = ?").get(claim.id) as { data: string };
    expect(JSON.parse(row.data).compile_status).toBe("stale");
  });

  test("backing_ids remove → compiled claim 失效", async () => {
    const claim = makeCompiledClaim(db, "Claim with backing");
    const ground = makeGround(db, { content: "Ground" });
    const warrant = makeWarrant(db, claim.id, [ground.id]);
    const backing = makeBacking(db, warrant.id, "Existing backing");

    const result = await tools.update_node.handler({
      node_id: warrant.id,
      backing_ids: { remove: [backing.id] },
    });

    expect(result.content[0].text).toContain("compiled status has been cleared");
    const row = db.prepare("SELECT data FROM nodes WHERE id = ?").get(claim.id) as { data: string };
    expect(JSON.parse(row.data).compile_status).toBe("stale");
  });
});

describe("compile 失效 — rebuttal_ids 变更触发失效", () => {
  test("rebuttal_ids add → compiled claim 失效", async () => {
    const claim = makeCompiledClaim(db, "Claim with rebuttal");
    const ground = makeGround(db, { content: "Ground" });
    makeWarrant(db, claim.id, [ground.id]);
    const rebuttalStmt = makeGround(db, { content: "Counter evidence" });

    const result = await tools.update_node.handler({
      node_id: claim.id,
      rebuttal_ids: { add: [rebuttalStmt.id] },
    });

    expect(result.content[0].text).toContain("compiled status has been cleared");
    const row = db.prepare("SELECT data FROM nodes WHERE id = ?").get(claim.id) as { data: string };
    expect(JSON.parse(row.data).compile_status).toBe("stale");
  });

  test("rebuttal_ids remove → compiled claim 失效", async () => {
    const claim = makeCompiledClaim(db, "Claim with rebuttal");
    const ground = makeGround(db, { content: "Ground" });
    makeWarrant(db, claim.id, [ground.id]);
    const rebuttal = makeRebuttal(db, claim.id, "claim", "Existing rebuttal");

    const result = await tools.update_node.handler({
      node_id: claim.id,
      rebuttal_ids: { remove: [rebuttal.id] },
    });

    expect(result.content[0].text).toContain("compiled status has been cleared");
    const row = db.prepare("SELECT data FROM nodes WHERE id = ?").get(claim.id) as { data: string };
    expect(JSON.parse(row.data).compile_status).toBe("stale");
    // 验证关系行实际被删除
    const rel = db.prepare(
      "SELECT * FROM rebuttal_targets WHERE statement_id = ? AND target_id = ?"
    ).get(rebuttal.id, claim.id);
    expect(rel).toBeNull();
  });
});

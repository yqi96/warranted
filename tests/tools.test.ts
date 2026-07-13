/**
 * Toulmin MCP — MCP 工具集成测试
 *
 * 通过 mock server 测试工具注册、参数校验和输出格式。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb, cleanupDb, makeClaim, makeGround, makeWarrant, makeBacking, makeRebuttal } from "./helpers.ts";
import { registerTools } from "../src/tools.ts";

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
  test("注册了 11 个工具", () => {
    expect(Object.keys(tools).length).toBe(11);
  });

  test("所有必需工具已注册", () => {
    const expected = [
      "create_claim", "create_ground", "create_warrant",
      "create_backing", "create_rebuttal",
      "list_claims", "get_argument", "search_nodes",
      "get_stats", "update_node", "delete_node",
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
// create_ground 工具
// =============================================================================

describe("create_ground 工具", () => {
  test("Mode A 成功创建", async () => {
    const result = await tools.create_ground.handler({
      content: "实验数据",
      source: "observed",
      verification: "verified",
    });
    expect(result.content[0].text).toContain("Created ground #1");
  });

  test("Mode B 成功创建", async () => {
    const claim = makeClaim(db);
    const result = await tools.create_ground.handler({
      ref_claim_id: claim.id,
    });
    expect(result.content[0].text).toContain("Created ground");
  });

  test("互斥模式返回错误", async () => {
    const claim = makeClaim(db);
    const result = await tools.create_ground.handler({
      content: "x",
      source: "observed",
      verification: "verified",
      ref_claim_id: claim.id,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("mutually exclusive");
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
    makeClaim(db, "C2", "validated");
    const result = await tools.list_claims.handler({ status: "validated" });
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

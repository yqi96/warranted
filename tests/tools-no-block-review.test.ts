/**
 * US-003 回归测试 — create_claim/create_warrant/update_node 不再同步阻断节点定义审查
 *
 * mock.module 必须在 tools.ts 导入之前调用，且用动态 import 加载，避免静态 import 提升
 * 导致 mock 对已解析的真实模块无效（同 review-llm-sdk-options.test.ts 的约束）。
 * mock 的 callAndParse 在被调用时抛出异常 —— 任何调用都会让测试失败，这是核心回归防护。
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb, cleanupDb, makeClaim, makeGround, makeWarrant } from "./helpers.ts";
import type { ReviewConfig } from "../src/review-config.ts";

function extractFromFences(text: string): string | null {
  const lines = text.split("\n");
  const openIdx = lines.findIndex(l => /^[ \t]*```(?:json)?[ \t]*$/.test(l));
  if (openIdx === -1) return null;
  for (let i = lines.length - 1; i > openIdx; i--) {
    if (/^[ \t]*```[ \t]*$/.test(lines[i])) {
      return lines.slice(openIdx + 1, i).join("\n");
    }
  }
  return null;
}

mock.module("../src/review-llm.ts", () => ({
  callAgent: async () => {
    throw new Error("callAgent should not be invoked from create/update paths");
  },
  callAndParse: async () => {
    throw new Error("callAndParse should not be invoked from create/update paths");
  },
  // 与真实实现行为一致（fence 剥离 + fallback），避免 mock.module 跨文件泄漏时
  // 覆盖 review-llm.test.ts 对真实 parseLLMResponse 的测试
  parseLLMResponse: (raw: string): Record<string, unknown> => {
    let jsonText = raw.trim();
    const extracted = extractFromFences(jsonText);
    if (extracted !== null) jsonText = extracted.trim();
    try {
      const parsed = JSON.parse(jsonText);
      if (parsed && typeof parsed === "object") return parsed;
      return { _parseFailed: true, errors: [jsonText.slice(0, 500)], warnings: [] };
    } catch {
      return { _parseFailed: true, errors: [raw.slice(0, 500)], warnings: [] };
    }
  },
}));

const { registerTools } = await import("../src/tools.ts");

function createMockServer() {
  const registered: Record<string, { schema: any; handler: Function }> = {};
  return {
    registerTool(name: string, config: any, handler: Function) {
      registered[name] = { schema: config.inputSchema, handler };
    },
    _tools: registered,
  };
}

function makeConfig(): ReviewConfig {
  return {
    enabled: true,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    apiKey: "sk-fake",
    maxTurns: 5,
    reviewDir: null,
    auditDir: null,
    dbPath: ".toulmin/argument.db",
  };
}

let db: Database;
let tools: Record<string, { schema: any; handler: Function }>;

beforeEach(() => {
  db = createTestDb();
  const server = createMockServer();
  registerTools(server, db, makeConfig());
  tools = server._tools;
});

afterEach(() => {
  cleanupDb(db);
});

describe("create_claim / create_warrant 在 reviewConfig 配置下不再阻断", () => {
  test("create_claim 即使内容不符合 Toulmin 定义也直接成功，零 LLM 调用", async () => {
    const result = await tools.create_claim.handler({ content: "asdf qwerty garbage" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Created claim #");
  });

  test("create_warrant 即使内容明显是 Ground 也直接成功，零 LLM 调用", async () => {
    const claim = makeClaim(db, "Test claim");
    const ground = makeGround(db);
    const result = await tools.create_warrant.handler({
      claim_id: claim.id,
      content: "Method A produced result R",
      ground_ids: [ground.id],
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Created warrant #");
  });
});

describe("update_node 修改 claim/warrant content 不再阻断", () => {
  test("修改 Claim content 直接成功，零 LLM 调用", async () => {
    const claim = makeClaim(db, "Original claim");
    const result = await tools.update_node.handler({ node_id: claim.id, content: "Malformed content that looks like a Ground" });
    expect(result.isError).toBeFalsy();
  });

  test("修改 Warrant content 直接成功，零 LLM 调用", async () => {
    const claim = makeClaim(db, "Test claim");
    const ground = makeGround(db);
    const warrant = makeWarrant(db, claim.id, [ground.id], "Original warrant");
    const result = await tools.update_node.handler({ node_id: warrant.id, content: "If ground then claim" });
    expect(result.isError).toBeFalsy();
  });
});

/**
 * US-004 回归测试 — compile_arguments 输出的节点前缀 / advisory 标记 / 审查结果文件命名
 *
 * mock.module 必须在 tools.ts 导入之前调用，且用动态 import 加载，避免静态 import 提升
 * 导致 mock 对已解析的真实模块无效（同 review-llm-sdk-options.test.ts 的约束）。
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTestDb, cleanupDb, makeClaim, makeGround, makeWarrant } from "./helpers.ts";
import type { ReviewConfig } from "../src/review-config.ts";

type CallResult = { errors: string[]; warnings: string[] };

let warrantResult: CallResult = { errors: [], warnings: [] };
let chainResult: CallResult = { errors: [], warnings: [] };

mock.module("../src/review-llm.ts", () => ({
  callAgent: async () => {
    throw new Error("callAgent should not be invoked directly in this test");
  },
  callAndParse: async (_config: unknown, prompt: string) => {
    if (prompt.includes("## Claim to Review")) return { errors: [], warnings: [] };
    if (prompt.includes("## Warrant to Review")) return warrantResult;
    if (prompt.includes("## Argument to Review")) return chainResult;
    throw new Error("Unrecognized prompt type in test mock");
  },
  parseLLMResponse: (raw: string) => JSON.parse(raw),
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

let reviewDir: string;

function makeConfig(): ReviewConfig {
  return {
    enabled: true,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    apiKey: "sk-fake",
    debounceMs: 30000,
    maxTurns: 5,
    reviewDir,
    auditDir: null,
    dbPath: ".toulmin/argument.db",
  };
}

let db: Database;
let tools: Record<string, { schema: any; handler: Function }>;

beforeEach(() => {
  db = createTestDb();
  reviewDir = mkdtempSync(join(tmpdir(), "warranted-compile-review-"));
  warrantResult = { errors: [], warnings: [] };
  chainResult = { errors: [], warnings: [] };
  const server = createMockServer();
  registerTools(server, db, makeConfig());
  tools = server._tools;
});

afterEach(() => {
  cleanupDb(db);
  rmSync(reviewDir, { recursive: true, force: true });
});

describe("compile_arguments 输出 — 节点前缀 + advisory 标记", () => {
  test("warrant 定义审查 error 在输出中带 Warrant #<id> 前缀", async () => {
    const claim = makeClaim(db, "Test claim");
    const ground = makeGround(db);
    const warrant = makeWarrant(db, claim.id, [ground.id], "Test warrant");
    warrantResult = { errors: ["Warrant restates ground as if-then bridge"], warnings: [] };

    const result = await tools.compile_arguments.handler({});
    expect(result.content[0].text).toContain(`Warrant #${warrant.id}: Warrant restates ground as if-then bridge`);
  });

  test("chain error 与定义审查 error 重叠时，降级为 advisory 并在输出中带标记", async () => {
    const claim = makeClaim(db, "Test claim");
    const ground = makeGround(db);
    makeWarrant(db, claim.id, [ground.id], "Test warrant");
    warrantResult = { errors: ["Warrant restates ground as if-then bridge"], warnings: [] };
    chainResult = { errors: ["Logical gap between ground and claim"], warnings: [] };

    const result = await tools.compile_arguments.handler({});
    expect(result.content[0].text).toContain("[advisory] Logical gap between ground and claim");
  });

  test("仅 chain error（无定义审查 error）时不带 advisory 标记", async () => {
    const claim = makeClaim(db, "Test claim");
    const ground = makeGround(db);
    makeWarrant(db, claim.id, [ground.id], "Test warrant");
    chainResult = { errors: ["Logical gap between ground and claim"], warnings: [] };

    const result = await tools.compile_arguments.handler({});
    expect(result.content[0].text).toContain("Error: Logical gap between ground and claim");
    expect(result.content[0].text).not.toContain("[advisory]");
  });
});

describe("审查结果文件命名 — compile_{elementType}{nodeId}_definition_ 约定", () => {
  test("warrant 定义审查失败时写入包含节点 id 与 definition 的文件", async () => {
    const claim = makeClaim(db, "Test claim");
    const ground = makeGround(db);
    const warrant = makeWarrant(db, claim.id, [ground.id], "Test warrant");
    warrantResult = { errors: ["Warrant restates ground as if-then bridge"], warnings: [] };

    await tools.compile_arguments.handler({});

    const files = readdirSync(reviewDir);
    const definitionFile = files.find(f => new RegExp(`^compile_warrant${warrant.id}_definition_.*\\.json$`).test(f));
    expect(definitionFile).toBeDefined();

    const payload = JSON.parse(readFileSync(join(reviewDir, definitionFile!), "utf-8"));
    expect(payload).toMatchObject({
      type: "definition",
      elementType: "warrant",
      claimId: claim.id,
      nodeId: warrant.id,
    });

    // 不应再有以 chain 命名但实际是 warrant 定义结果的重复/错误标记文件
    const mislabeled = files.filter(f => f.includes(`_chain_`)).map(f => JSON.parse(readFileSync(join(reviewDir, f), "utf-8")));
    for (const m of mislabeled) {
      expect(m.reviewer).not.toBe("warrant");
      expect(m.reviewer).not.toBe("claim");
    }
  });
});

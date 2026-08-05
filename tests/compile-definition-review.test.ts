/**
 * US-002 回归测试 — 节点定义审查与逻辑链审查在 compileArgument 中并行执行
 *
 * mock.module 必须在 compile-service.ts 导入之前调用，且用动态 import 加载，
 * 否则静态 import 提升会导致 mock 对已解析的真实模块无效（同 review-llm-sdk-options.test.ts 的约束）。
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  createTestDb,
  cleanupDb,
  makeClaim,
  makeGround,
  makeWarrant,
} from "./helpers.ts";
import type { Database } from "bun:sqlite";
import type { ReviewConfig } from "../src/review-config.ts";

type CallResult = { errors: string[]; warnings: string[] };

let claimResult: CallResult = { errors: [], warnings: [] };
let warrantResult: CallResult = { errors: [], warnings: [] };
let chainResult: CallResult = { errors: [], warnings: [] };
const promptLog: string[] = [];

mock.module("../src/review-llm.ts", () => ({
  callAndParse: async (_config: unknown, prompt: string) => {
    promptLog.push(prompt);
    if (prompt.includes("## Claim to Review")) return claimResult;
    if (prompt.includes("## Warrant to Review")) return warrantResult;
    if (prompt.includes("## Argument to Review")) return chainResult;
    throw new Error("Unrecognized prompt type in test mock");
  },
  parseLLMResponse: (raw: string) => JSON.parse(raw),
}));

const { compileArgument, runDefinitionReviews } = await import("../src/compile-service.ts");

function makeConfig(): ReviewConfig {
  return {
    enabled: true,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    apiKey: "sk-test",
    debounceMs: 30000,
    maxTurns: 5,
    reviewDir: null,
    auditDir: null,
    dbPath: ".toulmin/argument.db",
  };
}

let db: Database;

beforeEach(() => {
  db = createTestDb();
  claimResult = { errors: [], warnings: [] };
  warrantResult = { errors: [], warnings: [] };
  chainResult = { errors: [], warnings: [] };
  promptLog.length = 0;
});

afterEach(() => {
  cleanupDb(db);
});

describe("runDefinitionReviews", () => {
  test("对 Claim 和每个 Warrant 各产生一条 ElementReviewResult", async () => {
    const claim = makeClaim(db, "Test claim");
    const ground = makeGround(db);
    makeWarrant(db, claim.id, [ground.id], "Test warrant");

    const config = makeConfig();
    const results = await runDefinitionReviews(config, db, claim.id);

    expect(results.length).toBe(2);
    expect(results.find(r => r.reviewer === "claim")?.nodeId).toBe(claim.id);
    expect(results.find(r => r.reviewer === "warrant")).toBeDefined();
  });
});

describe("compileArgument — 并行执行 + advisory 降级", () => {
  test("仅链审查有 error，定义审查全干净 → 不降级为 advisory", async () => {
    const claim = makeClaim(db, "Test claim");
    const ground = makeGround(db);
    makeWarrant(db, claim.id, [ground.id], "Test warrant");
    chainResult = { errors: ["Logical gap between ground and claim"], warnings: [] };

    const config = makeConfig();
    const result = await compileArgument(db, config, claim.id);

    const chain = result.elementReviews.find(r => r.reviewer === "chain")!;
    expect(chain.errors.length).toBeGreaterThan(0);
    expect(chain.advisory).toBeUndefined();
    expect(result.verdict).toBe("failed");
  });

  test("定义审查（warrant）与链审查都有 error → 链审查结果降级为 advisory，verdict 仍为 failed", async () => {
    const claim = makeClaim(db, "Test claim");
    const ground = makeGround(db);
    makeWarrant(db, claim.id, [ground.id], "Test warrant");
    warrantResult = { errors: ["Warrant restates ground as if-then bridge"], warnings: [] };
    chainResult = { errors: ["Logical gap between ground and claim"], warnings: [] };

    const config = makeConfig();
    const result = await compileArgument(db, config, claim.id);

    const chain = result.elementReviews.find(r => r.reviewer === "chain")!;
    const warrant = result.elementReviews.find(r => r.reviewer === "warrant")!;
    expect(warrant.errors.length).toBeGreaterThan(0);
    expect(warrant.advisory).toBeUndefined();
    expect(chain.advisory).toBe(true);
    // advisory 不影响 verdict/hasError 判定 —— errors 仍计入
    expect(result.verdict).toBe("failed");
  });

  test("定义审查与链审查均干净 → verdict passed，无 advisory", async () => {
    const claim = makeClaim(db, "Test claim");
    const ground = makeGround(db);
    makeWarrant(db, claim.id, [ground.id], "Test warrant");

    const config = makeConfig();
    const result = await compileArgument(db, config, claim.id);

    expect(result.verdict).toBe("passed");
    expect(result.elementReviews.every(r => !r.advisory)).toBe(true);
  });

  test("定义审查与链审查并行执行（两者的 prompt 都被调用）", async () => {
    const claim = makeClaim(db, "Test claim");
    const ground = makeGround(db);
    makeWarrant(db, claim.id, [ground.id], "Test warrant");

    const config = makeConfig();
    await compileArgument(db, config, claim.id);

    expect(promptLog.some(p => p.includes("## Claim to Review"))).toBe(true);
    expect(promptLog.some(p => p.includes("## Warrant to Review"))).toBe(true);
    expect(promptLog.some(p => p.includes("## Argument to Review"))).toBe(true);
  });
});

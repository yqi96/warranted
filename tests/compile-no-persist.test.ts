/**
 * --no-persist 模式下 compile-service 的回归测试
 *
 * 复现 Bug：reviewDir=null 时 path.join(null, filename) 抛出
 *   "The 'paths[0]' property must be of type string, got object"
 */

import { describe, test, expect, mock } from "bun:test";

// Mock callAndParse，避免真实 SDK 调用
mock.module("../src/review-llm.ts", () => ({
  callAndParse: async () => ({ errors: [], warnings: [] }),
  parseLLMResponse: (raw: string) => JSON.parse(raw),
}));

import { reviewNodeDefinition } from "../src/compile-service.ts";
import type { ReviewConfig } from "../src/review-config.ts";

/** 构造 --no-persist 模式下的 ReviewConfig（reviewDir/auditDir 均为 null） */
function makeNoPersistConfig(): ReviewConfig {
  return {
    enabled: true,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    apiKey: "sk-test",
    debounceMs: 30000,
    maxTurns: 5,
    reviewDir: null,   // --no-persist 设置
    auditDir: null,    // --no-persist 设置
    dbPath: ".toulmin/argument.db",
  };
}

describe("reviewNodeDefinition — --no-persist (reviewDir=null)", () => {
  test("claim 审查不抛出路径错误", async () => {
    const config = makeNoPersistConfig();
    await expect(
      reviewNodeDefinition(config, "claim", "Test claim content")
    ).resolves.toMatchObject({ errors: [], warnings: [] });
  });

  test("warrant 审查不抛出路径错误", async () => {
    const config = makeNoPersistConfig();
    await expect(
      reviewNodeDefinition(config, "warrant", "Test warrant content")
    ).resolves.toMatchObject({ errors: [], warnings: [] });
  });

  test("ground 审查不抛出路径错误", async () => {
    const config = makeNoPersistConfig();
    await expect(
      reviewNodeDefinition(config, "ground", "Test ground content")
    ).resolves.toMatchObject({ errors: [], warnings: [] });
  });
});

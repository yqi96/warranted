/**
 * SDK 调用配置测试 — review-llm.ts
 *
 * 固定 callAgent() 传给 query() 的 permissionMode/allowedTools/disallowedTools，
 * 并验证 permission_denied 消息会被记录（console.warn），而不是被静默丢弃。
 *
 * mock.module 必须在任何 review-llm.ts 导入之前调用，且 review-llm.ts 必须用
 * 动态 import 加载 —— 否则静态 import 提升会导致 mock 对已解析的真实模块无效。
 */

import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import type { ReviewConfig } from "../src/review-config.ts";
import { createTestDb, cleanupDb, makeClaim, makeGround, makeWarrant } from "./helpers.ts";

const testConfig: ReviewConfig = {
  enabled: true,
  provider: "anthropic",
  model: "claude-opus-4-7",
  apiKey: "test-key",
  maxTurns: 10,
  reviewDir: null,
  auditDir: null,
  dbPath: "/tmp/test.db",
};

let capturedOptions: Record<string, unknown> | undefined;
let mockMessages: unknown[] = [];
let mockDelayMs = 0;
let concurrencyCounter = 0;
let peakConcurrency = 0;

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { prompt: string; options: Record<string, unknown> }) => {
    capturedOptions = args.options;
    async function* generator() {
      concurrencyCounter++;
      peakConcurrency = Math.max(peakConcurrency, concurrencyCounter);
      try {
        if (mockDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, mockDelayMs));
        }
        for (const message of mockMessages) {
          yield message;
        }
      } finally {
        concurrencyCounter--;
      }
    }
    return generator();
  },
}));

const { callAgent } = await import("../src/review-llm.ts");
const { compileArgument } = await import("../src/compile-service.ts");
const { reviewStatementEvidencePreCreate } = await import("../src/review-sync.ts");

describe("callAgent SDK call options", () => {
  beforeEach(() => {
    capturedOptions = undefined;
    mockMessages = [];
  });

  afterEach(() => {
    mock.restore();
  });

  test("传给 query() 的 permissionMode 是 dontAsk", async () => {
    mockMessages = [{ type: "result", subtype: "success", result: "{}" }];

    await callAgent(testConfig, "test prompt", []);

    expect(capturedOptions?.permissionMode).toBe("dontAsk");
  });

  test("allowedTools/disallowedTools 保持不变", async () => {
    mockMessages = [{ type: "result", subtype: "success", result: "{}" }];

    await callAgent(testConfig, "test prompt", []);

    expect(capturedOptions?.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect(capturedOptions?.disallowedTools).toEqual(["Edit", "Write", "Bash", "MultiEdit"]);
  });

  test("permission_denied 消息触发 console.warn 并包含工具名", async () => {
    mockMessages = [
      { type: "system", subtype: "permission_denied", tool_name: "Read", tool_use_id: "x" },
      { type: "result", subtype: "success", result: "{}" },
    ];
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const res = await callAgent(testConfig, "test prompt", []);
    expect(res).toBe("{}");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("Read");
  });

  test("permission_denied 的工具名交回调用方，不是只进 console.warn", async () => {
    // console.warn 走 MCP server 的 stderr，主 agent 从来看不到。只记在那里,
    // 「被拒 = 没审过」这条防线在生产路径上就没有承载者 —— 消费侧那段
    // deniedTools 判断永远是死代码，而图上一次被拒的审查与一次真通过完全同形
    mockMessages = [
      { type: "system", subtype: "permission_denied", tool_name: "Read", tool_use_id: "x" },
      { type: "result", subtype: "success", result: "{}" },
    ];
    spyOn(console, "warn").mockImplementation(() => {});

    const denied: string[] = [];
    await callAgent(testConfig, "test prompt", [], undefined, undefined, denied);
    expect(denied).toEqual(["Read"]);
  });

  test("被拒的审查经 review-sync 落成第三种结局，不是一次干净通过", async () => {
    mockMessages = [
      { type: "system", subtype: "permission_denied", tool_name: "Read", tool_use_id: "x" },
      { type: "result", subtype: "success", result: '{"errors":[],"warnings":[]}' },
    ];
    spyOn(console, "warn").mockImplementation(() => {});

    const r = await reviewStatementEvidencePreCreate(testConfig, {
      content: "一条证据",
      source: "observed",
      attachments: ["evidence/x.txt"],
    });
    expect(r.deniedTools).toEqual(["Read"]);
    expect(r.reviewError).toBeDefined();
  });

  test("仅 success 消息时不调用 console.warn，且正确返回结果", async () => {
    mockMessages = [{ type: "result", subtype: "success", result: "hello" }];
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const res = await callAgent(testConfig, "test prompt", []);
    expect(res).toBe("hello");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("callAgent 全局并发上限", () => {
  beforeEach(() => {
    mockMessages = [{ type: "result", subtype: "success", result: "{}" }];
    mockDelayMs = 20;
    concurrencyCounter = 0;
    peakConcurrency = 0;
  });

  afterEach(() => {
    mockDelayMs = 0;
    mock.restore();
  });

  test("maxConcurrency=2 时，6 个并发调用的峰值同时在飞数恰为 2", async () => {
    const cappedConfig: ReviewConfig = { ...testConfig, maxConcurrency: 2 };

    const results = await Promise.all(
      Array.from({ length: 6 }, () => callAgent(cappedConfig, "test prompt", []))
    );

    expect(results).toEqual(Array(6).fill("{}"));
    expect(peakConcurrency).toBe(2);
  });

  test("一个 Claim + 三个 Warrant 的定义审查与链审查在 compileArgument 中真实并行", async () => {
    const db = createTestDb();
    try {
      const cappedConfig: ReviewConfig = { ...testConfig, maxConcurrency: 3, reviewDir: null };
      const claim = makeClaim(db, "Test claim");
      const ground = makeGround(db);
      makeWarrant(db, claim.id, [ground.id], "Warrant 1");
      makeWarrant(db, claim.id, [ground.id], "Warrant 2");
      makeWarrant(db, claim.id, [ground.id], "Warrant 3");

      const result = await compileArgument(db, cappedConfig, claim.id);

      expect(result.verdict).toBe("passed");
      // 4 个定义审查（1 claim + 3 warrant）+ 1 个链审查 = 5 次 LLM 调用，
      // 在 maxConcurrency=3 下应真实重叠（peak >= 2），且不超过上限
      expect(peakConcurrency).toBeGreaterThanOrEqual(2);
      expect(peakConcurrency).toBeLessThanOrEqual(3);
    } finally {
      cleanupDb(db);
    }
  });

  test("reviewStatementEvidencePreCreate 与 compile 时定义审查共享全局并发上限", async () => {
    const db = createTestDb();
    try {
      const cappedConfig: ReviewConfig = { ...testConfig, maxConcurrency: 2, reviewDir: null };
      const claim = makeClaim(db, "Test claim");
      const ground = makeGround(db);
      makeWarrant(db, claim.id, [ground.id], "Test warrant");

      await Promise.all([
        compileArgument(db, cappedConfig, claim.id),
        reviewStatementEvidencePreCreate(cappedConfig, { content: "x", source: "observed", attachments: [] }),
        reviewStatementEvidencePreCreate(cappedConfig, { content: "y", source: "observed", attachments: [] }),
      ]);

      // compileArgument (1 claim + 1 warrant + 1 chain) 与两次 statement 证据审查
      // 共 5 次调用，全部经过同一 callAgent 信号量 —— 组合并发峰值不应超过 cap
      expect(peakConcurrency).toBeGreaterThanOrEqual(2);
      expect(peakConcurrency).toBeLessThanOrEqual(2);
    } finally {
      cleanupDb(db);
    }
  });
});

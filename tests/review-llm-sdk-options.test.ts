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

const testConfig: ReviewConfig = {
  enabled: true,
  provider: "anthropic",
  model: "claude-opus-4-7",
  apiKey: "test-key",
  debounceMs: 30000,
  maxTurns: 10,
  reviewDir: null,
  auditDir: null,
  dbPath: "/tmp/test.db",
};

let capturedOptions: Record<string, unknown> | undefined;
let mockMessages: unknown[] = [];

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { prompt: string; options: Record<string, unknown> }) => {
    capturedOptions = args.options;
    async function* generator() {
      for (const message of mockMessages) {
        yield message;
      }
    }
    return generator();
  },
}));

const { callAgent } = await import("../src/review-llm.ts");

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

  test("仅 success 消息时不调用 console.warn，且正确返回结果", async () => {
    mockMessages = [{ type: "result", subtype: "success", result: "hello" }];
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const res = await callAgent(testConfig, "test prompt", []);
    expect(res).toBe("hello");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

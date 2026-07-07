/**
 * LLM 调用层测试 — review-llm.ts
 *
 * 测试 parseLLMResponse（不调用真实 API）。
 */

import { describe, test, expect } from "bun:test";
import { parseLLMResponse } from "../src/review-llm.ts";

describe("parseLLMResponse", () => {
  test("正常 JSON 响应直接解析", () => {
    const raw = JSON.stringify({
      verdict: "sound",
      summary: "The argument is logically valid.",
      issues: [],
      suggestions: [],
    });

    const result = parseLLMResponse(raw, "concerns");
    expect(result.verdict).toBe("sound");
    expect(result.summary).toBe("The argument is logically valid.");
  });

  test("```json 包裹的响应能正确提取", () => {
    const raw = '```json\n{"verdict":"invalid","summary":"Bad logic"}\n```';

    const result = parseLLMResponse(raw, "concerns");
    expect(result.verdict).toBe("invalid");
  });

  test("无 verdict 字段时使用 fallback", () => {
    const raw = JSON.stringify({ summary: "Some analysis without verdict" });

    const result = parseLLMResponse(raw, "concerns");
    expect(result.verdict).toBe("concerns");
    expect(result._raw).toBe(raw);
  });

  test("无效 JSON 时使用 fallback", () => {
    const raw = "This is not JSON at all, just a text response.";

    const result = parseLLMResponse(raw, "needs_improvement");
    expect(result.verdict).toBe("needs_improvement");
    expect(result.summary).toContain("not JSON");
    expect(result._raw).toBe(raw);
  });

  test("空字符串时使用 fallback", () => {
    const result = parseLLMResponse("", "concerns");
    expect(result.verdict).toBe("concerns");
  });

  test("保留原始 issues 和 suggestions", () => {
    const raw = JSON.stringify({
      verdict: "concerns",
      summary: "Some issues found",
      issues: [
        { severity: "major", element: "warrant", nodeId: 3, message: "If-then bridge" },
        { severity: "minor", element: "ground", nodeId: 2, message: "Weak evidence" },
      ],
      suggestions: ["Generalize the warrant", "Add more grounds"],
    });

    const result = parseLLMResponse(raw, "sound");
    expect(result.verdict).toBe("concerns");
    expect((result.issues as any[]).length).toBe(2);
    expect((result.suggestions as any[]).length).toBe(2);
  });
});

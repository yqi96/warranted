/**
 * Review 集成测试 — 真实 API 调用
 *
 * 使用 .toulmin/review.json 配置，通过转发站调用 Agent SDK。
 * 验证：API 连通 → Agent 执行 → 响应解析。
 *
 * 运行方式：bun test tests/review-integration.test.ts
 */

import { describe, test, expect } from "bun:test";
import { loadReviewConfig } from "../src/review-config.ts";
import { callAgent, parseLLMResponse } from "../src/review-llm.ts";

const CONFIG_PATH = ".toulmin/review.json";
const DB_PATH = ".toulmin/argument.db";

describe("Review 集成测试（真实 API）", () => {
  const config = loadReviewConfig(CONFIG_PATH, DB_PATH);

  test("配置文件加载成功", () => {
    expect(config).not.toBeNull();
    expect(config!.apiKey).toBeTruthy();
    expect(config!.baseUrl).toBeTruthy();
  });

  test("Agent 能完成一次真实推理链审查", async () => {
    if (!config) throw new Error("Config not loaded");

    // 模拟真实的推理链审查 prompt（与 review-prompts.ts 一致）
    const prompt = `You are a rigorous scientific argumentation reviewer. Your task is to evaluate whether a Toulmin argument chain is logically sound.

## Argument Chain to Review

**Claim** (#1, status: proposed): Method A achieves the highest accuracy, therefore it is the best optimization method.

**Warrant** (#3): The method with the highest accuracy is the best.

**Grounds**:
  - Ground #2 [observed/verified]: Method A achieved 95% accuracy on the benchmark dataset.

## Review Checklist

1. **Warrant validity**: Does the Warrant name a genuine domain-general principle? Or is it merely an if-then bridge?
2. **Ground-Claim relevance**: Do the Grounds actually provide evidence for the Claim?
3. **Warrant-Ground fit**: Does the Warrant correctly authorize the inference FROM these Grounds TO this Claim?

## Output Format

Respond in JSON:
{
  "verdict": "sound" | "concerns" | "invalid",
  "summary": "One-paragraph overall assessment",
  "issues": [{"severity": "major" | "minor" | "info", "element": "claim" | "warrant" | "ground", "nodeId": <number>, "message": "..."}],
  "suggestions": ["Actionable improvement suggestions"]
}`;

    const raw = await callAgent(config, prompt, []);
    expect(raw).toBeTruthy();
    console.error("[Integration] Agent raw response (first 500 chars):\n", raw.slice(0, 500));

    const result = parseLLMResponse(raw, "");
    // Argument review 可能返回旧格式 {verdict} 或新格式 {errors, warnings}
    if (result.verdict) {
      expect(["sound", "concerns", "invalid"]).toContain(result.verdict as string);
      console.error("[Integration] Parsed verdict:", result.verdict);
    } else {
      expect(result.errors).toBeDefined();
      console.error("[Integration] Parsed errors:", (result.errors as any[])?.length, "warnings:", (result.warnings as any[])?.length);
    }
  }, { timeout: 120_000 });
});

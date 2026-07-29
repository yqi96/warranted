/**
 * 审查 Prompt 构建测试 — review-prompts.ts
 */

import { describe, test, expect } from "bun:test";
import { buildStatementEvidencePrompt } from "../src/review-prompts.ts";

describe("buildStatementEvidencePrompt", () => {
  test("包含 Statement 信息和附件", () => {
    const prompt = buildStatementEvidencePrompt({
      statement: {
        id: 5,
        content: "温度上升2度",
        source: "observed",
        verification: "verified",
        attachments: ["/data/temp.csv"],
      },
    });

    expect(prompt).toContain("Statement");
    expect(prompt).toContain("#5");
    expect(prompt).toContain("温度上升2度");
    expect(prompt).toContain("/data/temp.csv");
    expect(prompt).toContain("observed");
  });

  test("输出格式要求包含 errors 和 warnings", () => {
    const prompt = buildStatementEvidencePrompt({
      statement: {
        id: 5,
        content: "G",
        source: "observed",
        verification: "verified",
        attachments: [],
      },
    });

    expect(prompt).toContain('"errors"');
    expect(prompt).toContain('"warnings"');
  });

  test("Statement 证据 Prompt 也指示 agent 读取附件", () => {
    const prompt = buildStatementEvidencePrompt({
      statement: {
        id: 5,
        content: "G",
        source: "observed",
        verification: "verified",
        attachments: ["/data.csv"],
      },
    });

    expect(prompt).toContain("MUST use your Read tool");
  });
});

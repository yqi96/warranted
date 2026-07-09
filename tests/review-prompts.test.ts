/**
 * 审查 Prompt 构建测试 — review-prompts.ts
 */

import { describe, test, expect } from "bun:test";
import {
  buildArgumentReviewPrompt,
  buildGroundEvidencePrompt,
} from "../src/review-prompts.ts";

describe("buildArgumentReviewPrompt", () => {
  test("包含 Claim、Warrant、Ground 信息", () => {
    const prompt = buildArgumentReviewPrompt({
      claim: { id: 1, content: "方法A最优", status: "proposed" },
      warrant: { id: 3, content: "准确率最高意味着最优" },
      grounds: [
        { id: 2, content: "方法A准确率95%", source: "observed", verification: "verified", attachments: ["/data.csv"] },
      ],
    });

    expect(prompt).toContain("Claim");
    expect(prompt).toContain("#1");
    expect(prompt).toContain("方法A最优");
    expect(prompt).toContain("Warrant");
    expect(prompt).toContain("#3");
    expect(prompt).toContain("准确率最高意味着最优");
    expect(prompt).toContain("Ground");
    expect(prompt).toContain("#2");
    expect(prompt).toContain("方法A准确率95%");
    // attachments 不包含在推理链审查 prompt 中（纯逻辑分析，不读文件）
    expect(prompt).not.toContain("/data.csv");
  });

  test("包含 Qualifier", () => {
    const prompt = buildArgumentReviewPrompt({
      claim: { id: 1, content: "C", status: "proposed", qualifier: "probably" },
      warrant: { id: 2, content: "W" },
      grounds: [{ id: 3, content: "G", source: "observed", verification: "verified", attachments: [] }],
    });

    expect(prompt).toContain("probably");
  });

  test("包含 Backings 和 Rebuttals", () => {
    const prompt = buildArgumentReviewPrompt({
      claim: { id: 1, content: "C", status: "proposed" },
      warrant: { id: 2, content: "W" },
      grounds: [{ id: 3, content: "G", source: "observed", verification: "verified", attachments: [] }],
      backings: [{ id: 4, content: "方法论支撑" }],
      rebuttals: [{ id: 5, content: "例外情况", targetType: "claim" }],
    });

    expect(prompt).toContain("Backing");
    expect(prompt).toContain("#4");
    expect(prompt).toContain("方法论支撑");
    expect(prompt).toContain("Rebuttal");
    expect(prompt).toContain("#5");
    expect(prompt).toContain("例外情况");
  });

  test("输出格式要求包含 verdict", () => {
    const prompt = buildArgumentReviewPrompt({
      claim: { id: 1, content: "C", status: "proposed" },
      warrant: { id: 2, content: "W" },
      grounds: [{ id: 3, content: "G", source: "observed", verification: "verified", attachments: [] }],
    });

    expect(prompt).toContain('"sound"');
    expect(prompt).toContain('"concerns"');
    expect(prompt).toContain('"invalid"');
  });

  test("推理链审查 Prompt 不要求读文件（纯逻辑分析）", () => {
    const prompt = buildArgumentReviewPrompt({
      claim: { id: 1, content: "C", status: "proposed" },
      warrant: { id: 2, content: "W" },
      grounds: [{ id: 3, content: "G", source: "observed", verification: "verified", attachments: ["/data.csv"] }],
    });

    // Argument review 是纯逻辑分析，不应包含读文件指令
    expect(prompt).not.toContain("MUST use your Read tool");
  });
});

describe("buildGroundEvidencePrompt", () => {
  test("包含 Ground 信息和附件", () => {
    const prompt = buildGroundEvidencePrompt({
      ground: {
        id: 5,
        content: "温度上升2度",
        source: "observed",
        verification: "verified",
        attachments: ["/data/temp.csv"],
      },
    });

    expect(prompt).toContain("Ground");
    expect(prompt).toContain("#5");
    expect(prompt).toContain("温度上升2度");
    expect(prompt).toContain("/data/temp.csv");
    expect(prompt).toContain("observed");
  });

  test("包含引用 Claim", () => {
    const prompt = buildGroundEvidencePrompt({
      ground: {
        id: 5,
        content: "引用证据",
        source: "hypothesis",
        verification: "verified",
        attachments: ["/proof.md"],
        refClaimId: 1,
      },
      referencedClaim: { id: 1, content: "被引用的主张" },
    });

    expect(prompt).toContain("Claim #1");
    expect(prompt).toContain("被引用的主张");
  });

  test("输出格式要求包含 verdict", () => {
    const prompt = buildGroundEvidencePrompt({
      ground: {
        id: 5,
        content: "G",
        source: "observed",
        verification: "verified",
        attachments: [],
      },
    });

    expect(prompt).toContain('"sufficient"');
    expect(prompt).toContain('"insufficient"');
    expect(prompt).toContain('"needs_improvement"');
  });

  test("Ground 证据 Prompt 也指示 agent 读取附件", () => {
    const prompt = buildGroundEvidencePrompt({
      ground: {
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

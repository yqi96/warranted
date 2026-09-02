/**
 * 响应解析 — review-llm.ts 的 parseLLMResponse
 *
 * 这一层**不认识协议**:它只负责"把一段文本变成一个能读的对象",Q1/Q2/findings 的
 * 形状由 review-run.ts 的 interpretResponse 收口。所以这里测的全是文本层面的事——
 * 围栏怎么剥、解析不出来时怎么如实交代,而不是某个字段该长什么样。
 *
 * 尤其:解析失败时**不再伪造一个 `{errors, warnings}` 兜底对象**。伪造的兜底会让
 * 调用方分不清"审查器说没问题"和"审查器根本没说话",而这两者在图上的后果相反。
 */

import { describe, test, expect } from "bun:test";
import { parseLLMResponse } from "../src/review-llm.ts";

describe("parseLLMResponse", () => {
  test("原样返回解析出的对象,不裁剪、不补字段", () => {
    const raw = JSON.stringify({ Q1: "pass", Q2: "fail", findings: [], extra: 1 });

    const result = parseLLMResponse(raw);

    expect(result).toEqual({ Q1: "pass", Q2: "fail", findings: [], extra: 1 });
    expect(result._parseFailed).toBeUndefined();
  });

  test("```json 围栏中的唯一对象会被提取", () => {
    const result = parseLLMResponse('```json\n{"Q1":"n/a","Q2":"pass"}\n```');
    expect(result.Q1).toBe("n/a");
  });

  test("JSON 字符串里的三反引号不影响对象边界", () => {
    const raw = '```json\n{"Q2":"fail","note":"the model wrote ``` inline"}\n```';
    const result = parseLLMResponse(raw);
    expect(result.Q2).toBe("fail");
    expect(result.note).toContain("```");
  });

  test("前置分析文字后的唯一嵌套 JSON 会被恢复", () => {
    const answer = {
      Q1: "fail",
      Q2: "fail",
      findings: [{
        question: "Q1",
        content: 'scope {specific}, with an escaped "quote"',
        citation: { attachment: "evidence/paper.md", quote: "reported result" },
      }],
    };
    const result = parseLLMResponse(
      `I read the attachment and analyzed both questions.\n\n${JSON.stringify(answer)}`,
    );

    expect(result).toEqual(answer);
  });

  test("JSON 后仍有解释文字时不把中途对象当最终答案", () => {
    const result = parseLLMResponse(
      '{"Q1":"pass","Q2":"pass","findings":[]}\nDone.',
    );
    expect(result._parseFailed).toBe(true);
  });

  test("多个合法顶层对象有歧义时失败关闭", () => {
    for (const raw of [
      'draft {"Q1":"pass"}\nfinal {"Q1":"fail","Q2":"fail"}',
      'draft {"Q1":"pass"}\n```json\n{"Q1":"fail","Q2":"fail"}\n```',
    ]) {
      const result = parseLLMResponse(raw);
      expect(result._parseFailed).toBe(true);
      expect(result.Q1).toBeUndefined();
    }
  });

  test("前文有不成对的普通花括号时仍能找到后面的唯一对象", () => {
    const result = parseLLMResponse(
      'Analysis uses { as notation, not JSON.\n{"Q1":"fail","Q2":"fail"}',
    );
    expect(result).toEqual({ Q1: "fail", Q2: "fail" });
  });

  test("解析不出来时标 _parseFailed,并留下原文开头", () => {
    const raw = "This is not JSON at all, just a text response.";

    const result = parseLLMResponse(raw);

    expect(result._parseFailed).toBe(true);
    expect(result._raw).toContain("not JSON at all");
    // 不伪造 errors/warnings:调用方要能区分"没问题"与"没说话"。
    expect(result.errors).toBeUndefined();
    expect(result.warnings).toBeUndefined();
  });

  test("空字符串同样是解析失败,不是一次空的通过", () => {
    const result = parseLLMResponse("");
    expect(result._parseFailed).toBe(true);
  });

  test("合法 JSON 但不是对象(数组/标量)也算失败", () => {
    // JSON.parse("42") 不抛,但一个数字不是协议要的形状。
    expect(parseLLMResponse('[{"Q1":"pass"}]')._parseFailed).toBe(true);
    // 外层数组即使只差一个尾逗号，也不能偷取里面的对象当协议结果。
    expect(parseLLMResponse('[{"Q1":"pass"},]')._parseFailed).toBe(true);
    expect(parseLLMResponse("42")._parseFailed).toBe(true);
    expect(parseLLMResponse('"just a string"')._parseFailed).toBe(true);
    // 整段是 JSON 字符串时，不能二次扫描字符串内容并把它升级成对象。
    expect(parseLLMResponse('"{}"')._parseFailed).toBe(true);
    expect(parseLLMResponse("null")._parseFailed).toBe(true);
  });

  test("_raw 截断到 500 字,不把整段回答塞进错误信息", () => {
    const result = parseLLMResponse("x".repeat(2000));
    expect(result._parseFailed).toBe(true);
    expect((result._raw as string).length).toBe(500);
  });
});

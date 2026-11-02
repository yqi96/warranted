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
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import type { ReviewConfig } from "../src/review-config.ts";
import type { AttachmentRead } from "../src/types.ts";
import { makePdf } from "./pdf-fixture.ts";

const testConfig: ReviewConfig = {
  enabled: true,
  provider: "anthropic",
  model: "claude-opus-4-7",
  apiKey: "test-key",
  maxTurns: 10,
  auditDir: null,
  dbPath: "/tmp/test.db",
};

let capturedOptions: Record<string, unknown> | undefined;
/** 每一次 query() 的入参，按调用顺序。重试路径要看两次调用的差别，只留最后一次不够。 */
let capturedCalls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
let mockMessages: unknown[] = [];
/**
 * 按调用序号给不同的返回消息。null = 每次都用 mockMessages。
 * 空数组表示"没有 success 消息" —— callAgent 会抛 "Agent returned no result"，
 * 这是真实的失败路径，不需要另造一个抛错开关。
 */
let mockMessagesPerCall: unknown[][] | null = null;
let mockErrorsPerCall: Array<Error | null> | null = null;
let mockDelayMs = 0;
let mockCloseCount = 0;
let concurrencyCounter = 0;
let peakConcurrency = 0;
let mockPostToolUseInputs: unknown[] = [];
let mockPostToolUseInputsPerCall: unknown[][] | null = null;

function fullRead(filePath: string): Record<string, unknown> {
  return {
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    tool_use_id: "read-1",
    tool_input: { file_path: filePath },
    tool_response: {
      type: "text",
      file: {
        filePath,
        content: "evidence",
        numLines: 1,
        startLine: 1,
        totalLines: 1,
      },
    },
  };
}

function textRead(
  filePath: string,
  startLine: number,
  numLines: number,
  totalLines: number,
  truncatedByTokenCap = false
): Record<string, unknown> {
  return {
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    tool_use_id: `read-${startLine}`,
    tool_input: { file_path: filePath, offset: startLine, limit: numLines },
    tool_response: {
      type: "text",
      file: {
        filePath,
        content: "segment",
        numLines,
        startLine,
        totalLines,
        ...(truncatedByTokenCap ? { truncatedByTokenCap: true } : {}),
      },
    },
  };
}

function pdfRead(
  filePath: string,
  type: "pdf" | "parts",
  pages?: string
): Record<string, unknown> {
  const bytes = makePdf(10);
  writeFileSync(filePath, bytes);
  return {
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    tool_use_id: `read-${pages ?? "all"}`,
    tool_input: { file_path: filePath, ...(pages ? { pages } : {}) },
    tool_response: type === "pdf"
      ? { type, file: { filePath, base64: bytes.toString("base64"), originalSize: bytes.length } }
      : {
          type,
          file: {
            filePath,
            originalSize: bytes.length,
            count: pages ? 5 : 10,
            outputDir: "/tmp/warranted-sdk-options/pdf-parts",
          },
        },
  };
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { prompt: string; options: Record<string, unknown> }) => {
    capturedOptions = args.options;
    const callIndex = capturedCalls.length;
    capturedCalls.push({ prompt: args.prompt, options: args.options });
    const messages = mockMessagesPerCall
      ? (mockMessagesPerCall[callIndex] ?? mockMessages)
      : mockMessages;
    async function* generator() {
      concurrencyCounter++;
      peakConcurrency = Math.max(peakConcurrency, concurrencyCounter);
      try {
        if (mockDelayMs > 0) {
          await new Promise<void>((resolve, reject) => {
            const signal = (args.options.abortController as AbortController).signal;
            const onAbort = () => { clearTimeout(timer); reject(new Error("SDK aborted")); };
            const timer = setTimeout(() => {
              signal.removeEventListener("abort", onAbort);
              resolve();
            }, mockDelayMs);
            signal.addEventListener("abort", onAbort, { once: true });
          });
        }
        const hookInputs = mockPostToolUseInputsPerCall
          ? (mockPostToolUseInputsPerCall[callIndex] ?? [])
          : mockPostToolUseInputs;
        const hooks = args.options.hooks as
          | {
              PreToolUse?: Array<{ hooks: Array<(input: never) => Promise<unknown>> }>;
              PostToolUse?: Array<{
                hooks: Array<(
                  input: never,
                  toolUseId: string | undefined,
                  options: { signal: AbortSignal },
                ) => Promise<unknown>>;
              }>;
            }
          | undefined;
        const preToolUse = hooks?.PreToolUse ?? [];
        const postToolUse = (
          hooks?.PostToolUse ?? []
        );
        for (const entry of hookInputs) {
          const input = typeof entry === "function" ? entry(args.options) : entry;
          let allowed = true;
          for (const matcher of preToolUse) {
            for (const hook of matcher.hooks) {
              const response = await hook({
                ...(input as Record<string, unknown>),
                hook_event_name: "PreToolUse",
              } as never) as {
                hookSpecificOutput?: { permissionDecision?: string };
              };
              if (response.hookSpecificOutput?.permissionDecision === "deny") allowed = false;
            }
          }
          if (!allowed) continue;
          for (const matcher of postToolUse) {
            for (const hook of matcher.hooks) {
              await hook(
                input as never,
                (input as { tool_use_id?: string }).tool_use_id,
                { signal: new AbortController().signal },
              );
            }
          }
        }
        const error = mockErrorsPerCall?.[callIndex];
        if (error) throw error;
        for (const message of messages) {
          yield message;
        }
      } finally {
        concurrencyCounter--;
      }
    }
    return Object.assign(generator(), { close: () => { mockCloseCount++; } });
  },
}));

beforeEach(() => {
  mockErrorsPerCall = null;
  mockPostToolUseInputs = [];
  mockPostToolUseInputsPerCall = null;
  mkdirSync("/tmp/warranted-sdk-options", { recursive: true });
  writeFileSync("/tmp/warranted-sdk-options/evidence.md", "evidence\n", "utf8");
});

afterEach(() => {
  rmSync("/tmp/warranted-sdk-options/evidence.md", { force: true });
});

const { callAgent, callAndParse } = await import("../src/review-llm.ts");
const { buildReviewRequestPrompt } = await import("../src/review-prompts.ts");
const { runReview } = await import("../src/review-run.ts");
const svc = await import("../src/service.ts");
const { NotFoundError, ReviewUnavailableError } = await import("../src/errors.ts");
const { createTestDb, cleanupDb, checkContextFor } = await import("./helpers.ts");

/** runReview 只用 ctx 解析附件路径,这些用例一个附件都不挂。 */
const ctx = checkContextFor("/tmp/warranted-sdk-options/.toulmin/graph.db");

describe("callAgent SDK call options", () => {
  beforeEach(() => {
    capturedOptions = undefined;
    capturedCalls = [];
    mockMessagesPerCall = null;
    mockMessages = [];
  });

  afterEach(() => {
    mock.restore();
  });

  test("传给 query() 的 permissionMode 是 dontAsk", async () => {
    mockMessages = [{ type: "result", subtype: "success", result: "{}" }];

    await callAgent(testConfig, "test prompt", []);

    expect(capturedOptions?.permissionMode).toBe("dontAsk");
    expect(capturedOptions?.tools).toEqual(["Read"]);
    expect(capturedOptions?.skills).toEqual([]);
    expect(capturedOptions?.strictMcpConfig).toBe(true);
    expect(capturedOptions?.includePartialMessages).toBe(false);
  });

  test("review effort is independent of main-agent overrides", async () => {
    const previousEffort = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    const previousThinking = process.env.MAX_THINKING_TOKENS;
    process.env.CLAUDE_CODE_EFFORT_LEVEL = "max";
    process.env.MAX_THINKING_TOKENS = "32000";
    try {
      mockMessages = [{ type: "result", subtype: "success", result: "{}" }];
      await callAgent({ ...testConfig, effort: "low" }, "test prompt", []);
      expect(capturedOptions?.effort).toBe("low");
      const env = capturedOptions?.env as Record<string, unknown>;
      expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBe("low");
      expect(env.MAX_THINKING_TOKENS).toBeUndefined();
    } finally {
      if (previousEffort === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
      else process.env.CLAUDE_CODE_EFFORT_LEVEL = previousEffort;
      if (previousThinking === undefined) delete process.env.MAX_THINKING_TOKENS;
      else process.env.MAX_THINKING_TOKENS = previousThinking;
    }
  });

  test("timeout cancels and closes one attempt without exhausting later calls", async () => {
    mockDelayMs = 1000;
    mockCloseCount = 0;
    try {
      await expect(callAgent({ ...testConfig, timeoutMs: 15, maxConcurrency: 1 }, "slow", []))
        .rejects.toThrow("timed out after 15 ms");
      expect((capturedOptions?.abortController as AbortController).signal.aborted).toBe(true);
      expect(mockCloseCount).toBeGreaterThan(0);
      expect(concurrencyCounter).toBe(0);
      mockDelayMs = 0;
      mockMessages = [{ type: "result", subtype: "success", result: "{}" }];
      expect(await callAgent({ ...testConfig, timeoutMs: 100, maxConcurrency: 1 }, "new claim", []))
        .toBe("{}");
    } finally { mockDelayMs = 0; }
  });

  test("SDK failure preserves the actual subtype and reason", async () => {
    mockMessages = [{ type: "result", subtype: "error_during_execution", errors: ["32000 output token maximum"] }];
    await expect(callAgent(testConfig, "test prompt", []))
      .rejects.toThrow("Review SDK error_during_execution: 32000 output token maximum");
  });

  test("allowedTools/disallowedTools 保持不变", async () => {
    mockMessages = [{ type: "result", subtype: "success", result: "{}" }];

    await callAgent(testConfig, "test prompt", []);

    expect(capturedOptions?.allowedTools).toEqual(["Read"]);
    expect(capturedOptions?.disallowedTools).toEqual([
      "Edit", "Write", "Bash", "MultiEdit", "Glob", "Grep",
    ]);
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
    // 调用方需要收到拒绝记录,包括审查随后成功完成的情况。
    mockMessages = [
      { type: "system", subtype: "permission_denied", tool_name: "Read", tool_use_id: "x" },
      { type: "result", subtype: "success", result: "{}" },
    ];
    spyOn(console, "warn").mockImplementation(() => {});

    const denied: string[] = [];
    await callAgent(testConfig, "test prompt", [], undefined, undefined, denied);
    expect(denied).toEqual(["Read"]);
  });

  test("denied read followed by sufficient evidence records review and retains denials", async () => {
    mockPostToolUseInputs = [fullRead("wrong-path.md"), fullRead("attachments/0001.md")];
    mockMessages = [{ type: "result", subtype: "success", result: '{"status":"completed","Q1":"pass","Q2":"pass","findings":[]}' }];
    const auditDir = `/tmp/warranted-denied-audit-${crypto.randomUUID()}`;
    const config = { ...testConfig, auditDir };
    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [{ content: "A proposition", evidence: { attachments: ["evidence.md"] } }])[0]!.id;
      const result = await runReview(config, db, id, ctx);
      expect(result.Q1).toBe("pass");
      expect(result.deniedTools).toEqual(["Read:wrong-path.md"]);
      expect(result.attachmentsRead).toEqual(["/tmp/warranted-sdk-options/evidence.md"]);
      const events = svc.getHistory(db, { id }).events.filter(e => e.op === "review");
      expect(events).toHaveLength(1);
      expect(events[0]!.payload.deniedTools).toEqual(result.deniedTools);
      const audit = JSON.parse(readFileSync(`${auditDir}/${readdirSync(auditDir)[0]}`, "utf8"));
      expect(audit.output.deniedTools).toEqual(result.deniedTools);
      expect(audit.input.prompt).toBeUndefined();
      const cached = await runReview(config, db, id, ctx);
      expect(cached.reused).toBe("completed");
      expect(cached.deniedTools).toEqual(result.deniedTools);
    } finally { cleanupDb(db); rmSync(auditDir, { recursive: true, force: true }); }
  });

  test("denied read without successful evidence access remains incomplete", async () => {
    mockPostToolUseInputs = [fullRead("wrong-path.md")];
    mockMessages = [{ type: "result", subtype: "success", result: '{"Q1":"pass","Q2":"pass","findings":[]}' }];
    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [{ content: "A proposition", evidence: { attachments: ["evidence.md"] } }])[0]!.id;
      const err = await runReview(testConfig, db, id, ctx).catch(e => e);
      expect(err).toBeInstanceOf(ReviewUnavailableError);
      expect(err.diagnostics).toMatchObject({ stage: "read", recorded: false, deniedTools: ["Read:wrong-path.md"], attachmentsRead: [] });
      expect(err.diagnostics.attempts[0].deniedTools).toEqual(["Read:wrong-path.md"]);
      expect(svc.getHistory(db, { id }).events.some(e => e.op === "review")).toBe(false);
    } finally { cleanupDb(db); }
  });

  test("a denial in an unparseable first attempt does not veto a sufficient retry", async () => {
    mockMessagesPerCall = [
      [{ type: "result", subtype: "success", result: "not JSON" }],
      [{ type: "result", subtype: "success", result: '{"Q1":"pass","Q2":"pass","findings":[]}' }],
    ];
    mockPostToolUseInputsPerCall = [[fullRead("wrong-path.md")], [fullRead("attachments/0001.md")]];
    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [{ content: "A proposition", evidence: { attachments: ["evidence.md"] } }])[0]!.id;
      const result = await runReview({ ...testConfig, fallbackModel: "fallback" }, db, id, ctx);
      expect(result.actualModel).toBe("fallback");
      expect(result.deniedTools).toEqual(["Read:wrong-path.md"]);
      expect(svc.getHistory(db, { id }).events.filter(e => e.op === "review")).toHaveLength(1);
    } finally { cleanupDb(db); }
  });

  test("仅 success 消息时不调用 console.warn，且正确返回结果", async () => {
    mockMessages = [{ type: "result", subtype: "success", result: "hello" }];
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const res = await callAgent(testConfig, "test prompt", []);
    expect(res).toBe("hello");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("只把完整成功的 Read 记入轨迹，部分读取不算", async () => {
    mockMessages = [{ type: "result", subtype: "success", result: "{}" }];
    const filePath = "/tmp/warranted-sdk-options/evidence.md";
    mockPostToolUseInputs = [
      fullRead(filePath),
      {
        ...fullRead("/tmp/warranted-sdk-options/partial.md"),
        tool_response: {
          type: "text",
          file: {
            filePath: "/tmp/warranted-sdk-options/partial.md",
            content: "first page",
            numLines: 1,
            startLine: 1,
            totalLines: 2,
          },
        },
      },
    ];
    const reads: string[] = [];

    await callAgent(
      testConfig,
      "test prompt",
      ["evidence.md", "partial.md"],
      "/tmp/warranted-sdk-options",
      undefined,
      [],
      reads
    );

    expect(reads).toEqual([filePath]);
  });

  test("同一文本的乱序、重叠分段 Read 累计覆盖全部行后只记一次", async () => {
    mockMessages = [{ type: "result", subtype: "success", result: "{}" }];
    const filePath = "/tmp/warranted-sdk-options/evidence.md";
    mockPostToolUseInputs = [
      textRead(filePath, 6, 3, 10),
      textRead(filePath, 1, 4, 10),
      textRead(filePath, 4, 3, 10),
      textRead(filePath, 9, 2, 10),
      textRead(filePath, 1, 10, 10),
    ];
    const reads: string[] = [];

    await callAgent(
      testConfig,
      "test prompt",
      ["evidence.md"],
      "/tmp/warranted-sdk-options",
      undefined,
      [],
      reads
    );

    expect(reads).toEqual([filePath]);
  });

  test("文本分段有空洞、token 截断或 totalLines 矛盾时不宣称完整", async () => {
    mockMessages = [{ type: "result", subtype: "success", result: "{}" }];
    const gapPath = "/tmp/warranted-sdk-options/gap.md";
    const truncatedPath = "/tmp/warranted-sdk-options/truncated.md";
    const inconsistentPath = "/tmp/warranted-sdk-options/inconsistent.md";
    mockPostToolUseInputs = [
      textRead(gapPath, 1, 4, 10),
      textRead(gapPath, 6, 5, 10),
      textRead(truncatedPath, 1, 10, 10, true),
      textRead(inconsistentPath, 6, 5, 10),
      textRead(inconsistentPath, 1, 5, 5),
    ];
    const reads: string[] = [];

    await callAgent(
      testConfig,
      "test prompt",
      ["gap.md", "truncated.md", "inconsistent.md"],
      "/tmp/warranted-sdk-options",
      undefined,
      [],
      reads
    );

    expect(reads).toEqual([]);
  });

  test("PDF 无 pages 的 pdf/parts 响应保持整份读取行为", async () => {
    mockMessages = [{ type: "result", subtype: "success", result: "{}" }];
    const small = "/tmp/warranted-sdk-options/small.pdf";
    const extracted = "/tmp/warranted-sdk-options/extracted.pdf";
    mockPostToolUseInputs = [pdfRead(small, "pdf"), pdfRead(extracted, "parts")];
    const reads: string[] = [];

    await callAgent(
      testConfig,
      "test prompt",
      ["small.pdf", "extracted.pdf"],
      "/tmp/warranted-sdk-options",
      undefined,
      [],
      reads
    );

    expect(reads).toEqual([small, extracted]);
  });

  test("PDF multiple actual page ranges cover the independently measured whole document", async () => {
    mockMessages = [{ type: "result", subtype: "success", result: "{}" }];
    const filePath = "/tmp/warranted-sdk-options/evidence.pdf";
    mockPostToolUseInputs = [
      pdfRead(filePath, "parts", "1-5"),
      pdfRead(filePath, "parts", "6-10"),
    ];
    const reads: string[] = [];

    await callAgent(
      testConfig,
      "test prompt",
      ["evidence.pdf"],
      "/tmp/warranted-sdk-options",
      undefined,
      [],
      reads
    );

    expect(reads).toEqual([filePath]);
  });

  test("review prompt permits selective reading and explicit evidence gaps", () => {
    const prompt = buildReviewRequestPrompt({
      id: 1,
      content: "A proposition",
      warrant: null,
      attachments: ["evidence.pdf"],
      evidenceNodes: [],
    });

    expect(prompt).toContain("may be read in page ranges");
    expect(prompt).not.toContain("cover every page");
    expect(prompt).not.toContain("open every corresponding");
    expect(prompt).toContain("You need not read every attachment or every page");
    expect(prompt).toContain('"status": "incomplete"');
    expect(prompt).toContain("relevant contrary evidence");
  });

  test("partial text and an unread unrelated attachment can complete without claiming full coverage", async () => {
    writeFileSync("/tmp/warranted-sdk-options/unrelated.md", "unrelated\n");
    mockPostToolUseInputs = [textRead("attachments/0001.md", 3, 2, 10)];
    mockMessages = [{ type: "result", subtype: "success", result: '{"Q1":"pass","Q2":"pass","findings":[]}' }];
    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [{ content: "A proposition", evidence: { attachments: ["evidence.md", "unrelated.md"] } }])[0]!.id;
      const result = await runReview(testConfig, db, id, ctx);
      expect(result.attachmentsRead).toEqual(["/tmp/warranted-sdk-options/evidence.md"]);
      expect(result.unreadAttachments).toEqual(["/tmp/warranted-sdk-options/unrelated.md"]);
      expect(result.attachmentReads).toEqual([{ path: "/tmp/warranted-sdk-options/evidence.md", kind: "text", ranges: [[3, 4]], total: 10, complete: false }]);
      expect(svc.getHistory(db, { id }).events.filter((e) => e.op === "review")).toHaveLength(1);
      const cached = await runReview(testConfig, db, id, ctx);
      expect(cached.reused).toBe("completed");
      expect(cached.attachmentReads).toEqual(result.attachmentReads);
    } finally { cleanupDb(db); }
  });

  test("65-page PDF can complete after five relevant pages, with truthful normal audit", async () => {
    const bytes = makePdf(65);
    writeFileSync("/tmp/warranted-sdk-options/selective.pdf", bytes);
    mockPostToolUseInputs = [(options: { cwd: string }) => {
      const path = `${options.cwd}/attachments/0001.pdf`;
      return { hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "pdf-range",
        tool_input: { file_path: path, pages: "41-45" },
        tool_response: { type: "parts", file: { filePath: path, originalSize: bytes.length, count: 5, outputDir: "/tmp/sdk-pages" } } };
    }];
    mockMessages = [{ type: "result", subtype: "success", result: '{"Q1":"pass","Q2":"pass","findings":[]}' }];
    const db = createTestDb();
    const auditDir = `/tmp/warranted-sdk-options/selective-audit-${crypto.randomUUID()}`;
    try {
      const id = svc.createPropositions(db, ctx, [{ content: "A proposition", evidence: { attachments: ["selective.pdf"] } }])[0]!.id;
      const result = await runReview({ ...testConfig, auditDir }, db, id, ctx);
      expect(result.attachmentReads).toEqual([{ path: "/tmp/warranted-sdk-options/selective.pdf", kind: "pdf", ranges: [[41, 45]], total: 65, complete: false }]);
      const audit = JSON.parse(readFileSync(`${auditDir}/${readdirSync(auditDir)[0]}`, "utf8"));
      expect(audit.output.successfulReads).toEqual([]);
      expect(audit.output.attachmentReads).toEqual([{ path: "selective.pdf", kind: "pdf", ranges: [[41, 45]], total: 65, complete: false }]);
      expect(audit.input.prompt).toBeUndefined();
      expect(svc.getHistory(db, { id }).events.filter((e) => e.op === "review")).toHaveLength(1);
    } finally { cleanupDb(db); }
  });

  test("explicit evidence gap preserves candidates and earlier review without retrying or recording a pass", async () => {
    mockPostToolUseInputs = [textRead("attachments/0001.md", 1, 1, 10)];
    mockMessages = [{ type: "result", subtype: "success", result: '{"Q1":"pass","Q2":"pass","findings":[]}' }];
    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [{ content: "A proposition", evidence: { attachments: ["evidence.md"] } }])[0]!.id;
      await runReview(testConfig, db, id, ctx);
      mockMessages = [{ type: "result", subtype: "success", result: JSON.stringify({ status: "incomplete", reason: "The necessary methods table could not be read", findings: [{ question: "Q1", confidence: "high", content: "A number differs", citation: { attachment: "evidence.md", locator: "line 1", quote: "evidence" } }] }) }];
      mockMessages.unshift({ type: "system", subtype: "permission_denied", tool_name: "Read", tool_use_id: "missing-table" });
      const err = await runReview(testConfig, db, id, ctx, { refresh: true }).catch(e => e);
      expect(err).toBeInstanceOf(ReviewUnavailableError);
      expect(err.diagnostics).toMatchObject({ status: "incomplete", recorded: false, stage: "read", attachmentsRead: ["evidence.md"], unreadAttachments: [] });
      expect(err.message).toContain("necessary methods table");
      expect(err.diagnostics.deniedTools).toEqual(["Read"]);
      expect(err.diagnostics.candidateFindings).toHaveLength(1);
      expect(err.diagnostics).not.toHaveProperty("Q1");
      expect(err.diagnostics.attempts).toHaveLength(1);
      expect(capturedCalls).toHaveLength(2);
      expect(svc.getHistory(db, { id }).events.filter((e) => e.op === "review")).toHaveLength(1);
    } finally { cleanupDb(db); }
  });

  test("reading one attachment does not license a Q1 citation from another unread attachment", async () => {
    writeFileSync("/tmp/warranted-sdk-options/unrelated.md", "unrelated\n");
    mockPostToolUseInputs = [textRead("attachments/0001.md", 1, 1, 10)];
    mockMessages = [{ type: "result", subtype: "success", result: JSON.stringify({ Q1: "fail", Q2: "pass", findings: [{ question: "Q1", confidence: "high", content: "A number differs", citation: { attachment: "unrelated.md", locator: "line 1", quote: "unrelated" } }] }) }];
    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [{ content: "A proposition", evidence: { attachments: ["evidence.md", "unrelated.md"] } }])[0]!.id;
      const err = await runReview(testConfig, db, id, ctx).catch(e => e);
      expect(err.message).toContain("cited an unread attachment");
      expect(svc.getHistory(db, { id }).events.filter((e) => e.op === "review")).toHaveLength(0);
    } finally { cleanupDb(db); }
  });

  test("failed or truncated reads do not become observed access under selective reading", async () => {
    const failed = textRead("attachments/0001.md", 1, 1, 10);
    (failed.tool_response as Record<string, unknown>).isError = true;
    mockPostToolUseInputs = [textRead("attachments/0001.md", 1, 1, 10, true), failed];
    mockMessages = [{ type: "result", subtype: "success", result: '{"Q1":"pass","Q2":"pass","findings":[]}' }];
    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [{ content: "A proposition", evidence: { attachments: ["evidence.md"] } }])[0]!.id;
      const err = await runReview(testConfig, db, id, ctx).catch(e => e);
      expect(err.diagnostics.attachmentReads).toEqual([]);
      expect(err.message).toContain("did not successfully Read any attachment");
    } finally { cleanupDb(db); }
  });

  test("partial reads survive SDK execution failure in the attempt trace", async () => {
    mockPostToolUseInputs = [textRead("attachments/0001.md", 7, 2, 10)];
    mockMessages = [];
    const observed: AttachmentRead[] = [];
    await callAgent(testConfig, "prompt", ["attachments/0001.md"], "/tmp/warranted-sdk-options", undefined, [], [], undefined, 1, observed).catch(() => {});
    expect(observed).toEqual([{ path: "/tmp/warranted-sdk-options/attachments/0001.md", kind: "text", ranges: [[7, 8]], total: 10, complete: false }]);
  });

  test("Read 路径白名单拒绝未声明文件,且不把它记成成功读取", async () => {
    mockMessages = [{ type: "result", subtype: "success", result: "{}" }];
    mockPostToolUseInputs = [fullRead("/tmp/warranted-sdk-options/other.md")];
    const denied: string[] = [];
    const reads: string[] = [];
    spyOn(console, "warn").mockImplementation(() => {});

    await callAgent(
      testConfig,
      "test prompt",
      ["evidence.md"],
      "/tmp/warranted-sdk-options",
      undefined,
      denied,
      reads
    );

    expect(denied.join(" ")).toContain("other.md");
    expect(reads).toEqual([]);
  });

  test("有附件但没有任何有效 Read 时，runReview 作废且不落事件", async () => {
    mockMessages = [
      { type: "result", subtype: "success", result: '{"Q1":"pass","Q2":"pass","findings":[]}' },
    ];
    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [
        { content: "A proposition", evidence: { attachments: ["evidence.md"] } },
      ])[0]!.id;
      const err = await runReview(testConfig, db, id, ctx).catch((e) => e);
      expect(err).toBeInstanceOf(ReviewUnavailableError);
      expect(err.message).toContain("did not successfully Read any attachment");
      expect(svc.getHistory(db, { id }).events.some((e) => e.op === "review")).toBe(false);
    } finally {
      cleanupDb(db);
    }
  });

  test("fallback verdict 只承认 fallback 那次的完整 Read，并记录实际模型", async () => {
    const filePath = "/tmp/warranted-sdk-options/evidence.md";
    const snapshotPath = "attachments/0001.md";
    mockMessagesPerCall = [
      [{ type: "result", subtype: "success", result: "not-json" }],
      [
        {
          type: "result",
          subtype: "success",
          result: '{"Q1":"pass","Q2":"pass","findings":[]}',
        },
      ],
    ];
    mockPostToolUseInputsPerCall = [[], [fullRead(snapshotPath)]];
    const db = createTestDb();
    try {
      const config: ReviewConfig = {
        ...testConfig,
        fallbackModel: "fallback-reviewer",
        dbPath: "/tmp/warranted-sdk-options/.toulmin/graph.db",
      };
      const id = svc.createPropositions(db, ctx, [
        { content: "A proposition", evidence: { attachments: ["evidence.md"] } },
      ])[0]!.id;
      const result = await runReview(config, db, id);
      expect(result.actualModel).toBe("fallback-reviewer");
      expect(result.attachmentsRead).toEqual([filePath]);
      const event = svc.getHistory(db, { id }).events.find((item) => item.op === "review")!;
      expect(event.payload.model).toBe("fallback-reviewer");
    } finally {
      cleanupDb(db);
    }
  });

  test("首轮读过但最终 fallback 没读时仍作废", async () => {
    const filePath = "/tmp/warranted-sdk-options/evidence.md";
    const snapshotPath = "attachments/0001.md";
    mockMessagesPerCall = [
      [{ type: "result", subtype: "success", result: "not-json" }],
      [
        {
          type: "result",
          subtype: "success",
          result: '{"Q1":"pass","Q2":"pass","findings":[]}',
        },
      ],
    ];
    mockPostToolUseInputsPerCall = [[fullRead(snapshotPath)], []];
    const db = createTestDb();
    try {
      const config: ReviewConfig = {
        ...testConfig,
        fallbackModel: "fallback-reviewer",
        dbPath: "/tmp/warranted-sdk-options/.toulmin/graph.db",
      };
      const id = svc.createPropositions(db, ctx, [
        { content: "A proposition", evidence: { attachments: ["evidence.md"] } },
      ])[0]!.id;
      const err = await runReview(config, db, id).catch((e) => e);
      expect(err).toBeInstanceOf(ReviewUnavailableError);
      expect(svc.getHistory(db, { id }).events.some((event) => event.op === "review")).toBe(false);
    } finally {
      cleanupDb(db);
    }
  });

  test("模型运行期间命题输入改变:整次作废且不落 review 事件", async () => {
    mockDelayMs = 20;
    mockMessages = [
      { type: "result", subtype: "success", result: '{"Q1":"n/a","Q2":"pass","findings":[]}' },
    ];
    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [{ content: "Before" }])[0]!.id;
      const running = runReview(testConfig, db, id, ctx).catch((e) => e);
      await new Promise((resolve) => setTimeout(resolve, 5));
      svc.updateProposition(db, ctx, { id, content: "After" });
      const err = await running;
      expect(err).toBeInstanceOf(ReviewUnavailableError);
      expect(err.message).toContain("changed");
      expect(err.message).toContain("Nothing was recorded");
      expect(svc.getHistory(db, { id }).events.some((event) => event.op === "review")).toBe(false);
    } finally {
      mockDelayMs = 0;
      cleanupDb(db);
    }
  });

  test("模型运行期间附件字节改变:整次作废且不落 review 事件", async () => {
    mockDelayMs = 20;
    const filePath = "/tmp/warranted-sdk-options/evidence.md";
    mockPostToolUseInputs = [fullRead("attachments/0001.md")];
    mockMessages = [
      { type: "result", subtype: "success", result: '{"Q1":"pass","Q2":"pass","findings":[]}' },
    ];
    const config: ReviewConfig = {
      ...testConfig,
      dbPath: "/tmp/warranted-sdk-options/.toulmin/graph.db",
    };
    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [
        { content: "A proposition", evidence: { attachments: ["evidence.md"] } },
      ])[0]!.id;
      const running = runReview(config, db, id, ctx).catch((e) => e);
      await new Promise((resolve) => setTimeout(resolve, 5));
      writeFileSync(filePath, "changed during review\n", "utf8");
      const err = await running;
      expect(err).toBeInstanceOf(ReviewUnavailableError);
      expect(err.message).toContain("changed");
      expect(err.message).toContain("Nothing was recorded");
      expect(svc.getHistory(db, { id }).events.some((event) => event.op === "review")).toBe(false);
    } finally {
      mockDelayMs = 0;
      cleanupDb(db);
    }
  });

  test("附件 A→B→A 时 reviewer 始终读不可变 A 快照,最终 review 可保持 current", async () => {
    mockDelayMs = 30;
    const filePath = "/tmp/warranted-sdk-options/evidence.md";
    mockPostToolUseInputs = [fullRead("attachments/0001.md")];
    mockMessages = [
      { type: "result", subtype: "success", result: '{"Q1":"pass","Q2":"pass","findings":[]}' },
    ];
    const config: ReviewConfig = {
      ...testConfig,
      dbPath: "/tmp/warranted-sdk-options/.toulmin/graph.db",
    };
    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [
        { content: "A proposition", evidence: { attachments: ["evidence.md"] } },
      ])[0]!.id;
      const running = runReview(config, db, id, ctx);
      await new Promise((resolve) => setTimeout(resolve, 5));
      writeFileSync(filePath, "temporary B\n", "utf8");
      await new Promise((resolve) => setTimeout(resolve, 5));
      writeFileSync(filePath, "evidence\n", "utf8");
      const result = await running;

      expect(result.Q1).toBe("pass");
      expect(svc.propositionView(db, ctx, id).review.status).toBe("current");
      expect(String(capturedCalls[0]!.options.cwd)).toContain("warranted-review-");
      expect(capturedCalls[0]!.prompt).toContain('"evidence.md" -> attachments/0001.md');
    } finally {
      mockDelayMs = 0;
      cleanupDb(db);
    }
  });

  test("Q2=fail 但没有有效 Q2 finding:协议失败且不落事件", async () => {
    mockMessages = [
      { type: "result", subtype: "success", result: '{"Q1":"n/a","Q2":"fail","findings":[]}' },
    ];
    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [{ content: "A proposition" }])[0]!.id;
      const err = await runReview(testConfig, db, id, ctx).catch((e) => e);
      expect(err).toBeInstanceOf(ReviewUnavailableError);
      expect(err.message).toContain("verdict and accepted findings disagree");
      expect(svc.getHistory(db, { id }).events.some((event) => event.op === "review")).toBe(false);
    } finally {
      cleanupDb(db);
    }
  });
});

describe("callAgent 全局并发上限", () => {
  beforeEach(() => {
    mockMessages = [{ type: "result", subtype: "success", result: "{}" }];
    mockMessagesPerCall = null;
    capturedCalls = [];
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

  test("多条命题同时 review 时共享同一个全局信号量", async () => {
    // 信号量是模块级的:限的是"这个进程同时在飞多少次 LLM 调用",不是"每次调用方
    // 各自限几个"。按调用方分别限流从来限不住总量 —— 上层一个 Promise.all 就穿透了。
    mockMessages = [
      { type: "result", subtype: "success", result: '{"Q1":"n/a","Q2":"pass","findings":[]}' },
    ];
    const db = createTestDb();
    try {
      const capped: ReviewConfig = { ...testConfig, maxConcurrency: 2 };
      const ids = svc
        .createPropositions(db, ctx, [
          { content: "one" },
          { content: "two" },
          { content: "three" },
          { content: "four" },
          { content: "five" },
        ])
        .map((r) => r.id);

      await Promise.all(ids.map((id) => runReview(capped, db, id)));

      expect(peakConcurrency).toBeGreaterThanOrEqual(2);
      expect(peakConcurrency).toBeLessThanOrEqual(2);
    } finally {
      cleanupDb(db);
    }
  });

  test("裸 callAgent 与 runReview 共用那一个信号量,不各限各的", async () => {
    mockMessages = [
      { type: "result", subtype: "success", result: '{"Q1":"n/a","Q2":"pass","findings":[]}' },
    ];
    const db = createTestDb();
    try {
      const capped: ReviewConfig = { ...testConfig, maxConcurrency: 2 };
      const id = svc.createPropositions(db, ctx, [{ content: "one" }])[0]!.id;

      await Promise.all([
        runReview(capped, db, id),
        callAgent(capped, "p", []),
        callAgent(capped, "p", []),
        callAgent(capped, "p", []),
      ]);

      expect(peakConcurrency).toBe(2);
    } finally {
      cleanupDb(db);
    }
  });
});

// =============================================================================
// D36 — 配置里的凭据必须递到 SDK
// =============================================================================

/**
 * apiKey/baseUrl 曾经被 loadReviewConfig 读进来、被文档要求填写、缺失时还会直接
 * 关掉审查，但 src/ 里零个消费者：callAgent 传给 query() 的 options 只有
 * model/maxTurns/工具白名单/permissionMode/cwd/mcpServers。SDK 起的是子进程，
 * 于是真正生效的是外部 shell 的环境变量 —— 用户写在 review.json 里的转发站地址
 * 从来没被用过，而加载日志照样打 "Config loaded"。
 */
describe("配置里的凭据递给 SDK", () => {
  beforeEach(() => {
    capturedOptions = undefined;
    capturedCalls = [];
    mockMessagesPerCall = null;
    mockMessages = [{ type: "result", subtype: "success", result: "{}" }];
  });

  afterEach(() => {
    mock.restore();
  });

  function env(): Record<string, string | undefined> {
    return capturedOptions?.env as Record<string, string | undefined>;
  }

  test("apiKey 同时作为 API_KEY 和 AUTH_TOKEN 出现在 options.env 里", async () => {
    await callAgent(testConfig, "test prompt", []);
    // SDK 的 apiKeyAuth() 发 X-Api-Key、bearerAuth() 发 Authorization: Bearer，
    // 两者独立读这两个变量且同时设置不冲突。官方 endpoint 认前者，
    // 转发站常只认后者，配置里只有一个"凭据"字段说不清该走哪种 —— 两个都给。
    expect(env().ANTHROPIC_API_KEY).toBe("test-key");
    expect(env().ANTHROPIC_AUTH_TOKEN).toBe("test-key");
  });

  test("baseUrl 作为 ANTHROPIC_BASE_URL 出现在 options.env 里", async () => {
    const proxied: ReviewConfig = { ...testConfig, baseUrl: "https://proxy.example.com" };
    await callAgent(proxied, "test prompt", []);
    expect(env().ANTHROPIC_BASE_URL).toBe("https://proxy.example.com");
  });

  test("未配 baseUrl 时沿用外部环境变量，不被抹成 undefined", async () => {
    // 不能断言"键不出现"：...process.env 已经把外部的同名变量铺进来了。
    // 要守的是别把它写成 undefined —— 那等于把一个本来能工作的 endpoint 关掉。
    const saved = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "https://ambient.example.com";
    try {
      await callAgent(testConfig, "test prompt", []);
      expect(env().ANTHROPIC_BASE_URL).toBe("https://ambient.example.com");
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = saved;
    }
  });

  test("配置文件里的值压过外部环境变量", async () => {
    const saved = {
      key: process.env.ANTHROPIC_API_KEY,
      token: process.env.ANTHROPIC_AUTH_TOKEN,
      url: process.env.ANTHROPIC_BASE_URL,
    };
    process.env.ANTHROPIC_API_KEY = "ambient-key";
    process.env.ANTHROPIC_AUTH_TOKEN = "ambient-token";
    process.env.ANTHROPIC_BASE_URL = "https://ambient.example.com";
    try {
      const proxied: ReviewConfig = { ...testConfig, baseUrl: "https://proxy.example.com" };
      await callAgent(proxied, "test prompt", []);
      // 为审查专门写的配置是更明确的选择，必须赢
      expect(env().ANTHROPIC_API_KEY).toBe("test-key");
      expect(env().ANTHROPIC_AUTH_TOKEN).toBe("test-key");
      expect(env().ANTHROPIC_BASE_URL).toBe("https://proxy.example.com");
    } finally {
      for (const [name, value] of [
        ["ANTHROPIC_API_KEY", saved.key],
        ["ANTHROPIC_AUTH_TOKEN", saved.token],
        ["ANTHROPIC_BASE_URL", saved.url],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("其余环境变量被铺进去，不是把子进程环境清空", async () => {
    // 显式传 env 会替换继承来的整个环境。少了 ...process.env，
    // 子进程就丢掉 PATH/HOME 这类东西 —— 比原缺陷更糟。
    process.env.WARRANTED_TEST_SENTINEL = "sentinel-value";
    try {
      await callAgent(testConfig, "test prompt", []);
      expect(env().WARRANTED_TEST_SENTINEL).toBe("sentinel-value");
      expect(env().PATH).toBe(process.env.PATH);
    } finally {
      delete process.env.WARRANTED_TEST_SENTINEL;
    }
  });

  test("传 settingSources: [] 隔离文件设置，否则配置里的凭据会被用户 settings 盖掉", async () => {
    // 这条断言的依据不是本文件的 mock —— mock 只能证明"我们传了什么"。
    // 依据是一次实测：删掉 process.env 里的三个 ANTHROPIC_* 后，
    // 给 config.baseUrl 填 http://127.0.0.1:1（必然连不上），请求照样 6.5 秒成功；
    // 加上 settingSources: [] 之后同一个死地址才真的失败、真地址才真的成功。
    // 原因是子进程是完整的 Claude Code CLI，启动后自己读 ~/.claude/settings.json
    // 的 env 段。上面那个 env 传得再对，也会被它盖掉一遍。
    await callAgent(testConfig, "test prompt", []);
    expect(capturedOptions?.settingSources).toEqual([]);
  });

  test("隔离只挡文件设置，外部 shell 的环境变量照样递进去", async () => {
    // settingSources 和 ...process.env 管的是两件不同的事，别把前者当成"什么都不继承"。
    process.env.WARRANTED_TEST_SENTINEL = "from-shell";
    try {
      await callAgent(testConfig, "test prompt", []);
      expect(capturedOptions?.settingSources).toEqual([]);
      expect(env().WARRANTED_TEST_SENTINEL).toBe("from-shell");
    } finally {
      delete process.env.WARRANTED_TEST_SENTINEL;
    }
  });

  test("审计日志记 baseUrl，绝不记 apiKey", async () => {
    // 缺陷长期无法定位的原因之一：审计只记 model/maxTurns，看不出请求去了哪里。
    const auditDir = `/tmp/warranted-audit-${Date.now()}-${Math.round(performance.now())}`;
    try {
      const audited: ReviewConfig = {
        ...testConfig,
        baseUrl: "https://proxy.example.com",
        auditDir,
      };
      await callAgent(audited, "test prompt", []);
      const files = readdirSync(auditDir);
      expect(files.length).toBe(1);
      const body = readFileSync(`${auditDir}/${files[0]}`, "utf-8");
      expect(JSON.parse(body).baseUrl).toBe("https://proxy.example.com");
      expect(body).not.toContain("test-key");
    } finally {
      try { rmSync(auditDir, { recursive: true }); } catch {}
    }
  });

  test("normal audit retains actual usage without full prompt or response", async () => {
    const auditDir = `/tmp/warranted-usage-${crypto.randomUUID()}`;
    try {
      mockMessages = [
        { type: "system", subtype: "init", model: "sdk-reported-model" },
        { type: "result", subtype: "success", result: "private response", usage: { input_tokens: 12, output_tokens: 7 }, total_cost_usd: 0.012, duration_api_ms: 30 },
      ];
      await callAgent({ ...testConfig, auditDir }, "private prompt", []);
      const body = readFileSync(`${auditDir}/${readdirSync(auditDir)[0]}`, "utf8");
      const audit = JSON.parse(body);
      expect(audit.status).toBe("completed");
      expect(audit.telemetry).toMatchObject({ actualModel: "sdk-reported-model", usage: { input_tokens: 12, output_tokens: 7 }, totalCostUsd: 0.012, durationApiMs: 30 });
      expect(audit.output.queueMs).toBeGreaterThanOrEqual(0);
      expect(body).not.toContain("private prompt");
      expect(body).not.toContain("private response");
    } finally { rmSync(auditDir, { recursive: true, force: true }); }
  });

  test.each(["empty", "sdk_error", "timeout"])("%s leaves a failed attempt audit", async (mode) => {
    const auditDir = `/tmp/warranted-failed-audit-${crypto.randomUUID()}`;
    try {
      mockMessages = mode === "sdk_error"
        ? [{ type: "result", subtype: "error_during_execution", errors: ["output exceeds 32000 tokens"] }]
        : [];
      mockDelayMs = mode === "timeout" ? 100 : 0;
      await expect(callAgent({ ...testConfig, auditDir, timeoutMs: mode === "timeout" ? 10 : 1000 }, "private prompt", [])).rejects.toThrow();
      const audit = JSON.parse(readFileSync(`${auditDir}/${readdirSync(auditDir)[0]}`, "utf8"));
      expect(audit.status).toBe("failed");
      expect(audit.output.error.message).toContain(mode === "timeout" ? "timed out" : mode === "sdk_error" ? "32000" : "no result");
      expect(audit.telemetry.totalCostUsd).toBeNull();
      expect(audit.telemetry.usage).toBeNull();
    } finally {
      mockDelayMs = 0;
      rmSync(auditDir, { recursive: true, force: true });
    }
  });

  test("debug review preserves exact snapshot bytes after cleanup and source edits", async () => {
    const auditDir = `/tmp/warranted-debug-review-${crypto.randomUUID()}`;
    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [{ content: "Evidence exists", evidence: { attachments: ["evidence.md"] } }])[0]!.id;
      mockPostToolUseInputs = [fullRead("attachments/0001.md")];
      mockMessages = [{ type: "result", subtype: "success", result: '{"Q1":"pass","Q2":"pass","findings":[]}' }];
      await runReview({ ...testConfig, auditDir, debug: true }, db, id, ctx);
      expect(capturedOptions?.includePartialMessages).toBe(true);
      const filename = readdirSync(auditDir).find((file) => file.endsWith(".json"))!;
      const audit = JSON.parse(readFileSync(`${auditDir}/${filename}`, "utf8"));
      const archive = audit.input.attachmentArchive[0];
      writeFileSync("/tmp/warranted-sdk-options/evidence.md", "different later bytes");
      expect(readFileSync(`${auditDir}/${archive.storedPath}`, "utf8")).toBe("evidence\n");
      expect(audit.input.prompt).toContain("Evidence exists");
      expect(audit.output.raw).toContain('"Q1":"pass"');
      expect(readFileSync(`${auditDir}/${audit.input.eventsPath}`, "utf8")).toContain("read_result");
      expect(() => readFileSync(`${audit.input.cwd}/${archive.readPath}`)).toThrow();
    } finally { cleanupDb(db); rmSync(auditDir, { recursive: true, force: true }); }
  });

  test("parse fallback writes two distinct attempts with the same request identity", async () => {
    const auditDir = `/tmp/warranted-retry-audit-${crypto.randomUUID()}`;
    try {
      mockMessagesPerCall = [
        [{ type: "result", subtype: "success", result: "not json" }],
        [{ type: "result", subtype: "success", result: "{}" }],
      ];
      await callAndParse({ ...testConfig, auditDir }, "p", [], "/tmp");
      const audits = readdirSync(auditDir).map((file) => JSON.parse(readFileSync(`${auditDir}/${file}`, "utf8")));
      expect(audits).toHaveLength(2);
      expect(new Set(audits.map((audit) => audit.requestId)).size).toBe(1);
      expect(audits.map((audit) => audit.attempt).sort()).toEqual([1, 2]);
      expect(audits.every((audit) => audit.scope === "model_attempt")).toBe(true);
    } finally { rmSync(auditDir, { recursive: true, force: true }); }
  });

  test("审计同时保存声明附件读取和实际私有快照路径", async () => {
    const auditDir = `/tmp/warranted-audit-${Date.now()}-${Math.round(performance.now())}`;
    try {
      const audited: ReviewConfig = { ...testConfig, auditDir };
      mockPostToolUseInputs = [fullRead("attachments/0001.md")];
      await callAgent(
        audited,
        "final prompt",
        ["attachments/0001.md"],
        "/tmp/warranted-sdk-options",
        undefined,
        [],
        [],
        {
          inputFingerprint: "a".repeat(64),
          attachmentSnapshots: [{ path: "evidence.md", sha256: "b".repeat(64) }],
        }
      );
      const file = readdirSync(auditDir)[0]!;
      const audit = JSON.parse(readFileSync(`${auditDir}/${file}`, "utf8"));
      expect(audit.output.successfulReads).toEqual(["evidence.md"]);
      expect(audit.output.snapshotReads).toEqual(["attachments/0001.md"]);
    } finally {
      try { rmSync(auditDir, { recursive: true }); } catch {}
    }
  });
});

// =============================================================================
// D17 — 解析失败后的重试用什么模型、什么轮数
// =============================================================================

/**
 * 原来重试写死 `model: "claude-opus-4-7", maxTurns: 3`。那个模型 ID 是 2026-07
 * 填进源码的 Anthropic 官方名字，配了转发站的部署未必有；模型不存在时 callAgent
 * 抛错，被 catch 接成一条 "Reviewer error"，于是一次本该救场的重试变成归咎于
 * 审查器的编译错误，而那个模型名不是用户选的。轮数同理：失败原因是"输出不是 JSON"，
 * 与轮数无关，砍到 3 只会让重试因为附件读不完而再失败一次。
 */
describe("解析失败后的重试", () => {
  const UNPARSEABLE = [{ type: "result", subtype: "success", result: "这不是 JSON" }];
  const PARSEABLE = [
    { type: "result", subtype: "success", result: '{"errors":[],"warnings":["from retry"]}' },
  ];

  beforeEach(() => {
    capturedOptions = undefined;
    capturedCalls = [];
    mockMessagesPerCall = null;
    mockMessages = [];
  });

  afterEach(() => {
    mock.restore();
  });

  test("未配 fallbackModel 时，重试沿用同一个模型", async () => {
    mockMessagesPerCall = [UNPARSEABLE, PARSEABLE];
    const config: ReviewConfig = { ...testConfig, model: "claude-sonnet-4-6" };

    const r = await callAndParse(config, "p", [], "/tmp");

    expect(capturedCalls.length).toBe(2);
    expect(capturedCalls[0]!.options.model).toBe("claude-sonnet-4-6");
    // 不猜"更强的模型"：只用已经证明在这个 endpoint 上存在的模型名
    expect(capturedCalls[1]!.options.model).toBe("claude-sonnet-4-6");
    expect(r.warnings).toEqual(["from retry"]);
  });

  test("配了 fallbackModel 时，重试换成它，第一次调用不受影响", async () => {
    mockMessagesPerCall = [UNPARSEABLE, PARSEABLE];
    const config: ReviewConfig = {
      ...testConfig,
      model: "claude-sonnet-4-6",
      fallbackModel: "claude-opus-4-8",
    };

    await callAndParse(config, "p", [], "/tmp");

    expect(capturedCalls[0]!.options.model).toBe("claude-sonnet-4-6");
    expect(capturedCalls[1]!.options.model).toBe("claude-opus-4-8");
  });

  test("重试不改 maxTurns，用户配的 20 轮不会被偷偷砍成 3", async () => {
    mockMessagesPerCall = [UNPARSEABLE, PARSEABLE];
    const config: ReviewConfig = { ...testConfig, maxTurns: 20 };

    await callAndParse(config, "p", [], "/tmp");

    expect(capturedCalls[0]!.options.maxTurns).toBe(20);
    expect(capturedCalls[1]!.options.maxTurns).toBe(20);
  });

  test("第一次就解析成功时不重试", async () => {
    mockMessagesPerCall = [PARSEABLE];
    mockMessages = PARSEABLE;

    const r = await callAndParse(testConfig, "p", [], "/tmp");

    expect(capturedCalls.length).toBe(1);
    expect(r.warnings).toEqual(["from retry"]);
  });

  test("前置 prose 加唯一 JSON 时本地恢复,不重新采样语义", async () => {
    mockMessagesPerCall = [
      [{
        type: "result",
        subtype: "success",
        result: 'analysis first\n{"errors":[],"warnings":["salvaged"]}',
      }],
      PARSEABLE,
    ];

    const r = await callAndParse(testConfig, "p", [], "/tmp");

    expect(capturedCalls.length).toBe(1);
    expect(r.warnings).toEqual(["salvaged"]);
  });

  test("重试也失败时，错误信息里带上实际用的模型名", async () => {
    // 第二次调用没有 success 消息 → callAgent 抛 "Agent returned no result"
    mockMessagesPerCall = [UNPARSEABLE, []];
    const config: ReviewConfig = {
      ...testConfig,
      model: "claude-sonnet-4-6",
      fallbackModel: "claude-opus-4-8",
    };

    const r = await callAndParse(config, "p", [], "/tmp");

    expect(r._parseFailed).toBe(true);
    // 原来这条只说 "fallback model also failed"，不说是哪个模型 ——
    // 而那个模型名恰好是最可能出错、且用户没选过的东西
    expect(String(r._raw)).toContain("claude-opus-4-8");
    expect(String(r._raw)).toContain("Agent returned no result");
  });
});

// =============================================================================
// D37 — 审查器不往用户目录写会话记录
// =============================================================================

/**
 * SDK 每起一次 query() 都会在 ~/.claude/projects/<编码后的cwd>/ 下留一份 jsonl
 * 会话记录。审查器的 cwd 就是用户的项目根目录（reviewCwd = dirname(dirname(dbPath))），
 * 于是这些记录混进用户自己的 session 历史，/resume 时看得到。
 *
 * 量过：一个项目的审查工作量留下 300 个文件、144MB，是 reviews+audit+log
 * 三者合计（3MB）的 48 倍。而审查器的会话没有任何人会去恢复。
 *
 * persistSession: false 是 SDK 官方开关。实测：不设它的调用写了 1 个 jsonl，
 * 设成 false 的两次都是 0 个，三次调用全部成功。
 */
describe("审查器不落盘会话记录", () => {
  beforeEach(() => {
    capturedOptions = undefined;
    capturedCalls = [];
    mockMessagesPerCall = null;
    mockMessages = [{ type: "result", subtype: "success", result: "{}" }];
  });

  afterEach(() => {
    mock.restore();
  });

  test("persistSession 是 false，不是缺省也不是 true", async () => {
    // 缺省即为 true（SDK 文档 @default true），所以"键不出现"和"写成 true"
    // 后果相同，都要拦住。
    await callAgent(testConfig, "test prompt", []);
    expect(capturedOptions?.persistSession).toBe(false);
  });

  test("解析失败后的重试也不落盘", async () => {
    // 重试是第二次 query()，会再留一份记录。原缺陷的量正是按"调用次数"增长的，
    // 只在第一次调用上关掉等于漏掉了增长最快的那部分。
    mockMessagesPerCall = [
      [{ type: "result", subtype: "success", result: "这不是 JSON" }],
      [{ type: "result", subtype: "success", result: '{"errors":[],"warnings":[]}' }],
    ];

    await callAndParse(testConfig, "p", [], "/tmp");

    expect(capturedCalls.length).toBe(2);
    expect(capturedCalls[0]!.options.persistSession).toBe(false);
    expect(capturedCalls[1]!.options.persistSession).toBe(false);
  });
});

describe("incomplete review diagnostics", () => {
  beforeEach(() => {
    capturedCalls = [];
    mockMessages = [];
    mockMessagesPerCall = null;
    mockDelayMs = 0;
  });

  afterEach(() => {
    mockDelayMs = 0;
  });

  function q2(id: number, quote = "A proposition") {
    return {
      question: "Q2", confidence: "high", content: "The warrant does not establish the claim",
      citation: { node_id: id, slot: "content", quote },
    };
  }

  function reply(value: unknown) {
    return [{ type: "result", subtype: "success", result: JSON.stringify(value) }];
  }

  test("missing configuration returns empty, explicitly incomplete diagnostics without a request", async () => {
    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [{ content: "A proposition" }])[0]!.id;
      const err = await runReview(null, db, id, ctx).catch((e) => e);
      expect(err).toBeInstanceOf(ReviewUnavailableError);
      expect(err.diagnostics).toMatchObject({
        status: "incomplete", recorded: false, stage: "configuration", nodeId: id,
        candidateFindings: [], rejected: [], attempts: [],
      });
      expect(err.diagnostics.requestId).toBeUndefined();
      expect(capturedCalls).toHaveLength(0);
      expect(svc.propositionView(db, ctx, id).review.status).toBe("never");
    } finally { cleanupDb(db); }
  });

  test("unread attachment preserves a valid Q2 candidate and all prior formal state", async () => {
    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [{
        content: "A proposition", evidence: { attachments: ["evidence.md"] },
      }])[0]!.id;
      mockMessages = reply({ Q1: "pass", Q2: "fail", findings: [q2(id)] });
      mockPostToolUseInputs = [fullRead("attachments/0001.md")];
      await runReview(testConfig, db, id, ctx);
      svc.setQualifier(db, ctx, [{ id, qualifier: "probably" }]);
      const before = svc.propositionView(db, ctx, id);
      const history = svc.getHistory(db, { id });
      mockPostToolUseInputs = [];
      const err = await runReview(testConfig, db, id, ctx, { refresh: true }).catch((e) => e);
      expect(err).toBeInstanceOf(ReviewUnavailableError);
      expect(err.diagnostics).toMatchObject({
        status: "incomplete", stage: "read", nodeId: id,
        attachmentsRead: [], unreadAttachments: ["evidence.md"], rejected: [],
      });
      expect(err.diagnostics.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(err.diagnostics.candidateFindings).toHaveLength(1);
      expect(err.diagnostics.candidateFindings[0]).not.toHaveProperty("id");
      expect(err.diagnostics.candidateFindings[0].question).toBe("Q2");
      expect(err.diagnostics.candidateNotice).toContain("not formal findings");
      expect(err.diagnostics.attempts[0]).toMatchObject({
        attempt: 1, model: testConfig.model, status: "parsed",
        requestId: err.diagnostics.requestId,
        attachmentsRead: [], unreadAttachments: ["evidence.md"],
      });
      const after = svc.propositionView(db, ctx, id);
      expect(after.findings).toEqual(before.findings);
      expect(after.qualifier).toBe(before.qualifier);
      expect(after.review).toEqual(before.review);
      expect(svc.getHistory(db, { id })).toEqual(history);
    } finally { cleanupDb(db); }
  });

  test("protocol failure preserves valid candidates and rejected finding reasons", async () => {
    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [{ content: "A proposition" }])[0]!.id;
      mockMessages = reply({ Q1: "n/a", Q2: "pass", findings: [q2(id), q2(id, "invented quote")] });
      const err = await runReview(testConfig, db, id, ctx).catch((e) => e);
      expect(err.diagnostics.stage).toBe("protocol");
      expect(err.diagnostics.candidateFindings).toHaveLength(1);
      expect(err.diagnostics.rejected).toHaveLength(1);
      expect(err.diagnostics.rejected[0]).toMatchObject({ failed: "F4", raw: q2(id, "invented quote") });
      expect(err.diagnostics.rejected[0].detail).toContain("verbatim");
      expect(svc.getHistory(db, { id }).events.some((event) => event.op === "review")).toBe(false);
      expect(svc.propositionView(db, ctx, id).findings).toEqual([]);
    } finally { cleanupDb(db); }
  });

  test("input changes keep candidates bound to the original snapshot without recording", async () => {
    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [{ content: "Before" }])[0]!.id;
      mockMessages = reply({ Q1: "n/a", Q2: "fail", findings: [q2(id, "Before")] });
      mockDelayMs = 20;
      const running = runReview(testConfig, db, id, ctx).catch((e) => e);
      await new Promise((resolve) => setTimeout(resolve, 5));
      svc.updateProposition(db, ctx, { id, content: "After" });
      const err = await running;
      expect(err.diagnostics.stage).toBe("input_freshness");
      expect(err.diagnostics.candidateFindings[0].citation.quote).toBe("Before");
      expect(err.diagnostics.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(svc.propositionView(db, ctx, id).review.status).toBe("never");
      expect(svc.getHistory(db, { id }).events.some((event) => event.op === "review")).toBe(false);
    } finally { cleanupDb(db); }
  });

  test("deleting a running review's target preserves its candidate as incomplete input", async () => {
    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [{ content: "A proposition" }])[0]!.id;
      mockMessages = reply({ Q1: "n/a", Q2: "fail", findings: [q2(id)] });
      mockDelayMs = 20;
      const running = runReview(testConfig, db, id, ctx).catch((e) => e);
      await new Promise((resolve) => setTimeout(resolve, 5));
      svc.deleteProposition(db, ctx, { id });
      const err = await running;
      expect(err).toBeInstanceOf(ReviewUnavailableError);
      expect(err.diagnostics).toMatchObject({ stage: "input_freshness", recorded: false, nodeId: id });
      expect(err.diagnostics.candidateFindings).toHaveLength(1);
      expect(err.diagnostics.candidateFindings[0].citation.quote).toBe("A proposition");
      expect(svc.getHistory(db, {}).events.some((event) => event.op === "review")).toBe(false);
    } finally { cleanupDb(db); }
  });

  test("a target absent before review keeps ordinary NotFound semantics", async () => {
    const db = createTestDb();
    try {
      const err = await runReview(testConfig, db, 123, ctx).catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundError);
      expect(err.diagnostics).toBeUndefined();
      expect(capturedCalls).toHaveLength(0);
    } finally { cleanupDb(db); }
  });

  test("an error after commit cannot claim that the review was unrecorded", async () => {
    const db = createTestDb();
    const loggerError = new ReviewUnavailableError("mock post-commit log error");
    const errorSpy = spyOn(console, "error").mockImplementation((line) => {
      if (String(line).includes("END review")) throw loggerError;
    });
    try {
      const id = svc.createPropositions(db, ctx, [{ content: "A proposition" }])[0]!.id;
      mockMessages = reply({ Q1: "n/a", Q2: "pass", findings: [] });
      const err = await runReview(testConfig, db, id, ctx).catch((e) => e);
      expect(err).toBe(loggerError);
      expect(err.diagnostics).toBeUndefined();
      expect(svc.propositionView(db, ctx, id).review.status).toBe("current");
    } finally {
      errorSpy.mockRestore();
      cleanupDb(db);
    }
  });

  test("no model response has an error attempt but no fabricated candidate", async () => {
    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [{ content: "A proposition" }])[0]!.id;
      const err = await runReview(testConfig, db, id, ctx).catch((e) => e);
      expect(err.diagnostics).toMatchObject({ stage: "execution", candidateFindings: [], rejected: [] });
      expect(err.diagnostics.attempts[0]).toMatchObject({ attempt: 1, status: "error", model: testConfig.model });
      expect(err.diagnostics.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(err.diagnostics.attempts[0].error).toContain("Agent returned no result");
    } finally { cleanupDb(db); }
  });

  test("parse retry keeps both attempt identities and does not invent findings", async () => {
    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [{ content: "A proposition" }])[0]!.id;
      mockMessages = [{ type: "result", subtype: "success", result: "not JSON" }];
      const err = await runReview({ ...testConfig, fallbackModel: "fallback" }, db, id, ctx).catch((e) => e);
      expect(err.diagnostics).toMatchObject({ stage: "parse", candidateFindings: [], rejected: [] });
      expect(err.diagnostics.attempts.map((a: { attempt: number; status: string; model: string }) =>
        [a.attempt, a.status, a.model])).toEqual([[1, "unparseable", testConfig.model], [2, "unparseable", "fallback"]]);
      expect(new Set(err.diagnostics.attempts.map((a: { requestId: string }) => a.requestId)).size).toBe(1);
    } finally { cleanupDb(db); }
  });

  test("fallback exception retains each attempt's actual read coverage and request identity", async () => {
    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [{
        content: "A proposition", evidence: { attachments: ["evidence.md"] },
      }])[0]!.id;
      mockMessages = [{ type: "result", subtype: "success", result: "not JSON" }];
      mockErrorsPerCall = [null, new Error("mock SDK stream failed")];
      mockPostToolUseInputsPerCall = [[], [fullRead("attachments/0001.md")]];
      const err = await runReview({ ...testConfig, fallbackModel: "fallback" }, db, id, ctx).catch((e) => e);
      expect(err.diagnostics).toMatchObject({
        stage: "execution", recorded: false, candidateFindings: [],
        attachmentsRead: ["evidence.md"], unreadAttachments: [],
      });
      expect(err.diagnostics.attempts).toMatchObject([
        { attempt: 1, status: "unparseable", attachmentsRead: [], unreadAttachments: ["evidence.md"] },
        { attempt: 2, status: "error", model: "fallback", error: "mock SDK stream failed",
          attachmentsRead: ["evidence.md"], unreadAttachments: [] },
      ]);
      expect(err.diagnostics.attempts.every((a: { requestId: string }) =>
        a.requestId === err.diagnostics.requestId)).toBe(true);
      expect(svc.propositionView(db, ctx, id).review.status).toBe("never");
    } finally { cleanupDb(db); }
  });

  test("snapshot failure identifies unread declared input without fabricating a request", async () => {
    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [{
        content: "A proposition", evidence: { attachments: ["evidence.md"] },
      }])[0]!.id;
      rmSync("/tmp/warranted-sdk-options/evidence.md");
      const err = await runReview(testConfig, db, id, ctx).catch((e) => e);
      expect(err.diagnostics).toMatchObject({
        stage: "snapshot", recorded: false, candidateFindings: [], attempts: [],
        attachmentsRead: [], unreadAttachments: ["evidence.md"],
      });
      expect(err.diagnostics.requestId).toBeUndefined();
      expect(err.diagnostics.inputFingerprint).toBeUndefined();
      expect(capturedCalls).toHaveLength(0);
    } finally { cleanupDb(db); }
  });

  test("denied tool when no attachments are required does not veto valid findings", async () => {
    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [{ content: "A proposition" }])[0]!.id;
      mockMessages = [
        { type: "system", subtype: "permission_denied", tool_name: "Read", tool_use_id: "x" },
        ...reply({ Q1: "n/a", Q2: "fail", findings: [q2(id)] }),
      ];
      const result = await runReview(testConfig, db, id, ctx);
      expect(result.deniedTools).toEqual(["Read"]);
      expect(result.findings).toHaveLength(1);
      expect(svc.propositionView(db, ctx, id).review.status).toBe("current");
    } finally { cleanupDb(db); }
  });

  test("MCP cached review preserves agent acceptance and refresh requests a new opinion", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { registerTools } = await import("../src/tools.ts");
    const server = new McpServer({ name: "reuse-test", version: "0" });
    const client = new Client({ name: "reuse-test-client", version: "0" });
    const db = createTestDb();
    const parse = (result: any) => {
      expect(result.isError).not.toBe(true);
      const text = result.content[0].text as string;
      return { text, payload: JSON.parse(text.slice(text.indexOf("{"))) };
    };
    try {
      const id = svc.createPropositions(db, ctx, [{ content: "A proposition" }])[0]!.id;
      registerTools(server, db, "/tmp/warranted-sdk-options/.toulmin/graph.db", testConfig);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      mockMessages = reply({ Q1: "n/a", Q2: "fail", findings: [q2(id)] });
      const first = parse(await client.callTool({ name: "review", arguments: { id } }));
      expect(first.payload.reused).toBe(false);
      parse(await client.callTool({ name: "dismiss", arguments: { items: [{ id: first.payload.findings[0].id, reason: "Checked the objection and accept the stated limited scope" }] } }));
      const cached = parse(await client.callTool({ name: "review", arguments: { id } }));
      expect(cached.payload.reused).toBe("completed");
      expect(cached.payload.Q2).toBe("fail");
      expect(cached.payload.reviewDecision).toMatchObject({ status: "passed", source: "agent" });
      expect(cached.payload.findings[0].state).toBe("acknowledged");
      expect(cached.text.startsWith("⚑")).toBe(false);
      expect(capturedCalls).toHaveLength(1);
      const fresh = parse(await client.callTool({ name: "review", arguments: { id, refresh: true } }));
      expect(fresh.payload.reused).toBe(false);
      expect(fresh.payload.reviewDecision.status).toBe("pending");
      expect(fresh.text.startsWith("⚑")).toBe(true);
      expect(capturedCalls).toHaveLength(2);
    } finally {
      await client.close(); await server.close(); cleanupDb(db);
    }
  });

  test("MCP transport serializes incomplete diagnostics as JSON and keeps isError", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { registerTools } = await import("../src/tools.ts");
    const server = new McpServer({ name: "diagnostics-test", version: "0" });
    const client = new Client({ name: "diagnostics-test-client", version: "0" });
    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [{ content: "A proposition" }])[0]!.id;
      registerTools(server, db, "/tmp/warranted-sdk-options/.toulmin/graph.db", testConfig);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      mockMessages = reply({ Q1: "n/a", Q2: "pass", findings: [q2(id)] });
      const result = await client.callTool({ name: "review", arguments: { id } });
      expect(result.isError).toBe(true);
      const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      expect(payload).toMatchObject({ status: "incomplete", recorded: false, stage: "protocol", nodeId: id });
      expect(payload).not.toHaveProperty("Q1");
      expect(payload).not.toHaveProperty("Q2");
      expect(payload.candidateFindings).toHaveLength(1);
      expect(payload.candidateFindings[0]).not.toHaveProperty("id");
      expect(result.structuredContent).toEqual(payload);
      expect(svc.propositionView(db, ctx, id).review.status).toBe("never");
    } finally {
      await client.close();
      await server.close();
      cleanupDb(db);
    }
  });
});

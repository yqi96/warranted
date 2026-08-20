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
import { readdirSync, readFileSync, rmSync } from "fs";
import type { ReviewConfig } from "../src/review-config.ts";

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
let mockDelayMs = 0;
let concurrencyCounter = 0;
let peakConcurrency = 0;

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
          await new Promise((resolve) => setTimeout(resolve, mockDelayMs));
        }
        for (const message of messages) {
          yield message;
        }
      } finally {
        concurrencyCounter--;
      }
    }
    return generator();
  },
}));

const { callAgent, callAndParse } = await import("../src/review-llm.ts");
const { runReview } = await import("../src/review-run.ts");
const svc = await import("../src/service.ts");
const { ReviewUnavailableError } = await import("../src/errors.ts");
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

  test("被拒的审查整次作废,不是一次干净通过", async () => {
    // console.warn 走 MCP server 的 stderr,主 agent 看不到。被拒意味着审查器可能
    // 从没读到附件,而 review 不产出 pass —— 记一条 "Q1: pass" 会在图上造出
    // "忠实性已核实"的假象,所以整次抛掉,一条 review 事件都不留。
    mockMessages = [
      { type: "system", subtype: "permission_denied", tool_name: "Read", tool_use_id: "x" },
      { type: "result", subtype: "success", result: '{"Q1":"pass","Q2":"pass","findings":[]}' },
    ];
    spyOn(console, "warn").mockImplementation(() => {});

    const db = createTestDb();
    try {
      const id = svc.createPropositions(db, ctx, [{ content: "A proposition" }])[0]!.id;
      const err = await runReview(testConfig, db, id).catch((e) => e);
      expect(err).toBeInstanceOf(ReviewUnavailableError);
      expect(err.message).toContain("Read");
      expect(svc.getHistory(db, { id }).events.some((e) => e.op === "review")).toBe(false);
    } finally {
      cleanupDb(db);
    }
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

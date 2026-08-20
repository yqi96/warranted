/**
 * 审查配置测试 — review-config.ts
 */

import { describe, test, expect, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { loadReviewConfig } from "../src/review-config.ts";

const TEST_DIR = "/tmp/toulmin-test-review-config-" + Date.now();

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true }); } catch {}
});

function setupDir(): string {
  mkdirSync(TEST_DIR, { recursive: true });
  return TEST_DIR;
}

describe("loadReviewConfig", () => {
  test("未提供配置文件路径时返回 null", () => {
    const config = loadReviewConfig(null, "/tmp/test.db");
    expect(config).toBeNull();
  });

  test("undefined 路径返回 null", () => {
    const config = loadReviewConfig(undefined, "/tmp/test.db");
    expect(config).toBeNull();
  });

  test("空字符串路径返回 null", () => {
    const config = loadReviewConfig("", "/tmp/test.db");
    expect(config).toBeNull();
  });

  test("配置文件不存在时返回 null", () => {
    const config = loadReviewConfig("/nonexistent/path.json", "/tmp/test.db");
    expect(config).toBeNull();
  });

  test("配置文件无 apiKey 时返回 null", () => {
    const dir = setupDir();
    const configPath = `${dir}/review.json`;
    writeFileSync(configPath, JSON.stringify({ model: "test" }));

    const config = loadReviewConfig(configPath, "/tmp/test.db");
    expect(config).toBeNull();
  });

  test("无效 JSON 返回 null", () => {
    const dir = setupDir();
    const configPath = `${dir}/review.json`;
    writeFileSync(configPath, "not json");

    const config = loadReviewConfig(configPath, "/tmp/test.db");
    expect(config).toBeNull();
  });

  test("有效配置返回完整 ReviewConfig", () => {
    const dir = setupDir();
    const configPath = `${dir}/review.json`;
    writeFileSync(configPath, JSON.stringify({
      apiKey: "sk-test",
      baseUrl: "https://proxy.example.com",
      model: "claude-3-haiku",
    }));

    const config = loadReviewConfig(configPath, `${dir}/test.db`);
    expect(config).not.toBeNull();
    expect(config!.enabled).toBe(true);
    expect(config!.provider).toBe("anthropic");
    expect(config!.apiKey).toBe("sk-test");
    expect(config!.baseUrl).toBe("https://proxy.example.com");
    expect(config!.model).toBe("claude-3-haiku");
    expect(config!.maxTurns).toBe(10); // 默认值
    expect(config!.dbPath).toBe(`${dir}/test.db`);
  });

  test("仅 apiKey 时使用默认值", () => {
    const dir = setupDir();
    const configPath = `${dir}/review.json`;
    writeFileSync(configPath, JSON.stringify({ apiKey: "sk-test" }));

    const config = loadReviewConfig(configPath, `${dir}/test.db`);
    expect(config).not.toBeNull();
    expect(config!.model).toBe("claude-sonnet-4-20250514");
    expect(config!.maxTurns).toBe(10);
    expect(config!.baseUrl).toBeUndefined();
  });

  test("自定义 maxTurns 生效", () => {
    const dir = setupDir();
    const configPath = `${dir}/review.json`;
    writeFileSync(configPath, JSON.stringify({ apiKey: "sk-test", maxTurns: 20 }));

    const config = loadReviewConfig(configPath, `${dir}/test.db`);
    expect(config!.maxTurns).toBe(20);
  });

  test("未设置 auditDir 时默认为 dirname(dbPath)/audit", () => {
    const dir = setupDir();
    const configPath = `${dir}/review.json`;
    writeFileSync(configPath, JSON.stringify({ apiKey: "sk-test" }));

    const config = loadReviewConfig(configPath, `${dir}/test.db`);
    expect(config).not.toBeNull();
    expect(config!.auditDir).toBe(`${dir}/audit`);
  });

  test("auditDir: null 时禁用审计", () => {
    const dir = setupDir();
    const configPath = `${dir}/review.json`;
    writeFileSync(configPath, JSON.stringify({ apiKey: "sk-test", auditDir: null }));

    const config = loadReviewConfig(configPath, `${dir}/test.db`);
    expect(config).not.toBeNull();
    expect(config!.auditDir).toBeNull();
  });

  test("自定义 auditDir 生效", () => {
    const dir = setupDir();
    const configPath = `${dir}/review.json`;
    const customAuditDir = `${dir}/my-audit`;
    writeFileSync(configPath, JSON.stringify({ apiKey: "sk-test", auditDir: customAuditDir }));

    const config = loadReviewConfig(configPath, `${dir}/test.db`);
    expect(config).not.toBeNull();
    expect(config!.auditDir).toBe(customAuditDir);
  });
});

// =============================================================================
// D16 — 正整数配置项的取值校验
// =============================================================================

/**
 * 配置文件必须写原始 JSON 文本，不能用 JSON.stringify 造。
 * JSON.stringify(Infinity) 是 "null"，JSON.stringify(NaN) 也是 "null" ——
 * 用它造夹具，1e400 这一行测的是 null，等于没测到真实输入通道。
 */
function writeRawConfig(dir: string, body: string): string {
  const configPath = `${dir}/review.json`;
  writeFileSync(configPath, body);
  return configPath;
}

/** 收集一次 loadReviewConfig 期间打到 console.error 的所有行 */
function captureStderr<T>(fn: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    return { result: fn(), lines };
  } finally {
    console.error = original;
  }
}

describe("正整数配置项校验", () => {
  // 原来的检查是 isNaN(x)，它只拦得住 "abc" 和 {}。下面每一行都曾经原样放行。
  const REJECTED = [
    ["0", "0"],
    ["负数", "-1"],
    ["小数", "3.7"],
    ["空字符串", '""'],
    ["数字字符串", '"8"'],
    ["非数字字符串", '"abc"'],
    ["空数组", "[]"],
    ["空对象", "{}"],
    ["null", "null"],
    ["true", "true"],
    ["false", "false"],
    ["溢出成 Infinity", "1e400"],
    ["溢出成 -Infinity", "-1e400"],
  ] as const;

  for (const [label, literal] of REJECTED) {
    test(`maxTurns = ${label}（${literal}）回落到 10`, () => {
      const dir = setupDir();
      const configPath = writeRawConfig(dir, `{"apiKey":"sk-test","maxTurns":${literal}}`);
      const { result: config } = captureStderr(() =>
        loadReviewConfig(configPath, `${dir}/test.db`)
      );
      expect(config).not.toBeNull();
      expect(config!.maxTurns).toBe(10);
    });

    test(`maxConcurrency = ${label}（${literal}）时键整个不出现`, () => {
      const dir = setupDir();
      const configPath = writeRawConfig(dir, `{"apiKey":"sk-test","maxConcurrency":${literal}}`);
      const { result: config } = captureStderr(() =>
        loadReviewConfig(configPath, `${dir}/test.db`)
      );
      expect(config).not.toBeNull();
      // 这里不能只断言 !== 0：0 的后果是 review-llm acquirePermit 闸门开度为 0，
      // 第一个请求挂进等待队列后再没人唤醒 —— 永久静默卡死。键必须缺席，
      // 让消费处的 DEFAULT_MAX_CONCURRENCY 接管。
      expect("maxConcurrency" in config!).toBe(false);
      expect(config!.maxConcurrency).toBeUndefined();
    });
  }

  test("合法正整数原样生效", () => {
    const dir = setupDir();
    const configPath = writeRawConfig(dir, `{"apiKey":"sk-test","maxTurns":3,"maxConcurrency":2}`);
    const { result: config, lines } = captureStderr(() =>
      loadReviewConfig(configPath, `${dir}/test.db`)
    );
    expect(config!.maxTurns).toBe(3);
    expect(config!.maxConcurrency).toBe(2);
    expect(lines.filter((l) => l.includes("Invalid"))).toEqual([]);
  });

  test("警告里说清是哪个字段、收到了什么", () => {
    const dir = setupDir();
    const configPath = writeRawConfig(dir, `{"apiKey":"sk-test","maxConcurrency":0}`);
    const { lines } = captureStderr(() => loadReviewConfig(configPath, `${dir}/test.db`));
    const warning = lines.find((l) => l.includes("Invalid maxConcurrency"));
    expect(warning).toBeDefined();
    expect(warning!).toContain("Invalid maxConcurrency: 0");
    expect(warning!).toContain("positive integer");
  });

  test("Infinity 在警告里印成 Infinity，不是 null", () => {
    const dir = setupDir();
    const configPath = writeRawConfig(dir, `{"apiKey":"sk-test","maxTurns":1e400}`);
    const { lines } = captureStderr(() => loadReviewConfig(configPath, `${dir}/test.db`));
    const warning = lines.find((l) => l.includes("Invalid maxTurns"));
    // JSON.stringify(Infinity) 是 "null"，直接用它会把这行报成 "Invalid maxTurns: null"
    expect(warning!).toContain("Invalid maxTurns: Infinity");
  });

  test("两个字段都非法时各自警告一次", () => {
    const dir = setupDir();
    const configPath = writeRawConfig(dir, `{"apiKey":"sk-test","maxTurns":0,"maxConcurrency":-1}`);
    const { result: config, lines } = captureStderr(() =>
      loadReviewConfig(configPath, `${dir}/test.db`)
    );
    expect(lines.filter((l) => l.includes("Invalid maxTurns")).length).toBe(1);
    expect(lines.filter((l) => l.includes("Invalid maxConcurrency")).length).toBe(1);
    expect(config!.maxTurns).toBe(10);
    expect("maxConcurrency" in config!).toBe(false);
  });

  test("字段缺失时不打警告", () => {
    const dir = setupDir();
    const configPath = writeRawConfig(dir, `{"apiKey":"sk-test"}`);
    const { result: config, lines } = captureStderr(() =>
      loadReviewConfig(configPath, `${dir}/test.db`)
    );
    expect(lines.filter((l) => l.includes("Invalid"))).toEqual([]);
    expect(config!.maxTurns).toBe(10);
    expect("maxConcurrency" in config!).toBe(false);
  });
});

// =============================================================================
// D35 — debounceMs 已删除
// =============================================================================

describe("debounceMs 已删除", () => {
  test("旧配置文件里留着 debounceMs 仍然能加载", () => {
    const dir = setupDir();
    // 加它的那次提交（85ca6ef）同时删掉了 review-dispatcher/worker/notifier ——
    // 去重窗口属于那套被删掉的异步架构，字段从来没有消费者。
    // JSON 配置对未知键是忽略，所以旧文件不该因为这个键加载失败。
    const configPath = writeRawConfig(dir, `{"apiKey":"sk-test","debounceMs":60000}`);
    const { result: config } = captureStderr(() =>
      loadReviewConfig(configPath, `${dir}/test.db`)
    );
    expect(config).not.toBeNull();
    expect("debounceMs" in config!).toBe(false);
  });
});

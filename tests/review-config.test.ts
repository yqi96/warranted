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
      debounceMs: 5000,
    }));

    const config = loadReviewConfig(configPath, `${dir}/test.db`);
    expect(config).not.toBeNull();
    expect(config!.enabled).toBe(true);
    expect(config!.provider).toBe("anthropic");
    expect(config!.apiKey).toBe("sk-test");
    expect(config!.baseUrl).toBe("https://proxy.example.com");
    expect(config!.model).toBe("claude-3-haiku");
    expect(config!.debounceMs).toBe(5000);
    expect(config!.maxTurns).toBe(10); // 默认值
    expect(config!.dbPath).toBe(`${dir}/test.db`);
    expect(config!.reviewDir).toBe(`${dir}/reviews`);
  });

  test("仅 apiKey 时使用默认值", () => {
    const dir = setupDir();
    const configPath = `${dir}/review.json`;
    writeFileSync(configPath, JSON.stringify({ apiKey: "sk-test" }));

    const config = loadReviewConfig(configPath, `${dir}/test.db`);
    expect(config).not.toBeNull();
    expect(config!.model).toBe("claude-sonnet-4-20250514");
    expect(config!.debounceMs).toBe(30000);
    expect(config!.maxTurns).toBe(10);
    expect(config!.baseUrl).toBeUndefined();
  });

  test("无效 debounceMs 使用默认值", () => {
    const dir = setupDir();
    const configPath = `${dir}/review.json`;
    writeFileSync(configPath, JSON.stringify({ apiKey: "sk-test", debounceMs: "abc" }));

    const config = loadReviewConfig(configPath, `${dir}/test.db`);
    expect(config!.debounceMs).toBe(30000);
  });

  test("自定义 maxTurns 生效", () => {
    const dir = setupDir();
    const configPath = `${dir}/review.json`;
    writeFileSync(configPath, JSON.stringify({ apiKey: "sk-test", maxTurns: 20 }));

    const config = loadReviewConfig(configPath, `${dir}/test.db`);
    expect(config!.maxTurns).toBe(20);
  });

  test("无效 maxTurns 使用默认值", () => {
    const dir = setupDir();
    const configPath = `${dir}/review.json`;
    writeFileSync(configPath, JSON.stringify({ apiKey: "sk-test", maxTurns: "xyz" }));

    const config = loadReviewConfig(configPath, `${dir}/test.db`);
    expect(config!.maxTurns).toBe(10);
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

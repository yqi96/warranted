/**
 * 审计日志测试 — review-audit.ts
 */

import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync } from "fs";
import { writeAuditRecord, type AuditRecord } from "../src/review-audit.ts";

const TEST_DIR = "/tmp/toulmin-test-audit-" + Date.now();

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

function makeRecord(overrides?: Partial<AuditRecord>): AuditRecord {
  return {
    timestamp: "2026-07-15T10:30:00.000Z",
    requestId: "abc12345-0000-0000-0000-000000000000",
    model: "claude-sonnet-4-20250514",
    maxTurns: 10,
    input: {
      prompt: "Review this argument.",
      attachmentPaths: ["/project/data.csv"],
      cwd: "/project",
    },
    output: {
      raw: '{"errors":[],"warnings":[]}',
      durationMs: 1234,
    },
    ...overrides,
  };
}

describe("writeAuditRecord", () => {
  test("在指定目录创建有效 JSON 文件", () => {
    const dir = TEST_DIR + "/audit";
    mkdirSync(dir, { recursive: true });

    writeAuditRecord(dir, makeRecord());

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^audit_.*\.json$/);
  });

  test("目录不存在时自动创建", () => {
    const dir = TEST_DIR + "/nonexistent/audit";
    expect(existsSync(dir)).toBe(false);

    writeAuditRecord(dir, makeRecord());

    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  test("文件包含正确的 prompt、response 和 duration", () => {
    const dir = TEST_DIR + "/audit";
    const record = makeRecord();
    writeAuditRecord(dir, record);

    const files = readdirSync(dir);
    const content = JSON.parse(readFileSync(dir + "/" + files[0], "utf-8"));

    expect(content.input.prompt).toBe("Review this argument.");
    expect(content.input.attachmentPaths).toEqual(["/project/data.csv"]);
    expect(content.input.cwd).toBe("/project");
    expect(content.output.raw).toBe('{"errors":[],"warnings":[]}');
    expect(content.output.durationMs).toBe(1234);
    expect(content.model).toBe("claude-sonnet-4-20250514");
    expect(content.maxTurns).toBe(10);
    expect(content.timestamp).toBe("2026-07-15T10:30:00.000Z");
    expect(content.requestId).toBe("abc12345-0000-0000-0000-000000000000");
  });

  test("文件名包含 timestamp 和 requestId 前缀", () => {
    const dir = TEST_DIR + "/audit";
    writeAuditRecord(dir, makeRecord());

    const files = readdirSync(dir);
    // timestamp part: 2026-07-15T10-30-00-000Z
    expect(files[0]).toContain("2026-07-15T10-30-00-000Z");
    // requestId first 8 non-dash chars: abc12345
    expect(files[0]).toContain("abc12345");
  });

  test("两次快速调用（相同 prompt）生成两个不同文件名", () => {
    const dir = TEST_DIR + "/audit";

    // 相同内容但不同 requestId → 不同文件名
    writeAuditRecord(dir, makeRecord({ requestId: "aaaa1111-0000-0000-0000-000000000000" }));
    writeAuditRecord(dir, makeRecord({ requestId: "bbbb2222-0000-0000-0000-000000000000" }));

    const files = readdirSync(dir);
    expect(files).toHaveLength(2);
    expect(files[0]).not.toBe(files[1]);
  });

  test("写入失败时静默忽略，不抛出异常", () => {
    // 传入一个无效路径（根目录下不可写）
    expect(() => {
      writeAuditRecord("/proc/cannot-write-here/audit", makeRecord());
    }).not.toThrow();
  });
});

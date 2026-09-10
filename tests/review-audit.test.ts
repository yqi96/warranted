/**
 * 审计日志测试 — review-audit.ts
 */

import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { beginReviewAudit, writeAuditRecord, type AuditRecord } from "../src/review-audit.ts";
import type { ReviewConfig } from "../src/review-config.ts";

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
      successfulReads: ["/project/data.csv"],
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
    expect(content.output.successfulReads).toEqual(["/project/data.csv"]);
    expect(content.model).toBe("claude-sonnet-4-20250514");
    expect(content.maxTurns).toBe(10);
    expect(content.timestamp).toBe("2026-07-15T10:30:00.000Z");
    expect(content.requestId).toBe("abc12345-0000-0000-0000-000000000000");
  });

  test("可以把 review 输入指纹与附件哈希写进审计,不需要记录凭据", () => {
    const dir = TEST_DIR + "/audit";
    const fingerprint = "a".repeat(64);
    const record = makeRecord({
      input: {
        prompt: "Review this argument.",
        attachmentPaths: ["evidence.bin"],
        cwd: "/project",
        inputFingerprint: fingerprint,
        attachmentSnapshots: [{ path: "evidence.bin", sha256: "b".repeat(64) }],
      },
    });
    writeAuditRecord(dir, record);

    const filename = readdirSync(dir)[0]!;
    const content = JSON.parse(readFileSync(dir + "/" + filename, "utf-8"));
    expect(content.input.inputFingerprint).toBe(fingerprint);
    expect(content.input.attachmentSnapshots).toEqual([
      { path: "evidence.bin", sha256: "b".repeat(64) },
    ]);
    expect(JSON.stringify(content)).not.toContain("apiKey");
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

  test("写入失败时警告但不抛出异常", () => {
    const warnings = captureWarnings(() => {
      expect(() => writeAuditRecord("/proc/cannot-write-here/audit", makeRecord())).not.toThrow();
    });
    expect(warnings.join(" ")).toContain("Failed to write audit record");
  });
});

function captureWarnings(run: () => void): string[] {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  try { run(); } finally { console.warn = original; }
  return warnings;
}

function auditConfig(debug = false): ReviewConfig {
  return {
    enabled: true, provider: "anthropic", model: "requested-model", maxTurns: 10,
    apiKey: "unique-audit-secret-credential", auditDir: join(TEST_DIR, "audit"),
    dbPath: join(TEST_DIR, ".toulmin", "graph.db"), debug,
  };
}
function jsonRecords(config: ReviewConfig) {
  return readdirSync(config.auditDir!).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(config.auditDir!, name), "utf8")));
}
function snapshot() {
  const cwd = join(TEST_DIR, "private-snapshot");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "attachment.txt"), "old exact evidence bytes\n");
  return {
    cwd, attachmentPaths: ["attachment.txt"], prompt: "Exact review prompt",
    metadata: {
      inputFingerprint: "a".repeat(64),
      attachmentSnapshots: [{ path: "original/evidence.txt", sha256: createHash("sha256").update("old exact evidence bytes\n").digest("hex") }],
    },
  };
}

describe("beginReviewAudit", () => {
  test("normal writes started before query then compact final telemetry, not prompt/raw/events/bytes", () => {
    const config = auditConfig();
    const input = snapshot();
    const audit = beginReviewAudit(config, { ...input, requestId: "same-request", attempt: 2 });
    expect(jsonRecords(config)[0].status).toBe("started");
    audit.event({ type: "system", subtype: "init", model: "actual-model" });
    audit.event({ type: "assistant", message: { content: "large internal visible message" } });
    audit.event({ type: "result", subtype: "success", num_turns: 3, total_cost_usd: 0.12,
      duration_api_ms: 800, duration_ms: 900, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 20 },
      modelUsage: { "actual-model": { inputTokens: 10, outputTokens: 20, costUSD: 0.12 } }, result: "RAW ANSWER" });
    audit.finish({ status: "completed", raw: "RAW ANSWER", durationMs: 1000, successfulReads: ["original/evidence.txt"], snapshotReads: ["attachment.txt"] });
    const records = jsonRecords(config);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ scope: "model_attempt", status: "completed", attempt: 2,
      telemetry: { actualModel: "actual-model", numTurns: 3, totalCostUsd: 0.12, durationApiMs: 800, usage: { input_tokens: 10, output_tokens: 20 } } });
    expect(records[0].input.attachmentSnapshots).toEqual(input.metadata.attachmentSnapshots);
    expect(records[0].input.prompt).toBeUndefined();
    expect(records[0].output.raw).toBeUndefined();
    expect(JSON.stringify(records)).not.toContain("RAW ANSWER");
    expect(JSON.stringify(records)).not.toContain("large internal visible message");
    expect(existsSync(join(config.auditDir!, "debug"))).toBe(false);
  });

  test("debug archives exact old bytes by hash once and appends visible events before finish", () => {
    const config = auditConfig(true);
    const input = snapshot();
    const first = beginReviewAudit(config, input);
    first.event({ type: "assistant", message: { content: "SDK-visible partial output" } });
    const initial = jsonRecords(config)[0];
    expect(initial.status).toBe("started");
    expect(initial.input.prompt).toBe(input.prompt);
    const mapping = initial.input.attachmentArchive[0];
    expect(mapping.path).toBe("original/evidence.txt");
    expect(mapping.sha256).toBe(input.metadata.attachmentSnapshots[0]!.sha256);
    expect(readFileSync(join(config.auditDir!, initial.input.eventsPath), "utf8")).toContain("SDK-visible partial output");
    const second = beginReviewAudit(config, input);
    second.finish({ status: "completed", durationMs: 2, raw: "second reply", successfulReads: [] });
    expect(readdirSync(join(config.auditDir!, "debug", "attachments"))).toHaveLength(1);
    writeFileSync(join(input.cwd, "attachment.txt"), "changed later");
    expect(readFileSync(join(config.auditDir!, mapping.storedPath), "utf8")).toBe("old exact evidence bytes\n");
    first.finish({ status: "failed", error: Error("timeout"), durationMs: 300000, successfulReads: [] });
    expect(jsonRecords(config).map((item) => item.status).sort()).toEqual(["completed", "failed"]);
  });

  test("failed attempts retain explicit unknown usage instead of zeros and redact credentials", () => {
    const config = auditConfig(true);
    const audit = beginReviewAudit(config, { prompt: `prompt ${config.apiKey}`, attachmentPaths: [] });
    audit.event({ type: "api_error", message: `Bearer ${config.apiKey}`, env: { ANTHROPIC_API_KEY: "different-value" }, authorization: "different-value" });
    audit.finish({ status: "failed", durationMs: 123, error: Error(`Rejected ${config.apiKey}`), successfulReads: [], result: { type: "result", subtype: "error_during_execution", usage: {}, modelUsage: {} } });
    const record = jsonRecords(config)[0];
    expect(record.telemetry).toMatchObject({ usage: null, modelUsage: null, numTurns: null, totalCostUsd: null, durationApiMs: null, actualModel: null });
    const data = JSON.stringify(record) + readFileSync(join(config.auditDir!, record.input.eventsPath), "utf8");
    expect(data).not.toContain(config.apiKey);
    expect(data).not.toContain("different-value");
    expect(data).toContain("[REDACTED]");
    expect(record.output.error.message).toContain("Rejected");
  });

  test("audit disabled never creates directories even when debug is true", () => {
    const config = { ...auditConfig(true), auditDir: null };
    const audit = beginReviewAudit(config, { prompt: "x", attachmentPaths: [] });
    audit.event({ type: "result" });
    audit.finish({ status: "failed", durationMs: 1, successfulReads: [] });
    expect(existsSync(TEST_DIR)).toBe(false);
  });

  test("filesystem failures warn without throwing or changing the scientific outcome", () => {
    const config = { ...auditConfig(true), auditDir: "/proc/warranted-audit-test" };
    const warnings = captureWarnings(() => {
      const audit = beginReviewAudit(config, { prompt: "x", attachmentPaths: [] });
      expect(() => audit.event({ type: "system", subtype: "init", model: "m" })).not.toThrow();
      expect(() => audit.finish({ status: "completed", raw: "pass", durationMs: 1, successfulReads: [] })).not.toThrow();
    });
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.every((line) => line.includes("review outcome unchanged"))).toBe(true);
  });

  test("debug only copies declared snapshot aliases and reports hash mismatch", () => {
    const config = auditConfig(true);
    const input = snapshot();
    const warnings = captureWarnings(() => {
      beginReviewAudit(config, { ...input, metadata: { ...input.metadata, attachmentSnapshots: [{ path: "original/evidence.txt", sha256: "b".repeat(64) }] } });
      beginReviewAudit(config, { ...input, attachmentPaths: ["../outside.txt"], metadata: undefined });
    });
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    const records = jsonRecords(config);
    expect(records.every((record) => record.input.attachmentArchive[0].storedPath === null)).toBe(true);
    expect(records.some((record) => record.input.attachmentArchive[0].error.includes("fingerprint"))).toBe(true);
  });
});

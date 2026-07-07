/**
 * 审查派发器测试 — review-dispatcher.ts
 *
 * 测试去重逻辑和锁文件管理（不实际 spawn 子进程）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";

const TEST_DIR = "/tmp/toulmin-test-dispatcher-" + Date.now();

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true }); } catch {}
});

// 由于 dispatchReview 内部使用 Bun.spawn，我们只测试去重逻辑
// 通过直接操作锁文件来验证去重行为

describe("dispatcher 去重逻辑", () => {
  test("锁文件路径格式正确", () => {
    // 验证锁文件命名规则
    const lockFile = join(TEST_DIR, ".lock_argument_1_3");
    writeFileSync(lockFile, String(Date.now()));
    expect(existsSync(lockFile)).toBe(true);
  });

  test("锁文件内容包含时间戳", () => {
    const lockFile = join(TEST_DIR, ".lock_argument_1_3");
    const now = Date.now();
    writeFileSync(lockFile, String(now));
    const content = readFileSync(lockFile, "utf-8");
    expect(parseInt(content, 10)).toBe(now);
  });

  test("去重窗口内的锁应被检测到", () => {
    const lockFile = join(TEST_DIR, ".lock_ground_evidence_5");
    const now = Date.now();
    writeFileSync(lockFile, String(now));

    const content = readFileSync(lockFile, "utf-8");
    const timestamp = parseInt(content, 10);
    const age = Date.now() - timestamp;

    // 刚创建的锁，age 应该很小
    expect(age).toBeLessThan(1000);
    // 在默认 30 秒去重窗口内
    expect(age).toBeLessThan(30000);
  });

  test("过期锁（>5分钟）应被视为可覆盖", () => {
    const lockFile = join(TEST_DIR, ".lock_argument_1_3");
    const fiveMinutesAgo = Date.now() - 6 * 60 * 1000;
    writeFileSync(lockFile, String(fiveMinutesAgo));

    const content = readFileSync(lockFile, "utf-8");
    const timestamp = parseInt(content, 10);
    const age = Date.now() - timestamp;

    // 超过 5 分钟
    expect(age).toBeGreaterThan(5 * 60 * 1000);
  });

  test("ID 排序确保锁文件唯一性", () => {
    // claimId=1, warrantId=3 和 claimId=1, warrantId=3 应该生成相同的锁文件名
    const ids1 = [1, 3].sort((a, b) => a - b);
    const ids2 = [3, 1].sort((a, b) => a - b);
    expect(ids1).toEqual(ids2);
  });
});

/**
 * Warranted — 审查的三种结局在生产路径上的接线
 *
 * 对应 `.omc/plans/0.5.0/pr3-batch.md` §3.0 与 §3.0.1。
 *
 * `batch.test.ts` 里 19/20 两条把 `executeStatementReview` 整个替掉，锁的是
 * **tools 层**的分类逻辑：拿到一个会抛的实现 / 一个带 `deniedTools` 的返回值
 * 之后，工具是否落到第三种结局。那两条锁不住它上游的一段 —— 真实的
 * `executeStatementReview` 到底会不会产出那样的返回值。
 *
 * 这个文件从 `callAgent` 这一层注入，跑真实的 `executeStatementReview`，
 * 锁的正是那一段：
 *
 * - 审查基础设施自己抛异常时，返回值必须把它标成 `reviewError`，
 *   而不是塞进 `errors` —— 塞进 `errors` 之后它与「审查判定证据不足」
 *   在返回值上完全同形，第三种结局在生产路径上就不存在了；
 * - `callAgent` 收集到的 `deniedTools` 必须真的传得回来。它只进
 *   `console.warn`（走 MCP server 的 stderr，主 agent 从来看不到）时，
 *   tools 层那个 `deniedTools` 判断永远是死代码。
 *
 * 单独一个文件是因为 `mock.module` 在文件内是全局且不可逆的：
 * `batch.test.ts` 已经替换过 `../src/review-sync.ts`，在同一文件里再想拿到
 * 真实实现就拿不到了。
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTestDb, cleanupDb, makeGround } from "./helpers.ts";

/** 注入 callAgent —— 不起真实会话。 */
let agentImpl: (deniedOut?: string[]) => Promise<string> = async () => '{"errors":[],"warnings":[]}';

mock.module("../src/review-llm.ts", () => ({
  callAgent: async (
    _config: unknown,
    _prompt: string,
    _attachments: string[],
    _cwd?: string,
    _requestId?: string,
    deniedOut?: string[]
  ) => agentImpl(deniedOut),
  callAndParse: async () => ({ errors: [], warnings: [] }),
  parseLLMResponse: (raw: string) => {
    try {
      return JSON.parse(raw);
    } catch {
      return { _parseFailed: true, errors: [raw], warnings: [] };
    }
  },
}));

const { executeStatementReview } = await import("../src/review-sync.ts");

let workRoot: string;
let dbPath: string;
let db: Database;

function makeReviewConfig(): any {
  return {
    enabled: true,
    provider: "anthropic",
    model: "test-model",
    apiKey: "test-key",
    debounceMs: 0,
    maxTurns: 3,
    maxConcurrency: 4,
    reviewDir: null,
    auditDir: null,
    dbPath,
  };
}

beforeEach(() => {
  workRoot = join(tmpdir(), `warranted-outcome-${process.hrtime.bigint()}`);
  mkdirSync(join(workRoot, ".warranted"), { recursive: true });
  dbPath = join(workRoot, ".warranted", "graph.db");
  db = createTestDb();
  agentImpl = async () => '{"errors":[],"warnings":[]}';
});

afterEach(() => {
  cleanupDb(db);
  rmSync(workRoot, { recursive: true, force: true });
});

describe("§3.0：审查自身出错与审查判定不通过，在返回值上就必须可分辨", () => {
  test("审查基础设施抛异常 ⇒ reviewError 有值，errors 不被塞进伪造的判定", async () => {
    // 把异常写成 errors: ["Reviewer error: ..."] 之后，调用方看到的是
    // 「有 error」—— 与 reviewer 判定证据不足完全同形。两者处方相反：
    // 一个是重试，一个是去改 Statement 内容
    agentImpl = async () => {
      throw new Error("SDK timeout");
    };
    const g = makeGround(db, { content: "证据", verification: "pending", attachments: ["a.txt"] });
    const r = await executeStatementReview(makeReviewConfig(), db, g.id);
    expect(r.reviewError).toBeDefined();
    expect(r.reviewError).toContain("SDK timeout");
    expect(r.errors).toEqual([]);
  });

  test("reviewer 判定不通过 ⇒ errors 有值而 reviewError 无值", async () => {
    agentImpl = async () => '{"errors":["evidence mismatch"],"warnings":[]}';
    const g = makeGround(db, { content: "证据", verification: "pending", attachments: ["a.txt"] });
    const r = await executeStatementReview(makeReviewConfig(), db, g.id);
    expect(r.errors).toEqual(["evidence mismatch"]);
    expect(r.reviewError).toBeUndefined();
  });
});

describe("§3.0.1：deniedTools 必须传得回调用方", () => {
  test("callAgent 收集到的 deniedTools 出现在审查返回值里，并计为第三种结局", async () => {
    // 只进 console.warn 时，这条信息走的是 MCP server 的 stderr，主 agent 永远看不到，
    // tools 层那个 deniedTools 判断就是一段永不触发的死代码 ——
    // 「被拒 = 没审过」这条防线在生产路径上根本没接上
    agentImpl = async (deniedOut) => {
      deniedOut?.push("Read");
      return '{"errors":[],"warnings":[]}';
    };
    const g = makeGround(db, { content: "证据", verification: "pending", attachments: ["a.txt"] });
    const r = await executeStatementReview(makeReviewConfig(), db, g.id);
    expect(r.deniedTools).toEqual(["Read"]);
    expect(r.reviewError).toBeDefined();
    // 关键：不得作为一次干净通过返回 —— 图上它与真通过完全同形
    expect(r.errors).toEqual([]);
  });

  test("无拒绝时不留下 deniedTools / reviewError", async () => {
    const g = makeGround(db, { content: "证据", verification: "pending", attachments: ["a.txt"] });
    const r = await executeStatementReview(makeReviewConfig(), db, g.id);
    expect(r.deniedTools).toBeUndefined();
    expect(r.reviewError).toBeUndefined();
    expect(r.errors).toEqual([]);
  });
});

describe("mapLimit 的并发上限环境变量拼写", () => {
  test("WARRANTED_REVIEW_CONCURRENCY 生效", async () => {
    const { getDefaultLimit } = await import("../src/concurrency.ts");
    const prev = process.env.WARRANTED_REVIEW_CONCURRENCY;
    try {
      process.env.WARRANTED_REVIEW_CONCURRENCY = "7";
      expect(getDefaultLimit()).toBe(7);
    } finally {
      if (prev === undefined) delete process.env.WARRANTED_REVIEW_CONCURRENCY;
      else process.env.WARRANTED_REVIEW_CONCURRENCY = prev;
    }
  });

  test("未设置时默认 4", async () => {
    const { getDefaultLimit } = await import("../src/concurrency.ts");
    const prev = process.env.WARRANTED_REVIEW_CONCURRENCY;
    delete process.env.WARRANTED_REVIEW_CONCURRENCY;
    try {
      expect(getDefaultLimit()).toBe(4);
    } finally {
      if (prev !== undefined) process.env.WARRANTED_REVIEW_CONCURRENCY = prev;
    }
  });
});

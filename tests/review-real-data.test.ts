/**
 * Review 集成测试 — 通用项目扫描
 *
 * 用法：PROJECT_DIR=/path/to/project bun test tests/review-real-data.test.ts
 *
 * 自动从 $PROJECT_DIR/.toulmin/argument.db 读取所有 verified Ground，
 * 对每个 verified Ground 跑 Evidence Review。要花真实 API 额度。
 */

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join } from "path";
import { loadReviewConfig } from "../src/review-config.ts";
import { callAgent, parseLLMResponse } from "../src/review-llm.ts";
import { buildStatementEvidencePrompt } from "../src/review-prompts.ts";

// =============================================================================
// 项目路径
// =============================================================================
//
// 只认环境变量。文件头以前写的是 `--project-dir=路径`，代码里以前也有一个解析
// `--project-dir` 的循环 —— 两个都不工作：`bun test` 不把自己不认识的参数传给
// 测试进程，`process.argv.slice(2)` 在 bun test 下恒为空，`--` 也不透传。实测过
// 等号、空格、`--` 三种写法，argv 里一个都没有。
//
// 也没有默认路径。这里以前兜底一台机器上的一个目录，于是在别的机器上跳过时打印的
// 是一条读者从没见过的路径，而真实原因是"你没给项目目录"。两件事要分开说。

const USAGE = "PROJECT_DIR=/path/to/project bun test tests/review-real-data.test.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || null;

const DB_PATH = PROJECT_DIR ? join(PROJECT_DIR, ".toulmin", "argument.db") : null;
const CONFIG_PATH = PROJECT_DIR ? join(PROJECT_DIR, ".toulmin", "review.json") : null;

const dbExists = !!DB_PATH && existsSync(DB_PATH);
if (!PROJECT_DIR) {
  console.error(`[Integration] 跳过：没有指定项目目录。用法：${USAGE}`);
} else if (!dbExists) {
  console.error(`[Integration] 跳过：${PROJECT_DIR} 下没有 .toulmin/argument.db`);
}

// =============================================================================
// 工具函数
// =============================================================================

function getAllVerifiedGroundsWithAttachments(db: Database): any[] {
  const grounds = db
    .prepare("SELECT * FROM nodes WHERE type = 'statement'")
    .all() as any[];
  return grounds.filter((g) => {
    const data = JSON.parse(g.data);
    return data.verification === "verified" && data.attachments?.length > 0;
  });
}

// =============================================================================
// 动态生成测试
// =============================================================================

describe.skipIf(!dbExists)("真实数据审查测试", () => {
  if (!dbExists) return;
  const projectDir = PROJECT_DIR!;

  const config = loadReviewConfig(CONFIG_PATH!, DB_PATH!);
  const db = new Database(DB_PATH!, { readonly: true });

  // =========================================================================
  // 自动发现所有 verified Ground 并跑 Evidence Review
  // =========================================================================
  const verifiedGrounds = getAllVerifiedGroundsWithAttachments(db);
  console.error(`[Integration] Found ${verifiedGrounds.length} verified grounds with attachments`);

  for (const gRow of verifiedGrounds) {
    const groundData = JSON.parse(gRow.data);

    test(`Ground Evidence Review: Ground #${gRow.id} (${groundData.source})`, async () => {
      if (!config) throw new Error("Config not loaded");

      const prompt = buildStatementEvidencePrompt({
        statement: {
          id: gRow.id,
          content: gRow.content,
          source: groundData.source,
          attachments: groundData.attachments || [],
        },
      });

      console.error(`\n[Integration] === Ground Evidence Review: Ground #${gRow.id} ===`);
      console.error(`[Integration] Attachments:`, groundData.attachments);

      const raw = await callAgent(config, prompt, groundData.attachments || [], projectDir);
      const result = parseLLMResponse(raw, "");

      const errors = (result.errors as string[]) || [];
      const warnings = (result.warnings as string[]) || [];
      console.error(`[Integration] Errors: ${errors.length}, Warnings: ${warnings.length}`);
      for (const e of errors) console.error(`  [ERROR] ${e}`);
      for (const w of warnings) console.error(`  [WARNING] ${w}`);

      expect(Array.isArray(errors)).toBe(true);
      expect(Array.isArray(warnings)).toBe(true);
    }, { timeout: 180_000 });
  }
});

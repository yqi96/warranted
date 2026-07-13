/**
 * Review 集成测试 — 通用项目扫描
 *
 * 用法：bun test tests/review-real-data.test.ts --project-dir=/path/to/project
 *
 * 自动从 project/.toulmin/argument.db 读取所有论证链，
 * 对每条完整链路（Claim→Warrant→Grounds）跑 Argument Review，
 * 对所有 verified Ground 跑 Evidence Review。
 */

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { loadReviewConfig } from "../src/review-config.ts";
import { callAgent, parseLLMResponse } from "../src/review-llm.ts";
import { buildArgumentReviewPrompt, buildGroundEvidencePrompt } from "../src/review-prompts.ts";
import { detectConnectedChain } from "../src/service.ts";

// =============================================================================
// 从命令行参数或环境变量获取项目路径
// =============================================================================

const PROJECT_DIR = process.env.PROJECT_DIR || (() => {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project-dir" && args[i + 1]) return args[i + 1];
  }
  return "/home/qiyao/workspace/reproduce-test/v0.2/37_pages2k_2019(select)";
})();

const DB_PATH = join(PROJECT_DIR, ".toulmin", "argument.db");
const CONFIG_PATH = "/home/qiyao/workspace/team-work/toulmin-mcp/.toulmin/review.json";

if (!existsSync(DB_PATH)) {
  throw new Error(`Database not found: ${DB_PATH}`);
}

console.error(`[Integration] Project: ${PROJECT_DIR}`);
console.error(`[Integration] DB: ${DB_PATH}`);

// =============================================================================
// 工具函数
// =============================================================================

function readNode(db: Database, id: number): any {
  const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as any;
  if (!row) throw new Error(`Node #${id} not found`);
  return { ...row, data: JSON.parse(row.data) };
}

function getAllWarrants(db: Database): any[] {
  return db.prepare("SELECT * FROM nodes WHERE type = 'warrant'").all() as any[];
}

function getAllVerifiedGroundsWithAttachments(db: Database): any[] {
  const grounds = db
    .prepare("SELECT * FROM nodes WHERE type = 'ground'")
    .all() as any[];
  return grounds.filter((g) => {
    const data = JSON.parse(g.data);
    return data.verification === "verified" && data.attachments?.length > 0;
  });
}

// =============================================================================
// 动态生成测试
// =============================================================================

describe("真实数据审查测试", () => {
  const config = loadReviewConfig(CONFIG_PATH, DB_PATH);
  const db = new Database(DB_PATH, { readonly: true });

  // =========================================================================
  // 自动发现所有论证链并跑 Argument Review
  // =========================================================================
  const warrants = getAllWarrants(db);
  console.error(`[Integration] Found ${warrants.length} warrants in DB`);

  for (const wRow of warrants) {
    const chain = detectConnectedChain(db, wRow.id);
    if (!chain) continue; // 跳过不完整链路

    const claim = readNode(db, chain.claimId);
    const warrant = readNode(db, chain.warrantId);
    const grounds = chain.groundIds.map((gid) => readNode(db, gid));

    test(`Argument Review: Claim #${chain.claimId} → Warrant #${chain.warrantId}`, async () => {
      if (!config) throw new Error("Config not loaded");

      const prompt = buildArgumentReviewPrompt({
        claim: {
          id: chain.claimId,
          content: claim.content,
          status: claim.data.status,
          qualifier: claim.data.qualifier || null,
        },
        warrant: { id: chain.warrantId, content: warrant.content },
        grounds: grounds.map((g) => ({
          id: g.id,
          content: g.content,
          source: g.data.source,
          verification: g.data.verification,
          attachments: g.data.attachments || [],
        })),
      });

      console.error(`\n[Integration] === Argument Review: Claim #${chain.claimId} ===`);
      console.error(`[Integration] Prompt length: ${prompt.length} chars`);

      const raw = await callAgent(config, prompt, [], PROJECT_DIR);
      const result = parseLLMResponse(raw, "");

      // Argument review 可能返回旧格式 {verdict, summary, issues} 或新格式 {errors, warnings}
      if (result.verdict) {
        console.error(`[Integration] Verdict: ${result.verdict}`);
        expect(["sound", "concerns", "invalid"]).toContain(result.verdict as string);
      } else {
        console.error(`[Integration] Errors: ${(result.errors as any[])?.length ?? 0}`);
        expect(result.errors).toBeDefined();
      }
    }, { timeout: 180_000 });
  }

  // =========================================================================
  // 自动发现所有 verified Ground 并跑 Evidence Review
  // =========================================================================
  const verifiedGrounds = getAllVerifiedGroundsWithAttachments(db);
  console.error(`[Integration] Found ${verifiedGrounds.length} verified grounds with attachments`);

  for (const gRow of verifiedGrounds) {
    const groundData = JSON.parse(gRow.data);

    test(`Ground Evidence Review: Ground #${gRow.id} (${groundData.source})`, async () => {
      if (!config) throw new Error("Config not loaded");

      const prompt = buildGroundEvidencePrompt({
        ground: {
          id: gRow.id,
          content: gRow.content,
          source: groundData.source,
          verification: groundData.verification,
          attachments: groundData.attachments || [],
        },
      });

      console.error(`\n[Integration] === Ground Evidence Review: Ground #${gRow.id} ===`);
      console.error(`[Integration] Attachments:`, groundData.attachments);

      const raw = await callAgent(config, prompt, groundData.attachments || [], PROJECT_DIR);
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

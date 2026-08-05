/**
 * Agent 行为评测 runner。
 *
 * 默认 dry-run(只打印将要执行什么,不花一分钱);加 --live 才真正调用 claude。
 *
 * 用法:
 *   bun tests/agent-eval/run.ts                    # dry-run,列出全部用例
 *   bun tests/agent-eval/run.ts --tier 1 --live    # 只跑 Tier 1(判断层,便宜)
 *   bun tests/agent-eval/run.ts --case support-task-live --live
 *   bun tests/agent-eval/run.ts --live --judge     # 附带 LLM judge 评分
 *   bun tests/agent-eval/run.ts --live --model claude-sonnet-5
 */
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { cases } from "./cases";
import { openGraph, totalNodes } from "./helpers";
import type { AssertCtx, EvalCase, Tier2Case } from "./types";

const ROOT = resolve(import.meta.dir, "../..");
const AGENT = "warranted:toulmin-researcher";
const RESULTS_ROOT = join(import.meta.dir, "results");

const { values: opts } = parseArgs({
  options: {
    live: { type: "boolean", default: false },
    judge: { type: "boolean", default: false },
    case: { type: "string" },
    tier: { type: "string" },
    model: { type: "string" },
    timeout: { type: "string", default: "600" },
  },
});

const TIMEOUT_MS = Number(opts.timeout) * 1000;

const selected = cases.filter((c) => {
  if (opts.case && !opts.case.split(",").includes(c.id)) return false;
  if (opts.tier && String(c.tier) !== opts.tier) return false;
  return true;
});

if (selected.length === 0) {
  console.error("没有匹配的用例。可用用例:");
  for (const c of cases) console.error(`  [tier${c.tier}] ${c.id} — ${c.title}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 命令构造
// ---------------------------------------------------------------------------

const TIER1_WRAPPER = (instruction: string) =>
  `假设接到以下指令,你会如何处理?请只说明你的计划——包括是否需要操作论证图、建立哪些结构、以什么先后顺序——不要实际执行任何步骤:\n\n"""\n${instruction}\n"""`;

function claudeCmd(prompt: string, maxTurns: number): string[] {
  return [
    "claude",
    "-p",
    prompt,
    "--plugin-dir",
    ROOT,
    "--agent",
    AGENT,
    // 洁净室(系统临时目录)内跑,跳过权限询问,否则 headless 下工具调用会被静默拒绝
    "--dangerously-skip-permissions",
    "--output-format",
    "json",
    "--max-turns",
    String(maxTurns),
    ...(opts.model ? ["--model", opts.model] : []),
  ];
}

function judgeCmd(prompt: string): string[] {
  return [
    "claude",
    "-p",
    prompt,
    "--output-format",
    "json",
    "--max-turns",
    "1",
    ...(opts.model ? ["--model", opts.model] : []),
  ];
}

async function runClaude(cmd: string[], cwd: string): Promise<{ answer: string; raw: string }> {
  const proc = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  const [raw, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  clearTimeout(timer);
  if (proc.exitCode !== 0 && !raw.trim()) {
    return { answer: `<claude 退出码 ${proc.exitCode}: ${err.slice(0, 500)}>`, raw };
  }
  try {
    const parsed = JSON.parse(raw);
    return { answer: parsed.result ?? raw, raw };
  } catch {
    return { answer: raw, raw };
  }
}

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------

interface JudgeVerdict {
  pass: boolean;
  criteria: Array<{ name: string; pass: boolean; reason: string }>;
}

async function runJudge(
  rubric: string[],
  content: string,
  outDir: string,
): Promise<JudgeVerdict | null> {
  const prompt = [
    "你是严格的评审。以下是一个研究 agent 的输出,请按评分标准逐条判断是否达成。",
    '只输出 JSON,不要任何其他文字:{"pass": <全部达成为 true>, "criteria": [{"name": "<标准原文>", "pass": <bool>, "reason": "<一句话理由>"}]}',
    "",
    "评分标准:",
    ...rubric.map((r, i) => `${i + 1}. ${r}`),
    "",
    "被评内容:",
    '"""',
    content,
    '"""',
  ].join("\n");
  const { answer, raw } = await runClaude(judgeCmd(prompt), outDir);
  writeFileSync(join(outDir, "judge-raw.json"), raw);
  const match = answer.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as JudgeVerdict;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 图 dump(给 judge 和归档用)
// ---------------------------------------------------------------------------

function dumpGraph(dbPath: string): string {
  const db = openGraph(dbPath);
  if (!db) return "(未创建图数据库)";
  const nodes = db.query("SELECT id, type, content, data FROM nodes ORDER BY id").all();
  const wg = db.query("SELECT * FROM warrant_grounds").all();
  const rb = db.query("SELECT * FROM rebuttal_targets").all();
  return JSON.stringify({ nodes, warrant_grounds: wg, rebuttal_targets: rb }, null, 2);
}

// ---------------------------------------------------------------------------
// 用例执行
// ---------------------------------------------------------------------------

interface CaseResult {
  id: string;
  tier: 1 | 2;
  checks: Array<{ name: string; pass: boolean; detail?: string }>;
  judge?: JudgeVerdict | null;
}

function prepareScratch(c: EvalCase): string {
  // 洁净室:scratch 放在系统临时目录,避免被测 agent 把 warranted 仓库当作所在项目
  const scratch = mkdtempSync(join(tmpdir(), `agent-eval-${c.id}-`));
  for (const [rel, content] of Object.entries(c.files ?? {})) {
    const p = join(scratch, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  if (c.tier === 2 && (c as Tier2Case).seed) {
    const dbDir = join(scratch, ".toulmin");
    mkdirSync(dbDir, { recursive: true });
    const db = new Database(join(dbDir, "argument.db"), { create: true });
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(readFileSync(join(ROOT, "sql/schema.sql"), "utf-8"));
    (c as Tier2Case).seed!(db);
    db.close();
  }
  return scratch;
}

async function runCase(c: EvalCase, runDir: string): Promise<CaseResult> {
  const outDir = join(runDir, c.id);
  mkdirSync(outDir, { recursive: true });
  const scratch = prepareScratch(c);
  const dbPath = join(scratch, ".toulmin/argument.db");

  const prompt = c.tier === 1 ? TIER1_WRAPPER(c.instruction) : c.instruction;
  const maxTurns = c.maxTurns ?? (c.tier === 1 ? 6 : 15);

  console.log(`\n▶ [tier${c.tier}] ${c.id} — ${c.title}`);
  const { answer, raw } = await runClaude(claudeCmd(prompt, maxTurns), scratch);
  writeFileSync(join(outDir, "response-raw.json"), raw);
  writeFileSync(join(outDir, "answer.md"), answer);
  writeFileSync(join(outDir, "graph-dump.json"), dumpGraph(dbPath));

  const checks: CaseResult["checks"] = [];
  const db = openGraph(dbPath);
  const ctx: AssertCtx = { db, scratch, answer };

  if (c.tier === 1) {
    // Tier 1 统一硬断言:声明"只说计划"时不得实际动图
    const n = totalNodes(db);
    checks.push({
      name: "假设性提问下未实际操作图",
      pass: n === 0,
      detail: n === 0 ? undefined : `实际创建了 ${n} 个节点`,
    });
  } else {
    for (const a of (c as Tier2Case).assertions) {
      let pass = false;
      let detail: string | undefined;
      try {
        const r = a.check(ctx);
        pass = r === true;
        detail = r === true ? undefined : r;
      } catch (e) {
        detail = `断言抛出异常: ${e}`;
      }
      checks.push({ name: a.name, pass, detail });
    }
  }
  db?.close();

  let judge: JudgeVerdict | null | undefined;
  if (opts.judge && c.rubric?.length) {
    const judged =
      c.tier === 1 ? answer : `${answer}\n\n--- 运行后的论证图 ---\n${dumpGraph(dbPath)}`;
    judge = await runJudge(c.rubric, judged, outDir);
  }

  const result: CaseResult = { id: c.id, tier: c.tier, checks, judge };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(result, null, 2));

  // 归档完整工作目录后清理临时目录
  cpSync(scratch, join(outDir, "scratch"), { recursive: true });
  rmSync(scratch, { recursive: true, force: true });
  return result;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

if (!opts.live) {
  console.log("DRY-RUN(未加 --live,不会调用模型)。将执行的用例:\n");
  for (const c of selected) {
    const maxTurns = c.maxTurns ?? (c.tier === 1 ? 6 : 15);
    console.log(`[tier${c.tier}] ${c.id} — ${c.title}`);
    console.log(`  max-turns: ${maxTurns}${c.files ? `,fixtures: ${Object.keys(c.files).join(", ")}` : ""}`);
    console.log(`  指令: ${c.instruction.slice(0, 80)}${c.instruction.length > 80 ? "…" : ""}`);
  }
  const t1 = selected.filter((c) => c.tier === 1).length;
  const t2 = selected.filter((c) => c.tier === 2).length;
  console.log(
    `\n共 ${selected.length} 个用例(Tier1 ${t1} 个 / Tier2 ${t2} 个)` +
      `,预计 claude 调用 ${selected.length + (opts.judge ? selected.length : 0)} 次。`,
  );
  console.log("确认成本后加 --live 执行;建议测试期先移除/清空 review.json 以关闭 LLM review。");
  process.exit(0);
}

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(RESULTS_ROOT, runId);
mkdirSync(runDir, { recursive: true });

const results: CaseResult[] = [];
for (const c of selected) {
  results.push(await runCase(c, runDir));
}

console.log("\n========== 评测结果 ==========");
let failed = 0;
for (const r of results) {
  const allPass = r.checks.every((x) => x.pass) && r.judge?.pass !== false;
  if (!allPass) failed++;
  console.log(`\n${allPass ? "✅" : "❌"} [tier${r.tier}] ${r.id}`);
  for (const x of r.checks) {
    console.log(`   ${x.pass ? "✓" : "✗"} ${x.name}${x.detail ? ` — ${x.detail}` : ""}`);
  }
  if (r.judge === null) console.log("   ⚠ judge 输出无法解析(见 judge-raw.json)");
  if (r.judge) {
    for (const cr of r.judge.criteria) {
      console.log(`   ${cr.pass ? "✓" : "✗"} [judge] ${cr.name} — ${cr.reason}`);
    }
  }
}
console.log(`\n通过 ${results.length - failed}/${results.length},产物在 ${runDir}`);
writeFileSync(join(runDir, "summary.json"), JSON.stringify(results, null, 2));
process.exit(failed > 0 ? 1 : 0);

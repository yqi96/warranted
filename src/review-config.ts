/**
 * Warranted — 异步审查配置
 *
 * 从 JSON 配置文件加载审查功能配置。
 * 未提供配置文件或文件无效时返回 null，审查功能静默关闭。
 *
 * 配置文件格式（JSON）：
 * {
 *   "apiKey": "sk-xxx",              // 必需；作为 ANTHROPIC_API_KEY 递给 SDK 子进程
 *   "baseUrl": "https://...",         // 可选，转发站地址；作为 ANTHROPIC_BASE_URL 递给 SDK 子进程
 *   "model": "claude-sonnet-4-...",   // 可选，默认 claude-sonnet-4-20250514
 *   "fallbackModel": "claude-...",    // 可选，解析失败重试时换的模型；不设置 = 沿用 model
 *   "maxTurns": 10,                   // 可选，agent 最大轮数（正整数），默认 10
 *   "maxConcurrency": 4,              // 可选，全局并发上限（所有 callAgent 调用共享，正整数），默认 4
 *   "auditDir": "/path/to/audit"      // 可选，审计日志目录；null = 禁用；不设置 = dirname(dbPath)/audit
 * }
 *
 * 这个文件是启用审查的唯一入口：路径只从 `--review-config <file>` 来（见 index.ts
 * parseArgs），没有任何环境变量回落 —— index.ts 和本文件里都没有 process.env 读取。
 * 所以「设置 ANTHROPIC_API_KEY 来启用审查」是做不到的事，面向用户的提示不要那么说
 * （warnings.compiledWithoutReviewModel、messages.review_not_configured 都曾那么说）。
 *
 * apiKey/baseUrl 由 review-llm.ts 显式递给 SDK 子进程，且子进程以隔离模式启动
 * （settingSources: []），不读 ~/.claude/settings.json。所以这个文件必须自带
 * 完整凭据：以前靠用户 settings 里的 ANTHROPIC_BASE_URL 碰巧能跑通的部署，
 * 现在要把地址写进这里。外部 shell 的环境变量仍然继承。
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";

/**
 * 校验一个"正整数"配置项：合法就返回它，缺失或非法都返回 undefined，
 * 由调用处的 `?? 默认值` 决定回落到什么。
 *
 * 这里原来用 `isNaN(x)`。那道检查只拦得住 "abc" 和 {}：0、负数、""、[]、false、
 * Infinity、字符串 "8" 全部放行。而 JSON 语法里没有 NaN 字面量，配置文件是 JSON 文件，
 * 所以它守的恰好是唯一送不进来的值。放行 0 的实际后果不是"取默认值"，而是
 * review-llm.ts acquirePermit 的闸门开度为 0 —— 第一个请求挂进等待队列，
 * 而唤醒队列的条件是"有请求结束"，于是永久静默卡死，连网络请求都没发出去。
 *
 * 同一条规则在 concurrency.ts getDefaultLimit 里写对过一次（Number.isFinite && > 0）。
 * 两处没有合并：那边校验的是环境变量字符串（parseInt 的产物），这边是 JSON 解析出的任意值，
 * 且改完之后两种写法对所有输入判定一致。改其中一处时记得看另一处。
 *
 * 非法值只警告 + 回落，不关闭审查：一个旋钮填错不等于整套功能没法工作
 * （对比 apiKey 缺失 —— 那是真的没法工作，直接返回 null）。
 */
function positiveInt(name: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  // 数字单独走 String()：JSON.stringify(Infinity) 是 "null"，会把 1e400 报成 null。
  const shown = typeof value === "number" ? String(value) : JSON.stringify(value);
  console.error(
    `[Warranted] Invalid ${name}: ${shown}. Must be a positive integer. Falling back to the default.`
  );
  return undefined;
}

/**
 * Compute the review working directory from the database path.
 * The review cwd is the parent of the database directory (dirname(dirname(dbPath))).
 * All attachment paths are resolved relative to this directory.
 */
export function reviewCwd(config: ReviewConfig): string;
export function reviewCwd(dbPath: string): string;
export function reviewCwd(configOrPath: ReviewConfig | string): string {
  const p = typeof configOrPath === "string" ? configOrPath : configOrPath.dbPath;
  return resolve(dirname(dirname(p)));
}

export interface ReviewConfig {
  enabled: boolean;
  provider: "anthropic";
  model: string;
  /**
   * 解析失败重试时换用的模型。不设置 = 沿用 model。
   * 不设置时刻意不猜一个"更强的模型" —— 只用已经证明在这个 endpoint 上存在的模型名
   * （见 review-llm.ts callAndParse）。
   */
  fallbackModel?: string;
  apiKey: string;
  baseUrl?: string;
  maxTurns: number;
  /** 所有 callAgent 调用共享的全局并发上限。默认 4（见 review-llm.ts DEFAULT_MAX_CONCURRENCY） */
  maxConcurrency?: number;
  reviewDir: string | null;
  /** 审计日志目录。null = 禁用审计。默认 dirname(dbPath)/audit */
  auditDir: string | null;
  dbPath: string;
}

interface ReviewConfigFile {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fallbackModel?: string;
  maxTurns?: number;
  maxConcurrency?: number;
  /** 审计日志目录。null = 禁用审计。不设置时默认 dirname(dbPath)/audit */
  auditDir?: string | null;
}

/**
 * 从 JSON 配置文件加载审查配置。
 * @param configPath 配置文件路径，或 null/undefined 表示不启用审查
 * @param dbPath 数据库路径（用于推导 review 目录）
 * @returns ReviewConfig 或 null（审查关闭）
 */
export function loadReviewConfig(
  configPath: string | null | undefined,
  dbPath: string
): ReviewConfig | null {
  // 未提供配置文件
  if (!configPath) {
    console.error("[Warranted] No review config specified. Reviews disabled.");
    return null;
  }

  // 配置文件不存在
  if (!existsSync(configPath)) {
    console.error(`[Warranted] Config file not found: ${configPath}. Reviews disabled.`);
    return null;
  }

  // 读取并解析
  let fileConfig: ReviewConfigFile;
  try {
    const content = readFileSync(configPath, "utf-8");
    fileConfig = JSON.parse(content);
  } catch (err) {
    console.error(`[Warranted] Failed to parse config file: ${configPath}. Reviews disabled.`);
    console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  // 校验必需字段
  const apiKey = fileConfig.apiKey;
  if (!apiKey) {
    console.error(`[Warranted] No apiKey in config file. Reviews disabled.`);
    return null;
  }

  const model = fileConfig.model ?? "claude-sonnet-4-20250514";
  // fallbackModel 和 model 一样不做取值校验：两个字段是同一种东西（模型名），
  // 只给其中一个加校验会产生"同一条规则两处编码"。要加就一起加。
  const fallbackModel = fileConfig.fallbackModel ?? undefined;
  const maxTurns = positiveInt("maxTurns", fileConfig.maxTurns) ?? 10;
  const maxConcurrency = positiveInt("maxConcurrency", fileConfig.maxConcurrency);
  const baseUrl = fileConfig.baseUrl ?? undefined;
  const reviewDir = dirname(dbPath) + "/reviews";

  // auditDir: null = 禁用；string = 自定义；未设置 = 默认路径
  const auditDir = "auditDir" in fileConfig
    ? (fileConfig.auditDir ?? null)
    : dirname(dbPath) + "/audit";

  // 确保 review 目录存在
  if (!existsSync(reviewDir)) {
    mkdirSync(reviewDir, { recursive: true });
  }

  // 确保 audit 目录存在（仅在启用时）
  if (auditDir && !existsSync(auditDir)) {
    mkdirSync(auditDir, { recursive: true });
  }

  console.error(`[Warranted] Config loaded: ${configPath}`);

  return {
    enabled: true,
    provider: "anthropic",
    model,
    // 未设置时整个键不出现，由 callAndParse 的 `?? config.model` 接管。
    ...(fallbackModel !== undefined ? { fallbackModel } : {}),
    apiKey,
    baseUrl,
    maxTurns,
    // 非法值在 positiveInt 里已经变成 undefined，这里整个键不出现，
    // 由消费处的默认值接管（review-llm.ts DEFAULT_MAX_CONCURRENCY）。
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    reviewDir,
    auditDir,
    dbPath,
  };
}

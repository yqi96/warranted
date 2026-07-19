/**
 * Toulmin MCP — 异步审查配置
 *
 * 从 JSON 配置文件加载审查功能配置。
 * 未提供配置文件或文件无效时返回 null，审查功能静默关闭。
 *
 * 配置文件格式（JSON）：
 * {
 *   "apiKey": "sk-xxx",              // 必需
 *   "baseUrl": "https://...",         // 可选，转发站地址
 *   "model": "claude-sonnet-4-...",   // 可选，默认 claude-sonnet-4-20250514
 *   "debounceMs": 30000,              // 可选，去重窗口（毫秒），默认 30000
 *   "maxTurns": 10,                   // 可选，agent 最大轮数，默认 10
 *   "auditDir": "/path/to/audit"      // 可选，审计日志目录；null = 禁用；不设置 = dirname(dbPath)/audit
 * }
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname } from "path";

export interface ReviewConfig {
  enabled: boolean;
  provider: "anthropic";
  model: string;
  apiKey: string;
  baseUrl?: string;
  debounceMs: number;
  maxTurns: number;
  reviewDir: string | null;
  /** 审计日志目录。null = 禁用审计。默认 dirname(dbPath)/audit */
  auditDir: string | null;
  dbPath: string;
}

interface ReviewConfigFile {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  debounceMs?: number;
  maxTurns?: number;
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
    console.error("[Toulmin Review] No review config specified. Reviews disabled.");
    return null;
  }

  // 配置文件不存在
  if (!existsSync(configPath)) {
    console.error(`[Toulmin Review] Config file not found: ${configPath}. Reviews disabled.`);
    return null;
  }

  // 读取并解析
  let fileConfig: ReviewConfigFile;
  try {
    const content = readFileSync(configPath, "utf-8");
    fileConfig = JSON.parse(content);
  } catch (err) {
    console.error(`[Toulmin Review] Failed to parse config file: ${configPath}. Reviews disabled.`);
    console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  // 校验必需字段
  const apiKey = fileConfig.apiKey;
  if (!apiKey) {
    console.error(`[Toulmin Review] No apiKey in config file. Reviews disabled.`);
    return null;
  }

  const model = fileConfig.model ?? "claude-sonnet-4-20250514";
  const debounceMs = fileConfig.debounceMs ?? 30000;
  const maxTurns = fileConfig.maxTurns ?? 10;
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

  console.error(`[Toulmin Review] Config loaded: ${configPath}`);

  return {
    enabled: true,
    provider: "anthropic",
    model,
    apiKey,
    baseUrl,
    debounceMs: isNaN(debounceMs) ? 30000 : debounceMs,
    maxTurns: isNaN(maxTurns) ? 10 : maxTurns,
    reviewDir,
    auditDir,
    dbPath,
  };
}

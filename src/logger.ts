/**
 * Warranted — 轻量操作日志
 *
 * 记录每次工具调用的：工具名、输入摘要、结果（成功/失败）、耗时。
 * 输出目标：stderr（不影响 MCP stdout JSON-RPC 协议）。
 *
 * 日志格式（单行，便于 grep）：
 *   [Warranted] 2025-01-15T10:30:00.123Z | create_claim | OK  | 3ms | content="xxx"
 *   [Warranted] 2025-01-15T10:30:00.456Z | create_ground | ERR | 1ms | Error: validation failed
 */

import { appendFileSync } from "fs";

// =============================================================================
// 状态
// =============================================================================

let logFilePath: string | null = null;

/** 初始化日志文件路径（在 index.ts 启动时调用） */
export function initLogger(filePath: string): void {
  logFilePath = filePath;
}

// =============================================================================
// 核心日志函数
// =============================================================================

export function log(
  toolName: string,
  status: "OK" | "ERR",
  durationMs: number,
  summary: string,
): void {
  const ts = new Date().toISOString();
  const line = `[Warranted] ${ts} | ${toolName.padEnd(18)} | ${status} | ${durationMs}ms | ${summary}`;

  // 始终输出到 stderr
  console.error(line);

  // 如果配置了日志文件，同时追加写入
  if (logFilePath) {
    try {
      appendFileSync(logFilePath, line + "\n");
    } catch {
      // 写入失败不影响主流程
    }
  }
}

// =============================================================================
// 输入摘要工具
// =============================================================================

/** 将工具输入参数序列化为紧凑摘要字符串（截断长文本） */
export function summarizeInput(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    let repr: string;
    if (typeof value === "string") {
      repr = value.length > 60 ? `"${value.slice(0, 57)}..."` : `"${value}"`;
    } else if (Array.isArray(value)) {
      repr = `[${value.length}]`;
    } else {
      repr = String(value);
    }
    parts.push(`${key}=${repr}`);
  }
  return parts.join(", ");
}

/** 从工具返回结果中提取摘要（取第一行，截断） */
export function summarizeOutput(resultText: string): string {
  const firstLine = resultText.split("\n")[0];
  return firstLine.length > 100 ? firstLine.slice(0, 97) + "..." : firstLine;
}

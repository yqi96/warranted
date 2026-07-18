/**
 * Toulmin MCP — LLM 调用层（Agent SDK）
 *
 * 使用 Claude Agent SDK 的 query() 进行审查。
 * Agent 可以自主读取附件文件，进行多轮推理后给出审查结论。
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ReviewConfig } from "./review-config.ts";
import { writeAuditRecord } from "./review-audit.ts";

/**
 * 调用 Agent 执行审查。
 * Agent 拥有 Read/Glob/Grep 工具，可以读取附件文件。
 * 返回最终文本结果（期望是 JSON）。
 */
export async function callAgent(
  config: ReviewConfig,
  prompt: string,
  attachmentPaths: string[],
  cwd?: string,
  requestId?: string
): Promise<string> {
  // 构建完整 prompt：审查指令 + 附件路径列表
  const fullPrompt = attachmentPaths.length > 0
    ? `${prompt}\n\n## Attachment files to read\nPlease read and analyze the following files before responding:\n${attachmentPaths.map(p => `- ${p}`).join("\n")}`
    : prompt;

  const t0 = Date.now();
  const result = await query({
    prompt: fullPrompt,
    options: {
      model: config.model,
      maxTurns: config.maxTurns ?? 10,
      // 只给只读工具
      allowedTools: ["Read", "Glob", "Grep"],
      // 禁止写操作
      disallowedTools: ["Edit", "Write", "Bash", "MultiEdit"],
      // 静默模式
      permissionMode: "bypassPermissions",
      // 工作目录（agent 在此目录下搜索和读取文件）
      ...(cwd ? { cwd } : {}),
      // 禁用所有 MCP 服务器（reviewer 不需要 MCP 工具）
      mcpServers: {},
    },
  });

  // 收集消息，提取最终结果
  let finalResult = "";
  for await (const message of result) {
    if (message.type === "result" && message.subtype === "success") {
      finalResult = message.result || "";
    }
  }

  if (!finalResult) {
    throw new Error("Agent returned no result");
  }

  // 写入审计日志（失败时静默忽略）
  if (config.auditDir) {
    const rid = requestId ?? crypto.randomUUID();
    writeAuditRecord(config.auditDir, {
      timestamp: new Date().toISOString(),
      requestId: rid,
      model: config.model,
      maxTurns: config.maxTurns ?? 10,
      input: { prompt: fullPrompt, attachmentPaths, cwd },
      output: { raw: finalResult, durationMs: Date.now() - t0 },
    });
  }

  return finalResult;
}

const FALLBACK_MODEL = "claude-opus-4-7";

/**
 * 从文本中提取 markdown 代码块内容。
 * 按行扫描：找到首个开启 fence，再从末尾往前找最后一个关闭 fence，
 * 避免 lazy regex 在内容含三反引号时提前终止。
 */
function extractFromFences(text: string): string | null {
  const lines = text.split("\n");
  const openIdx = lines.findIndex(l => /^[ \t]*```(?:json)?[ \t]*$/.test(l));
  if (openIdx === -1) return null;
  for (let i = lines.length - 1; i > openIdx; i--) {
    if (/^[ \t]*```[ \t]*$/.test(lines[i])) {
      return lines.slice(openIdx + 1, i).join("\n");
    }
  }
  return null;
}

function toStr(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

/**
 * 从 Agent 响应文本中提取 JSON 对象（通用解析器）。
 * 自动剥除 markdown 代码围栏，返回任意 JSON 对象。
 * 如果解析失败，在返回值中标记 _parseFailed: true。
 */
export function parseLLMResponse(
  raw: string,
  _fallback: string
): Record<string, unknown> {
  let jsonText = raw.trim();
  const extracted = extractFromFences(jsonText);
  if (extracted !== null) {
    jsonText = extracted.trim();
  }

  try {
    const parsed = JSON.parse(jsonText);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
    return { _parseFailed: true, errors: [jsonText.slice(0, 500)], warnings: [] };
  } catch {
    return { _parseFailed: true, errors: [raw.slice(0, 500)], warnings: [] };
  }
}

/**
 * 调用 Agent 并解析结果。解析失败时自动用大模型重试一次。
 */
const NO_FENCES_SUFFIX = "\n\nCRITICAL: Output ONLY a raw JSON object. Do NOT wrap in markdown code fences (```)." as const;

export async function callAndParse(
  config: ReviewConfig,
  prompt: string,
  attachments: string[],
  cwd: string
): Promise<{ errors: string[]; warnings: string[] }> {
  const requestId = crypto.randomUUID();
  const raw = await callAgent(config, prompt + NO_FENCES_SUFFIX, attachments, cwd, requestId);
  const parsed = parseLLMResponse(raw, "");

  if (!parsed._parseFailed) {
    return {
      errors: ((parsed.errors as unknown[]) || []).map(toStr),
      warnings: ((parsed.warnings as unknown[]) || []).map(toStr),
    };
  }

  // 解析失败 → 用大模型重试（同一 requestId，便于关联）
  const retryConfig: ReviewConfig = { ...config, model: FALLBACK_MODEL, maxTurns: 3 };
  try {
    const retryRaw = await callAgent(retryConfig, prompt + NO_FENCES_SUFFIX, attachments, cwd, requestId);
    const retryParsed = parseLLMResponse(retryRaw, "");
    return {
      errors: ((retryParsed.errors as unknown[]) || []).map(toStr),
      warnings: ((retryParsed.warnings as unknown[]) || []).map(toStr),
    };
  } catch (e) {
    return { errors: [`Reviewer error: fallback model also failed: ${e}`], warnings: [] };
  }
}

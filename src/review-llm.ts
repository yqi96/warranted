/**
 * Toulmin MCP — LLM 调用层（Agent SDK）
 *
 * 使用 Claude Agent SDK 的 query() 进行审查。
 * Agent 可以自主读取附件文件，进行多轮推理后给出审查结论。
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ReviewConfig } from "./review-config.ts";

/**
 * 调用 Agent 执行审查。
 * Agent 拥有 Read/Glob/Grep 工具，可以读取附件文件。
 * 返回最终文本结果（期望是 JSON）。
 */
export async function callAgent(
  config: ReviewConfig,
  prompt: string,
  attachmentPaths: string[],
  cwd?: string
): Promise<string> {
  // 构建完整 prompt：审查指令 + 附件路径列表
  const fullPrompt = attachmentPaths.length > 0
    ? `${prompt}\n\n## Attachment files to read\nPlease read and analyze the following files before responding:\n${attachmentPaths.map(p => `- ${p}`).join("\n")}`
    : prompt;

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

  return finalResult;
}

/**
 * 解析 Agent 的 JSON 响应。
 * 期望格式：{ errors: [], warnings: [] }
 * 如果解析失败，将原始文本包装为 errors fallback。
 */
export function parseLLMResponse(
  raw: string,
  _fallback: string
): Record<string, unknown> {
  // 尝试提取 JSON 块（Agent 可能用 ```json 包裹）
  let jsonText = raw.trim();
  const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonText = jsonMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonText);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
    return { errors: [jsonText.slice(0, 500)], warnings: [] };
  } catch {
    return { errors: [raw.slice(0, 500)], warnings: [] };
  }
}

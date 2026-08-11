/**
 * Warranted — LLM 调用层（Agent SDK）
 *
 * 使用 Claude Agent SDK 的 query() 进行审查。
 * Agent 可以自主读取附件文件，进行多轮推理后给出审查结论。
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ReviewConfig } from "./review-config.ts";
import { writeAuditRecord } from "./review-audit.ts";

const DEFAULT_MAX_CONCURRENCY = 4;

/**
 * 全局并发上限信号量。所有 callAgent 调用（跨 compile-service、compile-reviewers、
 * review-sync 的全部 LLM 调用路径）共享同一个模块级实例，而非按 claim 或按调用方分别限流 ——
 * compileClaims 本身已对所有 claim 做 Promise.all，按 claim 限流无法真正限制总并发。
 */
let inFlight = 0;
const waiters: Array<() => void> = [];

async function acquirePermit(limit: number): Promise<void> {
  if (inFlight < limit) {
    inFlight++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inFlight++;
}

function releasePermit(): void {
  inFlight--;
  const next = waiters.shift();
  if (next) next();
}

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
  requestId?: string,
  deniedOut?: string[]
): Promise<string> {
  // 构建完整 prompt：审查指令 + 附件路径列表
  const fullPrompt = attachmentPaths.length > 0
    ? `${prompt}\n\n## Attachment files to read\nPlease read and analyze the following files before responding:\n${attachmentPaths.map(p => `- ${p}`).join("\n")}`
    : prompt;

  const t0 = Date.now();
  await acquirePermit(config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
  let finalResult = "";
  const deniedTools: string[] = [];
  try {
    const result = await query({
      prompt: fullPrompt,
      options: {
        model: config.model,
        maxTurns: config.maxTurns ?? 10,
        // 凭据必须显式递进去：SDK 起的是子进程，配置文件里的 apiKey/baseUrl
        // 曾经读进 ReviewConfig 就再没被任何人用过（src/ 里 config.apiKey 零个消费者），
        // 于是真正生效的是外部 shell 的环境变量 —— 用户按注释把密钥和转发站写进
        // review.json，加载日志还打 "Config loaded"，请求却打去了别处。
        //
        // ...process.env 不能省：显式传 env 会替换继承来的整个环境，不铺一遍等于清空
        // （连 PATH/HOME 都没了）。配置值放在展开之后 —— 为审查专门写的配置压过外部环境变量。
        //
        // apiKey 同时写进 API_KEY 和 AUTH_TOKEN 两个变量：SDK 里这两者各自独立读取，
        // apiKeyAuth() 发 X-Api-Key、bearerAuth() 发 Authorization: Bearer，
        // 返回的是 E([apiKeyAuth, bearerAuth]) —— 同时设置不冲突，只是两个头都发。
        // 官方 endpoint 认前者，转发站常只认后者，而配置里只有一个字段说"凭据"，
        // 无法表达该走哪种。两个都给，让 endpoint 挑它认的那个。
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: config.apiKey,
          ANTHROPIC_AUTH_TOKEN: config.apiKey,
          ...(config.baseUrl ? { ANTHROPIC_BASE_URL: config.baseUrl } : {}),
        },
        // 光传 env 不够，还要隔离文件设置。子进程是完整的 Claude Code CLI，
        // 它启动后会自己读 ~/.claude/settings.json 的 env 段，把上面传的值再盖一遍。
        // 实测：把三个 ANTHROPIC_* 从 process.env 删掉、config.baseUrl 填一个连不上的
        // 地址，请求照样 6.5 秒成功 —— 生效的是用户 settings 里的地址，不是配置文件里的。
        // 加上隔离后同一个死地址才真的失败，真地址才真的成功。
        // 只挡文件设置，不挡外部 shell 的环境变量（那些还是从 ...process.env 进来），
        // 所以「没配 baseUrl 时沿用外部环境」这条行为不变。
        //
        // 顺带的好处是审查器不再继承用户的 CLAUDE.md、hooks 和权限设置。
        // 一个看证据的审查器带着别人的项目约定和钩子去工作，本身就不对。
        settingSources: [],
        // 不往 ~/.claude/projects/ 写会话记录。每次 LLM 调用都会落一份 jsonl，
        // 而工作目录就是用户的项目根目录（reviewCwd = dirname(dirname(dbPath))），
        // 于是审查器的会话混进用户自己的 session 历史，/resume 时能看到。
        // 实测一个项目的审查工作量留下 300 个文件、144MB —— 是 reviews+audit+log
        // 三者合计（3MB）的 48 倍。审查器的会话没人要恢复，不需要留。
        persistSession: false,
        // 只给只读工具
        allowedTools: ["Read", "Glob", "Grep"],
        // 禁止写操作
        disallowedTools: ["Edit", "Write", "Bash", "MultiEdit"],
        // 从不询问：未预批准的操作直接拒绝，不会因为无 TTY 而卡死
        permissionMode: "dontAsk",
        // 工作目录（agent 在此目录下搜索和读取文件）
        ...(cwd ? { cwd } : {}),
        // 禁用所有 MCP 服务器（reviewer 不需要 MCP 工具）
        mcpServers: {},
      },
    });

    // 收集消息，提取最终结果
    for await (const message of result) {
      if (message.type === "result" && message.subtype === "success") {
        finalResult = message.result || "";
      } else if (message.type === "system" && message.subtype === "permission_denied") {
        deniedTools.push(message.tool_name);
      }
    }
  } finally {
    releasePermit();
  }
  if (deniedTools.length > 0) {
    // stderr only reaches the server operator, never the calling agent — so the
    // names are also handed back to the caller, which is what lets a denied
    // review be reported as "not reviewed" rather than counted as a pass.
    console.warn(`[review-llm] ${deniedTools.length} tool call(s) denied under dontAsk: ${deniedTools.join(", ")}`);
    deniedOut?.push(...deniedTools);
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
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      input: { prompt: fullPrompt, attachmentPaths, cwd },
      output: { raw: finalResult, durationMs: Date.now() - t0 },
    });
  }

  return finalResult;
}

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
 * 调用 Agent 并解析结果。解析失败时重试一次。
 *
 * 重试用 config.fallbackModel，没配就用同一个 config.model。
 * 这里原来写死 `model: "claude-opus-4-7", maxTurns: 3`：一个 2026-07 填进来的
 * Anthropic 官方模型 ID，加上一个凭空砍到 3 的轮数上限。两者都是丢用户的配置 ——
 * 配了转发站的部署未必有这个模型名，模型不存在时 callAgent 抛错，被下面的 catch
 * 接成一条 "Reviewer error"，于是一次本该救场的重试变成归咎于审查器的编译错误，
 * 而那个模型名不是用户选的。轮数同理：解析失败的原因是"输出不是 JSON"，
 * 不是"轮数太多"，没有理由借这个机会把 20 轮改成 3 轮 —— 附件都可能读不完。
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

  // 解析失败 → 重试一次（同一 requestId，便于关联）
  const retryConfig: ReviewConfig = { ...config, model: config.fallbackModel ?? config.model };
  try {
    const retryRaw = await callAgent(retryConfig, prompt + NO_FENCES_SUFFIX, attachments, cwd, requestId);
    const retryParsed = parseLLMResponse(retryRaw, "");
    return {
      errors: ((retryParsed.errors as unknown[]) || []).map(toStr),
      warnings: ((retryParsed.warnings as unknown[]) || []).map(toStr),
    };
  } catch (e) {
    return { errors: [`Reviewer error: retry with model ${retryConfig.model} also failed: ${e}`], warnings: [] };
  }
}

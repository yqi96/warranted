/**
 * Warranted — LLM 调用层（Agent SDK）
 *
 * 使用 Claude Agent SDK 的 query() 进行审查。
 * Agent 可以自主读取附件文件，进行多轮推理后给出审查结论。
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { resolve } from "path";
import type { ReviewConfig } from "./review-config.ts";
import { writeAuditRecord, type ReviewAuditMetadata } from "./review-audit.ts";

const DEFAULT_MAX_CONCURRENCY = 4;

interface TextReadCoverage {
  totalLines: number;
  intervals: Array<[startLine: number, endLine: number]>;
  invalid: boolean;
}

function isSafeIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

/**
 * Merge the line interval reported by one successful SDK Read into the coverage
 * already observed for the same resolved path. The hook response is the source
 * of truth: tool-input offset/limit describe the request, not what was returned.
 */
function recordTextCoverage(
  coverageByPath: Map<string, TextReadCoverage>,
  resolvedPath: string,
  file: Record<string, unknown>
): boolean {
  const { startLine, numLines, totalLines } = file;
  if (
    !isSafeIntegerAtLeast(startLine, 1) ||
    !isSafeIntegerAtLeast(numLines, 0) ||
    !isSafeIntegerAtLeast(totalLines, 0) ||
    file.truncatedByTokenCap === true
  ) {
    // A token-truncated response may end in the middle of a line. Line metadata
    // alone cannot prove that final line was fully observed, so fail closed.
    return false;
  }

  if (totalLines === 0) {
    return startLine === 1 && numLines === 0;
  }
  if (numLines === 0 || startLine > totalLines) return false;

  const linesRemaining = totalLines - startLine + 1;
  const endLine = numLines >= linesRemaining
    ? totalLines
    : startLine + numLines - 1;
  let coverage = coverageByPath.get(resolvedPath);
  if (!coverage) {
    coverage = { totalLines, intervals: [], invalid: false };
    coverageByPath.set(resolvedPath, coverage);
  }
  // Immutable snapshots cannot legitimately change totalLines. Once the hook
  // contradicts itself, do not let a later smaller total reset the evidence and
  // manufacture complete coverage.
  if (coverage.totalLines !== totalLines) coverage.invalid = true;
  if (coverage.invalid) return false;

  const ordered = [...coverage.intervals, [startLine, endLine] as [number, number]]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const interval of ordered) {
    const previous = merged.at(-1);
    if (!previous || interval[0] > previous[1] + 1) {
      merged.push([...interval]);
    } else {
      previous[1] = Math.max(previous[1], interval[1]);
    }
  }
  coverage.intervals = merged;
  return merged.length === 1 && merged[0]![0] === 1 && merged[0]![1] >= totalLines;
}

/**
 * 全局并发上限信号量。所有 callAgent 调用共享同一个模块级实例，而不是让每条命题
 * 或每个调用方各自限流；否则并发 review 多条命题时，总在飞请求数仍会失控。
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
 * Agent 只拥有 Read,且 PreToolUse 把它限制到本次传入的不可变附件快照。
 * 返回最终文本结果（期望是 JSON）。
 */
export async function callAgent(
  config: ReviewConfig,
  prompt: string,
  attachmentPaths: string[],
  cwd?: string,
  requestId?: string,
  deniedOut?: string[],
  successfulReadsOut?: string[],
  auditMetadata?: ReviewAuditMetadata
): Promise<string> {
  // 调用方递进来的已经是最终 prompt。它与 protocol hash 必须逐字相同。
  const fullPrompt = prompt;

  const t0 = Date.now();
  await acquirePermit(config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
  let finalResult = "";
  const deniedTools: string[] = [];
  const successfulReads: string[] = [];
  const successfulReadPaths = new Set<string>();
  const textCoverageByPath = new Map<string, TextReadCoverage>();
  const readRoot = cwd ?? process.cwd();
  const allowedReadPaths = new Set(attachmentPaths.map((path) => resolve(readRoot, path)));
  const abortController = new AbortController();
  const timeoutMs = config.timeoutMs ?? 300_000;
  let activeQuery: ReturnType<typeof query> | undefined;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort();
    activeQuery?.close?.();
  }, timeoutMs);
  const authorizeRead: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Read") return {};
    const raw = input.tool_input;
    const path = raw && typeof raw === "object" && "file_path" in raw &&
      typeof raw.file_path === "string"
      ? raw.file_path
      : null;
    const allowed = path !== null && allowedReadPaths.has(resolve(readRoot, path));
    if (!allowed) deniedTools.push(path ? `Read:${path}` : "Read");
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: allowed ? "allow" : "deny",
        permissionDecisionReason: allowed
          ? "Declared immutable review attachment"
          : "Only declared immutable review attachments may be read",
      },
    };
  };
  const recordSuccessfulRead: HookCallback = async (input) => {
    if (
      input.hook_event_name === "PostToolUse" &&
      input.tool_name === "Read" &&
      input.tool_input &&
      typeof input.tool_input === "object" &&
      "file_path" in input.tool_input &&
      typeof input.tool_input.file_path === "string"
    ) {
      const path = input.tool_input.file_path;
      const resolvedPath = resolve(readRoot, path);
      const response = input.tool_response;
      const complete = (() => {
        if (!response || typeof response !== "object" || !("type" in response)) return false;
        if (
          response.type === "text" &&
          "file" in response &&
          response.file &&
          typeof response.file === "object"
        ) {
          const file = response.file as Record<string, unknown>;
          return recordTextCoverage(textCoverageByPath, resolvedPath, file);
        }
        if (response.type === "file_unchanged") return successfulReadPaths.has(resolvedPath);
        if ("pages" in input.tool_input && input.tool_input.pages !== undefined) {
          // SDK 0.3.201 reports paginated PDFs as parts.file.count (pages
          // extracted), but exposes no totalPages. Even several successful page
          // ranges therefore cannot prove whole-document coverage.
          return false;
        }
        return (
          response.type === "image" ||
          response.type === "notebook" ||
          response.type === "pdf" ||
          response.type === "parts"
        );
      })();
      if (complete && !successfulReadPaths.has(resolvedPath)) {
        successfulReadPaths.add(resolvedPath);
        successfulReads.push(path);
      }
    }
    return {};
  };
  try {
    const result = activeQuery = query({
      prompt: fullPrompt,
      options: {
        model: config.model,
        maxTurns: config.maxTurns ?? 10,
        effort: config.effort ?? "medium",
        abortController,
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
          CLAUDE_CODE_EFFORT_LEVEL: config.effort ?? "medium",
          // Do not inherit the research agent's separate thinking-token override.
          MAX_THINKING_TOKENS: undefined,
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
        // 只给 Read,且下面的 PreToolUse 再把路径收窄到本次不可变快照。
        allowedTools: ["Read"],
        // 搜索工具也能返回未声明文件内容,因此与写操作一起禁用。
        disallowedTools: ["Edit", "Write", "Bash", "MultiEdit", "Glob", "Grep"],
        // 从不询问：未预批准的操作直接拒绝，不会因为无 TTY 而卡死
        permissionMode: "dontAsk",
        // 工作目录（agent 在此目录下搜索和读取文件）
        ...(cwd ? { cwd } : {}),
        // 禁用所有 MCP 服务器（reviewer 不需要 MCP 工具）
        mcpServers: {},
        // PostToolUse fires only after the built-in Read completed. Merely asking
        // the model to read, or observing no permission denial, is not evidence
        // that an attachment was actually opened.
        hooks: {
          PreToolUse: [{ matcher: "Read", hooks: [authorizeRead] }],
          PostToolUse: [{ matcher: "Read", hooks: [recordSuccessfulRead] }],
        },
      },
    });

    // 收集消息，提取最终结果
    for await (const message of result) {
      if (message.type === "result" && message.subtype === "success") {
        finalResult = message.result || "";
      } else if (message.type === "system" && message.subtype === "permission_denied") {
        deniedTools.push(message.tool_name);
      } else if (message.type === "result" && message.subtype !== "success") {
        throw new Error(`Review SDK ${message.subtype}: ${message.errors.join("; ")}`);
      }
    }
    if (timedOut) throw new Error(`Review attempt timed out after ${timeoutMs} ms`);
  } catch (error) {
    if (timedOut) throw new Error(`Review attempt timed out after ${timeoutMs} ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
    activeQuery?.close?.();
    // Preserve observed coverage and denials even when the SDK produces no final result.
    successfulReadsOut?.push(...successfulReads);
    deniedOut?.push(...deniedTools);
    releasePermit();
  }
  if (deniedTools.length > 0) {
    // stderr only reaches the server operator, never the calling agent — so the
    // names are also handed back to the caller, which is what lets a denied
    // review be reported as "not reviewed" rather than counted as a pass.
    console.warn(`[review-llm] ${deniedTools.length} tool call(s) denied under dontAsk: ${deniedTools.join(", ")}`);
  }

  if (!finalResult) {
    throw new Error("Agent returned no result");
  }

  // 写入审计日志（失败时静默忽略）
  if (config.auditDir) {
    const rid = requestId ?? crypto.randomUUID();
    const successfulResolved = new Set(
      successfulReads.map((path) => resolve(readRoot, path))
    );
    const declaredReads =
      auditMetadata?.attachmentSnapshots.length === attachmentPaths.length
        ? attachmentPaths.flatMap((path, index) =>
            successfulResolved.has(resolve(readRoot, path))
              ? [auditMetadata.attachmentSnapshots[index]!.path]
              : []
          )
        : successfulReads;
    writeAuditRecord(config.auditDir, {
      timestamp: new Date().toISOString(),
      requestId: rid,
      model: config.model,
      maxTurns: config.maxTurns ?? 10,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      input: {
        prompt: fullPrompt,
        attachmentPaths,
        cwd,
        ...(auditMetadata ?? {}),
      },
      output: {
        raw: finalResult,
        durationMs: Date.now() - t0,
        successfulReads: declaredReads,
        snapshotReads: successfulReads,
      },
    });
  }

  return finalResult;
}

export interface ReviewAttemptTrace {
  requestId: string;
  attempt: number;
  model: string;
  status: "parsed" | "unparseable" | "error";
  error?: string;
  /** Paths with complete Read coverage; multiple text-line Reads may contribute. */
  successfulReads: string[];
}

function asJsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Find the end of one JSON object/array candidate without being confused by
 * nested values, braces inside strings, or escaped quotes.
 */
function structuredValueEnd(text: string, start: number): number | null {
  const opening = text[start];
  if (opening !== "{" && opening !== "[") return null;
  const stack: Array<"{" | "["> = [opening];
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < text.length; index++) {
    const char = text[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.at(-1) !== expected) return null;
      stack.pop();
      if (stack.length === 0) return index;
    }
  }
  return null;
}

/**
 * Recover one terminal JSON object after explanatory prose or inside markdown
 * fences. Text after the object is limited to whitespace and one closing fence.
 * Valid outer arrays are skipped as a unit so an object nested inside an array
 * is not mistaken for the protocol response. More than one valid object is
 * ambiguous and therefore fails closed.
 */
function extractUniqueJsonObject(text: string): Record<string, unknown> | null {
  const matches: Array<{ value: Record<string, unknown>; end: number }> = [];
  for (let start = 0; start < text.length; start++) {
    const opening = text[start];
    if (opening !== "{" && opening !== "[") continue;
    const end = structuredValueEnd(text, start);
    if (end === null) continue;

    let value: unknown;
    try {
      value = JSON.parse(text.slice(start, end + 1));
    } catch {
      // Do not salvage a nested object from a malformed outer object/array.
      // A later sibling candidate remains discoverable after this span.
      start = end;
      continue;
    }

    // A valid structured value owns its nested spans; do not revisit them as
    // separate candidates. Only object roots satisfy this parser's contract.
    start = end;
    const object = asJsonObject(value);
    if (!object) continue;
    matches.push({ value: object, end });
    if (matches.length > 1) return null;
  }

  const match = matches[0];
  if (!match) return null;
  const suffix = text.slice(match.end + 1);
  if (!/^\s*(?:```[ \t]*\s*)?$/.test(suffix)) return null;
  return match.value;
}

/**
 * 从 Agent 响应文本中提取 JSON 对象（通用解析器）。优先接受纯 JSON；
 * 对前面有说明文字或 markdown 围栏的响应，只恢复位于响应末尾的唯一一个括号平衡、
 * 可解析对象。多个对象有歧义，数组/标量不是协议对象，均按解析失败处理。
 */
export function parseLLMResponse(raw: string): Record<string, unknown> {
  const jsonText = raw.trim();
  try {
    const parsed = JSON.parse(jsonText);
    const direct = asJsonObject(parsed);
    return direct ?? { _parseFailed: true, _raw: raw.slice(0, 500) };
  } catch {
    // Mixed prose is not valid as a whole; try one tightly bounded recovery.
  }

  const embedded = extractUniqueJsonObject(raw);
  if (embedded) return embedded;

  return { _parseFailed: true, _raw: raw.slice(0, 500) };
}

/**
 * 调用 Agent 并解析结果。解析失败时重试一次，两次都失败则返回带 `_parseFailed` 的对象。
 *
 * 返回的是**原样的 JSON 对象**，不预设任何字段形状：调用方自己知道它约的是什么协议
 * （review-run.ts 约的是 Q1/Q2/findings），这里只负责"拿到一个能读的对象"。
 *
 * 重试用 config.fallbackModel，没配就用同一个 config.model。
 * 这里原来写死 `model: "claude-opus-4-7", maxTurns: 3`：一个 2026-07 填进来的
 * Anthropic 官方模型 ID，加上一个凭空砍到 3 的轮数上限。两者都是丢用户的配置 ——
 * 配了转发站的部署未必有这个模型名，模型不存在时 callAgent 抛错，被下面的 catch
 * 接成一条错误，于是一次本该救场的重试变成归咎于审查器的失败，
 * 而那个模型名不是用户选的。轮数同理：解析失败的原因是"输出不是 JSON"，
 * 不是"轮数太多"，没有理由借这个机会把 20 轮改成 3 轮 —— 附件都可能读不完。
 */
export async function callAndParse(
  config: ReviewConfig,
  prompt: string,
  attachments: string[],
  cwd: string,
  deniedOut?: string[],
  traceOut?: ReviewAttemptTrace[],
  auditMetadata?: ReviewAuditMetadata
): Promise<Record<string, unknown>> {
  const requestId = crypto.randomUUID();
  async function callAttempt(attemptConfig: ReviewConfig, attempt: number): Promise<Record<string, unknown>> {
    const trace: ReviewAttemptTrace = {
      requestId, attempt, model: attemptConfig.model, status: "error", successfulReads: [],
    };
    traceOut?.push(trace);
    try {
      const raw = await callAgent(
        attemptConfig, prompt, attachments, cwd, requestId, deniedOut, trace.successfulReads, auditMetadata,
      );
      const parsed = parseLLMResponse(raw);
      trace.status = parsed._parseFailed ? "unparseable" : "parsed";
      return parsed;
    } catch (error) {
      trace.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
  const parsed = await callAttempt(config, 1);
  if (!parsed._parseFailed) return parsed;

  // 解析失败 → 重试一次（同一 requestId，便于关联）
  const retryConfig: ReviewConfig = { ...config, model: config.fallbackModel ?? config.model };
  try {
    return await callAttempt(retryConfig, 2);
  } catch (e) {
    return {
      _parseFailed: true,
      _raw: `retry with model ${retryConfig.model} also failed: ${e}`,
    };
  }
}

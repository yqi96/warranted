import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

/**
 * The treatment prompt intentionally does not mention revisions, warnings, or
 * expected graph edits. "Continue" gives the agent permission to act without
 * telling it which action the evaluator expects.
 */
export const VITAMINC_AGENT_PROMPT = "请继续处理当前研究，并告诉我结论。";

export const TOULMIN_TOOLS = [
  "create_propositions",
  "update_proposition",
  "set_qualifier",
  "promote_warrant",
  "delete_proposition",
  "get_argument",
  "find_propositions",
  "get_stats",
  "get_history",
  "review",
  "dismiss",
] as const;

export type ToulminTool = (typeof TOULMIN_TOOLS)[number];

/** The only graph operations exposed by the VitaminC treatment runtime. */
export const DEFAULT_TOULMIN_TOOL_ALLOWLIST = [
  "get_stats",
  "find_propositions",
  "get_argument",
  "get_history",
  "update_proposition",
  "set_qualifier",
  "dismiss",
] as const satisfies readonly ToulminTool[];

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface RuntimeAttachment {
  /** Source file outside the clean room. */
  sourcePath: string;
  /** Relative path expected by the graph, for example evidence/current.txt. */
  relativePath: string;
}

export interface VitaminCAgentRuntimeOptions {
  /** Frozen post-update graph produced by the deterministic preparation step. */
  preparedDatabasePath: string;
  /** Evaluator-owned directory. It is never made visible to the agent. */
  artifactDir: string;
  /** Warranted plugin root, used only to load the agent and Toulmin server. */
  pluginRoot: string;
  /** A full Claude model id such as claude-opus-4-6; aliases are rejected. */
  model: string;
  /**
   * Permit a non-Claude model identifier for an explicitly non-primary
   * Anthropic-compatible provider diagnostic. Formal runs must leave this off.
   */
  allowCompatibleModel?: boolean;
  /** Explicit CLI effort. Claude Code currently supports up to max. */
  effort: ClaudeEffort;
  maxTurns?: number;
  timeoutMs?: number;
  /** Hard Claude Code spend cap for one case. */
  maxBudgetUsd?: number;
  attachments?: readonly RuntimeAttachment[];
  toulminToolAllowlist?: readonly ToulminTool[];
  /** Defaults to claude. Tests can inject a deterministic fake executable. */
  executable?: string;
  /** Optional arguments inserted immediately after the executable. */
  executableArgs?: readonly string[];
  /** Additional environment for a fake CLI or an explicitly configured run. */
  env?: Record<string, string | undefined>;
  /** Parent for the anonymous directory; defaults to the system temp dir. */
  scratchRoot?: string;
  /** Test/debug escape hatch. Production callers should leave this false. */
  retainScratch?: boolean;
  /** Internal sanitized plugin directory created inside the clean room. */
  agentPluginDir?: string;
}

export type AgentRunStatus =
  | "success"
  | "timeout"
  | "nonzero_exit"
  | "invalid_output"
  | "max_turns"
  | "agent_error"
  | "artifact_failure"
  | "spawn_failure";

export interface AgentRuntimeRecovery {
  /** Recovery directory containing the complete clean-room state. */
  directory: string;
  /** Whether the scratch was moved, copied, or had to remain in place. */
  mode: "moved" | "copied" | "retained_in_place";
  archiveFailure: string;
  /** Set only when recovery itself could not be completed cleanly. */
  recoveryFailure: string | null;
}

export interface AgentUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  totalCostUsd: number | null;
  numTurns: number | null;
}

export interface AgentRawReportedUsage {
  totalCostUsd: { present: boolean; value: unknown };
  numTurns: { present: boolean; value: unknown };
}

export type VitaminCProvider =
  | "anthropic-direct"
  | "bedrock"
  | "anthropic-aws"
  | "vertex"
  | "foundry";

export interface AgentToolTraceEntry {
  streamIndex: number;
  kind: "call" | "result";
  toolUseId: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
}

export interface AgentRuntimeArtifacts {
  stdoutPath: string;
  stderrPath: string;
  toolTracePath: string;
  answerPath: string;
  processPath: string;
  databasePath: string;
}

export interface VitaminCAgentRunResult {
  status: AgentRunStatus;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  reportedDurationMs: number | null;
  answer: string;
  requestedModel: string;
  actualModel: string | null;
  actualModels: string[];
  actualTools: string[];
  actualMcpServers: Array<{ name: string; status: string | null }>;
  provider: VitaminCProvider;
  claudeCodeVersion: string | null;
  effort: ClaudeEffort;
  usage: AgentUsage;
  rawReportedUsage: AgentRawReportedUsage;
  resultSubtype: string | null;
  failureDetail: string | null;
  toolTrace: AgentToolTraceEntry[];
  artifacts: AgentRuntimeArtifacts;
  /** Non-null only when normal artifact archival failed. */
  recovery: AgentRuntimeRecovery | null;
  /** Present only when retainScratch=true. */
  scratchDir?: string;
}

interface JsonRecord {
  [key: string]: unknown;
}

interface ParsedStream {
  events: JsonRecord[];
  invalidLines: Array<{ line: number; text: string }>;
  protocolViolations: string[];
  initEventCount: number;
  initIsFirstEvent: boolean;
  resultEventCount: number;
  resultIsLastEvent: boolean;
  result: JsonRecord | null;
  answer: string;
  actualModels: string[];
  actualTools: string[];
  actualMcpServers: Array<{ name: string; status: string | null }>;
  claudeCodeVersion: string | null;
  toolTrace: AgentToolTraceEntry[];
  usage: AgentUsage;
  rawReportedUsage: AgentRawReportedUsage;
  reportedDurationMs: number | null;
}

const DEFAULT_MAX_TURNS = 12;
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_BUDGET_USD = 2;
const HARD_MAX_BUDGET_USD = 2;
const MODEL_ALIAS = /^(?:opus|sonnet|haiku)$/i;
const FULL_MODEL_ID = /^claude-[a-z0-9][a-z0-9._-]*\d[a-z0-9._-]*$/i;
const COMPATIBLE_MODEL_ID = /^[a-z0-9][a-z0-9._:+/\[\]-]{0,127}$/i;
const EFFORTS = new Set<ClaudeEffort>(["low", "medium", "high", "xhigh", "max"]);

function validateRequestedModel(model: unknown, allowCompatibleModel = false): string {
  if (typeof model !== "string" || !model.trim()) {
    throw new Error("model is required and must be a full Claude model id");
  }
  if (allowCompatibleModel) {
    if (!COMPATIBLE_MODEL_ID.test(model)) {
      throw new Error(`invalid Anthropic-compatible diagnostic model id: ${model}`);
    }
    return model;
  }
  if (MODEL_ALIAS.test(model) || !FULL_MODEL_ID.test(model)) {
    throw new Error(`model must be a full Claude model id, not an alias: ${model}`);
  }
  return model;
}

/**
 * Ambient variables intentionally inherited by the clean-room process. Keep
 * this list limited to process execution, locale, TLS/proxy configuration,
 * and credentials/provider selection required by supported Claude backends.
 * Callers may add test- or deployment-specific keys explicitly via options.env.
 */
export const VITAMINC_CHILD_ENV_ALLOWLIST = [
  // Process execution and temporary files.
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_RUNTIME_DIR",
  // Locale and clock presentation.
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  // TLS trust and outbound proxy configuration.
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "AWS_CA_BUNDLE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  // Direct Anthropic and custom Anthropic-compatible endpoints.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_ORGANIZATION_ID",
  // Amazon Bedrock and Anthropic on AWS.
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_EC2_METADATA_DISABLED",
  // Google Vertex AI.
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "CLOUD_ML_REGION",
  // Microsoft Foundry and Azure credential chains.
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "AZURE_AUTHORITY_HOST",
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_FEDERATED_TOKEN_FILE",
  "AZURE_CLIENT_CERTIFICATE_PATH",
  "AZURE_CLIENT_CERTIFICATE_PASSWORD",
  "AZURE_CLIENT_SEND_CERTIFICATE_CHAIN",
  "AZURE_TOKEN_CREDENTIALS",
  "AZURE_ADDITIONALLY_ALLOWED_TENANTS",
] as const;

export function buildVitaminCChildEnvironment(
  explicit: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of VITAMINC_CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  for (const [key, value] of Object.entries(explicit ?? {})) {
    if (typeof value === "string") env[key] = value;
    else delete env[key];
  }
  return env;
}

const PROVIDER_SELECTORS = [
  ["CLAUDE_CODE_USE_BEDROCK", "bedrock"],
  ["CLAUDE_CODE_USE_ANTHROPIC_AWS", "anthropic-aws"],
  ["CLAUDE_CODE_USE_VERTEX", "vertex"],
  ["CLAUDE_CODE_USE_FOUNDRY", "foundry"],
] as const satisfies readonly (readonly [string, Exclude<VitaminCProvider, "anthropic-direct">])[];

/**
 * Resolve the provider selected by Claude Code without inspecting or removing
 * credentials. Selector flags are mutually exclusive and must use the exact
 * value accepted by formal VitaminC runs.
 */
export function classifyVitaminCProviderSelection(
  env: Readonly<Record<string, string>>,
): VitaminCProvider {
  for (const [key] of PROVIDER_SELECTORS) {
    if (env[key] !== undefined && env[key] !== "1") {
      throw new Error(`${key} must be exactly 1 when present`);
    }
  }
  const selected = PROVIDER_SELECTORS.filter(([key]) => env[key] === "1");
  if (selected.length > 1) {
    throw new Error(
      `Claude provider selectors are mutually exclusive: ${selected.map(([key]) => key).join(",")}`,
    );
  }
  return selected[0]?.[1] ?? "anthropic-direct";
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstNumber(record: JsonRecord | null, ...keys: string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = finiteNumber(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function validateOptions(options: VitaminCAgentRuntimeOptions): void {
  validateRequestedModel(options.model, options.allowCompatibleModel);
  if (!EFFORTS.has(options.effort)) {
    throw new Error(`unsupported effort: ${String(options.effort)}`);
  }

  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
    throw new Error("maxTurns must be a positive integer");
  }
  const maxBudgetUsd = options.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD;
  if (
    !Number.isFinite(maxBudgetUsd) ||
    maxBudgetUsd <= 0 ||
    maxBudgetUsd > HARD_MAX_BUDGET_USD
  ) {
    throw new Error(`maxBudgetUsd must be positive and <= ${HARD_MAX_BUDGET_USD}`);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be positive");
  }
  if (!existsSync(options.preparedDatabasePath)) {
    throw new Error(`prepared database does not exist: ${options.preparedDatabasePath}`);
  }
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${options.preparedDatabasePath}${suffix}`)) {
      throw new Error(`prepared database must be sealed without SQLite sidecars: ${suffix}`);
    }
  }

  const requested = options.toulminToolAllowlist ?? DEFAULT_TOULMIN_TOOL_ALLOWLIST;
  if (requested.length === 0) throw new Error("toulminToolAllowlist must not be empty");
  const known = new Set<string>(DEFAULT_TOULMIN_TOOL_ALLOWLIST);
  for (const tool of requested) {
    if (!known.has(tool)) throw new Error(`unsafe or unsupported benchmark tool: ${String(tool)}`);
  }
}

function mcpName(tool: ToulminTool): string {
  return `mcp__toulmin__${tool}`;
}

/**
 * Build the audited Claude invocation. This helper is exported so manifests
 * and unit tests can inspect the exact treatment, without starting Claude.
 */
export function buildVitaminCAgentCommand(
  options: Pick<
    VitaminCAgentRuntimeOptions,
    | "pluginRoot"
    | "model"
    | "effort"
    | "maxTurns"
    | "maxBudgetUsd"
    | "toulminToolAllowlist"
    | "executable"
    | "executableArgs"
    | "agentPluginDir"
    | "allowCompatibleModel"
  >,
): string[] {
  const model = validateRequestedModel(options.model, options.allowCompatibleModel);
  if (!EFFORTS.has(options.effort)) {
    throw new Error(`unsupported effort: ${String(options.effort)}`);
  }
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
    throw new Error("maxTurns must be a positive integer");
  }
  const maxBudgetUsd = options.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD;
  if (
    !Number.isFinite(maxBudgetUsd) ||
    maxBudgetUsd <= 0 ||
    maxBudgetUsd > HARD_MAX_BUDGET_USD
  ) {
    throw new Error(`maxBudgetUsd must be positive and <= ${HARD_MAX_BUDGET_USD}`);
  }

  const allowlist = [...(options.toulminToolAllowlist ?? DEFAULT_TOULMIN_TOOL_ALLOWLIST)];
  const known = new Set<string>(DEFAULT_TOULMIN_TOOL_ALLOWLIST);
  if (allowlist.length === 0 || allowlist.some((tool) => !known.has(tool))) {
    throw new Error("toulminToolAllowlist contains no tools or an unsupported tool");
  }
  if (new Set(allowlist).size !== allowlist.length) {
    throw new Error("toulminToolAllowlist must not contain duplicates");
  }

  const denied = TOULMIN_TOOLS.filter((tool) => !allowlist.includes(tool));
  const mcpConfig = {
    mcpServers: {
      toulmin: {
        type: "stdio",
        command: process.execPath,
        args: [
          resolve(options.pluginRoot, "experiments/evaluation/vitaminc/mcp-server.ts"),
          "--allow-tools",
          allowlist.join(","),
        ],
      },
    },
  };

  return [
    options.executable ?? "claude",
    ...(options.executableArgs ?? []),
    "-p",
    VITAMINC_AGENT_PROMPT,
    "--plugin-dir",
    resolve(options.agentPluginDir ?? options.pluginRoot),
    "--agent",
    "warranted:toulmin-researcher",
    "--bare",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify(mcpConfig),
    "--tools",
    "",
    "--allowedTools",
    allowlist.map(mcpName).join(","),
    "--disallowedTools",
    denied.map(mcpName).join(","),
    "--permission-mode",
    "dontAsk",
    "--disable-slash-commands",
    "--no-chrome",
    "--no-session-persistence",
    "--setting-sources",
    "project",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    String(maxTurns),
    "--max-budget-usd",
    String(maxBudgetUsd),
    "--model",
    model,
    "--effort",
    options.effort,
  ];
}

function safeRelativePath(path: string): string {
  if (!path || isAbsolute(path)) throw new Error(`attachment path must be relative: ${path}`);
  const cleaned = normalize(path);
  if (cleaned === ".." || cleaned.startsWith(`..${sep}`)) {
    throw new Error(`attachment escapes clean room: ${path}`);
  }
  if (cleaned === join(".toulmin", "graph.db") || cleaned.startsWith(`.toulmin${sep}graph.db-`)) {
    throw new Error(`attachment collides with graph database: ${path}`);
  }
  return cleaned;
}

function copyDatabaseState(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  for (const suffix of ["-wal", "-shm"]) {
    const sourceSidecar = `${source}${suffix}`;
    const destinationSidecar = `${destination}${suffix}`;
    if (existsSync(sourceSidecar)) {
      copyFileSync(sourceSidecar, destinationSidecar);
    } else if (existsSync(destinationSidecar)) {
      rmSync(destinationSidecar);
    }
  }
}

function prepareScratch(options: VitaminCAgentRuntimeOptions): {
  scratchDir: string;
  scratchDatabasePath: string;
  agentPluginDir: string;
} {
  const parent = resolve(options.scratchRoot ?? tmpdir());
  mkdirSync(parent, { recursive: true });
  const scratchDir = mkdtempSync(join(parent, "case-"));
  try {
    const scratchDatabasePath = join(scratchDir, ".toulmin", "graph.db");
    copyDatabaseState(resolve(options.preparedDatabasePath), scratchDatabasePath);

    const seen = new Set<string>();
    for (const attachment of options.attachments ?? []) {
      const relativePath = safeRelativePath(attachment.relativePath);
      if (seen.has(relativePath)) throw new Error(`duplicate attachment target: ${relativePath}`);
      seen.add(relativePath);
      if (!existsSync(attachment.sourcePath)) {
        throw new Error(`attachment does not exist: ${attachment.sourcePath}`);
      }
      const target = join(scratchDir, relativePath);
      const back = relative(scratchDir, target);
      if (back === ".." || back.startsWith(`..${sep}`)) {
        throw new Error(`attachment escapes clean room: ${attachment.relativePath}`);
      }
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(attachment.sourcePath, target);
    }

    // Load the same primary-agent prompt without loading the repository plugin's
    // MCP declarations or hooks. In particular, this excludes browser, semantic
    // review, and the visualizer-selection hook from the benchmark treatment.
    const agentPluginDir = join(scratchDir, ".agent-plugin");
    mkdirSync(join(agentPluginDir, ".claude-plugin"), { recursive: true });
    mkdirSync(join(agentPluginDir, "agents"), { recursive: true });
    copyFileSync(
      join(resolve(options.pluginRoot), ".claude-plugin", "plugin.json"),
      join(agentPluginDir, ".claude-plugin", "plugin.json"),
    );
    const sourceAgentPath = join(
      resolve(options.pluginRoot),
      "agents",
      "toulmin-researcher.md",
    );
    const sourceAgent = readFileSync(sourceAgentPath, "utf8");
    const modelLines = sourceAgent.match(/^model:\s*.*$/gm) ?? [];
    if (modelLines.length !== 1) {
      throw new Error("toulmin-researcher agent must declare exactly one model field");
    }
    const pinnedAgent = sourceAgent.replace(/^model:\s*.*$/m, `model: ${options.model}`);
    writeFileSync(
      join(agentPluginDir, "agents", "toulmin-researcher.md"),
      pinnedAgent,
      "utf8",
    );
    return { scratchDir, scratchDatabasePath, agentPluginDir };
  } catch (error) {
    rmSync(scratchDir, { recursive: true, force: true });
    throw error;
  }
}

function parseContentBlocks(
  content: unknown,
  role: "assistant" | "user",
  streamIndex: number,
  toolNames: Map<string, string>,
  trace: AgentToolTraceEntry[],
  protocolViolations: string[],
): string[] {
  if (!Array.isArray(content)) return [];
  const text: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") text.push(block.text);
    if (block.type === "tool_use") {
      if (role !== "assistant") {
        protocolViolations.push(`tool_use appeared in ${role} event ${streamIndex}`);
        continue;
      }
      if (
        typeof block.id !== "string" ||
        block.id.length === 0 ||
        typeof block.name !== "string" ||
        block.name.length === 0
      ) {
        protocolViolations.push(`malformed tool_use at stream event ${streamIndex}`);
        continue;
      }
      toolNames.set(block.id, block.name);
      trace.push({
        streamIndex,
        kind: "call",
        toolUseId: block.id,
        toolName: block.name,
        ...(Object.hasOwn(block, "input") ? { input: block.input } : {}),
      });
    }
    if (block.type === "tool_result") {
      if (role !== "user") {
        protocolViolations.push(`tool_result appeared in ${role} event ${streamIndex}`);
        continue;
      }
      if (typeof block.tool_use_id !== "string" || block.tool_use_id.length === 0) {
        protocolViolations.push(`malformed tool_result at stream event ${streamIndex}`);
        continue;
      }
      if (Object.hasOwn(block, "is_error") && typeof block.is_error !== "boolean") {
        protocolViolations.push(`tool_result has non-boolean is_error at stream event ${streamIndex}`);
        continue;
      }
      trace.push({
        streamIndex,
        kind: "result",
        toolUseId: block.tool_use_id,
        ...(toolNames.has(block.tool_use_id) ? { toolName: toolNames.get(block.tool_use_id) } : {}),
        ...(Object.hasOwn(block, "content") ? { output: block.content } : {}),
        ...(typeof block.is_error === "boolean" ? { isError: block.is_error } : {}),
      });
    }
  }
  return text;
}

function usageFromResult(result: JsonRecord | null, assistantUsage: JsonRecord[]): AgentUsage {
  const resultUsage = result && isRecord(result.usage) ? result.usage : null;
  const summed = (keys: string[]): number | null => {
    let found = false;
    let total = 0;
    for (const usage of assistantUsage) {
      const value = firstNumber(usage, ...keys);
      if (value !== null) {
        found = true;
        total += value;
      }
    }
    return found ? total : null;
  };
  const pick = (...keys: string[]) => firstNumber(resultUsage, ...keys) ?? summed(keys);
  return {
    inputTokens: pick("input_tokens", "inputTokens"),
    outputTokens: pick("output_tokens", "outputTokens"),
    cacheCreationInputTokens: pick("cache_creation_input_tokens", "cacheCreationInputTokens"),
    cacheReadInputTokens: pick("cache_read_input_tokens", "cacheReadInputTokens"),
    totalCostUsd: firstNumber(result, "total_cost_usd", "totalCostUsd"),
    numTurns: firstNumber(result, "num_turns", "numTurns"),
  };
}

function rawReportedField(
  result: JsonRecord | null,
  ...keys: string[]
): { present: boolean; value: unknown } {
  if (result) {
    for (const key of keys) {
      if (Object.hasOwn(result, key)) return { present: true, value: result[key] };
    }
  }
  return { present: false, value: null };
}

function parseStream(raw: string): ParsedStream {
  const events: JsonRecord[] = [];
  const invalidLines: Array<{ line: number; text: string }> = [];
  const protocolViolations: string[] = [];
  const actualModels = new Set<string>();
  const assistantUsage: JsonRecord[] = [];
  const toolNames = new Map<string, string>();
  const toolTrace: AgentToolTraceEntry[] = [];
  let lastAssistantText = "";
  let actualTools: string[] = [];
  let actualMcpServers: Array<{ name: string; status: string | null }> = [];
  let claudeCodeVersion: string | null = null;
  let initEventCount = 0;

  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      invalidLines.push({ line: index + 1, text: line.slice(0, 500) });
      continue;
    }
    if (!isRecord(value)) {
      invalidLines.push({ line: index + 1, text: line.slice(0, 500) });
      continue;
    }
    const streamIndex = events.length;
    events.push(value);

    const topModel = stringValue(value.model);
    if (topModel) actualModels.add(topModel);

    if (value.type === "system" && value.subtype === "init") {
      initEventCount += 1;
      if (Array.isArray(value.tools)) {
        actualTools = value.tools.filter((tool): tool is string => typeof tool === "string");
      }
      if (Array.isArray(value.mcp_servers)) {
        actualMcpServers = value.mcp_servers.flatMap((server) => {
          if (!isRecord(server) || typeof server.name !== "string") return [];
          return [{ name: server.name, status: stringValue(server.status) }];
        });
      }
      claudeCodeVersion =
        stringValue(value.claude_code_version) ?? stringValue(value.claudeCodeVersion);
    }

    if (value.type === "assistant" && isRecord(value.message)) {
      const model = stringValue(value.message.model);
      if (model) actualModels.add(model);
      if (isRecord(value.message.usage)) assistantUsage.push(value.message.usage);
      const chunks = parseContentBlocks(
        value.message.content,
        "assistant",
        streamIndex,
        toolNames,
        toolTrace,
        protocolViolations,
      );
      if (chunks.length > 0) lastAssistantText = chunks.join("\n");
    } else if (value.type === "user" && isRecord(value.message)) {
      parseContentBlocks(
        value.message.content,
        "user",
        streamIndex,
        toolNames,
        toolTrace,
        protocolViolations,
      );
    }
  }

  const resultEvents = events.filter((event) => event.type === "result");
  const result = resultEvents[0] ?? null;
  if (result && isRecord(result.modelUsage)) {
    for (const model of Object.keys(result.modelUsage)) actualModels.add(model);
  }
  const answer = stringValue(result?.result) ?? lastAssistantText;
  return {
    events,
    invalidLines,
    protocolViolations,
    initEventCount,
    initIsFirstEvent:
      events[0]?.type === "system" && events[0]?.subtype === "init",
    resultEventCount: resultEvents.length,
    resultIsLastEvent: result !== null && events.at(-1) === result,
    result,
    answer,
    actualModels: [...actualModels],
    actualTools,
    actualMcpServers,
    claudeCodeVersion,
    toolTrace,
    usage: usageFromResult(result, assistantUsage),
    rawReportedUsage: {
      totalCostUsd: rawReportedField(result, "total_cost_usd", "totalCostUsd"),
      numTurns: rawReportedField(result, "num_turns", "numTurns"),
    },
    reportedDurationMs: firstNumber(result, "duration_ms", "durationMs"),
  };
}

function successfulToolProtocolViolation(
  parsed: ParsedStream,
  expectedTools: readonly string[],
): string | null {
  if (parsed.protocolViolations.length > 0) return parsed.protocolViolations[0]!;

  const expected = new Set(expectedTools);
  const calls = new Map<string, AgentToolTraceEntry>();
  const resultIds = new Set<string>();
  for (const entry of parsed.toolTrace) {
    if (entry.kind === "call") {
      if (!entry.toolName || !expected.has(entry.toolName)) {
        return `unexpected tool_use name for ${entry.toolUseId}: ${entry.toolName ?? "missing"}`;
      }
      if (calls.has(entry.toolUseId)) {
        return `duplicate tool_use id: ${entry.toolUseId}`;
      }
      calls.set(entry.toolUseId, entry);
      continue;
    }

    const call = calls.get(entry.toolUseId);
    if (!call) {
      return `tool_result precedes or has no matching tool_use: ${entry.toolUseId}`;
    }
    if (entry.streamIndex <= call.streamIndex) {
      return `tool_result must follow tool_use in a later stream event: ${entry.toolUseId}`;
    }
    if (resultIds.has(entry.toolUseId)) {
      return `multiple tool_result entries for tool_use id: ${entry.toolUseId}`;
    }
    resultIds.add(entry.toolUseId);
  }

  for (const toolUseId of calls.keys()) {
    if (!resultIds.has(toolUseId)) {
      return `tool_use has no matching tool_result: ${toolUseId}`;
    }
  }
  return null;
}

function jsonLines(values: readonly unknown[]): string {
  return values.length === 0 ? "" : `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function artifactSecretValues(environment: Readonly<Record<string, string>>): string[] {
  return Object.entries(environment)
    .filter(
      ([key, value]) =>
        /(?:AUTH|TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|BASE_URL)/i.test(key) &&
        value.length >= 4,
    )
    .map(([, value]) => value)
    .filter((value, index, values) => values.indexOf(value) === index);
}

function redactArtifactText(text: string, secretValues: readonly string[]): string {
  let redacted = text;
  for (const secret of secretValues) {
    const encoded = JSON.stringify(secret).slice(1, -1);
    for (const candidate of new Set([secret, encoded])) {
      if (candidate) redacted = redacted.split(candidate).join("[REDACTED]");
    }
  }
  return redacted;
}

function redactArtifactValue<T>(value: T, secretValues: readonly string[]): T {
  if (typeof value === "string") {
    return redactArtifactText(value, secretValues) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactArtifactValue(item, secretValues)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redactArtifactValue(item, secretValues),
      ]),
    ) as T;
  }
  return value;
}

/**
 * Preserve the clean-room state after an archival failure. A rename is
 * preferred because it cannot expose a partially copied recovery directory;
 * cross-device filesystems fall back to copy-then-delete. If both fail, the
 * original scratch is deliberately retained rather than destroyed.
 */
function recoverScratch(
  scratchDir: string,
  artifactDir: string,
  archiveFailure: string,
): AgentRuntimeRecovery {
  const recoveryRoot = join(artifactDir, "recovery");
  const destination = join(recoveryRoot, basename(scratchDir));
  let directory = scratchDir;
  let mode: AgentRuntimeRecovery["mode"] = "retained_in_place";
  let recoveryFailure: string | null = null;

  try {
    mkdirSync(recoveryRoot, { recursive: true });
    try {
      renameSync(scratchDir, destination);
      directory = destination;
      mode = "moved";
    } catch (renameError) {
      try {
        cpSync(scratchDir, destination, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        directory = destination;
        mode = "copied";
        try {
          rmSync(scratchDir, { recursive: true, force: true });
        } catch (cleanupError) {
          recoveryFailure = `recovery copy succeeded but scratch cleanup failed: ${errorMessage(cleanupError)}`;
        }
      } catch (copyError) {
        recoveryFailure =
          `rename failed: ${errorMessage(renameError)}; copy failed: ${errorMessage(copyError)}`;
      }
    }
  } catch (rootError) {
    recoveryFailure = `recovery directory creation failed: ${errorMessage(rootError)}`;
  }

  const recovery: AgentRuntimeRecovery = {
    directory,
    mode,
    archiveFailure,
    recoveryFailure,
  };
  if (mode !== "retained_in_place") {
    try {
      writeFileSync(
        join(directory, ".vitaminc-recovery.json"),
        `${JSON.stringify(recovery, null, 2)}\n`,
      );
    } catch (metadataError) {
      recovery.recoveryFailure = [
        recovery.recoveryFailure,
        `recovery metadata write failed: ${errorMessage(metadataError)}`,
      ]
        .filter(Boolean)
        .join("; ");
    }
  }
  return recovery;
}

function failureClassification(
  timedOut: boolean,
  exitCode: number | null,
  parsed: ParsedStream,
  spawnError: unknown,
  expectedTools: readonly string[],
  stderr: string,
): { status: AgentRunStatus; detail: string | null; subtype: string | null } {
  const stderrDetail = stderr.trim().slice(0, 2_000);
  if (spawnError) {
    return { status: "spawn_failure", detail: String(spawnError), subtype: null };
  }
  if (timedOut) return { status: "timeout", detail: "agent exceeded timeout", subtype: null };
  if (exitCode !== 0) {
    return {
      status: "nonzero_exit",
      detail: `Claude exited with code ${String(exitCode)}${stderrDetail ? `: ${stderrDetail}` : ""}`,
      subtype: stringValue(parsed.result?.subtype),
    };
  }
  if (parsed.invalidLines.length > 0) {
    return {
      status: "invalid_output",
      detail: `stream contained ${parsed.invalidLines.length} non-JSON line(s)${stderrDetail ? `; stderr: ${stderrDetail}` : ""}`,
      subtype: null,
    };
  }
  if (!parsed.result) {
    return {
      status: "invalid_output",
      detail: `stream contained no result event${stderrDetail ? `; stderr: ${stderrDetail}` : ""}`,
      subtype: null,
    };
  }
  if (parsed.resultEventCount !== 1) {
    return {
      status: "invalid_output",
      detail: `success stream must contain exactly one top-level result event; found ${parsed.resultEventCount}`,
      subtype: stringValue(parsed.result.subtype),
    };
  }
  const subtype = stringValue(parsed.result.subtype);
  if (subtype === "error_max_turns") {
    return { status: "max_turns", detail: "agent reached max turns", subtype };
  }
  if (subtype !== "success") {
    return {
      status: "agent_error",
      detail:
        stringValue(parsed.result.result) ??
        (stderrDetail || `result subtype=${String(subtype)}`),
      subtype,
    };
  }
  if (parsed.result.is_error !== false) {
    return {
      status: "invalid_output",
      detail: "success result must contain is_error=false",
      subtype,
    };
  }
  if (!parsed.resultIsLastEvent) {
    return {
      status: "invalid_output",
      detail: "success result must be the final non-empty stream event",
      subtype,
    };
  }
  if (parsed.initEventCount !== 1) {
    return {
      status: "invalid_output",
      detail: `success stream must contain exactly one system/init event; found ${parsed.initEventCount}`,
      subtype,
    };
  }
  if (!parsed.initIsFirstEvent) {
    return {
      status: "invalid_output",
      detail: "system/init must be the first non-empty stream event",
      subtype,
    };
  }
  const actualTools = [...parsed.actualTools].sort();
  const expected = [...expectedTools].sort();
  if (JSON.stringify(actualTools) !== JSON.stringify(expected)) {
    return {
      status: "invalid_output",
      detail: `unexpected tool surface: expected=${expected.join(",")}; actual=${actualTools.join(",") || "missing"}`,
      subtype: stringValue(parsed.result.subtype),
    };
  }
  const toolProtocolViolation = successfulToolProtocolViolation(parsed, expectedTools);
  if (toolProtocolViolation) {
    return {
      status: "invalid_output",
      detail: `invalid tool protocol: ${toolProtocolViolation}`,
      subtype,
    };
  }
  const mcpNames = parsed.actualMcpServers.map((server) => server.name).sort();
  if (
    JSON.stringify(mcpNames) !== JSON.stringify(["toulmin"]) ||
    parsed.actualMcpServers.some((server) => server.status !== "connected")
  ) {
    return {
      status: "agent_error",
      detail: `unexpected MCP state: ${JSON.stringify(parsed.actualMcpServers)}`,
      subtype: stringValue(parsed.result.subtype),
    };
  }
  if (typeof parsed.result.result !== "string") {
    return { status: "invalid_output", detail: "success result has no textual answer", subtype };
  }
  return { status: "success", detail: null, subtype };
}

/**
 * Run one treatment case in an anonymous clean room and archive an auditable
 * stream. This function never reads evaluator provenance or copies the source
 * case directory wholesale: only the explicit graph and attachments enter.
 */
export async function runVitaminCAgent(
  options: VitaminCAgentRuntimeOptions,
): Promise<VitaminCAgentRunResult> {
  validateOptions(options);
  const artifactDir = resolve(options.artifactDir);
  mkdirSync(artifactDir, { recursive: true });

  const artifacts: AgentRuntimeArtifacts = {
    stdoutPath: join(artifactDir, "stdout.stream.jsonl"),
    stderrPath: join(artifactDir, "stderr.log"),
    toolTracePath: join(artifactDir, "tool-calls.jsonl"),
    answerPath: join(artifactDir, "answer.md"),
    processPath: join(artifactDir, "process.json"),
    databasePath: join(artifactDir, ".toulmin", "graph.db"),
  };

  let scratchDir = "";
  let scratchDatabasePath = "";
  let agentPluginDir = "";
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let timedOut = false;
  let spawnError: unknown = null;
  let scratchRecovered = false;
  const startedAt = Date.now();

  try {
    ({ scratchDir, scratchDatabasePath, agentPluginDir } = prepareScratch(options));
    const commandOptions = { ...options, agentPluginDir };
    const command = buildVitaminCAgentCommand(commandOptions);
    const environment = buildVitaminCChildEnvironment(options.env);
    const provider = classifyVitaminCProviderSelection(environment);
    try {
      const proc = Bun.spawn({
        cmd: command,
        cwd: scratchDir,
        env: environment,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill("SIGKILL");
        } catch {
          // The process may have exited between the timeout and the signal.
        }
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        const [capturedStdout, capturedStderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        stdout = capturedStdout;
        stderr = capturedStderr;
        exitCode = code;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      spawnError = error;
      stderr = String(error);
    }

    const parsed = parseStream(stdout);
    const requestedTools = [
      ...(options.toulminToolAllowlist ?? DEFAULT_TOULMIN_TOOL_ALLOWLIST),
    ].map(mcpName);
    const classification = failureClassification(
      timedOut,
      exitCode,
      parsed,
      spawnError,
      requestedTools,
      stderr,
    );
    const secretValues = artifactSecretValues(environment);
    const safeStdout = redactArtifactText(stdout, secretValues);
    const safeStderr = redactArtifactText(stderr, secretValues);
    const safeAnswer = redactArtifactText(parsed.answer, secretValues);
    const safeToolTrace = redactArtifactValue(parsed.toolTrace, secretValues);
    const safeFailureDetail = classification.detail
      ? redactArtifactText(classification.detail, secretValues)
      : null;
    const durationMs = Date.now() - startedAt;
    const actualModel = parsed.actualModels.at(-1) ?? null;

    const resultBase = {
      exitCode,
      timedOut,
      durationMs,
      reportedDurationMs: parsed.reportedDurationMs,
      answer: safeAnswer,
      requestedModel: options.model,
      actualModel,
      actualModels: parsed.actualModels,
      actualTools: parsed.actualTools,
      actualMcpServers: parsed.actualMcpServers,
      provider,
      claudeCodeVersion: parsed.claudeCodeVersion,
      effort: options.effort,
      usage: parsed.usage,
      rawReportedUsage: parsed.rawReportedUsage,
      resultSubtype: classification.subtype,
      toolTrace: safeToolTrace,
      artifacts,
    };
    const processRecordBase = {
      ...resultBase,
      prompt: VITAMINC_AGENT_PROMPT,
      maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBudgetUsd: options.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD,
      allowedToulminTools: [...(options.toulminToolAllowlist ?? DEFAULT_TOULMIN_TOOL_ALLOWLIST)],
      environmentKeys: Object.keys(environment).sort(),
      invalidStreamLines: parsed.invalidLines,
      commandArguments: command.slice(1),
    };
    try {
      copyDatabaseState(scratchDatabasePath, artifacts.databasePath);
      writeFileSync(artifacts.stdoutPath, safeStdout);
      writeFileSync(artifacts.stderrPath, safeStderr);
      writeFileSync(artifacts.toolTracePath, jsonLines(safeToolTrace));
      writeFileSync(artifacts.answerPath, safeAnswer ? `${safeAnswer}\n` : "");

      const processRecord = {
        ...processRecordBase,
        status: classification.status,
        ok: classification.status === "success",
        failureDetail: safeFailureDetail,
        recovery: null,
        inputHashes: {
          graphDatabase: fileSha256(options.preparedDatabasePath),
          attachments: Object.fromEntries(
            (options.attachments ?? []).map((attachment) => [
              attachment.relativePath,
              fileSha256(attachment.sourcePath),
            ]),
          ),
          pluginManifest: fileSha256(
            join(resolve(options.pluginRoot), ".claude-plugin", "plugin.json"),
          ),
          agentDefinition: fileSha256(
            join(resolve(options.pluginRoot), "agents", "toulmin-researcher.md"),
          ),
          runtimeAgentDefinition: fileSha256(
            join(agentPluginDir, "agents", "toulmin-researcher.md"),
          ),
          mcpServerEntrypoint: fileSha256(
            join(
              resolve(options.pluginRoot),
              "experiments",
              "evaluation",
              "vitaminc",
              "mcp-server.ts",
            ),
          ),
        },
      };
      writeFileSync(
        artifacts.processPath,
        `${JSON.stringify(redactArtifactValue(processRecord, secretValues), null, 2)}\n`,
      );

      return {
        ...resultBase,
        status: classification.status,
        ok: classification.status === "success",
        failureDetail: safeFailureDetail,
        recovery: null,
        ...(options.retainScratch ? { scratchDir } : {}),
      };
    } catch (archiveError) {
      const archiveFailure = errorMessage(archiveError);
      const recovery = recoverScratch(scratchDir, artifactDir, archiveFailure);
      scratchRecovered = true;
      const failureDetail = [
        `artifact archival failed: ${archiveFailure}`,
        `scratch recovery ${recovery.mode}: ${recovery.directory}`,
        recovery.recoveryFailure,
      ]
        .filter(Boolean)
        .join("; ");
      const processRecord = {
        ...processRecordBase,
        status: "artifact_failure" as const,
        ok: false,
        failureDetail,
        recovery,
        inputHashes: null,
      };
      try {
        writeFileSync(
          artifacts.processPath,
          `${JSON.stringify(redactArtifactValue(processRecord, secretValues), null, 2)}\n`,
        );
      } catch {
        // The returned result and recovery metadata still identify the
        // preserved state when the normal process artifact is unwritable.
      }
      return {
        ...resultBase,
        status: "artifact_failure",
        ok: false,
        failureDetail,
        recovery,
      };
    }
  } finally {
    if (scratchDir && !options.retainScratch && !scratchRecovered) {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  }
}

/** Read a runtime artifact without exposing the clean-room implementation. */
export function readAgentProcessArtifact(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

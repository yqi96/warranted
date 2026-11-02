/**
 * Warranted — 审查审计日志
 *
 * Normal mode keeps compact attempt telemetry; debug mode additionally retains
 * SDK-visible events and exact declared attachment bytes for diagnosis.
 */

import { appendFileSync, writeFileSync, mkdirSync, readFileSync, renameSync, realpathSync, statSync, existsSync } from "fs";
import { join, relative, resolve, sep } from "path";
import { createHash, randomUUID } from "crypto";
import type { AttachmentRead, AttachmentSnapshot } from "./types.ts";
import type { ReviewConfig } from "./review-config.ts";

export interface ReviewAuditMetadata {
  inputFingerprint: string;
  attachmentSnapshots: AttachmentSnapshot[];
}

export interface AuditRecord {
  timestamp: string;
  requestId: string;
  model: string;
  maxTurns: number;
  /**
   * 请求实际打向的 endpoint（config.baseUrl；未配置则不出现，走 SDK 默认）。
   * 记它是因为：apiKey/baseUrl 曾经读进配置就再没递给 SDK，请求一直打向别处，
   * 而审计日志只记 model/maxTurns，看不出去了哪里 —— 缺陷因此长期无法定位。
   * apiKey 绝不入日志。
   */
  baseUrl?: string;
  input: {
    prompt: string;
    attachmentPaths: string[];
    cwd: string | undefined;
    inputFingerprint?: string;
    attachmentSnapshots?: AttachmentSnapshot[];
  };
  output: {
    raw: string;
    durationMs: number;
    /** Declared attachments with complete coverage (one full Read or cumulative text Reads). */
    successfulReads: string[];
    /** Actual private snapshot paths with complete coverage; retained for low-level audit. */
    snapshotReads?: string[];
    attachmentReads?: AttachmentRead[];
  };
}

/**
 * 将审计记录写入指定目录。
 * Legacy explicit full-record writer. Logging failures warn without changing the
 * scientific result. Production SDK attempts use beginReviewAudit below.
 */
export function writeAuditRecord(auditDir: string, record: AuditRecord): void {
  try {
    mkdirSync(auditDir, { recursive: true });
    // filename: audit_<ISO-timestamp>_<8-char-requestId>.json
    const ts = record.timestamp.replace(/[:.]/g, "-");
    const shortId = record.requestId.replace(/-/g, "").slice(0, 8);
    const filename = `audit_${ts}_${shortId}.json`;
    const filepath = join(auditDir, filename);
    writeFileSync(filepath, JSON.stringify(record, null, 2), "utf-8");
  } catch (error) {
    console.warn(`[review-audit] Failed to write audit record: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface BeginReviewAuditInput {
  prompt: string;
  /** Only the materialized immutable snapshot aliases, never mutable sources. */
  attachmentPaths: string[];
  cwd?: string;
  requestId?: string;
  attempt?: number;
  metadata?: ReviewAuditMetadata;
}

export interface FinishReviewAuditInput {
  deniedTools?: string[];
  /** SDK attempt lifecycle only, NOT runReview's semantic/protocol acceptance. */
  status: "completed" | "failed";
  raw?: string;
  error?: unknown;
  durationMs: number;
  queueMs?: number;
  readDurationMs?: number;
  successfulReads: string[];
  snapshotReads?: string[];
  attachmentReads?: AttachmentRead[];
  result?: unknown;
}

function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function nonemptyObject(value: unknown): Record<string, unknown> | null {
  const object = asObject(value);
  return object && Object.keys(object).length > 0 ? object : null;
}

/**
 * One stable JSON per SDK attempt, written before query and finalized in finally.
 * Debug events are appended immediately; they contain only what the SDK exposed,
 * not a promise of access to unreturned internal reasoning. Credential redaction
 * takes precedence over exact text preservation. Disabled audits do no file I/O.
 */
export function beginReviewAudit(config: ReviewConfig, input: BeginReviewAuditInput): {
  event(message: unknown): void;
  finish(result: FinishReviewAuditInput): void;
} {
  if (!config.auditDir) return { event() {}, finish() {} };
  const auditDir = resolve(config.auditDir);
  const debug = config.debug === true;
  const timestamp = new Date().toISOString();
  const requestId = input.requestId ?? randomUUID();
  const attempt = input.attempt ?? 1;
  // The nonce prevents same-millisecond direct calls from overwriting each other.
  const stem = `audit_${timestamp.replace(/[:.]/g, "-")}_${requestId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16)}_${attempt}_${randomUUID().slice(0, 8)}`;
  const filepath = join(auditDir, `${stem}.json`);
  const eventPath = join(auditDir, "debug", `${stem}.events.jsonl`);
  const secrets = [...new Set([
    config.apiKey, process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_AUTH_TOKEN,
    process.env.OPENAI_API_KEY,
  ].filter((value): value is string => typeof value === "string" && value.length > 0))];
  function redact(value: string): string {
    for (const secret of secrets) value = value.split(secret).join("[REDACTED]");
    return value;
  }
  function serialize(value: unknown, pretty = false): string {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (key, item) => {
      if (/^(env|environment|api[_-]?key|authorization|auth[_-]?token|access[_-]?token|password|secret)$/i.test(key)) return "[REDACTED]";
      if (item instanceof Error) return { name: item.name, message: redact(item.message) };
      if (typeof item === "string") return redact(item);
      if (typeof item === "bigint") return item.toString();
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
      }
      return item;
    }, pretty ? 2 : undefined);
  }
  const warn = (error: unknown) => {
    console.warn(`[review-audit] Logging failed; review outcome unchanged: ${redact(error instanceof Error ? error.message : String(error))}`);
  };
  const attachmentArchive: Array<Record<string, unknown>> = [];
  const record = {
    scope: "model_attempt", timestamp, requestId, attempt, debug,
    status: "started" as "started" | "completed" | "failed",
    finishedAt: null as string | null,
    model: config.model, maxTurns: config.maxTurns,
    effort: config.effort ?? "medium", timeoutMs: config.timeoutMs ?? 300_000,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    input: {
      inputFingerprint: input.metadata?.inputFingerprint ?? null,
      promptSha256: hash(input.prompt),
      attachmentPaths: input.attachmentPaths,
      attachmentSnapshots: input.metadata?.attachmentSnapshots.map((item) => ({ ...item })) ?? [] as AttachmentSnapshot[],
      cwd: input.cwd,
      ...(debug ? { prompt: input.prompt, attachmentArchive, eventsPath: relative(auditDir, eventPath) } : {}),
    },
    output: {
      durationMs: null as number | null,
      queueMs: null as number | null,
      readDurationMs: null as number | null,
      successfulReads: [] as string[], snapshotReads: [] as string[],
      attachmentReads: [] as AttachmentRead[],
      deniedTools: [] as string[],
      error: null as unknown,
      ...(debug ? { raw: null as string | null } : {}),
    },
    telemetry: {
      actualModel: null as string | null,
      usage: null as unknown, modelUsage: null as unknown,
      numTurns: null as number | null, totalCostUsd: null as number | null,
      durationApiMs: null as number | null, sdkDurationMs: null as number | null,
      resultSubtype: null as string | null, stopReason: null as string | null,
    },
  };
  function persist(): void {
    try {
      mkdirSync(auditDir, { recursive: true, mode: 0o700 });
      writeFileSync(`${filepath}.tmp`, serialize(record, true), { mode: 0o600 });
      renameSync(`${filepath}.tmp`, filepath);
    } catch (error) { warn(error); }
  }
  persist();

  // Materialization normally already supplied these hashes. Only derive missing
  // ones from the provided snapshot aliases; never follow an original graph path.
  if (debug || !input.metadata) {
    input.attachmentPaths.forEach((alias, index) => {
      const declared = input.metadata?.attachmentSnapshots[index];
      const archive: Record<string, unknown> = {
        path: declared?.path ?? alias, readPath: alias,
        expectedSha256: declared?.sha256 ?? null,
        sha256: null, storedPath: null, error: null,
      };
      if (debug) attachmentArchive.push(archive);
      try {
        const root = realpathSync(input.cwd ?? process.cwd());
        const source = realpathSync(resolve(root, alias));
        const rel = relative(root, source);
        if (rel === ".." || rel.startsWith(`..${sep}`) || !statSync(source).isFile()) {
          throw Error("Attachment must be a regular file within the supplied snapshot directory");
        }
        const bytes = readFileSync(source);
        const sha256 = hash(bytes);
        archive.sha256 = sha256;
        if (!input.metadata) record.input.attachmentSnapshots.push({ path: alias, sha256 });
        if (declared?.sha256 && declared.sha256 !== sha256) {
          throw Error("Immutable attachment bytes disagree with the declared fingerprint");
        }
        if (debug) {
          if (secrets.some((secret) => bytes.includes(Buffer.from(secret)))) {
            throw Error("Attachment archive skipped because it contains a configured credential");
          }
          const directory = join(auditDir, "debug", "attachments");
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          const destination = join(directory, sha256);
          if (!existsSync(destination)) {
            const temporary = `${destination}.${randomUUID()}.tmp`;
            writeFileSync(temporary, bytes, { mode: 0o400 });
            renameSync(temporary, destination);
          } else if (hash(readFileSync(destination)) !== sha256) {
            throw Error("Existing content-addressed attachment failed hash verification");
          }
          archive.storedPath = relative(auditDir, destination);
        }
      } catch (error) {
        archive.error = redact(error instanceof Error ? error.message : String(error));
        if (!input.metadata && !record.input.attachmentSnapshots.some((item) => item.path === alias)) {
          record.input.attachmentSnapshots.push({ path: alias, sha256: null });
        }
        warn(error);
      }
    });
    persist();
  }

  function telemetry(message: unknown): boolean {
    const item = asObject(message);
    if (!item) return false;
    if (item.type === "system" && item.subtype === "init" && typeof item.model === "string") {
      record.telemetry.actualModel = item.model;
      return true;
    }
    if (item.type !== "result") return false;
    record.telemetry.usage = nonemptyObject(item.usage);
    record.telemetry.modelUsage = nonemptyObject(item.modelUsage);
    record.telemetry.numTurns = finiteNumber(item.num_turns);
    record.telemetry.totalCostUsd = finiteNumber(item.total_cost_usd);
    record.telemetry.durationApiMs = finiteNumber(item.duration_api_ms);
    record.telemetry.sdkDurationMs = finiteNumber(item.duration_ms);
    record.telemetry.resultSubtype = typeof item.subtype === "string" ? item.subtype : null;
    record.telemetry.stopReason = typeof item.stop_reason === "string" ? item.stop_reason : null;
    return true;
  }
  let finished = false;
  return {
    event(message) {
      if (finished) return;
      try {
        if (debug) {
          mkdirSync(join(auditDir, "debug"), { recursive: true, mode: 0o700 });
          appendFileSync(eventPath, serialize({ timestamp: new Date().toISOString(), message }) + "\n", { mode: 0o600 });
        }
        if (telemetry(message)) persist();
      } catch (error) { warn(error); }
    },
    finish(result) {
      if (finished) return;
      finished = true;
      try {
        if (result.result) telemetry(result.result);
        record.status = result.status;
        record.finishedAt = new Date().toISOString();
        record.output.durationMs = finiteNumber(result.durationMs);
        record.output.queueMs = finiteNumber(result.queueMs);
        record.output.readDurationMs = finiteNumber(result.readDurationMs);
        record.output.successfulReads = [...result.successfulReads];
        record.output.deniedTools = [...(result.deniedTools ?? [])];
        record.output.snapshotReads = [...(result.snapshotReads ?? [])];
        record.output.attachmentReads = result.attachmentReads ?? [];
        const error = result.error;
        if (error === undefined || error === null) record.output.error = null;
        else if (debug) record.output.error = error;
        else {
          const message = error instanceof Error ? error.message : typeof error === "string"
            ? error : typeof asObject(error)?.message === "string" ? String(asObject(error)!.message) : "Unknown execution error";
          record.output.error = {
            name: error instanceof Error ? error.name : "Error",
            // Compact normal records do not retain arbitrarily large API bodies.
            message: message.slice(0, 2000), messageLength: message.length,
          };
        }
        if (debug) record.output.raw = result.raw ?? null;
        persist();
      } catch (error) { warn(error); }
    },
  };
}

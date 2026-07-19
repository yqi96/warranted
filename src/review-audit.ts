/**
 * Warranted — 审查审计日志
 *
 * 将每次 LLM 调用的输入（prompt）和原始输出保存为 JSON 文件，
 * 供后续分析 agent 缺陷。
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

export interface AuditRecord {
  timestamp: string;
  requestId: string;
  model: string;
  maxTurns: number;
  input: {
    prompt: string;
    attachmentPaths: string[];
    cwd: string | undefined;
  };
  output: {
    raw: string;
    durationMs: number;
  };
}

/**
 * 将审计记录写入指定目录。
 * 写入失败时静默忽略，不影响主流程。
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
  } catch {
    // 审计写入失败不影响主流程
  }
}

/**
 * Warranted — 测试辅助
 *
 * 夹具走 repo 层的原始写入,**绕开 service 的 V1–V3 与事件留痕**。这是有意的:
 * 要构造"附件写入后被删""引用被摘掉"这类状态,只能从公开接口造不出来的地方造。
 *
 * 但**默认值必须是公开接口造得出来的状态**——否则几百个不关心某个字段的调用点
 * 会白拿一个非法节点(旧 helpers 的注释记过这个教训,这条约束原样保留)。
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { openDatabase } from "../src/db.ts";
import * as repo from "../src/repo.ts";
import type { Qualifier } from "../src/types.ts";
import {
  type CheckContext,
  checkContext,
  loadNodeState,
  loadRefStates,
  selfFingerprintOf,
} from "../src/structural-check.ts";

// =============================================================================
// 数据库
// =============================================================================

export function createTestDb(): Database {
  return openDatabase(":memory:");
}

export function cleanupDb(db: Database): void {
  db.close();
}

// =============================================================================
// 临时项目根(附件判据要真实文件)
// =============================================================================

export interface TempRoot extends CheckContext {
  /** 在根下写一个文件,返回相对路径(附件槽里存的就是相对路径)。 */
  file(name: string, content?: string): string;
  /** 删掉一个已写入的文件,用来制造 S2。 */
  unlink(name: string): void;
  cleanup(): void;
}

export function makeTempRoot(): TempRoot {
  const root = mkdtempSync(join(tmpdir(), "warranted-test-"));
  return {
    root,
    file(name: string, content = "evidence") {
      writeFileSync(join(root, name), content);
      return name;
    },
    unlink(name: string) {
      rmSync(join(root, name), { force: true });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 只需要一个 CheckContext、不需要真实文件时用它(不建目录)。 */
export function checkContextFor(dbPath: string): CheckContext {
  return checkContext(dbPath);
}

// =============================================================================
// 命题工厂
// =============================================================================

export interface MakeOpts {
  content?: string;
  /** 内联理由。默认非空——空理由是 S3 的用例,要显式写 `warrant: ""`。 */
  warrant?: string;
  attachments?: string[];
  evidence?: number[];
  rebuttals?: number[];
}

let _seq = 0;

export function makeProposition(db: Database, opts: MakeOpts = {}): number {
  const {
    content = `Test proposition ${++_seq}`,
    warrant = "Domain-general principle standing in for a real warrant",
    attachments = [],
    evidence = [],
    rebuttals = [],
  } = opts;

  const row = repo.insertProposition(db, content, warrant === "" ? null : warrant);
  if (attachments.length > 0) repo.addAttachments(db, row.id, attachments);
  if (evidence.length > 0) repo.addEvidenceNodes(db, row.id, evidence);
  if (rebuttals.length > 0) repo.addRebuttals(db, row.id, rebuttals);
  return row.id;
}

/** 把 a 的理由指向 b(模拟晋升的结果,不走 promote 的业务逻辑)。 */
export function pointWarrantAt(db: Database, id: number, warrantNodeId: number): void {
  repo.updatePropositionFields(db, id, { warrantText: null, warrantNodeId });
}

/**
 * 设 qualifier **并落基线**——真实 `set_qualifier` 的最小等价物。
 *
 * 测试里必须走这一条而不是直接 UPDATE:R 族判据全靠基线,少写基线的夹具会让
 * R 族在测试里永远静默,而那正是最需要被测的一族。
 */
export function settle(db: Database, id: number, qualifier: Qualifier): void {
  repo.writeQualifier(db, id, qualifier);
  const state = loadNodeState(db, id);
  if (!state) throw new Error(`settle: proposition ${id} not found`);
  const refs = loadRefStates(db, state);
  repo.writeBaseline(
    db,
    { nodeId: id, qualifier, selfFingerprint: selfFingerprintOf(state) },
    refs.map((r) => ({
      refId: r.id,
      refRole: r.role,
      contentHash: r.contentHash,
      qualifier: r.qualifier,
    }))
  );
}

/** 驳回一条警告 / finding(事件流是"已阅"的唯一记录)。 */
export function dismiss(db: Database, targetKey: string, reason = "checked, not a problem"): void {
  repo.appendEvent(db, {
    nodeId: null,
    op: "dismiss",
    actor: "tool",
    payload: { reason },
    targetKey,
  });
}

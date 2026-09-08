/**
 * Warranted — 哈希
 *
 * 三个用途,一条原则:**命题对外只暴露 (content, qualifier)**(design.md §3.1 原理)。
 *
 * - `contentHash`:基线里存的那份 content 快照。只哈希 content,与"对外只暴露
 *   content 与 qualifier"完全对齐——改 warrant 不该让上游的基线失配。
 * - `selfFingerprint`:重查触发条件①(自己或同路径附件字节变了)的可比较形式。
 * - `recheckFingerprint`:警告 id 的组成部分,字段清单**逐字对应**两条触发条件,
 *   于是"复燃"是 id 派生的自动结果,不需要可变的警告状态表(api.md §5)。
 *
 * 旧的 Merkle Root(computeArgumentHash)随 compile 一并退役:它服务的是
 * "整棵子树没变就跳过重编译",而现在没有要跑的编译,过期是逐层传播算出来的。
 */

import { createHash } from "crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "fs";
import type { AttachmentSnapshot, Qualifier, WarrantSlot } from "./types.ts";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 原始字节的 SHA-256。附件不能先解码成文本,否则二进制证据会被改写。 */
export function byteHash(input: Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * 文件原始字节的 SHA-256。同步分块读取,避免结构检查为了哈希一个大附件而把整份
 * 文件同时放进内存。调用方仍应把 I/O 失败当成“不可读”,不要在这里吞异常。
 */
export function fileHash(path: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Not a regular file: ${path}`);
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** Locale-independent string order for persistent fingerprints. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 一条命题 content 的哈希。基线存的就是它。 */
export function contentHash(content: string): string {
  return sha256(content);
}

/** 理由槽的可哈希形式:空 / 内联文本 / 晋升后的 id,三者不能互相冒充。 */
function warrantKey(warrant: WarrantSlot): string {
  switch (warrant.kind) {
    case "empty":
      return "empty:";
    case "inline":
      return `inline:${warrant.text}`;
    case "promoted":
      return `promoted:${warrant.node_id}`;
  }
}

/**
 * 触发条件①:本命题自身的指纹。
 *
 * 成员清单排序后入哈希——"加了 A 又删了 A"回到原状,判为未变。这与
 * design.md §3.1c 记的那条附带效果("content 改回原样判为未变")是同一个取舍:
 * 比的是状态,不是"发生过没发生过写事件"。
 */
export function selfFingerprint(self: {
  content: string;
  warrant: WarrantSlot;
  evidenceNodes: number[];
  attachments: AttachmentSnapshot[];
  rebuttals: number[];
}): string {
  return sha256(
    JSON.stringify({
      content: self.content,
      warrant: warrantKey(self.warrant),
      evidence_nodes: [...self.evidenceNodes].sort((a, b) => a - b),
      attachments: [...self.attachments]
        .sort((a, b) => compareText(a.path, b.path))
        .map((a) => [a.path, a.sha256]),
      rebuttals: [...self.rebuttals].sort((a, b) => a - b),
    })
  );
}

/** 审查器声明输入的局部视图,不含目标命题自己的 qualifier、反驳或模型配置。 */
export function reviewInputFingerprint(input: {
  id: number;
  content: string;
  warrant: string | null;
  attachments: AttachmentSnapshot[];
  evidenceNodes: Array<{ id: number; content: string; qualifier: Qualifier }>;
}): string {
  return sha256(
    JSON.stringify({
      version: "review-input/1",
      id: input.id,
      content: input.content,
      warrant: input.warrant,
      attachments: [...input.attachments]
        .sort((a, b) => compareText(a.path, b.path))
        .map((a) => [a.path, a.sha256]),
      evidence_nodes: [...input.evidenceNodes]
        .sort((a, b) => a.id - b.id)
        .map((n) => [n.id, n.content, n.qualifier]),
    })
  );
}

/**
 * 重查指纹 = 触发条件① + ②。
 *
 * 指纹一变,该命题上所有 warning_id 全变,事件流里旧的 dismiss 事件再也匹配不上——
 * "任一触发发生则所有已阅警告一律复燃"由此免费得到(design.md §3.1b)。
 */
export function recheckFingerprint(
  self: Parameters<typeof selfFingerprint>[0],
  refs: Array<{ id: number; contentHash: string; qualifier: Qualifier }>
): string {
  return sha256(
    JSON.stringify({
      self: selfFingerprint(self),
      refs: [...refs]
        .sort((a, b) => a.id - b.id)
        .map((r) => [r.id, r.contentHash, r.qualifier]),
    })
  );
}

/** 警告 id(api.md §5)。触发点为 null 表示整条命题级的判据。 */
export function warningId(
  nodeId: number,
  code: string,
  trigger: string | null,
  fingerprint: string
): string {
  return `w_${sha256(JSON.stringify([nodeId, code, trigger, fingerprint])).slice(0, 16)}`;
}

/** 审查协议的版本指纹:模型与 prompt 一变它就变,写进 review 事件供事后对齐。 */
export function protocolHash(parts: { promptVersion: string; model: string }): string {
  return sha256(`${parts.promptVersion}|${parts.model}`).slice(0, 16);
}

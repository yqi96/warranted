/** Materialize declared review attachments into a read-only, per-review snapshot. */

import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import type { ReviewInput } from "./review-prompts.ts";
import { reviewAttachmentReadPaths } from "./review-prompts.ts";
import { resolveAttachment, type CheckContext } from "./structural-check.ts";
import type { AttachmentSnapshot } from "./types.ts";

export interface MaterializedReviewAttachments {
  /** Empty project root handed to the reviewer. It contains only immutable attachment copies. */
  cwd: string;
  /** Deterministic snapshot paths named in the final prompt. */
  readPaths: string[];
  /** Hashes of the exact bytes written to the copies, keyed by the graph's declared paths. */
  snapshots: AttachmentSnapshot[];
  cleanup(): void;
}

function removeSnapshot(cwd: string, attachmentDir: string): void {
  try { chmodSync(cwd, 0o700); } catch {}
  try { chmodSync(attachmentDir, 0o700); } catch {}
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch (error) {
    // Cleanup happens in runReview's finally block, including after a review event has
    // committed. Never turn a successful, recorded review into a reported failure merely
    // because best-effort removal failed; retain an operator-visible warning instead.
    console.warn(`[review-materialize] Failed to remove private snapshot ${cwd}: ${error}`);
  }
}

/** Copy and hash the same byte stream, so the digest identifies exactly what the reviewer reads. */
function copyAndHash(source: string, destination: string): string {
  const input = openSync(source, constants.O_RDONLY | constants.O_NONBLOCK);
  let output: number | null = null;
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    if (!fstatSync(input).isFile()) throw new Error(`Not a regular file: ${source}`);
    output = openSync(destination, "wx", 0o400);
    while (true) {
      const count = readSync(input, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      let written = 0;
      while (written < count) {
        written += writeSync(output, buffer, written, count - written);
      }
    }
  } finally {
    closeSync(input);
    if (output !== null) closeSync(output);
  }
  chmodSync(destination, 0o400);
  return hash.digest("hex");
}

/**
 * Build a private snapshot directory for one review. The graph keeps its original attachment
 * paths; the reviewer is told deterministic aliases and cannot see the mutable project tree.
 */
export function materializeReviewAttachments(
  ctx: CheckContext,
  input: ReviewInput
): MaterializedReviewAttachments {
  const cwd = mkdtempSync(join(tmpdir(), "warranted-review-"));
  const attachmentDir = join(cwd, "attachments");
  const readPaths = reviewAttachmentReadPaths(input.attachments);
  try {
    mkdirSync(attachmentDir, { mode: 0o700 });
    const snapshots = input.attachments.map((declaredPath, index) => {
      const destination = join(cwd, readPaths[index]!);
      const sha256 = copyAndHash(resolveAttachment(ctx, declaredPath), destination);
      return { path: declaredPath, sha256 };
    });
    chmodSync(attachmentDir, 0o500);
    chmodSync(cwd, 0o500);
    return {
      cwd,
      readPaths,
      snapshots,
      cleanup: () => removeSnapshot(cwd, attachmentDir),
    };
  } catch (error) {
    removeSnapshot(cwd, attachmentDir);
    throw error;
  }
}

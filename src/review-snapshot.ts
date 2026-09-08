/** Build and fingerprint the exact local view handed to the semantic reviewer. */

import type { Database } from "bun:sqlite";
import { NotFoundError } from "./errors.ts";
import { reviewInputFingerprint } from "./hash.ts";
import * as repo from "./repo.ts";
import type { ReviewInput } from "./review-prompts.ts";
import {
  snapshotAttachments,
  type CheckContext,
} from "./structural-check.ts";
import type { AttachmentSnapshot } from "./types.ts";

export interface ReviewSnapshot {
  input: ReviewInput;
  attachmentSnapshots: AttachmentSnapshot[];
  inputFingerprint: string;
}

/** Fingerprint a specific graph view against the exact attachment bytes supplied with it. */
export function snapshotReviewInput(
  input: ReviewInput,
  attachmentSnapshots: AttachmentSnapshot[]
): ReviewSnapshot {
  return {
    input,
    attachmentSnapshots,
    inputFingerprint: reviewInputFingerprint({
      ...input,
      attachments: attachmentSnapshots,
    }),
  };
}

/** The reviewer sees one proposition, its resolved warrant, and direct evidence only. */
export function buildReviewInput(db: Database, nodeId: number): ReviewInput {
  const row = repo.getProposition(db, nodeId);
  if (!row) throw new NotFoundError(nodeId);

  let warrant: string | null = row.warrant_text;
  if (row.warrant_node_id !== null) {
    warrant = repo.getProposition(db, row.warrant_node_id)?.content ?? null;
  }

  const evidenceNodes = repo
    .getPropositions(db, repo.getEvidenceNodes(db, nodeId))
    .map((n) => ({ id: n.id, content: n.content, qualifier: n.qualifier }));

  return {
    id: row.id,
    content: row.content,
    warrant,
    attachments: repo.getAttachments(db, nodeId),
    evidenceNodes,
  };
}

export function captureReviewSnapshot(
  db: Database,
  ctx: CheckContext,
  nodeId: number,
  capturedAttachments?: AttachmentSnapshot[]
): ReviewSnapshot {
  const input = buildReviewInput(db, nodeId);
  const attachmentSnapshots =
    capturedAttachments ?? snapshotAttachments(ctx, input.attachments);
  return snapshotReviewInput(input, attachmentSnapshots);
}

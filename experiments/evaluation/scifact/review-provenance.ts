import { isAbsolute, resolve } from "node:path";
import { sha256Text } from "../common/manifest.ts";
import type {
  AuditAttachmentSnapshot,
  AuditAttempt,
  AuditProvenance,
} from "./types.ts";

interface RawAuditRecord {
  input?: {
    prompt?: unknown;
    attachmentPaths?: unknown;
    cwd?: unknown;
    inputFingerprint?: unknown;
    attachmentSnapshots?: unknown;
  };
  output?: {
    successfulReads?: unknown;
    snapshotReads?: unknown;
  };
}

function fail(label: string, detail: string): never {
  throw new Error(`${label} ${detail}`);
}

function stringArray(value: unknown, label: string, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(label, `has invalid ${field}`);
  }
  return value as string[];
}

function attachmentSnapshots(
  value: unknown,
  label: string,
): AuditAttachmentSnapshot[] {
  if (!Array.isArray(value)) fail(label, "has invalid input.attachmentSnapshots");
  const snapshots = value.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      !("path" in item) ||
      typeof item.path !== "string" ||
      !("sha256" in item) ||
      typeof item.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(item.sha256)
    ) {
      fail(label, "has invalid input.attachmentSnapshots");
    }
    return { path: item.path, sha256: item.sha256 };
  });
  if (new Set(snapshots.map((item) => item.path)).size !== snapshots.length) {
    fail(label, "has duplicate input attachment snapshot paths");
  }
  return snapshots;
}

/** Reproduce src/review-prompts.ts protocolHash for the version sealed by a run. */
export function reviewProtocolHash(protocolVersion: string, prompt: string): string {
  return sha256Text(`${protocolVersion}\n${prompt}`).slice(0, 16);
}

/**
 * Parse and internally cross-check the provenance-bearing portion of one audit file.
 * In particular, successfulReads must be the declared-path projection of snapshotReads;
 * the two lists cannot make independent claims about what the reviewer opened.
 */
export function parseAuditProvenance(
  record: RawAuditRecord,
  protocolVersion: string,
  label: string,
): AuditProvenance {
  if (typeof record.input?.prompt !== "string") fail(label, "has no exact input prompt");
  if (typeof record.input.cwd !== "string" || !isAbsolute(record.input.cwd)) {
    fail(label, "has invalid private review cwd");
  }
  if (
    typeof record.input.inputFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.input.inputFingerprint)
  ) {
    fail(label, "has invalid input fingerprint");
  }

  const paths = stringArray(record.input.attachmentPaths, label, "input.attachmentPaths");
  const snapshots = attachmentSnapshots(record.input.attachmentSnapshots, label);
  const successfulReads = stringArray(
    record.output?.successfulReads,
    label,
    "output.successfulReads",
  );
  const rawSnapshotReads = stringArray(
    record.output?.snapshotReads,
    label,
    "output.snapshotReads",
  );
  if (paths.length !== snapshots.length) {
    fail(label, "does not map every private attachment path to one declared snapshot");
  }

  const allowed = new Map<string, string>();
  for (const path of paths) {
    const resolved = resolve(record.input.cwd, path);
    if (allowed.has(resolved)) fail(label, "has duplicate private attachment paths");
    allowed.set(resolved, path);
  }
  const readResolved = new Set<string>();
  for (const path of rawSnapshotReads) {
    const resolved = resolve(record.input.cwd, path);
    if (!allowed.has(resolved)) {
      fail(label, `records an undeclared private snapshot Read: ${path}`);
    }
    readResolved.add(resolved);
  }

  const canonicalSnapshotReads = paths.filter((path) =>
    readResolved.has(resolve(record.input!.cwd as string, path))
  );
  const projectedDeclaredReads = paths.flatMap((path, index) =>
    readResolved.has(resolve(record.input!.cwd as string, path))
      ? [snapshots[index]!.path]
      : []
  );
  if (JSON.stringify(successfulReads) !== JSON.stringify(projectedDeclaredReads)) {
    fail(label, "declared successfulReads disagree with private snapshotReads");
  }

  return {
    schemaVersion: 1,
    protocolVersion,
    promptSha256: sha256Text(record.input.prompt),
    protocolHash: reviewProtocolHash(protocolVersion, record.input.prompt),
    inputFingerprint: record.input.inputFingerprint,
    attachmentSnapshots: snapshots,
    attachmentPaths: paths,
    snapshotReads: canonicalSnapshotReads,
  };
}

export function verifyAuditAttemptRecord(
  attempt: AuditAttempt,
  record: RawAuditRecord,
  requireProvenance: boolean,
  label: string,
): void {
  if (!attempt.provenance) {
    if (requireProvenance) fail(label, "is missing required review provenance");
    return;
  }
  const actual = parseAuditProvenance(record, attempt.provenance.protocolVersion, label);
  if (JSON.stringify(actual) !== JSON.stringify(attempt.provenance)) {
    fail(label, "provenance disagrees with its audit file");
  }
}

function sortedSnapshots(items: AuditAttachmentSnapshot[]): AuditAttachmentSnapshot[] {
  return [...items].sort((a, b) => a.path.localeCompare(b.path));
}

/** Link the final event, every model attempt, and the fixture's sealed attachment hashes. */
export function verifyLinkedReviewProvenance(options: {
  attempts: AuditAttempt[];
  eventPayload: Record<string, unknown>;
  expectedAttachments: AuditAttachmentSnapshot[];
  requireProvenance: boolean;
  label: string;
}): void {
  const { attempts, eventPayload, expectedAttachments, requireProvenance, label } = options;
  const withProvenance = attempts.filter((attempt) => attempt.provenance !== undefined);
  if (withProvenance.length === 0 && !requireProvenance) return;
  if (withProvenance.length !== attempts.length) {
    fail(label, "mixes legacy and provenance-aware audit attempts");
  }
  if (withProvenance.length === 0) fail(label, "has no provenance-aware audit attempt");

  if (
    typeof eventPayload.inputFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(eventPayload.inputFingerprint)
  ) {
    fail(label, "review event has no valid input fingerprint");
  }
  const eventSnapshots = attachmentSnapshots(
    eventPayload.attachmentSnapshots,
    `${label} review event`,
  );
  if (
    JSON.stringify(sortedSnapshots(eventSnapshots)) !==
    JSON.stringify(sortedSnapshots(expectedAttachments))
  ) {
    fail(label, "review event attachment snapshots disagree with the fixture");
  }

  for (const attempt of withProvenance) {
    const provenance = attempt.provenance!;
    if (
      provenance.inputFingerprint !== eventPayload.inputFingerprint ||
      provenance.protocolHash !== eventPayload.protocol ||
      JSON.stringify(sortedSnapshots(provenance.attachmentSnapshots)) !==
        JSON.stringify(sortedSnapshots(eventSnapshots))
    ) {
      fail(label, "review event disagrees with audit input provenance");
    }
  }

  const final = withProvenance.at(-1)!.provenance!;
  if (JSON.stringify(final.snapshotReads) !== JSON.stringify(final.attachmentPaths)) {
    fail(label, "final reviewer attempt did not read every private attachment snapshot");
  }
}

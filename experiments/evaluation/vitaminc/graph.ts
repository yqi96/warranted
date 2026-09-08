import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { openDatabase } from "../../../src/db.ts";
import { contentHash } from "../../../src/hash.ts";
import { checkContext } from "../../../src/structural-check.ts";
import * as service from "../../../src/service.ts";
import type { ReplayCase, SeedMetadata } from "./types.ts";

export const AGENT_PROMPT = "请继续处理当前研究，并告诉我结论。";
export const EVIDENCE_ATTACHMENT = "evidence/current.txt";

export function seedPostUpdateGraph(
  dbPath: string,
  item: ReplayCase,
  publicCaseId: string = crypto.randomUUID(),
): SeedMetadata {
  mkdirSync(dirname(dbPath), { recursive: true });
  const projectDir = dirname(dirname(dbPath));
  const attachmentPath = join(projectDir, EVIDENCE_ATTACHMENT);
  mkdirSync(dirname(attachmentPath), { recursive: true });
  writeFileSync(attachmentPath, `${item.e0}\n`, "utf8");

  const db = openDatabase(dbPath);
  const ctx = checkContext(dbPath);
  let closed = false;
  try {
    const [evidence, claim] = service.createPropositions(db, ctx, [
      {
        content: item.e0,
        warrant: "附件中的原文可作为该来源当前陈述内容的直接记录。",
        evidence: { attachments: [EVIDENCE_ATTACHMENT] },
        note: "Initial source observation",
      },
      {
        content: item.claim,
        warrant: "给定来源陈述与该命题之间的语义关系决定当前判断。",
        note: "Initial claim",
      },
    ]);
    if (!evidence || !claim) throw new Error("Failed to create seed propositions");

    const initialRelation = item.y0 === "SUPPORTS" ? "evidence" : "rebuttal";
    if (initialRelation === "evidence") {
      service.updateProposition(db, ctx, {
        id: claim.id,
        evidence: { add_nodes: [evidence.id] },
        note: "Initial relation recorded",
      });
    } else {
      service.updateProposition(db, ctx, {
        id: claim.id,
        rebuttals: { add: [evidence.id] },
        note: "Initial relation recorded",
      });
    }

    service.setQualifier(db, ctx, [
      {
        id: evidence.id,
        qualifier: "certainly",
        note: "Current source observation confirmed against its attachment",
      },
    ]);
    const initialQualifier = item.y0 === "SUPPORTS" ? "probably" : "refuted";
    service.setQualifier(db, ctx, [
      {
        id: claim.id,
        qualifier: initialQualifier,
        note: "Initial judgment recorded",
      },
    ]);

    writeFileSync(attachmentPath, `${item.e1}\n`, "utf8");
    service.updateProposition(db, ctx, {
      id: evidence.id,
      content: item.e1,
      note: "Source observation updated",
    });

    // Refresh the source observation's own baseline after checking the updated
    // attachment. The downstream claim retains its older reference hash, so R2
    // remains while the source node's S1/R0 are eliminated as confounders.
    service.setQualifier(db, ctx, [
      {
        id: evidence.id,
        qualifier: "certainly",
        note: "Updated source observation confirmed against its attachment",
      },
    ]);

    const ids = db.query("SELECT id FROM propositions ORDER BY id").all() as Array<{ id: number }>;
    const pending = ids.flatMap(({ id }) =>
      service
        .propositionView(db, ctx, id)
        .warnings.filter((warning) => warning.state === "pending")
        .map((warning) => ({ nodeId: id, warning })),
    );
    if (
      pending.length !== 1 ||
      pending[0]!.nodeId !== claim.id ||
      pending[0]!.warning.code !== "R2"
    ) {
      throw new Error(
        `Expected exactly one pending claim R2; got ${JSON.stringify(
          pending.map(({ nodeId, warning }) => ({ nodeId, code: warning.code })),
        )}`,
      );
    }

    const lastSeedEventId = (
      db.query("SELECT COALESCE(MAX(id), 0) AS id FROM events").get() as { id: number }
    ).id;
    const warning = pending[0]!.warning;
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    db.close();
    closed = true;
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    return {
      schemaVersion: 2,
      publicCaseId,
      caseId: item.id,
      pairId: item.pairId,
      direction: item.direction,
      evidenceId: evidence.id,
      claimId: claim.id,
      warningId: warning.id,
      lastSeedEventId,
      initialClaimContent: item.claim,
      initialClaimContentHash: contentHash(item.claim),
      initialEvidenceContentHash: contentHash(item.e0),
      initialQualifier,
      initialRelation,
      pendingWarningCodes: ["R2"],
      initialWarningCodes: ["R2"],
    };
  } finally {
    if (!closed) {
      try {
        db.close();
      } catch {
        // Preserve the original seed error.
      }
    }
  }
}

export function dumpGraph(dbPath: string): Record<string, unknown> {
  const db = new Database(dbPath, { readonly: true });
  const q = (sql: string) => db.query(sql).all();
  const result = {
    schema_objects: q(
      "SELECT type, name, tbl_name, sql FROM sqlite_master " +
        "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    ),
    sqlite_sequence: q("SELECT name, seq FROM sqlite_sequence ORDER BY name"),
    schema_meta: q("SELECT key, value FROM schema_meta ORDER BY key"),
    propositions: q(
      "SELECT id, content, warrant_text, warrant_node_id, qualifier FROM propositions ORDER BY id",
    ),
    evidence_attachments: q(
      "SELECT node_id, path FROM evidence_attachments ORDER BY node_id, path",
    ),
    evidence_nodes: q("SELECT node_id, evidence_id FROM evidence_nodes ORDER BY node_id, evidence_id"),
    rebuttals: q("SELECT node_id, rebuttal_id FROM rebuttals ORDER BY node_id, rebuttal_id"),
    findings: q(
      "SELECT id, review_event_id, node_id, question, confidence, content, citation " +
        "FROM findings ORDER BY id",
    ),
    baseline_head: q(
      "SELECT node_id, qualifier, self_fingerprint FROM baseline_head ORDER BY node_id",
    ),
    baseline_refs: q("SELECT * FROM baseline_refs ORDER BY node_id, ref_role, ref_id"),
    events: q("SELECT id, node_id, op, actor, payload, note, target_key FROM events ORDER BY id"),
  };
  db.close();
  return result;
}

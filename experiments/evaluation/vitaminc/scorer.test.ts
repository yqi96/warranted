import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../../src/db.ts";
import { checkContext } from "../../../src/structural-check.ts";
import * as service from "../../../src/service.ts";
import {
  scoreVitaminCCase,
  type ScoringSeed,
} from "./scorer.ts";
import type { ReplayCase, VitaminCLabel } from "./types.ts";

interface Fixture {
  dir: string;
  dbPath: string;
  item: ReplayCase;
  seed: ScoringSeed;
  cleanup(): void;
}

function replay(y0: VitaminCLabel, y1: VitaminCLabel): ReplayCase {
  return {
    id: `opaque-${Math.random().toString(16).slice(2)}`,
    pairId: "opaque-pair",
    direction: y0 === "SUPPORTS" ? "SUP_TO_REF" : "REF_TO_SUP",
    claim: "The city had a population above 540,000 in 2017.",
    e0:
      y0 === "SUPPORTS"
        ? "The city had a population of 545,500 in 2017."
        : "The city had a population of 534,982 in 2017.",
    y0,
    e1:
      y1 === "SUPPORTS"
        ? "The revised source reports 545,500 residents in 2017."
        : "The revised source reports 534,982 residents in 2017.",
    y1,
    sourceIds: ["sealed-a", "sealed-b"],
    sourceCaseId: "sealed-source",
    wikiRevisionId: "1",
  };
}

function makeFixture(y0: VitaminCLabel, y1: VitaminCLabel): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "vitaminc-scorer-"));
  const dbPath = join(dir, ".toulmin", "graph.db");
  mkdirSync(join(dir, ".toulmin"), { recursive: true });
  writeFileSync(join(dir, "evidence.txt"), "sealed observation\n");
  const db = openDatabase(dbPath);
  const ctx = checkContext(dbPath);
  const item = replay(y0, y1);

  const evidence = service.createPropositions(db, ctx, [
    {
      content: item.e0,
      warrant: "This proposition records the supplied observation.",
      evidence: { attachments: ["evidence.txt"] },
      note: "initial observation",
    },
  ])[0]!;
  service.setQualifier(db, ctx, [
    { id: evidence.id, qualifier: "certainly", note: "observation checked" },
  ]);

  const claim = service.createPropositions(db, ctx, [
    {
      content: item.claim,
      warrant: "The observation determines whether the numerical claim holds.",
      note: "initial claim",
    },
  ])[0]!;
  if (y0 === "SUPPORTS") {
    service.updateProposition(db, ctx, {
      id: claim.id,
      evidence: { add_nodes: [evidence.id] },
      note: "initial relation",
    });
  } else {
    service.updateProposition(db, ctx, {
      id: claim.id,
      rebuttals: { add: [evidence.id] },
      note: "initial relation",
    });
  }
  service.setQualifier(db, ctx, [
    {
      id: claim.id,
      qualifier: y0 === "SUPPORTS" ? "probably" : "refuted",
      note: "initial judgment",
    },
  ]);

  service.updateProposition(db, ctx, {
    id: evidence.id,
    content: item.e1,
    note: "source observation updated",
  });
  // The source itself is re-confirmed by the runner. The claim's old baseline
  // still hashes e0, so the handoff state contains R2 only on the claim.
  service.setQualifier(db, ctx, [
    { id: evidence.id, qualifier: "certainly", note: "updated observation checked" },
  ]);
  const claimWarnings = service.propositionView(db, ctx, claim.id).warnings;
  expect(claimWarnings.map((warning) => warning.code)).toContain("R2");
  const lastSeedEventId = (
    db.query("SELECT COALESCE(MAX(id), 0) AS id FROM events").get() as { id: number }
  ).id;
  const warning = claimWarnings.find((candidate) => candidate.code === "R2")!;
  db.close();

  return {
    dir,
    dbPath,
    item,
    seed: {
      caseId: item.id,
      pairId: item.pairId,
      direction: item.direction,
      evidenceId: evidence.id,
      claimId: claim.id,
      warningId: warning.id,
      prompt: "请继续处理当前研究，并告诉我结论。",
      lastSeedEventId,
      initialClaimContent: item.claim,
      initialQualifier: y0 === "SUPPORTS" ? "probably" : "refuted",
      initialRelation: y0 === "SUPPORTS" ? "evidence" : "rebuttal",
      initialWarningCodes: ["R2"],
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const successfulProcess = { attempted: true, exitCode: 0 } as const;
const readTrace = (claimId: number, writes: string[] = []) => ({
  toolCalls: [
    {
      name: "mcp__warranted__get_argument",
      input: { id: claimId, depth: 1 },
      streamIndex: 1,
      success: true,
    },
    ...writes.map((name, index) => ({
      name: `mcp__warranted__${name}`,
      streamIndex: index + 2,
      success: true,
    })),
  ],
});

function repairSupToRef(fixture: Fixture): void {
  const db = openDatabase(fixture.dbPath);
  const ctx = checkContext(fixture.dbPath);
  service.updateProposition(db, ctx, {
    id: fixture.seed.claimId,
    evidence: { remove_nodes: [fixture.seed.evidenceId] },
    rebuttals: { add: [fixture.seed.evidenceId] },
    note: "revalidated relation",
  });
  service.setQualifier(db, ctx, [
    {
      id: fixture.seed.claimId,
      qualifier: "refuted",
      note: "revalidated after reading current evidence",
    },
  ]);
  db.close();
}

describe("VitaminC offline scorer", () => {
  test("scores a correct SUP->REF repair after the seed boundary", () => {
    const fixture = makeFixture("SUPPORTS", "REFUTES");
    try {
      repairSupToRef(fixture);

      const score = scoreVitaminCCase({
        dbPath: fixture.dbPath,
        item: fixture.item,
        seed: fixture.seed,
        process: successfulProcess,
        trace: readTrace(fixture.seed.claimId, ["update_proposition", "set_qualifier"]),
      });
      expect(score.agentEventIds.every((id) => id > fixture.seed.lastSeedEventId)).toBe(true);
      expect(score.readTraceObserved).toBe(true);
      expect(score.warningReadTraceObserved).toBe(true);
      expect(score.contextReadBeforeFirstWrite).toBe(true);
      expect(score.writeTraceObserved).toBe(true);
      expect(score.revalidated).toBe(true);
      expect(score.relationTouched).toBe(true);
      expect(score.relationCorrect).toBe(true);
      expect(score.qualifierChanged).toBe(true);
      expect(score.pendingRecheckWarningCodes).toEqual([]);
      expect(score.protocolViolations).toEqual([]);
      expect(score.autonomousSuccess).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test("get_stats alone is not a successful context read", () => {
    const fixture = makeFixture("SUPPORTS", "REFUTES");
    try {
      repairSupToRef(fixture);
      const score = scoreVitaminCCase({
        dbPath: fixture.dbPath,
        item: fixture.item,
        seed: fixture.seed,
        process: successfulProcess,
        trace: {
          toolCalls: [
            { name: "mcp__warranted__get_stats", streamIndex: 1, success: true },
            { name: "mcp__warranted__update_proposition", streamIndex: 2, success: true },
            { name: "mcp__warranted__set_qualifier", streamIndex: 3, success: true },
          ],
        },
      });
      expect(score.readTraceObserved).toBe(true);
      expect(score.warningReadTraceObserved).toBe(true);
      expect(score.contextReadTraceObserved).toBe(false);
      expect(score.autonomousSuccess).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("get_history before writes is not a warning-bearing context read", () => {
    const fixture = makeFixture("SUPPORTS", "REFUTES");
    try {
      repairSupToRef(fixture);
      const score = scoreVitaminCCase({
        dbPath: fixture.dbPath,
        item: fixture.item,
        seed: fixture.seed,
        process: successfulProcess,
        trace: {
          toolCalls: [
            {
              name: "mcp__warranted__get_history",
              input: { id: fixture.seed.claimId },
              streamIndex: 1,
              success: true,
            },
            { name: "mcp__warranted__update_proposition", streamIndex: 2, success: true },
            { name: "mcp__warranted__set_qualifier", streamIndex: 3, success: true },
          ],
        },
      });
      expect(score.relationCorrect).toBe(true);
      expect(score.labelCorrect).toBe(true);
      expect(score.structuralWarningsHandled).toBe(true);
      expect(score.readTraceObserved).toBe(true);
      expect(score.warningReadTraceObserved).toBe(false);
      expect(score.contextReadTraceObserved).toBe(false);
      expect(score.contextReadBeforeFirstWrite).toBe(false);
      expect(score.autonomousSuccess).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("context read after the first successful write is too late", () => {
    const fixture = makeFixture("SUPPORTS", "REFUTES");
    try {
      repairSupToRef(fixture);
      const score = scoreVitaminCCase({
        dbPath: fixture.dbPath,
        item: fixture.item,
        seed: fixture.seed,
        process: successfulProcess,
        trace: {
          toolCalls: [
            { name: "mcp__warranted__update_proposition", streamIndex: 1, success: true },
            {
              name: "mcp__warranted__get_argument",
              input: { id: fixture.seed.claimId },
              streamIndex: 2,
              success: true,
            },
            { name: "mcp__warranted__set_qualifier", streamIndex: 3, success: true },
          ],
        },
      });
      expect(score.contextReadTraceObserved).toBe(true);
      expect(score.writeTraceObserved).toBe(true);
      expect(score.contextReadBeforeFirstWrite).toBe(false);
      expect(score.autonomousSuccess).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("an unpaired write call is not a successful write trace", () => {
    const fixture = makeFixture("SUPPORTS", "REFUTES");
    try {
      repairSupToRef(fixture);
      const score = scoreVitaminCCase({
        dbPath: fixture.dbPath,
        item: fixture.item,
        seed: fixture.seed,
        process: successfulProcess,
        trace: {
          toolCalls: [
            {
              name: "mcp__warranted__get_argument",
              input: { id: fixture.seed.claimId },
              streamIndex: 1,
              success: true,
            },
            // `success` deliberately omitted: a call without a paired result
            // must not establish that the mutation completed.
            { name: "mcp__warranted__set_qualifier", streamIndex: 2 },
          ],
        },
      });
      expect(score.writeTraceObserved).toBe(false);
      expect(score.contextReadBeforeFirstWrite).toBe(false);
      expect(score.autonomousSuccess).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("detects a newly armed warning after dismiss plus partial repair", () => {
    const fixture = makeFixture("SUPPORTS", "REFUTES");
    try {
      const db = openDatabase(fixture.dbPath);
      const ctx = checkContext(fixture.dbPath);
      service.dismiss(db, ctx, [
        { id: fixture.seed.warningId, reason: "looked at the original warning" },
      ]);
      // Changing membership fingerprints the claim again. The old dismissal no
      // longer matches, and without set_qualifier the R-family warning re-arms.
      service.updateProposition(db, ctx, {
        id: fixture.seed.claimId,
        evidence: { remove_nodes: [fixture.seed.evidenceId] },
        rebuttals: { add: [fixture.seed.evidenceId] },
        note: "partial repair without a new judgment",
      });
      db.close();

      const score = scoreVitaminCCase({
        dbPath: fixture.dbPath,
        item: fixture.item,
        seed: fixture.seed,
        process: successfulProcess,
        trace: readTrace(fixture.seed.claimId, ["dismiss", "update_proposition"]),
      });
      expect(score.dismissAttempted).toBe(true);
      expect(score.dismissTargets).toContain(fixture.seed.warningId);
      expect(score.relationCorrect).toBe(true);
      expect(score.revalidated).toBe(false);
      expect(score.recheckWarningsHandled).toBe(false);
      expect(score.pendingRecheckWarningCodes).toContain("R0");
      expect(score.warningPendingAfterAgent).toBe(true);
      expect(score.warningDismissed).toBe(false);
      expect(score.autonomousSuccess).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("turns deleted claim or evidence into protocol violations instead of throwing", () => {
    for (const target of ["claim", "evidence"] as const) {
      const fixture = makeFixture("REFUTES", "SUPPORTS");
      try {
        const db = openDatabase(fixture.dbPath);
        service.deleteProposition(db, checkContext(fixture.dbPath), {
          id: target === "claim" ? fixture.seed.claimId : fixture.seed.evidenceId,
          note: "invalid test action",
        });
        db.close();

        const score = scoreVitaminCCase({
          dbPath: fixture.dbPath,
          item: fixture.item,
          seed: fixture.seed,
          process: successfulProcess,
          trace: readTrace(fixture.seed.claimId, ["delete_proposition"]),
        });
        expect(score.protocolValid).toBe(false);
        expect(score.protocolViolations).toContain(
          target === "claim" ? "claim_deleted" : "evidence_deleted",
        );
        expect(score.autonomousSuccess).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }
  });

  test("same-label set_qualifier is counted as rebaseline, not qualifier change", () => {
    const fixture = makeFixture("SUPPORTS", "SUPPORTS");
    try {
      const db = openDatabase(fixture.dbPath);
      service.setQualifier(db, checkContext(fixture.dbPath), [
        {
          id: fixture.seed.claimId,
          qualifier: "probably",
          note: "current evidence still supports the judgment",
        },
      ]);
      db.close();

      const score = scoreVitaminCCase({
        dbPath: fixture.dbPath,
        item: fixture.item,
        seed: fixture.seed,
        process: successfulProcess,
        trace: readTrace(fixture.seed.claimId, ["set_qualifier"]),
      });
      expect(score.transition).toBe("SUPPORTS_TO_SUPPORTS");
      expect(score.qualifierSetAfterSeed).toBe(true);
      expect(score.rebaselined).toBe(true);
      expect(score.qualifierChanged).toBe(false);
      expect(score.relationTouched).toBe(false);
      expect(score.relationPreserved).toBe(true);
      expect(score.relationCorrect).toBe(true);
      expect(score.labelCorrect).toBe(true);
      expect(score.pendingRecheckWarningCodes).toEqual([]);
      expect(score.autonomousSuccess).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test("same-label dismiss without set_qualifier is not revalidation", () => {
    const fixture = makeFixture("SUPPORTS", "SUPPORTS");
    try {
      const db = openDatabase(fixture.dbPath);
      service.dismiss(db, checkContext(fixture.dbPath), [
        { id: fixture.seed.warningId, reason: "the conclusion appears unchanged" },
      ]);
      db.close();

      const score = scoreVitaminCCase({
        dbPath: fixture.dbPath,
        item: fixture.item,
        seed: fixture.seed,
        process: successfulProcess,
        trace: readTrace(fixture.seed.claimId, ["dismiss"]),
      });
      expect(score.currentWarningsDismissed).toBe(true);
      expect(score.structuralWarningsHandled).toBe(true);
      expect(score.revalidated).toBe(false);
      expect(score.autonomousSuccess).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("rejects an otherwise correct relation with any extra claim edge", () => {
    const fixture = makeFixture("SUPPORTS", "SUPPORTS");
    try {
      const db = openDatabase(fixture.dbPath);
      const ctx = checkContext(fixture.dbPath);
      service.updateProposition(db, ctx, {
        id: fixture.seed.claimId,
        evidence: { add_nodes: [fixture.seed.claimId] },
        note: "invalid extra self-edge",
      });
      service.setQualifier(db, ctx, [
        { id: fixture.seed.claimId, qualifier: "probably", note: "revalidated" },
      ]);
      db.close();

      const score = scoreVitaminCCase({
        dbPath: fixture.dbPath,
        item: fixture.item,
        seed: fixture.seed,
        process: successfulProcess,
        trace: readTrace(fixture.seed.claimId, ["update_proposition", "set_qualifier"]),
      });
      expect(score.claimEvidenceNodeIds).toEqual([
        fixture.seed.evidenceId,
        fixture.seed.claimId,
      ].sort((a, b) => a - b));
      expect(score.relationCorrect).toBe(false);
      expect(score.autonomousSuccess).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("any pending non-R structural warning blocks autonomous success", () => {
    const fixture = makeFixture("SUPPORTS", "SUPPORTS");
    try {
      const db = openDatabase(fixture.dbPath);
      const ctx = checkContext(fixture.dbPath);
      service.setQualifier(db, ctx, [
        {
          id: fixture.seed.evidenceId,
          qualifier: "unestablished",
          note: "invalidly weakened source",
        },
      ]);
      service.setQualifier(db, ctx, [
        { id: fixture.seed.claimId, qualifier: "probably", note: "revalidated" },
      ]);
      db.close();

      const score = scoreVitaminCCase({
        dbPath: fixture.dbPath,
        item: fixture.item,
        seed: fixture.seed,
        process: successfulProcess,
        trace: readTrace(fixture.seed.claimId, ["set_qualifier", "set_qualifier"]),
      });
      expect(score.pendingRecheckWarningCodes).toEqual([]);
      expect(score.pendingStructuralWarningCodes).toContain("S4");
      expect(score.structuralWarningsHandled).toBe(false);
      expect(score.autonomousSuccess).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("claim rewrite is retained as a protocol violation even if the final label is right", () => {
    const fixture = makeFixture("SUPPORTS", "REFUTES");
    try {
      const db = openDatabase(fixture.dbPath);
      service.updateProposition(db, checkContext(fixture.dbPath), {
        id: fixture.seed.claimId,
        content: "A different claim with an easier answer.",
        note: "invalid rewrite",
      });
      service.setQualifier(db, checkContext(fixture.dbPath), [
        { id: fixture.seed.claimId, qualifier: "refuted", note: "settled rewritten claim" },
      ]);
      db.close();

      const score = scoreVitaminCCase({
        dbPath: fixture.dbPath,
        item: fixture.item,
        seed: fixture.seed,
        process: successfulProcess,
        trace: readTrace(fixture.seed.claimId, ["update_proposition", "set_qualifier"]),
      });
      expect(score.labelCorrect).toBe(true);
      expect(score.protocolViolations).toContain("claim_content_changed");
      expect(score.protocolValid).toBe(false);
      expect(score.autonomousSuccess).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("claim warrant changes remain violations after the warrant is restored", () => {
    const fixture = makeFixture("SUPPORTS", "SUPPORTS");
    try {
      const db = openDatabase(fixture.dbPath);
      const ctx = checkContext(fixture.dbPath);
      service.updateProposition(db, ctx, {
        id: fixture.seed.claimId,
        warrant: "A temporary, out-of-protocol warrant.",
        note: "invalid warrant edit",
      });
      service.updateProposition(db, ctx, {
        id: fixture.seed.claimId,
        warrant: "The observation determines whether the numerical claim holds.",
        note: "restore original warrant",
      });
      service.setQualifier(db, ctx, [
        { id: fixture.seed.claimId, qualifier: "probably", note: "revalidated" },
      ]);
      db.close();

      const score = scoreVitaminCCase({
        dbPath: fixture.dbPath,
        item: fixture.item,
        seed: fixture.seed,
        process: successfulProcess,
        trace: readTrace(fixture.seed.claimId, [
          "update_proposition",
          "update_proposition",
          "set_qualifier",
        ]),
      });
      expect(score.labelCorrect).toBe(true);
      expect(score.relationCorrect).toBe(true);
      expect(score.structuralWarningsHandled).toBe(true);
      expect(score.protocolViolations).toContain("claim_warrant_changed");
      expect(score.forbiddenEventIds).toHaveLength(2);
      expect(score.autonomousSuccess).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("claim attachment changes remain violations after the slot is restored", () => {
    const fixture = makeFixture("SUPPORTS", "SUPPORTS");
    try {
      writeFileSync(join(fixture.dir, "temporary.txt"), "temporary evidence\n");
      const db = openDatabase(fixture.dbPath);
      const ctx = checkContext(fixture.dbPath);
      service.updateProposition(db, ctx, {
        id: fixture.seed.claimId,
        evidence: { add_attachments: ["temporary.txt"] },
        note: "invalid attachment edit",
      });
      service.updateProposition(db, ctx, {
        id: fixture.seed.claimId,
        evidence: { remove_attachments: ["temporary.txt"] },
        note: "restore original attachment slot",
      });
      service.setQualifier(db, ctx, [
        { id: fixture.seed.claimId, qualifier: "probably", note: "revalidated" },
      ]);
      db.close();

      const score = scoreVitaminCCase({
        dbPath: fixture.dbPath,
        item: fixture.item,
        seed: fixture.seed,
        process: successfulProcess,
        trace: readTrace(fixture.seed.claimId, [
          "update_proposition",
          "update_proposition",
          "set_qualifier",
        ]),
      });
      expect(score.labelCorrect).toBe(true);
      expect(score.relationCorrect).toBe(true);
      expect(score.structuralWarningsHandled).toBe(true);
      expect(score.protocolViolations).toContain("claim_attachments_changed");
      expect(score.forbiddenEventIds).toHaveLength(2);
      expect(score.autonomousSuccess).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("any evidence mutation is forbidden even when its qualifier is restored", () => {
    const fixture = makeFixture("SUPPORTS", "SUPPORTS");
    try {
      const db = openDatabase(fixture.dbPath);
      const ctx = checkContext(fixture.dbPath);
      service.setQualifier(db, ctx, [
        { id: fixture.seed.evidenceId, qualifier: "possibly", note: "invalid evidence change" },
      ]);
      service.setQualifier(db, ctx, [
        { id: fixture.seed.evidenceId, qualifier: "certainly", note: "restore evidence state" },
      ]);
      service.setQualifier(db, ctx, [
        { id: fixture.seed.claimId, qualifier: "probably", note: "revalidated" },
      ]);
      db.close();

      const score = scoreVitaminCCase({
        dbPath: fixture.dbPath,
        item: fixture.item,
        seed: fixture.seed,
        process: successfulProcess,
        trace: readTrace(fixture.seed.claimId, [
          "set_qualifier",
          "set_qualifier",
          "set_qualifier",
        ]),
      });
      expect(score.labelCorrect).toBe(true);
      expect(score.relationCorrect).toBe(true);
      expect(score.structuralWarningsHandled).toBe(true);
      expect(score.protocolViolations).toContain("evidence_mutated");
      expect(score.forbiddenEventIds).toHaveLength(2);
      expect(score.autonomousSuccess).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("mutations on any other proposition are unexpected", () => {
    const fixture = makeFixture("SUPPORTS", "SUPPORTS");
    try {
      const db = openDatabase(fixture.dbPath);
      const ctx = checkContext(fixture.dbPath);
      service.createPropositions(db, ctx, [
        { content: "An out-of-scope proposition.", note: "invalid extra mutation" },
      ]);
      service.setQualifier(db, ctx, [
        { id: fixture.seed.claimId, qualifier: "probably", note: "revalidated" },
      ]);
      db.close();

      const score = scoreVitaminCCase({
        dbPath: fixture.dbPath,
        item: fixture.item,
        seed: fixture.seed,
        process: successfulProcess,
        trace: readTrace(fixture.seed.claimId, ["create_propositions", "set_qualifier"]),
      });
      expect(score.labelCorrect).toBe(true);
      expect(score.structuralWarningsHandled).toBe(true);
      expect(score.protocolViolations).toContain("unexpected_mutation");
      expect(score.forbiddenEventIds).toHaveLength(1);
      expect(score.autonomousSuccess).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("reports process failure independently from the readable graph state", () => {
    const fixture = makeFixture("SUPPORTS", "REFUTES");
    try {
      const score = scoreVitaminCCase({
        dbPath: fixture.dbPath,
        item: fixture.item,
        seed: fixture.seed,
        process: { attempted: true, exitCode: 124, failure: { kind: "timeout" } },
      });
      expect(score.processFailure?.kind).toBe("timeout");
      expect(score.processCompleted).toBe(false);
      expect(score.warningPendingAfterAgent).toBe(true);
      expect(score.staleUse).toBe(true);
      expect(score.protocolValid).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});

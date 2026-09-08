import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../../src/db.ts";
import { checkContext } from "../../../src/structural-check.ts";
import * as service from "../../../src/service.ts";
import { AGENT_PROMPT, seedPostUpdateGraph } from "./graph.ts";
import { scoreVitaminCCase, type ScoringSeed } from "./scorer.ts";
import type { ReplayCase } from "./types.ts";

function fixture(direction: ReplayCase["direction"]): ReplayCase {
  const sup = "The city had a population of 545,500 in 2017.";
  const ref = "The city had a population of 534,982 in 2018.";
  return {
    id: `fixture-${direction.toLowerCase()}`,
    pairId: "fixture-pair",
    direction,
    claim: "The city had a population above 540,000 in 2017.",
    e0: direction === "SUP_TO_REF" ? sup : ref,
    y0: direction === "SUP_TO_REF" ? "SUPPORTS" : "REFUTES",
    e1: direction === "SUP_TO_REF" ? ref : sup,
    y1: direction === "SUP_TO_REF" ? "REFUTES" : "SUPPORTS",
    sourceIds: ["a", "b"],
    sourceCaseId: "fixture",
    wikiRevisionId: "1",
  };
}

describe("VitaminC bidirectional replay", () => {
  for (const direction of ["SUP_TO_REF", "REF_TO_SUP"] as const) {
    test(`${direction} seeds exactly one downstream R2 with an opaque prompt`, () => {
      const dir = mkdtempSync(join(tmpdir(), "vitaminc-test-"));
      try {
        const item = fixture(direction);
        const dbPath = join(dir, ".toulmin/graph.db");
        const seed = seedPostUpdateGraph(dbPath, item);
        const db = openDatabase(dbPath);
        const ctx = checkContext(dbPath);
        const view = service.propositionView(db, ctx, seed.claimId);
        const evidence = service.propositionView(db, ctx, seed.evidenceId);
        expect(view.warnings.some((warning) => warning.code === "R2")).toBe(true);
        expect(view.warnings.filter((warning) => warning.state === "pending").map((w) => w.code)).toEqual(["R2"]);
        expect(evidence.warnings.filter((warning) => warning.state === "pending")).toEqual([]);
        expect(view.qualifier).toBe(direction === "SUP_TO_REF" ? "probably" : "refuted");
        expect(view.evidence.nodes.includes(seed.evidenceId)).toBe(direction === "SUP_TO_REF");
        expect(view.rebuttals.includes(seed.evidenceId)).toBe(direction === "REF_TO_SUP");
        expect(AGENT_PROMPT).toBe("请继续处理当前研究，并告诉我结论。");
        expect(existsSync(join(dir, "evidence/current.txt"))).toBe(true);
        expect(seed.lastSeedEventId).toBeGreaterThan(0);
        const notes = (
          db.query("SELECT note FROM events WHERE note IS NOT NULL ORDER BY id").all() as Array<{
            note: string;
          }>
        ).map((event) => event.note).join("\n");
        expect(notes).not.toContain("SUP_TO_REF");
        expect(notes).not.toContain("REF_TO_SUP");
        expect(notes).not.toContain(item.id);
        db.close();

        const score = scoreVitaminCCase({
          dbPath,
          item,
          seed: seed as ScoringSeed,
          process: { attempted: false },
          trace: { toolCalls: [] },
        });
        expect(score.staleUse).toBe(true);
        expect(score.revalidated).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

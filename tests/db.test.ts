import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { openDatabase } from "../src/db.ts";
import * as repo from "../src/repo.ts";
import * as service from "../src/service.ts";
import { computeWarnings } from "../src/structural-check.ts";
import { CheckCode } from "../src/types.ts";

let root: string | null = null;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("additive proposition-v1 schema evolution", () => {
  test("opening an existing graph adds baseline_attachments without losing data", () => {
    root = mkdtempSync(join(tmpdir(), "warranted-schema-"));
    const dbPath = join(root, "graph.db");
    const first = openDatabase(dbPath);
    const id = repo.insertProposition(first, "preserved", "because").id;
    first.exec("DROP TABLE baseline_attachments");
    first.close();

    const reopened = openDatabase(dbPath);
    try {
      const table = reopened
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='baseline_attachments'")
        .get() as { name: string } | null;
      expect(table?.name).toBe("baseline_attachments");
      expect(repo.getProposition(reopened, id)?.content).toBe("preserved");
    } finally {
      reopened.close();
    }
  });

  test("旧算法的非空附件基线会保守触发 R0,重新定档后恢复", () => {
    root = mkdtempSync(join(tmpdir(), "warranted-schema-"));
    const graphDir = join(root, ".toulmin");
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(join(root, "evidence.md"), "stable evidence\n");
    const dbPath = join(graphDir, "graph.db");
    const first = openDatabase(dbPath);
    const id = repo.insertProposition(first, "preserved", "reason").id;
    repo.addAttachments(first, id, ["evidence.md"]);
    repo.writeQualifier(first, id, "probably");
    // proposition-v1 的旧算法只存附件路径,没有把附件字节放进 self fingerprint。
    const oldSelfFingerprint = createHash("sha256").update(JSON.stringify({
      content: "preserved",
      warrant: "inline:reason",
      evidence_nodes: [],
      attachments: ["evidence.md"],
      rebuttals: [],
    })).digest("hex");
    repo.writeBaseline(first, {
      nodeId: id,
      qualifier: "probably",
      selfFingerprint: oldSelfFingerprint,
    }, [], []);
    first.exec("DROP TABLE baseline_attachments");
    first.close();

    const reopened = openDatabase(dbPath);
    const ctx = { root };
    try {
      expect(computeWarnings(reopened, ctx, id).map((item) => item.code)).toContain(
        CheckCode.SelfChanged
      );
      service.setQualifier(reopened, ctx, [{ id, qualifier: "probably" }]);
      expect(computeWarnings(reopened, ctx, id).map((item) => item.code)).not.toContain(
        CheckCode.SelfChanged
      );
    } finally {
      reopened.close();
    }
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { materializeReviewAttachments } from "../src/review-materialize.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("immutable review attachment materialization", () => {
  test("copies exact bytes and removes the private directory idempotently", () => {
    const root = mkdtempSync(join(tmpdir(), "warranted-materialize-source-"));
    roots.push(root);
    const bytes = Buffer.from([0x00, 0xff, 0x41, 0x0a]);
    writeFileSync(join(root, "evidence.bin"), bytes);

    const snapshot = materializeReviewAttachments(
      { root },
      {
        id: 1,
        content: "claim",
        warrant: null,
        attachments: ["evidence.bin"],
        evidenceNodes: [],
      }
    );
    const cwd = snapshot.cwd;

    expect(readFileSync(join(cwd, snapshot.readPaths[0]!))).toEqual(bytes);
    expect(existsSync(cwd)).toBe(true);

    snapshot.cleanup();
    expect(existsSync(cwd)).toBe(false);
    expect(() => snapshot.cleanup()).not.toThrow();
  });
});

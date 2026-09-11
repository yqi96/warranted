import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPdfReadCoverageTracker, readPdfPageCount } from "../src/review-pdf-coverage.ts";
import { makePdf } from "./pdf-fixture.ts";
import type { AttachmentRead } from "../src/types.ts";

const folders: string[] = [];
const bytes = makePdf(10);
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "warranted-pdf-coverage-"));
  folders.push(dir);
  const path = join(dir, "snapshot.pdf");
  writeFileSync(path, bytes);
  return path;
}
function parts(path: string, count: number, extra: Record<string, unknown> = {}) {
  return { type: "parts", file: { filePath: path, originalSize: bytes.length, count, outputDir: "/tmp/sdk-pdf-pages", ...extra } };
}
function pdf(path: string, extra: Record<string, unknown> = {}) {
  return { type: "pdf", file: { filePath: path, originalSize: bytes.length, base64: bytes.toString("base64"), ...extra } };
}
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SDK PDF coverage", () => {
  test("valid selected pages are observed even when total page count is unknown", async () => {
    const path = fixture();
    const observed = new Map<string, AttachmentRead>();
    const record = createPdfReadCoverageTracker(async () => null, observed);
    expect(await record(path, { pages: "6-10" }, parts(path, 5))).toBe(false);
    expect(observed.get(path)).toEqual({ path, kind: "pdf", ranges: [[6, 10]], total: null, complete: false });
    await record(path, { pages: "1-5" }, parts(path, 4));
    expect(observed.get(path)?.ranges).toEqual([[6, 10]]);
    await record(path, { pages: "1-5" }, parts(path, 5, { originalSize: bytes.length - 1 }));
    expect(observed.has(path)).toBe(false);
  });

  test("successful page ranges accumulate, overlap and rereads do not replace missing pages", async () => {
    const path = fixture();
    let probes = 0;
    const record = createPdfReadCoverageTracker(async () => { probes++; return 10; });
    expect(await record(path, { pages: "6-10" }, parts(path, 5))).toBe(false);
    expect(await record(path, { pages: "6-10" }, parts(path, 5))).toBe(false);
    expect(await record(path, { pages: "1-4" }, parts(path, 4))).toBe(false);
    expect(await record(path, { pages: "4-6" }, parts(path, 3))).toBe(true);
    expect(probes).toBe(1);
  });

  test("requested pages without successful count never establish coverage", async () => {
    const path = fixture();
    for (const response of [null, {}, { type: "error" }, parts(path, 4), parts(path, 0), parts(path, 5, { truncatedByTokenCap: true }), { ...parts(path, 5), isError: true }]) {
      const record = createPdfReadCoverageTracker(async () => 10);
      expect(await record(path, { pages: "1-5" }, response)).toBe(false);
      expect(await record(path, { pages: "6-10" }, parts(path, 5))).toBe(false);
    }
  });

  test("invalid and out-of-document ranges fail closed", async () => {
    const path = fixture();
    for (const pages of ["0-5", "6-4", "1-11", "1-", "1,2", "1junk", "", 1, "9007199254740992"]) {
      const record = createPdfReadCoverageTracker(async () => 10);
      expect(await record(path, { pages }, parts(path, 10))).toBe(false);
    }
  });

  test("whole rendered PDF needs actual count equal to independently known total", async () => {
    const path = fixture();
    const record = createPdfReadCoverageTracker(async () => 10);
    expect(await record(path, {}, parts(path, 9))).toBe(false);
    expect(await record(path, {}, parts(path, 11))).toBe(false);
    expect(await record(path, {}, parts(path, 10))).toBe(true);
  });

  test("missing, invalid or failed pdfinfo cannot be replaced by an invented totalPages field", async () => {
    const path = fixture();
    for (const count of [null, 0, -1, NaN, 1.5]) {
      const record = createPdfReadCoverageTracker(async () => count);
      expect(await record(path, { pages: "1-10" }, parts(path, 10, { totalPages: 10 }))).toBe(false);
    }
    const record = createPdfReadCoverageTracker(async () => { throw Error("probe failed"); });
    expect(await record(path, {}, parts(path, 10))).toBe(false);
  });

  test("response path mismatch and snapshot size contradiction cannot manufacture coverage", async () => {
    const path = fixture();
    const record = createPdfReadCoverageTracker(async () => 10);
    expect(await record(path, { pages: "1-5" }, parts(path, 5))).toBe(false);
    expect(await record(path, { pages: "6-10" }, parts(path, 5, { filePath: `${path}.other` }))).toBe(false);
    expect(await record(path, { pages: "6-10" }, parts(path, 5, { originalSize: bytes.length - 1 }))).toBe(false);
    expect(await record(path, {}, parts(path, 10))).toBe(false);
  });

  test("whole base64 PDF succeeds without pdfinfo only for the complete actual snapshot", async () => {
    const path = fixture();
    const record = createPdfReadCoverageTracker(async () => { throw Error("must not probe"); });
    expect(await record(path, {}, pdf(path, { base64: "" }))).toBe(false);
    expect(await record(path, {}, pdf(path, { base64: bytes.subarray(0, -1).toString("base64") }))).toBe(false);
    expect(await record(path, { pages: "1-5" }, pdf(path))).toBe(false);
    expect(await record(path, {}, pdf(path))).toBe(true);
  });

  test("missing snapshots and malformed PDF payloads fail closed", async () => {
    const path = fixture();
    const record = createPdfReadCoverageTracker(async () => 10);
    expect(await record(`${path}.missing`, {}, pdf(`${path}.missing`))).toBe(false);
    expect(await record(path, {}, { type: "parts", file: { count: 10 } })).toBe(false);
  });

  test("pdfinfo failure is returned as unknown rather than complete", async () => {
    expect(await readPdfPageCount("/tmp/warranted-pdf-coverage-missing.pdf")).toBeNull();
  });

  test("pdfinfo counts a real two-page snapshot without rendering", async () => {
    const path = fixture();
    const content = makePdf(2);
    writeFileSync(path, content);
    // pdfinfo is optional at runtime; only run the positive integration check
    // when the host has it. Pure coverage checks above do not depend on poppler.
    if (!Bun.which("pdfinfo")) return;
    expect(await readPdfPageCount(path)).toBe(2);
    const record = createPdfReadCoverageTracker();
    const size = Buffer.byteLength(content);
    expect(await record(path, { pages: "1" }, parts(path, 1, { originalSize: size }))).toBe(false);
    expect(await record(path, { pages: "2" }, parts(path, 1, { originalSize: size }))).toBe(true);
  });
});

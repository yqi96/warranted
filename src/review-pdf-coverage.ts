import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

/** Read metadata only; this does not render the PDF or expose it to the model. */
export async function readPdfPageCount(snapshotPath: string): Promise<number | null> {
  return new Promise((done) => {
    execFile("pdfinfo", [resolve(snapshotPath)], {
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    }, (error, stdout) => {
      if (error) return done(null);
      const counts = [...stdout.matchAll(/^Pages:\s+(\d+)\s*$/gm)];
      const pages = counts.length === 1 ? Number(counts[0]![1]) : NaN;
      done(positiveInteger(pages) ? pages : null);
    });
  });
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface Coverage {
  originalSize: number;
  totalPages?: Promise<number | null>;
  intervals: Array<[number, number]>;
  invalid: boolean;
}

/**
 * Track one review's immutable, already-authorized PDF attachments.
 *
 * SDK 0.3.201 Read returns `pdf.file.base64` for a whole document and
 * `parts.file.{filePath,originalSize,count,outputDir}` for rendered pages. It
 * does NOT return totalPages. Its pdftoppm adapter uses the requested -f/-l
 * range; count is the number of successfully generated page images. Therefore
 * a requested range contributes only if that success count matches it exactly,
 * and a separately probed snapshot page count proves the document boundary.
 * Call only from successful PostToolUse, after enforcing the path whitelist.
 */
export function createPdfReadCoverageTracker(
  getPageCount: (path: string) => Promise<number | null> = readPdfPageCount,
): (snapshotPath: string, toolInput: unknown, toolResponse: unknown) => Promise<boolean> {
  const states = new Map<string, Promise<Coverage | null>>();
  return async (snapshotPath, toolInput, toolResponse) => {
    if (!object(toolInput) || !object(toolResponse) ||
        !["pdf", "parts"].includes(String(toolResponse.type)) ||
        !object(toolResponse.file) || toolResponse.isError === true) return false;
    const file = toolResponse.file;
    const path = resolve(snapshotPath);
    if (typeof file.filePath !== "string" || resolve(file.filePath) !== path ||
        file.truncated === true || file.truncatedByTokenCap === true ||
        toolResponse.truncated === true) return false;

    let pending = states.get(path);
    if (!pending) {
      pending = stat(path).then((info) => info.isFile() && info.size > 0
        ? { originalSize: info.size, intervals: [], invalid: false } as Coverage
        : null).catch(() => null);
      states.set(path, pending);
    }
    const coverage = await pending;
    if (!coverage || coverage.invalid) return false;
    // Contradictory metadata cannot reset earlier evidence from the same snapshot.
    if (file.originalSize !== coverage.originalSize) {
      coverage.invalid = true;
      return false;
    }

    if (toolResponse.type === "pdf") {
      if (toolInput.pages !== undefined || typeof file.base64 !== "string") return false;
      // A whole-file response can prove coverage without poppler being installed.
      // Canonical base64 equality also rejects missing/truncated/foreign payloads.
      try {
        const bytes = await readFile(path);
        return bytes.length === coverage.originalSize &&
          bytes.subarray(0, 5).toString("ascii") === "%PDF-" &&
          bytes.toString("base64") === file.base64;
      } catch {
        return false;
      }
    }

    if (!positiveInteger(file.count) || typeof file.outputDir !== "string" || !file.outputDir) return false;
    coverage.totalPages ??= getPageCount(path).catch(() => null);
    const total = await coverage.totalPages;
    if (!positiveInteger(total)) return false;
    let first = 1;
    let last = total;
    if (toolInput.pages !== undefined) {
      // SDK accepts one page or a closed range; open ranges fail its 20-page cap.
      const range = typeof toolInput.pages === "string"
        ? /^(\d+)(?:-(\d+))?$/.exec(toolInput.pages.trim()) : null;
      if (!range) return false;
      first = Number(range[1]);
      last = Number(range[2] ?? range[1]);
      if (!positiveInteger(first) || !positiveInteger(last) || first > last || last > total) return false;
    }
    if (file.count !== last - first + 1) return false;

    const ordered = [...coverage.intervals, [first, last] as [number, number]]
      .sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const [start, end] of ordered) {
      const previous = merged.at(-1);
      if (!previous || start > previous[1] + 1) merged.push([start, end]);
      else previous[1] = Math.max(previous[1], end);
    }
    coverage.intervals = merged;
    return merged.length === 1 && merged[0]![0] === 1 && merged[0]![1] === total;
  };
}

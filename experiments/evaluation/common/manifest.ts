import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  writeJson(temporary, value);
  renameSync(temporary, path);
}

export function writeJsonl(path: string, values: unknown[]): void {
  const body = values.map((value) => JSON.stringify(value)).join("\n");
  writeFileSync(path, body.length > 0 ? `${body}\n` : "", "utf8");
}

export function readJsonl<T>(path: string): T[] {
  const body = readFileSync(path, "utf8").trim();
  if (!body) return [];
  return body.split("\n").map((line, index) => {
    try {
      return JSON.parse(line) as T;
    } catch (error) {
      throw new Error(`Invalid JSONL at ${path}:${index + 1}: ${error}`);
    }
  });
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";

const SCRIPT = join(import.meta.dir, "..", "skills", "overleaf-setup", "scripts", "overleaf-push.py");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options: {
  attachments?: string[];
  bib?: string;
  cite?: string;
  createPdfs?: string[];
  proposition?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), "warranted-overleaf-"));
  roots.push(root);
  const dbDir = join(root, ".toulmin");
  const latexDir = join(root, "review", "manuscript");
  mkdirSync(dbDir, { recursive: true });
  mkdirSync(latexDir, { recursive: true });
  const dbPath = join(dbDir, "graph.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE propositions (id INTEGER PRIMARY KEY);
    CREATE TABLE evidence_attachments (node_id INTEGER NOT NULL, path TEXT NOT NULL);
  `);
  if (options.proposition !== false) db.prepare("INSERT INTO propositions (id) VALUES (1)").run();
  for (const path of options.attachments ?? []) {
    db.prepare("INSERT INTO evidence_attachments (node_id, path) VALUES (1, ?)").run(path);
  }
  db.close();
  for (const path of options.createPdfs ?? []) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, "%PDF-test");
  }
  writeFileSync(join(latexDir, "main.tex"), `Text \\cite{${options.cite ?? "prop_1"}}.`);
  if (options.bib !== undefined) writeFileSync(join(latexDir, "references.bib"), options.bib);
  const stage = join(root, "stage");
  return { root, dbPath, latexDir, stage };
}

function run(f: ReturnType<typeof fixture>) {
  return Bun.spawnSync([
    "python3", SCRIPT,
    "--dir", f.latexDir,
    "--db", f.dbPath,
    "--stage", f.stage,
    "--no-push",
    "--require-prop-cites",
  ]);
}

describe("overleaf proposition citation validation", () => {
  test("multiple paper PDFs expand to multiple bibliography keys", async () => {
    const f = fixture({
      attachments: ["review/papers/alpha.pdf", "review/papers/beta.pdf", "review/notes/alpha.md"],
      createPdfs: ["review/papers/alpha.pdf", "review/papers/beta.pdf"],
      bib: "@article{alpha, title={A}}\n@article{beta, title={B}}\n",
    });
    const result = run(f);
    expect(result.exitCode).toBe(0);
    await expect(Bun.file(join(f.stage, "main.tex")).text()).resolves.toContain("\\cite{alpha, beta}");
  });

  test("a cited proposition with no paper PDF is rejected", () => {
    const f = fixture({ attachments: ["review/notes/alpha.md"], bib: "@article{alpha, title={A}}" });
    const result = run(f);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("only non-PDF attachments");
    expect(result.stderr.toString()).toContain("Attach the original paper PDF");
  });

  test("a PDF stem missing from project bibliography is rejected", () => {
    const f = fixture({
      attachments: ["review/papers/wrong-name.pdf"],
      createPdfs: ["review/papers/wrong-name.pdf"],
      bib: "@article{right_key, title={A}}",
    });
    const result = run(f);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("BibTeX key 'wrong-name'");
    expect(result.stderr.toString()).toContain("absent from the LaTeX project's .bib files");
  });

  test("a missing attached PDF is rejected with its resolved path", () => {
    const f = fixture({
      attachments: ["review/papers/alpha.pdf"],
      bib: "@article{alpha, title={A}}",
    });
    const result = run(f);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("attached paper PDF is missing");
    expect(result.stderr.toString()).toContain("review/papers/alpha.pdf");
  });

  test("a citation to a nonexistent proposition is rejected", () => {
    const f = fixture({ proposition: false, bib: "@article{alpha, title={A}}" });
    const result = run(f);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("proposition #1 does not exist");
  });
});

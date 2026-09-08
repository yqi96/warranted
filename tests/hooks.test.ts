import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const GUARD = join(ROOT, "hooks", "toulmin-guard.sh");
const HOOKS_MANIFEST = join(ROOT, "hooks", "hooks.json");
const SELECTION_HOOK = join(ROOT, "hooks", "viz-selection-context.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("hook compatibility", () => {
  test("retired Toulmin guard is an explicit, side-effect-free no-op", () => {
    const root = scratch("warranted-guard-");
    const result = Bun.spawnSync(["bash", GUARD], {
      cwd: root,
      stdin: new TextEncoder().encode('{"tool_name":"Read"}'),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("");
    expect(existsSync(join(root, ".toulmin"))).toBe(false);

    const source = readFileSync(GUARD, "utf8");
    expect(source).toContain("DEPRECATED");
    expect(source).toContain("side-effect-free");
    expect(source).not.toContain("compile_arguments");

    const manifest = readFileSync(HOOKS_MANIFEST, "utf8");
    expect(manifest).not.toContain("toulmin-guard.sh");
  });

  test("visualizer selection context labels propositions by qualifier", () => {
    const root = scratch("warranted-selection-");
    const fakeBin = join(root, "bin");
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(join(root, ".toulmin"), { recursive: true });

    const fakeCurl = join(fakeBin, "curl");
    writeFileSync(
      fakeCurl,
      `#!/usr/bin/env bash
url="\${!#}"
case "$url" in
  */viz/selection)
    printf '%s' '{"ids":[7],"nodes":[{"id":7,"type":"claim","content":"Evidence supports the result","qualifier":"probably"}]}'
    ;;
  */viz/current-db)
    printf '{"path":"%s"}' "$HOOK_TEST_DB_PATH"
    ;;
  *)
    exit 22
    ;;
esac
`,
    );
    chmodSync(fakeCurl, 0o755);

    const result = Bun.spawnSync(["bash", SELECTION_HOOK], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        HOOK_TEST_DB_PATH: join(root, ".toulmin", "graph.db"),
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const output = JSON.parse(result.stdout.toString());
    const context = output.hookSpecificOutput.additionalContext as string;
    expect(context).toContain("Proposition #7 [PROBABLY]: Evidence supports the result");
    expect(context).not.toContain("[CLAIM]");
    expect(existsSync(join(root, ".toulmin", "operation.log"))).toBe(false);
  });
});

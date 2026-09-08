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
import { join, resolve } from "node:path";
import {
  DEFAULT_TOULMIN_TOOL_ALLOWLIST,
  VITAMINC_AGENT_PROMPT,
  buildVitaminCAgentCommand,
  classifyVitaminCProviderSelection,
  runVitaminCAgent,
} from "./agent-runtime.ts";

const roots: string[] = [];
const PLUGIN_ROOT = resolve(import.meta.dir, "../../..");
const MODEL = "claude-opus-4-6";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix = "vitaminc-runtime-test-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function fakeExecutable(root: string): string {
  const path = join(root, "fake-claude.ts");
  writeFileSync(
    path,
    `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.env.FAKE_MODE ?? "success";
if (process.env.FAKE_INVOCATION_PATH) {
  writeFileSync(process.env.FAKE_INVOCATION_PATH, JSON.stringify({
    cwd: process.cwd(),
    args: process.argv.slice(2),
    inheritedSentinel: process.env.VITAMINC_PARENT_SENTINEL ?? null,
    explicitSentinel: process.env.FAKE_EXPLICIT_SENTINEL ?? null,
  }));
}

if (mode === "timeout") {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  process.exit(0);
}
if (mode === "nonzero") {
  process.stdout.write("not-json\\n");
  process.stderr.write("deliberate failure\\n");
  process.exit(7);
}
if (mode === "invalid") {
  process.stdout.write("not-json\\n");
  process.exit(0);
}
if (mode === "max-turns") {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "stopped" }) + "\\n");
  process.exit(0);
}

writeFileSync(join(process.cwd(), ".toulmin", "graph.db"), "updated-db");
const rows = [
  { type: "system", subtype: "init", model: "claude-opus-4-6", claude_code_version: "test-cli",
    tools: [
      "mcp__toulmin__get_stats",
      "mcp__toulmin__find_propositions",
      "mcp__toulmin__get_argument",
      "mcp__toulmin__get_history",
      "mcp__toulmin__update_proposition",
      "mcp__toulmin__set_qualifier",
      "mcp__toulmin__dismiss"
    ],
    mcp_servers: [{ name: "toulmin", status: "connected" }] },
  { type: "assistant", message: { model: "claude-opus-4-6", usage: { input_tokens: 4, output_tokens: 1 }, content: [
    { type: "tool_use", id: "tool-1", name: "mcp__toulmin__get_stats", input: {} }
  ] } },
  { type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "one warning" }], is_error: false }
  ] } },
  { type: "assistant", message: { model: "claude-opus-4-6", usage: { input_tokens: 6, output_tokens: 3 }, content: [
    { type: "text", text: "最终结论" }
  ] } },
  { type: "result", subtype: "success", is_error: false, result: "最终结论", duration_ms: 321,
    num_turns: 2, total_cost_usd: 0.12,
    usage: { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
    modelUsage: { "claude-opus-4-6": { inputTokens: 10, outputTokens: 4 } }
  }
];
if (mode === "missing-init") rows.shift();
if (mode === "duplicate-init") rows.splice(1, 0, structuredClone(rows[0]));
if (mode === "unexpected-tool-use") {
  rows[1].message.content[0].name = "mcp__toulmin__create_propositions";
}
if (mode === "malformed-tool-use") {
  delete rows[1].message.content[0].name;
}
if (mode === "duplicate-tool-use-id") {
  rows[1].message.content.push({
    type: "tool_use", id: "tool-1", name: "mcp__toulmin__get_argument", input: { id: 1 }
  });
}
if (mode === "missing-tool-result") rows.splice(2, 1);
if (mode === "duplicate-tool-result") rows.splice(3, 0, structuredClone(rows[2]));
if (mode === "tool-result-before-call") [rows[1], rows[2]] = [rows[2], rows[1]];
if (mode === "duplicate-result-event") rows.push(structuredClone(rows.at(-1)));
if (mode === "assistant-after-result") {
  rows.push({ type: "assistant", message: { model: "claude-opus-4-6", content: [
    { type: "text", text: "late text" }
  ] } });
}
if (mode === "tool-after-result") {
  rows.push({ type: "assistant", message: { model: "claude-opus-4-6", content: [
    { type: "tool_use", id: "tool-2", name: "mcp__toulmin__get_argument", input: { id: 1 } }
  ] } });
}
if (mode === "init-not-first") [rows[0], rows[1]] = [rows[1], rows[0]];
if (mode === "tool-use-in-user") rows[1].type = "user";
if (mode === "tool-result-in-assistant") rows[2].type = "assistant";
if (mode === "nonboolean-tool-result-error") rows[2].message.content[0].is_error = "false";
if (mode === "missing-success-is-error") delete rows.at(-1).is_error;
if (mode === "nonboolean-success-is-error") rows.at(-1).is_error = "false";
for (const row of rows) process.stdout.write(JSON.stringify(row) + "\\n");
process.stderr.write("fake diagnostic\\n");
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function fixture(mode = "success") {
  const root = tempRoot();
  const source = join(root, "source-sup-to-ref");
  const artifactDir = join(root, "artifacts");
  const scratchRoot = join(root, "scratch");
  mkdirSync(join(source, ".toulmin"), { recursive: true });
  mkdirSync(scratchRoot, { recursive: true });
  const database = join(source, ".toulmin", "graph.db");
  writeFileSync(database, "seed-db");
  const attachment = join(source, "current.txt");
  writeFileSync(attachment, "current evidence");
  const invocation = join(root, "invocation.json");
  return {
    root,
    source,
    artifactDir,
    scratchRoot,
    database,
    attachment,
    invocation,
    options: {
      preparedDatabasePath: database,
      artifactDir,
      pluginRoot: PLUGIN_ROOT,
      model: MODEL,
      effort: "max" as const,
      maxTurns: 9,
      timeoutMs: 1_000,
      executable: fakeExecutable(root),
      scratchRoot,
      attachments: [{ sourcePath: attachment, relativePath: "evidence/current.txt" }],
      env: { FAKE_MODE: mode, FAKE_INVOCATION_PATH: invocation },
    },
  };
}

describe("buildVitaminCAgentCommand", () => {
  test("builds a strict, non-persistent Toulmin-only invocation", () => {
    const command = buildVitaminCAgentCommand({
      pluginRoot: PLUGIN_ROOT,
      model: MODEL,
      effort: "max",
      maxTurns: 9,
    });
    expect(command[0]).toBe("claude");
    expect(command).toContain(VITAMINC_AGENT_PROMPT);
    expect(command).toContain("--strict-mcp-config");
    expect(command).toContain("--bare");
    expect(command).toContain("--no-session-persistence");
    expect(command).toContain("--no-chrome");
    expect(command).toContain("--disable-slash-commands");
    expect(command).toContain("--verbose");
    expect(command).toContain("stream-json");
    expect(command).toContain("dontAsk");
    const budgetIndex = command.indexOf("--max-budget-usd");
    expect(command[budgetIndex + 1]).toBe("2");
    expect(command).not.toContain("--dangerously-skip-permissions");
    expect(command).not.toContain("--continue");
    expect(command).not.toContain("--resume");

    const toolsIndex = command.indexOf("--tools");
    expect(command[toolsIndex + 1]).toBe("");
    const allowedIndex = command.indexOf("--allowedTools");
    expect(command[allowedIndex + 1]!.split(",").sort()).toEqual(
      DEFAULT_TOULMIN_TOOL_ALLOWLIST.map((tool) => `mcp__toulmin__${tool}`).sort(),
    );

    const configIndex = command.indexOf("--mcp-config");
    const config = JSON.parse(command[configIndex + 1]!) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(Object.keys(config.mcpServers)).toEqual(["toulmin"]);
    expect(config.mcpServers.toulmin!.command).toBe(process.execPath);
    expect(config.mcpServers.toulmin!.args).toEqual([
      join(PLUGIN_ROOT, "experiments/evaluation/vitaminc/mcp-server.ts"),
      "--allow-tools",
      DEFAULT_TOULMIN_TOOL_ALLOWLIST.join(","),
    ]);
    expect(command).toContain("--setting-sources");
  });

  test("rejects a drifting model alias and unsupported effort", () => {
    expect(() =>
      buildVitaminCAgentCommand({ pluginRoot: PLUGIN_ROOT, model: "opus", effort: "max" }),
    ).toThrow("full Claude model id");
    expect(() =>
      buildVitaminCAgentCommand({
        pluginRoot: PLUGIN_ROOT,
        model: MODEL,
        effort: "ultra" as never,
      }),
    ).toThrow("unsupported effort");
    expect(() =>
      buildVitaminCAgentCommand({
        pluginRoot: PLUGIN_ROOT,
        model: MODEL,
        effort: "max",
        toulminToolAllowlist: ["create_propositions"],
      }),
    ).toThrow("unsupported");
    expect(() =>
      buildVitaminCAgentCommand({
        pluginRoot: PLUGIN_ROOT,
        model: MODEL,
        effort: "max",
        maxBudgetUsd: 2.01,
      }),
    ).toThrow("<= 2");
  });
});

describe("classifyVitaminCProviderSelection", () => {
  test("distinguishes Claude Platform on AWS from Amazon Bedrock", () => {
    expect(classifyVitaminCProviderSelection({})).toBe("anthropic-direct");
    expect(classifyVitaminCProviderSelection({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe(
      "bedrock",
    );
    expect(classifyVitaminCProviderSelection({ CLAUDE_CODE_USE_ANTHROPIC_AWS: "1" })).toBe(
      "anthropic-aws",
    );
  });

  test("rejects conflicting or non-canonical provider selectors", () => {
    expect(() =>
      classifyVitaminCProviderSelection({
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
      }),
    ).toThrow("mutually exclusive");
    expect(() =>
      classifyVitaminCProviderSelection({ CLAUDE_CODE_USE_VERTEX: "true" }),
    ).toThrow("must be exactly 1");
  });
});

describe("runVitaminCAgent", () => {
  test("runs a fake CLI in an anonymous scratch and archives a complete trace", async () => {
    const f = fixture();
    const result = await runVitaminCAgent(f.options);
    expect(result.status).toBe("success");
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.answer).toBe("最终结论");
    expect(result.actualModel).toBe(MODEL);
    expect(result.claudeCodeVersion).toBe("test-cli");
    expect(result.actualTools.sort()).toEqual(
      DEFAULT_TOULMIN_TOOL_ALLOWLIST.map((tool) => `mcp__toulmin__${tool}`).sort(),
    );
    expect(result.actualMcpServers).toEqual([{ name: "toulmin", status: "connected" }]);
    expect(result.provider).toBe("anthropic-direct");
    expect(result.reportedDurationMs).toBe(321);
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 3,
      totalCostUsd: 0.12,
      numTurns: 2,
    });
    expect(result.rawReportedUsage).toEqual({
      totalCostUsd: { present: true, value: 0.12 },
      numTurns: { present: true, value: 2 },
    });
    expect(result.toolTrace).toHaveLength(2);
    expect(result.toolTrace[0]).toMatchObject({
      kind: "call",
      toolName: "mcp__toulmin__get_stats",
      toolUseId: "tool-1",
    });
    expect(result.toolTrace[1]).toMatchObject({
      kind: "result",
      toolName: "mcp__toulmin__get_stats",
      toolUseId: "tool-1",
      isError: false,
    });
    expect(readFileSync(result.artifacts.databasePath, "utf8")).toBe("updated-db");
    expect(readFileSync(result.artifacts.stderrPath, "utf8")).toContain("fake diagnostic");
    expect(readFileSync(result.artifacts.answerPath, "utf8")).toBe("最终结论\n");
    expect(readFileSync(result.artifacts.toolTracePath, "utf8")).toContain("mcp__toulmin__get_stats");

    const invocation = JSON.parse(readFileSync(f.invocation, "utf8")) as {
      cwd: string;
      args: string[];
    };
    expect(invocation.cwd.startsWith(f.scratchRoot)).toBe(true);
    expect(invocation.cwd.split("/").at(-1)).toMatch(/^case-/);
    expect(invocation.cwd).not.toContain("sup-to-ref");
    const pluginIndex = invocation.args.indexOf("--plugin-dir");
    expect(invocation.args[pluginIndex + 1]).toContain(".agent-plugin");
    expect(existsSync(invocation.cwd)).toBe(false);
    expect(invocation.args).not.toContain("--dangerously-skip-permissions");
  });

  test("classifies nonzero exit before malformed stdout", async () => {
    const f = fixture("nonzero");
    const result = await runVitaminCAgent(f.options);
    expect(result.status).toBe("nonzero_exit");
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
    expect(readFileSync(result.artifacts.databasePath, "utf8")).toBe("seed-db");
  });

  test("filters ambient environment while preserving explicit child overrides", async () => {
    const f = fixture();
    const previous = process.env.VITAMINC_PARENT_SENTINEL;
    process.env.VITAMINC_PARENT_SENTINEL = "ambient-secret-must-not-leak";
    try {
      const result = await runVitaminCAgent({
        ...f.options,
        env: {
          ...f.options.env,
          FAKE_EXPLICIT_SENTINEL: "explicit-visible-to-child",
        },
      });
      expect(result.status).toBe("success");

      const invocation = JSON.parse(readFileSync(f.invocation, "utf8")) as {
        inheritedSentinel: string | null;
        explicitSentinel: string | null;
      };
      expect(invocation.inheritedSentinel).toBeNull();
      expect(invocation.explicitSentinel).toBe("explicit-visible-to-child");

      const processText = readFileSync(result.artifacts.processPath, "utf8");
      const processRecord = JSON.parse(processText) as { environmentKeys: string[] };
      expect(processRecord.environmentKeys).toContain("FAKE_EXPLICIT_SENTINEL");
      expect(processRecord.environmentKeys).not.toContain("VITAMINC_PARENT_SENTINEL");
      expect(processText).not.toContain("ambient-secret-must-not-leak");
      expect(processText).not.toContain("explicit-visible-to-child");
    } finally {
      if (previous === undefined) delete process.env.VITAMINC_PARENT_SENTINEL;
      else process.env.VITAMINC_PARENT_SENTINEL = previous;
    }
  });

  test("classifies malformed zero-exit stream as invalid output", async () => {
    const f = fixture("invalid");
    const result = await runVitaminCAgent(f.options);
    expect(result.status).toBe("invalid_output");
    expect(result.exitCode).toBe(0);
    expect(result.failureDetail).toContain("non-JSON");
  });

  for (const [mode, expectedDetail] of [
    ["missing-init", "exactly one system/init event; found 0"],
    ["duplicate-init", "exactly one system/init event; found 2"],
    ["unexpected-tool-use", "unexpected tool_use name"],
    ["malformed-tool-use", "malformed tool_use"],
    ["duplicate-tool-use-id", "duplicate tool_use id"],
    ["missing-tool-result", "no matching tool_result"],
    ["duplicate-tool-result", "multiple tool_result"],
    ["tool-result-before-call", "precedes or has no matching tool_use"],
    ["duplicate-result-event", "exactly one top-level result event; found 2"],
    ["assistant-after-result", "result must be the final non-empty stream event"],
    ["tool-after-result", "result must be the final non-empty stream event"],
    ["init-not-first", "system/init must be the first non-empty stream event"],
    ["tool-use-in-user", "tool_use appeared in user event"],
    ["tool-result-in-assistant", "tool_result appeared in assistant event"],
    ["nonboolean-tool-result-error", "tool_result has non-boolean is_error"],
    ["missing-success-is-error", "success result must contain is_error=false"],
    ["nonboolean-success-is-error", "success result must contain is_error=false"],
  ] as const) {
    test(`rejects success stream contract violation: ${mode}`, async () => {
      const f = fixture(mode);
      const result = await runVitaminCAgent(f.options);
      expect(result.status).toBe("invalid_output");
      expect(result.ok).toBe(false);
      expect(result.failureDetail).toContain(expectedDetail);
    });
  }

  test("rejects conflicting provider selectors before starting the executable", async () => {
    const f = fixture();
    await expect(
      runVitaminCAgent({
        ...f.options,
        env: {
          ...f.options.env,
          CLAUDE_CODE_USE_BEDROCK: "1",
          CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
          CLAUDE_CODE_USE_VERTEX: undefined,
          CLAUDE_CODE_USE_FOUNDRY: undefined,
        },
      }),
    ).rejects.toThrow("mutually exclusive");
    expect(existsSync(f.invocation)).toBe(false);
  });

  test("classifies timeout independently of process exit", async () => {
    const f = fixture("timeout");
    const result = await runVitaminCAgent({ ...f.options, timeoutMs: 30 });
    expect(result.status).toBe("timeout");
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(2_000);
  });

  test("recognizes a valid max-turns result", async () => {
    const f = fixture("max-turns");
    const result = await runVitaminCAgent(f.options);
    expect(result.status).toBe("max_turns");
    expect(result.resultSubtype).toBe("error_max_turns");
  });

  test("reports a missing executable as spawn failure and preserves the seed DB", async () => {
    const f = fixture();
    const result = await runVitaminCAgent({
      ...f.options,
      executable: join(f.root, "does-not-exist"),
      env: {},
    });
    expect(result.status).toBe("spawn_failure");
    expect(result.exitCode).toBeNull();
    expect(readFileSync(result.artifacts.databasePath, "utf8")).toBe("seed-db");
  });

  test("recovers the complete scratch when artifact archival fails", async () => {
    const f = fixture();
    mkdirSync(join(f.artifactDir, ".toulmin", "graph.db"), { recursive: true });

    const result = await runVitaminCAgent(f.options);

    expect(result.status).toBe("artifact_failure");
    expect(result.ok).toBe(false);
    expect(result.failureDetail).toContain("artifact archival failed");
    expect(result.recovery).not.toBeNull();
    expect(result.recovery!.mode).toBe("moved");
    expect(result.recovery!.directory.startsWith(join(f.artifactDir, "recovery"))).toBe(true);
    expect(readFileSync(join(result.recovery!.directory, ".toulmin", "graph.db"), "utf8")).toBe(
      "updated-db",
    );
    expect(readFileSync(join(result.recovery!.directory, "evidence", "current.txt"), "utf8")).toBe(
      "current evidence",
    );
    expect(existsSync(join(result.recovery!.directory, ".vitaminc-recovery.json"))).toBe(true);

    const invocation = JSON.parse(readFileSync(f.invocation, "utf8")) as { cwd: string };
    expect(existsSync(invocation.cwd)).toBe(false);
    const processRecord = JSON.parse(readFileSync(result.artifacts.processPath, "utf8")) as {
      status: string;
      recovery: { directory: string };
    };
    expect(processRecord.status).toBe("artifact_failure");
    expect(processRecord.recovery.directory).toBe(result.recovery!.directory);
  });

  test("rejects a per-case budget above the production hard cap before spawning", async () => {
    const f = fixture();
    await expect(
      runVitaminCAgent({
        ...f.options,
        maxBudgetUsd: 2.01,
      }),
    ).rejects.toThrow("<= 2");
    expect(existsSync(f.invocation)).toBe(false);
  });

  test("rejects an unsealed prepared database before starting the executable", async () => {
    const f = fixture();
    writeFileSync(`${f.database}-wal`, "unmanifested state");
    await expect(runVitaminCAgent(f.options)).rejects.toThrow(
      "sealed without SQLite sidecars",
    );
    expect(existsSync(f.invocation)).toBe(false);
  });
});

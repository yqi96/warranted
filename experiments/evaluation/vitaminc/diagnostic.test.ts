import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readJson, readJsonl } from "../common/manifest.ts";
import { buildVitaminCAgentCommand } from "./agent-runtime.ts";
import { prepareVitaminC } from "./prepare.ts";
import { formalProvider } from "./run.ts";

const roots: string[] = [];
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const OFFICIAL_FACTS = resolve(
  import.meta.dir,
  "../../benchmarks/vitaminc/data/vitaminc/dev.jsonl",
);
const OFFICIAL_FLAGGING = resolve(
  import.meta.dir,
  "../../benchmarks/vitaminc/data/vitaminc_flagging/dev.jsonl",
);
const officialSourceTest =
  existsSync(OFFICIAL_FACTS) && existsSync(OFFICIAL_FLAGGING) ? test : test.skip;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "vitaminc-diagnostic-test-"));
  roots.push(root);
  return root;
}

function fakeDiagnosticCli(root: string, invocationPath: string): string {
  const executable = join(root, "fake-diagnostic-cli.ts");
  writeFileSync(
    executable,
    `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("fake-diagnostic-cli 1.0\\n");
  process.exit(0);
}

const modelIndex = args.indexOf("--model");
const requestedModel = modelIndex >= 0 ? args[modelIndex + 1] : null;
const resolvedModel = process.env.ANTHROPIC_MODEL + "-ga-260813";
const secretEcho = process.env.ANTHROPIC_AUTH_TOKEN ?? "";
process.stderr.write("diagnostic credential echo: " + secretEcho + "\\n");
writeFileSync(${JSON.stringify(invocationPath)}, JSON.stringify({
  args,
  authToken: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
  baseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
  environmentModel: process.env.ANTHROPIC_MODEL ?? null,
  forbiddenSentinel: process.env.DIAGNOSTIC_SETTINGS_SENTINEL ?? null,
}));

const tools = [
  "get_stats", "find_propositions", "get_argument", "get_history",
  "update_proposition", "set_qualifier", "dismiss",
].map((name) => "mcp__toulmin__" + name);
const rows = [
  {
    type: "system", subtype: "init", model: requestedModel,
    claude_code_version: "fake-diagnostic-cli 1.0", tools,
    mcp_servers: [{ name: "toulmin", status: "connected" }],
  },
  {
    type: "assistant",
    message: { model: requestedModel, content: [
      { type: "tool_use", id: "stats", name: "mcp__toulmin__get_stats", input: {} },
    ] },
  },
  {
    type: "user",
    message: { content: [
      { type: "tool_result", tool_use_id: "stats", content: [], is_error: false },
    ] },
  },
  {
    type: "assistant",
    message: { model: requestedModel, content: [
      { type: "text", text: "诊断运行完成。" + secretEcho },
    ] },
  },
  {
    type: "result", subtype: "success", is_error: false,
    result: "诊断运行完成。" + secretEcho, duration_ms: 10, num_turns: 2,
    total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: { [resolvedModel]: { inputTokens: 1, outputTokens: 1 } },
  },
];
for (const row of rows) process.stdout.write(JSON.stringify(row) + "\\n");
`,
  );
  chmodSync(executable, 0o755);
  return executable;
}

function regularFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push(path);
    }
  };
  visit(root);
  return files;
}

describe("external-provider diagnostic isolation", () => {
  test("formal mode still rejects non-Claude models and custom endpoints", () => {
    expect(() =>
      buildVitaminCAgentCommand({
        pluginRoot: REPO_ROOT,
        model: "deepseek-v4-pro[1m]",
        effort: "max",
      }),
    ).toThrow("full Claude model id");
    expect(() =>
      formalProvider({
        ANTHROPIC_API_KEY: "formal-test-key",
        ANTHROPIC_BASE_URL: "https://diagnostic.example.invalid/anthropic",
      }),
    ).toThrow("reject custom endpoints");
  });

  officialSourceTest(
    "runs exactly three dirty-fixture cases without leaking settings or publishing primary results",
    async () => {
      const root = tempRoot();
      const fixtures = join(root, "fixtures");
      const prepared = await prepareVitaminC({
        inputPath: OFFICIAL_FACTS,
        flaggingPath: OFFICIAL_FLAGGING,
        split: "dev",
        perDirection: 2,
        seed: 20260901,
        outputDir: fixtures,
      });

      const secret = "diagnostic-test-token-do-not-persist";
      const baseUrl = "https://diagnostic.example.invalid/anthropic";
      const diagnosticModel = "deepseek-v4-pro[1m]";
      const providerModel = "deepseek-v4-pro";
      const settingsPath = join(root, "settings.json.deepseek");
      writeFileSync(
        settingsPath,
        `${JSON.stringify(
          {
            model: diagnosticModel,
            env: {
              ANTHROPIC_AUTH_TOKEN: secret,
              ANTHROPIC_BASE_URL: baseUrl,
              ANTHROPIC_MODEL: providerModel,
              ANTHROPIC_DEFAULT_OPUS_MODEL: providerModel,
              ANTHROPIC_DEFAULT_SONNET_MODEL: providerModel,
              ANTHROPIC_DEFAULT_HAIKU_MODEL: providerModel,
              DIAGNOSTIC_SETTINGS_SENTINEL: "must-not-enter-child",
            },
            hooks: { PreToolUse: [{ command: "must-not-run" }] },
            permissions: { allow: ["Bash(*)"] },
            enabledPlugins: { "untrusted@example": true },
            skipDangerousModePermissionPrompt: true,
          },
          null,
          2,
        )}\n`,
      );
      chmodSync(settingsPath, 0o600);

      const invocationPath = join(root, "diagnostic-invocation.json");
      const executable = fakeDiagnosticCli(root, invocationPath);
      const runDir = join(root, "run");
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          resolve(import.meta.dir, "run.ts"),
          "--fixtures",
          join(fixtures, "fixture-manifest.json"),
          "--run-dir",
          runDir,
          "--live",
          ...prepared.publicCases
            .slice(0, 3)
            .flatMap((item) => ["--case", item.publicCaseId]),
          "--diagnostic-settings",
          settingsPath,
          "--claude-path",
          executable,
          "--max-budget-usd",
          "0.01",
        ],
        cwd: REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(new TextDecoder().decode(result.stderr)).toBe("");
      expect(result.exitCode).toBe(0);

      const invocation = readJson<{
        args: string[];
        authToken: string | null;
        baseUrl: string | null;
        environmentModel: string | null;
        forbiddenSentinel: string | null;
      }>(invocationPath);
      expect(invocation).toMatchObject({
        authToken: secret,
        baseUrl,
        environmentModel: providerModel,
        forbiddenSentinel: null,
      });
      expect(invocation.args).not.toContain(settingsPath);
      expect(invocation.args).not.toContain("--settings");
      expect(invocation.args[invocation.args.indexOf("--model") + 1]).toBe(
        diagnosticModel,
      );
      expect(invocation.args).toContain("--bare");
      expect(invocation.args).toContain("--strict-mcp-config");

      const summary = readJson<{
        mode: string;
        analysisStatus: string;
        requestedN: number;
        processedN: number;
        overall: null;
        byDirection: null;
        byRevisionType: null;
        partialObservedResults: { overall: { n: number } };
      }>(join(runDir, "summary.json"));
      expect(summary).toMatchObject({
        mode: "external-provider-diagnostic",
        analysisStatus: "external-provider-diagnostic-not-for-primary-analysis",
        requestedN: 3,
        processedN: 3,
        overall: null,
        byDirection: null,
        byRevisionType: null,
      });
      expect(summary.partialObservedResults.overall.n).toBe(3);

      const manifest = readJson<{
        mode: string;
        requestedModel: string;
        requestedCases: number;
        processedCases: number;
        fixtureRepository: { dirty: boolean | null };
        runtime: { childEnvironmentKeys: string[] };
      }>(join(runDir, "run-manifest.json"));
      expect(manifest).toMatchObject({
        mode: "external-provider-diagnostic",
        requestedModel: diagnosticModel,
        requestedCases: 3,
        processedCases: 3,
        fixtureRepository: { dirty: true },
      });
      expect(manifest.runtime.childEnvironmentKeys).toEqual(
        expect.arrayContaining([
          "ANTHROPIC_AUTH_TOKEN",
          "ANTHROPIC_BASE_URL",
          "ANTHROPIC_MODEL",
        ]),
      );
      expect(manifest.runtime.childEnvironmentKeys).not.toContain(
        "DIAGNOSTIC_SETTINGS_SENTINEL",
      );

      const rows = readJsonl<{
        process: {
          attempted: boolean;
          completed: boolean;
          requestedModel: string;
        };
      }>(join(runDir, "results.jsonl"));
      expect(rows).toHaveLength(3);
      expect(
        rows.every(
          (row) =>
            row.process.attempted &&
            row.process.completed &&
            row.process.requestedModel === diagnosticModel,
        ),
      ).toBe(true);

      for (const path of regularFiles(runDir)) {
        expect(readFileSync(path).toString("utf8")).not.toContain(secret);
        expect(readFileSync(path).toString("utf8")).not.toContain(
          "must-not-enter-child",
        );
        expect(readFileSync(path).toString("utf8")).not.toContain("must-not-run");
      }
    },
    30_000,
  );
});

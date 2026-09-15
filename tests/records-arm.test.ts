import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { makeTempRoot, createTestDb } from "./helpers.ts";
import { registerTools } from "../src/records-tools.ts";
import * as repo from "../src/repo.ts";

const forbiddenKeys = new Set(["warnings", "findings", "review", "reviewDecision", "reviewCoverage", "reviewDecisions", "unresolvedWarnings", "unresolvedFindings", "notices", "missing"]);
function assertPlain(value: unknown) {
  if (Array.isArray(value)) return value.forEach(assertPlain);
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    expect(forbiddenKeys.has(key)).toBe(false);
    assertPlain(child);
  }
}

test("installed records entry preserves edits and history without providing feedback", async () => {
  const root = makeTempRoot(); const dbPath = join(root.root, ".toulmin/graph.db");
  const client = new Client({ name: "records-arm-test", version: "0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "../src/index.ts"), "--db-path", dbPath, "--no-persist"], stderr: "pipe" });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    expect(tools.map(t => t.name).sort()).toEqual(["create_propositions", "update_proposition", "set_qualifier", "promote_warrant", "delete_proposition", "get_argument", "find_propositions", "get_stats", "get_history"].sort());
    // Check the actual advertised schemas, not just source-string replacements.
    expect(JSON.stringify(tools)).not.toMatch(/review|dismiss|warning|finding|has_unresolved|structural check|re-check/i);
    for (const name of ["review", "dismiss"]) {
      let denied = false;
      try { denied = (await client.callTool({ name, arguments: {} })).isError === true; } catch { denied = true; }
      expect(denied).toBe(true);
    }
    async function call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      const text = (result.content as any)[0].text as string;
      expect(text.startsWith("{")).toBe(true);
      const payload = JSON.parse(text); assertPlain(payload); return payload;
    }
    root.file("measurement.txt", "Observed mean: 5");
    const p = (await call("create_propositions", { items: [{ content: "Observed mean is 5", evidence: { attachments: ["measurement.txt"] } }] })).created[0].id;
    const c = (await call("create_propositions", { items: [{ content: "Mean exceeds 4", warrant: "5 exceeds 4", evidence: { nodes: [p] } }] })).created[0].id;
    await call("set_qualifier", { updates: [{ id: c, qualifier: "probably" }, { id: p, qualifier: "certainly" }] });
    // This exact change produces R2 in the full arm; records only stores it.
    await call("update_proposition", { id: p, content: "Observed mean is 3", note: "Corrected the measurement" });
    root.file("measurement.txt", "Observed mean: 3");
    root.unlink("measurement.txt");
    const argument = await call("get_argument", { id: c });
    expect(argument.root.qualifier).toBe("probably");
    expect(argument.neighbors[0].content).toBe("Observed mean is 3");
    await call("set_qualifier", { updates: [{ id: p, qualifier: "possibly" }] });
    expect((await call("get_stats")).attachments).toEqual({ total: 1 });
    expect((await call("find_propositions", { query: "Observed" })).total).toBe(1);
    expect((await call("get_history", { id: p })).events.some((e: any) => e.note === "Corrected the measurement")).toBe(true);
    const promoted = await call("promote_warrant", { id: c });
    expect((await call("get_argument", { id: c, depth: 0 })).root.warrant.node_id).toBe(promoted.newId);
    await call("delete_proposition", { id: p });
    expect((await call("get_argument", { id: c, depth: 0 })).root.evidence.nodes).toEqual([]);
    expect((await call("get_history", { id: p })).events.some((e: any) => e.op === "delete")).toBe(true);
    // Data integrity remains enforced and failed batches roll back atomically.
    const count = (await call("get_stats")).total;
    for (const items of [[{ content: "" }], [{ content: "Valid first item" }, { content: "Invalid reference", evidence: { nodes: [999999] } }], [{ content: "Missing file", evidence: { attachments: ["absent.txt"] } }]]) {
      expect((await client.callTool({ name: "create_propositions", arguments: { items } })).isError).toBe(true);
      expect((await call("get_stats")).total).toBe(count);
    }
    const db = new Database(dbPath, { readonly: true });
    try {
      for (const table of ["findings", "baseline_head", "baseline_refs", "baseline_attachments"]) {
        expect((db.query(`SELECT count(*) AS n FROM ${table}`).get() as any).n).toBe(0);
      }
      expect((db.query("SELECT count(*) AS n FROM events WHERE op IN ('review', 'dismiss')").get() as any).n).toBe(0);
    } finally { db.close(); }
  } finally { await client.close(); await transport.close(); root.cleanup(); }
});

test("records refuses a database containing another treatment's review events", () => {
  const db = createTestDb();
  const server = new McpServer({ name: "records-test", version: "0" });
  try {
    repo.appendEvent(db, { nodeId: null, op: "review", actor: "tool", payload: {} });
    expect(() => registerTools(server, db, ":memory:")).toThrow("another treatment");
  } finally { db.close(); }
});

test("records prompt and visualizer use the record-only paths", () => {
  const root = join(import.meta.dir, "..");
  const prompt = readFileSync(join(root, "agents/toulmin-researcher.md"), "utf8");
  expect(prompt).not.toMatch(/\breview\b|dismiss|automatic|warning|finding\(s\)|reviewCoverage|reviewDecisions/i);
  const server = readFileSync(join(root, "visualizer/server.ts"), "utf8");
  expect(server).toContain('"../src/records.ts"');
  expect(server).not.toMatch(/computeWarningsFor|findingViews|reviewDecision/);
  expect(readFileSync(join(root, "visualizer/js/phase.js"), "utf8")).not.toContain("没有待处理项");
});

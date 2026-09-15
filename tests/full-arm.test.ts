import { expect, test } from "bun:test";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../src/tools.ts";
import { createTestDb, makeTempRoot } from "./helpers.ts";
test("full arm retains all eleven tools and dependency-change feedback", async () => {
  const db = createTestDb(); const root = makeTempRoot();
  const server = new McpServer({ name: "full-arm", version: "0" });
  const client = new Client({ name: "test", version: "0" });
  registerTools(server, db, join(root.root, ".toulmin/graph.db"), null);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toHaveLength(11); expect(names).toContain("review"); expect(names).toContain("dismiss");
    async function call(name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args }); expect(result.isError).not.toBe(true);
      const text = (result.content as any)[0].text as string;
      return JSON.parse(text.slice(text.indexOf("{")));
    }
    const p = (await call("create_propositions", { items: [{ content: "Observed mean is 5" }] })).created[0].id;
    const c = (await call("create_propositions", { items: [{ content: "Mean exceeds 4", warrant: "5 exceeds 4", evidence: { nodes: [p] } }] })).created[0].id;
    await call("set_qualifier", { updates: [{ id: c, qualifier: "probably" }] });
    await call("update_proposition", { id: p, content: "Observed mean is 3" });
    const result = await call("get_argument", { id: c, depth: 0 });
    expect(result.root.warnings.some((w: any) => w.code === "R2")).toBe(true);
  } finally { await client.close(); await server.close(); db.close(); root.cleanup(); }
});

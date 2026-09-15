import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const root = join(import.meta.dir, "..");
test("guidance installs only the methodology prompt, without MCP or hooks", () => {
  expect(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"))).toEqual({ mcpServers: {} });
  expect(JSON.parse(readFileSync(join(root, "hooks/hooks.json"), "utf8"))).toEqual({ hooks: {} });
  expect(readdirSync(join(root, "hooks"))).toEqual(["hooks.json"]);
  const prompt = readFileSync(join(root, "agents/toulmin-researcher.md"), "utf8");
  expect(prompt.replace(/^---[\s\S]*?---/, "")).not.toMatch(/Warranted|Toulmin|graph|reviewer|dismiss|structural check|skill|MCP|set_qualifier|get_stats/);
  expect(prompt).toContain("## Experiment Validity");
  expect(prompt).toContain("## Check the Deliverable Against the Work");
});

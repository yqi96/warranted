import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const root = join(import.meta.dir, "..");
test("paper arms ship only the primary agent and no custom skills or browser", () => {
  expect(readdirSync(join(root, "agents"))).toEqual(["toulmin-researcher.md"]);
  expect(existsSync(join(root, "skills"))).toBe(false);
  expect(existsSync(join(root, "src/browser"))).toBe(false);
  expect(existsSync(join(root, "bin/start-browser.sh"))).toBe(false);
  const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  expect(Object.keys(mcp.mcpServers)).not.toContain("browser");
  const agent = readFileSync(join(root, "agents/toulmin-researcher.md"), "utf8");
  expect(agent).not.toMatch(/^model:/m);
});

test("methodology prefix matches the frozen shared guidance hash", () => {
  const agent = readFileSync(join(root, "agents/toulmin-researcher.md"), "utf8");
  const prefix = agent.split("\n## Structured Research Records")[0]!.trimEnd() + "\n";
  const manifest = JSON.parse(readFileSync(join(root, "experiment.json"), "utf8"));
  expect(new Bun.CryptoHasher("sha256").update(prefix).digest("hex")).toBe(manifest.guidance_sha256);
});

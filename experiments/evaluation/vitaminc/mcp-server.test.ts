import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../../src/db.ts";
import { registerTools } from "../../../src/tools.ts";
import {
  SAFE_VITAMINC_TOOLS,
  filteredRegistrationServer,
} from "./mcp-server.ts";
import { DEFAULT_TOULMIN_TOOL_ALLOWLIST } from "./agent-runtime.ts";

describe("VitaminC MCP surface", () => {
  test("registers only the benchmark allowlist at the server layer", () => {
    const root = mkdtempSync(join(tmpdir(), "vitaminc-mcp-test-"));
    const dbPath = join(root, ".toulmin", "graph.db");
    mkdirSync(join(root, ".toulmin"), { recursive: true });
    const db = openDatabase(dbPath);
    try {
      const names: string[] = [];
      const fake = {
        registerTool(name: string) {
          names.push(name);
        },
      } as unknown as McpServer;
      registerTools(
        filteredRegistrationServer(fake, new Set(SAFE_VITAMINC_TOOLS)),
        db,
        dbPath,
        null,
      );
      expect([...SAFE_VITAMINC_TOOLS].sort()).toEqual(
        [...DEFAULT_TOULMIN_TOOL_ALLOWLIST].sort(),
      );
      expect(names.sort()).toEqual([...SAFE_VITAMINC_TOOLS].sort());
      expect(names).not.toContain("review");
      expect(names).not.toContain("delete_proposition");
      expect(names).not.toContain("create_propositions");
      expect(names).not.toContain("promote_warrant");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

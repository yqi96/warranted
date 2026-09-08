#!/usr/bin/env bun

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { DEFAULT_DB_PATH, openDatabase } from "../../../src/db.ts";
import { registerTools, type Lifecycle } from "../../../src/tools.ts";

export const SAFE_VITAMINC_TOOLS = new Set([
  "get_stats",
  "find_propositions",
  "get_argument",
  "get_history",
  "update_proposition",
  "set_qualifier",
  "dismiss",
]);

function requestedTools(): Set<string> {
  const args = process.argv.slice(2);
  const index = args.indexOf("--allow-tools");
  if (index < 0 || !args[index + 1]) throw new Error("--allow-tools is required");
  const requested = new Set(args[index + 1]!.split(",").filter(Boolean));
  if (requested.size === 0) throw new Error("--allow-tools must not be empty");
  for (const name of requested) {
    if (!SAFE_VITAMINC_TOOLS.has(name)) throw new Error(`unsafe or unknown benchmark tool: ${name}`);
  }
  return requested;
}

export function filteredRegistrationServer(
  server: McpServer,
  allowlist: Set<string>,
): McpServer {
  const original = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property === "registerTool") {
        return (name: string, ...args: unknown[]) =>
          allowlist.has(name) ? original(name, ...args) : undefined;
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

async function main(): Promise<void> {
  const allowlist = requestedTools();
  const dbPath = DEFAULT_DB_PATH;
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  const server = new McpServer({ name: "warranted-vitamin-c", version: "2" });
  const registrationServer = filteredRegistrationServer(server, allowlist);

  let pending = 0;
  let drainResolve: (() => void) | null = null;
  const lifecycle: Lifecycle = {
    beginOp() {
      pending += 1;
    },
    endOp() {
      pending -= 1;
      if (pending === 0 && drainResolve) {
        const resolve = drainResolve;
        drainResolve = null;
        resolve();
      }
    },
    drain() {
      if (pending === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        drainResolve = resolve;
      });
    },
  };

  // The shared registration code still defines all product tools, but this
  // proxy only registers the fixed benchmark surface with the MCP SDK. Denied
  // tools therefore are not advertised to the model at all.
  registerTools(registrationServer, db, dbPath, null, lifecycle);
  await server.connect(new StdioServerTransport());

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await server.close();
    await lifecycle.drain();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

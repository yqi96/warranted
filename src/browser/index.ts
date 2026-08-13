#!/usr/bin/env bun
/**
 * Warranted Browser MCP Server
 *
 * A thin proxy in front of chrome-devtools-mcp. All actual browser
 * automation (navigate, click, screenshot, snapshot, network, performance,
 * ...) is delegated to chrome-devtools-mcp — this file only adds what it
 * doesn't have: on-demand, process-isolated sessions.
 *
 * Each browser_open() spawns a dedicated chrome-devtools-mcp child process
 * with no --browserUrl/--wsEndpoint, so chrome-devtools-mcp launches and
 * owns its own --isolated Chrome for that session. browser_close() closes
 * that child's stdio transport, which chrome-devtools-mcp treats as a
 * shutdown signal and cleans up its browser + temp profile itself.
 *
 * chrome-devtools-mcp is a pinned `dependencies` entry (see package.json),
 * installed by `bun install` like everything else — we exec its build output
 * directly with `node` instead of `npx`, so there's no runtime network
 * dependency and the version is locked by the lockfile, not just a comment.
 *
 * Usage:
 *   bun src/browser/index.ts
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// =============================================================================
// Config
// =============================================================================

// Resolve the installed chrome-devtools-mcp's own bin entry rather than
// hardcoding a node_modules path — bun install lays out node_modules however
// it wants, but "chrome-devtools-mcp/package.json" always resolves to the
// package we depend on.
const UPSTREAM_PKG_PATH = fileURLToPath(import.meta.resolve("chrome-devtools-mcp/package.json"));
const UPSTREAM_PKG = JSON.parse(readFileSync(UPSTREAM_PKG_PATH, "utf-8")) as {
  version: string;
  bin: Record<string, string>;
};
const UPSTREAM_BIN = join(dirname(UPSTREAM_PKG_PATH), UPSTREAM_PKG.bin["chrome-devtools-mcp"]!);
const UPSTREAM_VERSION = UPSTREAM_PKG.version;

const SESSION_FLAGS = ["--isolated", "--experimentalStructuredContent"];
const PROBE_FLAGS = ["--isolated", "--headless=true", "--experimentalStructuredContent"];

// =============================================================================
// Session state
// =============================================================================

interface SessionState {
  client: Client;
}

const sessions = new Map<string, SessionState>();

function spawnUpstreamTransport(extraArgs: string[]): StdioClientTransport {
  return new StdioClientTransport({
    command: "node",
    args: [UPSTREAM_BIN, ...extraArgs],
    stderr: "pipe",
  });
}

async function createUpstreamClient(extraArgs: string[]): Promise<Client> {
  const transport = spawnUpstreamTransport(extraArgs);
  const client = new Client({ name: "warranted-browser-proxy", version: "1.0.0" }, {});
  await client.connect(transport);

  const { tools } = await client.listTools();
  if (!tools.some((t) => t.name === "list_pages")) {
    await client.close();
    throw new Error("chrome-devtools-mcp did not expose expected tools (list_pages missing).");
  }

  return client;
}

async function openSession(sessionId: string): Promise<void> {
  if (sessions.has(sessionId)) return;

  const client = await createUpstreamClient(SESSION_FLAGS);
  client.onclose = () => {
    sessions.delete(sessionId);
  };
  client.onerror = () => {
    sessions.delete(sessionId);
  };
  sessions.set(sessionId, { client });
}

async function closeSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  await session.client.close().catch(() => {});
}

async function closeAllSessions(): Promise<void> {
  for (const sessionId of [...sessions.keys()]) {
    await closeSession(sessionId);
  }
}

// =============================================================================
// chrome-devtools-mcp schema probing
// =============================================================================

const BROWSER_OPEN_TOOL = {
  name: "browser_open",
  description:
    "Launch an isolated Chrome instance for browser automation. " +
    "Must be called before using any other browser tools. " +
    "Returns a session_id — pass it as _browser_session to all subsequent browser tool calls " +
    "so that parallel agents each get their own isolated Chrome process.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description:
          "Optional session identifier. If omitted, a UUID is generated automatically. " +
          "Use a stable ID (e.g. the agent's task ID) so you can reuse the same session " +
          "across multiple tool calls without reopening the browser.",
      },
    },
    required: [],
  },
};

const BROWSER_CLOSE_TOOL = {
  name: "browser_close",
  description:
    "Close a browser session and its Chrome process. " +
    "Pass session_id to close a specific session; omit to close all open sessions.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "Session to close. Omit to close all open sessions.",
      },
    },
    required: [],
  },
};

/**
 * Inject _browser_session into every upstream tool's inputSchema so agents
 * can route calls to the correct isolated Chrome process.
 */
function injectSessionParam(tool: Record<string, unknown>): Record<string, unknown> {
  const schema = (tool["inputSchema"] as Record<string, unknown> | undefined) ?? {
    type: "object",
    properties: {},
  };
  const properties = (schema["properties"] as Record<string, unknown> | undefined) ?? {};
  return {
    ...tool,
    inputSchema: {
      ...schema,
      properties: {
        ...properties,
        _browser_session: {
          type: "string",
          description:
            "Session ID returned by browser_open. Required on every call — " +
            "each session is its own isolated Chrome process.",
        },
      },
    },
  };
}

/**
 * Probe chrome-devtools-mcp for its (static) tool schemas via a throwaway
 * headless instance, then tear it down. Costs one short-lived Chrome launch
 * at our own startup, in exchange for giving the model the full tool list
 * from turn 1 without maintaining a hand-copied schema snapshot.
 */
async function probeUpstreamSchemas(): Promise<unknown[]> {
  try {
    const client = await createUpstreamClient(PROBE_FLAGS);
    try {
      const { tools } = await client.listTools();
      return tools.map((t) => injectSessionParam(t as Record<string, unknown>));
    } finally {
      await client.close().catch(() => {});
    }
  } catch (err) {
    console.error(`[warranted-browser] Failed to probe upstream schemas: ${String(err)}`);
    return [];
  }
}

// =============================================================================
// MCP server
// =============================================================================

async function main(): Promise<void> {
  const upstreamSchemas = await probeUpstreamSchemas();
  console.error(`[warranted-browser] Probed ${upstreamSchemas.length} upstream tools from chrome-devtools-mcp@${UPSTREAM_VERSION}`);

  const server = new Server(
    { name: "warranted-browser", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => {
    return { tools: [BROWSER_OPEN_TOOL, BROWSER_CLOSE_TOOL, ...upstreamSchemas] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolArgs = (request.params.arguments as Record<string, unknown>) ?? {};

    if (request.params.name === "browser_open") {
      const sessionId = (toolArgs["session_id"] as string | undefined) ?? randomUUID();
      await openSession(sessionId);
      return {
        content: [
          {
            type: "text",
            text: `Browser opened. Session: ${sessionId}\nPass _browser_session="${sessionId}" to all subsequent browser tool calls.`,
          },
        ],
      };
    }

    if (request.params.name === "browser_close") {
      const sessionId = toolArgs["session_id"] as string | undefined;
      if (sessionId) {
        await closeSession(sessionId);
        return { content: [{ type: "text", text: `Browser session ${sessionId} closed.` }] };
      }
      await closeAllSessions();
      return { content: [{ type: "text", text: "All browser sessions closed." }] };
    }

    const requestedSession = toolArgs["_browser_session"] as string | undefined;
    const forwardArgs = { ...toolArgs };
    delete forwardArgs["_browser_session"];

    if (!requestedSession) {
      return {
        content: [
          {
            type: "text",
            text: "Missing _browser_session. Call browser_open() first and pass the returned session ID as _browser_session to every browser tool call.",
          },
        ],
        isError: true,
      };
    }

    const session = sessions.get(requestedSession);
    if (!session) {
      return {
        content: [
          {
            type: "text",
            text: `Browser session "${requestedSession}" is not available — it was never opened, or its Chrome process ended. Call browser_open() again.`,
          },
        ],
        isError: true,
      };
    }

    try {
      return await session.client.callTool({ name: request.params.name, arguments: forwardArgs });
    } catch (err) {
      // If the child process died mid-call, evict it so the next call gets a clean error.
      if (!sessions.has(requestedSession)) {
        return {
          content: [
            {
              type: "text",
              text: `Browser session "${requestedSession}" is no longer available — its Chrome process ended. Call browser_open() again to restart it.`,
            },
          ],
          isError: true,
        };
      }
      throw err;
    }
  });

  let cleaningUp = false;
  async function cleanup(): Promise<void> {
    if (cleaningUp) return;
    cleaningUp = true;
    await closeAllSessions();
  }

  process.on("SIGINT", async () => { await cleanup(); process.exit(0); });
  process.on("SIGTERM", async () => { await cleanup(); process.exit(0); });
  process.stdin.on("close", async () => {
    await cleanup();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[warranted-browser] Server started on stdio");
}

main().catch((err: unknown) => {
  console.error(`[warranted-browser] fatal: ${String(err)}`);
  process.exit(1);
});

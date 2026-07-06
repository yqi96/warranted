/**
 * Toulmin MCP — MCP 工具注册
 *
 * 12 个工具，每个定义 zod inputSchema + handler。
 * Handler 调用 service 层，错误在边界捕获转为文本返回。
 */

import type { Database } from "bun:sqlite";
import { z } from "zod";
import * as service from "./service.ts";
import {
  ToulminError,
  NotFoundError,
  ValidationError,
  CascadeRequiredError,
  TypeMismatchError,
  MutuallyExclusiveModeError,
  StatusTransitionError,
} from "./errors.ts";
import type { ArgumentResult, Stats, ToulminNode } from "./types.ts";
import { log, summarizeInput, summarizeOutput } from "./logger.ts";
import { ELEMENTS, HINTS, WARNINGS } from "./content.ts";

// =============================================================================
// 辅助函数
// =============================================================================

function formatError(e: unknown): string {
  if (e instanceof ToulminError) {
    return `Error: ${e.message}`;
  }
  if (e instanceof Error) {
    return `Error: ${e.message}`;
  }
  return `Unknown error: ${String(e)}`;
}

function formatNode(node: ToulminNode): string {
  const base = `[${node.type} #${node.id}] ${node.content}`;
  switch (node.type) {
    case "claim":
      return `${base} (status: ${node.status})`;
    case "ground":
      return `${base} (source: ${node.source}, verification: ${node.verification})`;
    case "warrant":
      return `${base} (claim_id: ${node.claimId}, ground_ids: [${node.groundIds.join(", ")}])`;
    default:
      return base;
  }
}

function formatArgument(result: ArgumentResult): string {
  if ("claim" in result) {
    // ClaimArgument
    const lines: string[] = [];
    lines.push(`## Claim #${result.claim.id}`);
    lines.push(`Content: ${result.claim.content}`);
    lines.push(`Status: ${result.claim.status}`);
    if (result.claim.qualifier) {
      lines.push(`Qualifier: ${result.claim.qualifier}`);
    }
    lines.push("");

    for (const w of result.warrants) {
      lines.push(`### Warrant #${w.id}`);
      lines.push(w.content);
      if (w.grounds.length > 0) {
        lines.push("Grounds:");
        for (const g of w.grounds) {
          lines.push(`  - [#${g.id}] ${g.content} (${g.source}/${g.verification})`);
        }
      }
      if (w.backings.length > 0) {
        lines.push("Backings:");
        for (const b of w.backings) {
          lines.push(`  - [#${b.id}] ${b.content}`);
        }
      }
      lines.push("");
    }

    if (result.rebuttals.length > 0) {
      lines.push("### Rebuttals");
      for (const r of result.rebuttals) {
        lines.push(`- [#${r.id}] (${r.target_type}) ${r.content}`);
      }
    }

    return lines.join("\n");
  }

  if ("warrant" in result) {
    // WarrantArgument
    const lines: string[] = [];
    lines.push(`## Warrant #${result.warrant.id}`);
    lines.push(result.warrant.content);
    lines.push(`Claim ID: ${result.warrant.claim_id}`);
    lines.push("");

    if (result.grounds.length > 0) {
      lines.push("Grounds:");
      for (const g of result.grounds) {
        lines.push(`  - [#${g.id}] ${g.content}`);
      }
    }
    if (result.backings.length > 0) {
      lines.push("Backings:");
      for (const b of result.backings) {
        lines.push(`  - [#${b.id}] ${b.content}`);
      }
    }
    return lines.join("\n");
  }

  // NodeArgument
  const lines: string[] = [];
  lines.push(`## ${result.node.type} #${result.node.id}`);
  lines.push(result.node.content);
  if (result.used_in_warrants && result.used_in_warrants.length > 0) {
    lines.push("Used in warrants:");
    for (const w of result.used_in_warrants) {
      lines.push(`  - Warrant #${w.warrant_id} → Claim #${w.claim_id}: ${w.claim_content}`);
    }
  }
  return lines.join("\n");
}

function formatStats(stats: Stats): string {
  const lines: string[] = [];
  lines.push("## Argument Statistics", "");
  lines.push(`Claims: ${stats.claims.total}`);
  for (const [status, count] of Object.entries(stats.claims.by_status)) {
    lines.push(`  - ${status}: ${count}`);
  }
  lines.push("");
  lines.push(`Grounds: ${stats.grounds.total}`);
  for (const [source, count] of Object.entries(stats.grounds.by_source)) {
    lines.push(`  - ${source}: ${count}`);
  }
  for (const [v, count] of Object.entries(stats.grounds.by_verification)) {
    lines.push(`  - ${v}: ${count}`);
  }
  lines.push("");
  lines.push(`Warrants: ${stats.warrants.total}`);
  lines.push(`Backings: ${stats.backings.total}`);
  lines.push(`Rebuttals: ${stats.rebuttals.total}`);
  for (const [t, count] of Object.entries(stats.rebuttals.by_target_type)) {
    lines.push(`  - ${t}: ${count}`);
  }
  return lines.join("\n");
}

// =============================================================================
// 日志包装器
// =============================================================================

type ToolHandler = (input: any) => Promise<{ content: { type: string; text: string }[] }>;

/** 包装 handler，自动记录工具名、输入、结果摘要和耗时 */
function withLog(toolName: string, handler: ToolHandler): ToolHandler {
  return async (input: any) => {
    const start = Date.now();
    const inputSummary = summarizeInput(input ?? {});
    try {
      const result = await handler(input);
      const ms = Date.now() - start;
      const text = result.content?.[0]?.text ?? "";
      const status = text.startsWith("Error:") ? "ERR" : "OK ";
      log(toolName, status as "OK" | "ERR", ms, `${inputSummary} → ${summarizeOutput(text)}`);
      return result;
    } catch (e) {
      const ms = Date.now() - start;
      log(toolName, "ERR", ms, `${inputSummary} → ${String(e)}`);
      throw e;
    }
  };
}

// =============================================================================
// 工具注册
// =============================================================================

export function registerTools(server: any, db: Database): void {
  // ===========================================================================
  // 1. create_claim
  // ===========================================================================
  server.registerTool(
    "create_claim",
    {
      title: "Create Claim",
      description: ELEMENTS.claim.description,
      inputSchema: {
        content: z.string().describe(ELEMENTS.claim.content),
        qualifier: z.string().optional().describe(ELEMENTS.claim.qualifier),
      },
    },
    withLog("create_claim", async ({ content, qualifier }: { content: string; qualifier?: string }) => {
      try {
        const claim = service.createClaim(db, content, qualifier);
        const lines = [`Created claim #${claim.id}: ${claim.content}`];
        lines.push("", HINTS.claimNoWarrants);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: formatError(e) }] };
      }
    })
  );

  // ===========================================================================
  // 2. create_ground
  // ===========================================================================
  server.registerTool(
    "create_ground",
    {
      title: "Create Ground",
      description: ELEMENTS.ground.description,
      inputSchema: {
        content: z.string().optional().describe(ELEMENTS.ground.content),
        source: z.enum(["literature", "observed", "hypothesis"]).optional().describe(ELEMENTS.ground.source),
        verification: z.enum(["verified", "pending"]).optional().describe(ELEMENTS.ground.verification),
        attachments: z.array(z.string()).optional().describe(ELEMENTS.ground.attachments),
        ref_claim_id: z.number().optional().describe(ELEMENTS.ground.refClaimId),
      },
    },
    withLog("create_ground", async (opts: any) => {
      try {
        const ground = service.createGround(db, {
          content: opts.content,
          source: opts.source,
          verification: opts.verification,
          attachments: opts.attachments,
          refClaimId: opts.ref_claim_id,
        });
        const lines = [`Created ground #${ground.id}: ${ground.content}`];
        if (opts.verification === "pending") {
          lines.push("", HINTS.groundPending);
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: formatError(e) }] };
      }
    })
  );

  // ===========================================================================
  // 3. create_warrant
  // ===========================================================================
  server.registerTool(
    "create_warrant",
    {
      title: "Create Warrant",
      description: ELEMENTS.warrant.description,
      inputSchema: {
        claim_id: z.number().describe(ELEMENTS.warrant.claimId),
        content: z.string().describe(ELEMENTS.warrant.content),
        ground_ids: z.array(z.number()).optional().describe(ELEMENTS.warrant.groundIds),
      },
    },
    withLog("create_warrant", async ({ claim_id, content, ground_ids }: { claim_id: number; content: string; ground_ids?: number[] }) => {
      try {
        const warrant = service.createWarrant(db, { content, claimId: claim_id, groundIds: ground_ids });
        return {
          content: [{ type: "text", text: `Created warrant #${warrant.id}: ${warrant.content}` }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: formatError(e) }] };
      }
    })
  );

  // ===========================================================================
  // 4. create_backing
  // ===========================================================================
  server.registerTool(
    "create_backing",
    {
      title: "Create Backing",
      description: ELEMENTS.backing.description,
      inputSchema: {
        warrant_id: z.number().describe(ELEMENTS.backing.warrantId),
        content: z.string().describe(ELEMENTS.backing.content),
        attachments: z.array(z.string()).optional().describe("Attachment file paths"),
      },
    },
    withLog("create_backing", async ({ warrant_id, content, attachments }: { warrant_id: number; content: string; attachments?: string[] }) => {
      try {
        const backing = service.createBacking(db, { content, warrantId: warrant_id, attachments });
        return {
          content: [{ type: "text", text: `Created backing #${backing.id}: ${backing.content}` }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: formatError(e) }] };
      }
    })
  );

  // ===========================================================================
  // 5. create_rebuttal
  // ===========================================================================
  server.registerTool(
    "create_rebuttal",
    {
      title: "Create Rebuttal",
      description: ELEMENTS.rebuttal.description,
      inputSchema: {
        target_id: z.number().describe(ELEMENTS.rebuttal.targetId),
        target_type: z.enum(["claim", "warrant"]).describe(ELEMENTS.rebuttal.targetType),
        content: z.string().describe(ELEMENTS.rebuttal.content),
        attachments: z.array(z.string()).optional().describe("Attachment file paths"),
      },
    },
    withLog("create_rebuttal", async ({ target_id, target_type, content, attachments }: { target_id: number; target_type: "claim" | "warrant"; content: string; attachments?: string[] }) => {
      try {
        const rebuttal = service.createRebuttal(db, { content, targetId: target_id, targetType: target_type, attachments });
        return {
          content: [{ type: "text", text: `Created rebuttal #${rebuttal.id}: ${rebuttal.content}` }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: formatError(e) }] };
      }
    })
  );

  // ===========================================================================
  // 6. list_claims
  // ===========================================================================
  server.registerTool(
    "list_claims",
    {
      title: "List Claims",
      description: "List all claims, optionally filtered by status.",
      inputSchema: {
        status: z.string().optional().describe("Filter by status (comma-separated: proposed,supported,validated)"),
      },
    },
    withLog("list_claims", async ({ status }: { status?: string }) => {
      try {
        const claims = service.listClaims(db, status);
        if (claims.length === 0) {
          return { content: [{ type: "text", text: "No claims found." }] };
        }
        const lines = claims.map(c => `#${c.id} [${c.status}] ${c.content}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text", text: formatError(e) }] };
      }
    })
  );

  // ===========================================================================
  // 7. get_argument
  // ===========================================================================
  server.registerTool(
    "get_argument",
    {
      title: "Get Argument",
      description: "Get the complete argumentation subgraph for a node.",
      inputSchema: {
        node_id: z.number().describe("Any node ID"),
      },
    },
    withLog("get_argument", async ({ node_id }: { node_id: number }) => {
      try {
        const result = service.getArgument(db, node_id);
        return { content: [{ type: "text", text: formatArgument(result) }] };
      } catch (e) {
        return { content: [{ type: "text", text: formatError(e) }] };
      }
    })
  );

  // ===========================================================================
  // 8. search_nodes
  // ===========================================================================
  server.registerTool(
    "search_nodes",
    {
      title: "Search Nodes",
      description: "Search nodes by keyword, optionally filtered by type.",
      inputSchema: {
        keyword: z.string().describe("Search keyword"),
        node_type: z.enum(["claim", "ground", "warrant", "backing", "rebuttal"]).optional().describe("Filter by node type"),
      },
    },
    withLog("search_nodes", async ({ keyword, node_type }: { keyword: string; node_type?: string }) => {
      try {
        const results = service.searchNodesService(db, keyword, node_type);
        if (results.length === 0) {
          return { content: [{ type: "text", text: "No matching nodes found." }] };
        }
        const lines = results.map(n => formatNode(n));
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text", text: formatError(e) }] };
      }
    })
  );

  // ===========================================================================
  // 9. get_stats
  // ===========================================================================
  server.registerTool(
    "get_stats",
    {
      title: "Get Stats",
      description: "Get global argumentation statistics.",
      inputSchema: {},
    },
    withLog("get_stats", async () => {
      try {
        const stats = service.getStats(db);
        return { content: [{ type: "text", text: formatStats(stats) }] };
      } catch (e) {
        return { content: [{ type: "text", text: formatError(e) }] };
      }
    })
  );

  // ===========================================================================
  // 10. update_node
  // ===========================================================================
  server.registerTool(
    "update_node",
    {
      title: "Update Node",
      description: "Update a node's content, status, verification, or relationships.",
      inputSchema: {
        node_id: z.number().describe("Node ID to update"),
        content: z.string().optional().describe("New content"),
        attachments: z.array(z.string()).optional().describe("New attachment file paths"),
        status: z.enum(["proposed", "supported", "validated", "disputed", "refuted"]).optional().describe("Claim status: tracks argumentation progress"),
        source: z.enum(["literature", "observed", "hypothesis"]).optional().describe("Ground source"),
        verification: z.enum(["verified", "pending"]).optional().describe("Ground verification status"),
        ground_ids: z.object({
          add: z.array(z.number()).optional(),
          remove: z.array(z.number()).optional(),
        }).optional().describe("Warrant ground_ids incremental update"),
        qualifier: z.string().optional().describe("Claim qualifier: degree of certainty ('probably', 'presumably', 'certainly')"),
      },
    },
    withLog("update_node", async (opts: any) => {
      try {
        const { node, warnings } = service.updateNode(db, opts.node_id, {
          content: opts.content,
          attachments: opts.attachments,
          status: opts.status,
          source: opts.source,
          verification: opts.verification,
          ground_ids: opts.ground_ids,
          qualifier: opts.qualifier,
        });
        let text = `Updated ${formatNode(node)}`;
        if (warnings.length > 0) {
          text += "\n\n" + warnings.join("\n");
        }
        return {
          content: [{ type: "text", text }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: formatError(e) }] };
      }
    })
  );

  // ===========================================================================
  // 11. delete_node
  // ===========================================================================
  server.registerTool(
    "delete_node",
    {
      title: "Delete Node",
      description: "Delete a node. Deleting Ground/Warrant auto-cleans references and returns warnings. Claim deletion requires cascade=true.",
      inputSchema: {
        node_id: z.number().describe("Node ID to delete"),
        cascade: z.boolean().optional().default(false).describe("Recursively delete child nodes (required for Claims)"),
      },
    },
    withLog("delete_node", async ({ node_id, cascade }: { node_id: number; cascade?: boolean }) => {
      try {
        const warnings = service.deleteNode(db, node_id, cascade);
        let text = `Deleted node #${node_id}`;
        if (warnings.length > 0) {
          text += "\n\n" + warnings.join("\n");
        }
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return { content: [{ type: "text", text: formatError(e) }] };
      }
    })
  );
}

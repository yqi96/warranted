/** Static nine-tool surface for the records-only paper treatment. */
import type { Database } from "bun:sqlite";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as service from "./records.ts";
import { ToulminError } from "./errors.ts";
import { checkContext, type CheckContext } from "./structural-check.ts";
import { QUALIFIERS } from "./types.ts";
import { log, summarizeInput, summarizeOutput } from "./logger.ts";
import { TOOLS, PARAMS } from "./records-content.ts";

export interface Lifecycle {
  beginOp(): void;
  endOp(): void;
  drain(): Promise<void>;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [k: string]: unknown;
}

function text(s: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: s }], ...(isError ? { isError: true } : {}) };
}

function ok(payload: unknown): ToolResult {
  return text(JSON.stringify(payload, null, 2));
}

function fail(e: unknown): ToolResult {
  if (e instanceof ToulminError) return text(e.message, true);
  if (e instanceof Error) return text(e.message, true);
  return text(String(e), true);
}

const qualifierEnum = z.enum(QUALIFIERS as unknown as [string, ...string[]]);

const evidenceInput = z
  .object({
    attachments: z.array(z.string()).optional().describe(PARAMS.attachments),
    nodes: z.array(z.number().int()).optional().describe(PARAMS.evidence_nodes),
  })
  .optional();

type Handler = (input: any) => ToolResult | Promise<ToolResult>;

export function registerTools(
  server: McpServer,
  db: Database,
  dbPath: string,
  lifecycle?: Lifecycle
): void {
  const ctx: CheckContext = checkContext(dbPath);
  service.assertRecordDatabase(db);

  function withLog(toolName: string, handler: Handler): Handler {
    return async (input: any) => {
      lifecycle?.beginOp();
      const start = Date.now();
      const inputSummary = summarizeInput(input ?? {});
      try {
        const result = await handler(input);
        const ms = Date.now() - start;
        const body = result.content?.[0]?.text ?? "";
        log(toolName, result.isError ? "ERR" : "OK", ms, `${inputSummary} → ${summarizeOutput(body)}`);
        return result;
      } catch (e) {
        log(toolName, "ERR", Date.now() - start, `${inputSummary} → ${String(e)}`);
        throw e;
      } finally {
        lifecycle?.endOp();
      }
    };
  }

  server.registerTool(
    "create_propositions",
    {
      title: TOOLS.create_propositions.title,
      description: TOOLS.create_propositions.description,
      inputSchema: {
        items: z
          .array(
            z.object({
              content: z.string().describe(PARAMS.content),
              warrant: z.string().optional().describe(PARAMS.warrant),
              evidence: evidenceInput,
              attacks: z
                .object({
                  node: z.number().int().describe(PARAMS.target_id),
                  slot: z.enum(["content", "warrant"]).describe(PARAMS.attack_slot),
                })
                .optional()
                .describe(PARAMS.attacks),
              note: z.string().optional().describe(PARAMS.note),
            })
          )
          .min(1)
          .describe(PARAMS.create_items),
      },
    },
    withLog("create_propositions", (input) => {
      try {
        const results = service.createPropositions(db, ctx, input.items);
        return ok({ created: results });
      } catch (e) {
        return fail(e);
      }
    })
  );

  server.registerTool(
    "update_proposition",
    {
      title: TOOLS.update_proposition.title,
      description: TOOLS.update_proposition.description,
      inputSchema: {
        id: z.number().int().describe(PARAMS.proposition_id),
        content: z.string().optional().describe(PARAMS.content),
        warrant: z.string().optional().describe(PARAMS.warrant),
        evidence: z
          .object({
            add_attachments: z.array(z.string()).optional().describe(PARAMS.attachments),
            remove_attachments: z.array(z.string()).optional(),
            add_nodes: z.array(z.number().int()).optional().describe(PARAMS.evidence_nodes),
            remove_nodes: z.array(z.number().int()).optional(),
          })
          .optional()
          .describe(PARAMS.update_evidence),
        rebuttals: z
          .object({
            add: z.array(z.number().int()).optional(),
            remove: z.array(z.number().int()).optional(),
          })
          .optional()
          .describe(PARAMS.update_rebuttals),
        note: z.string().optional().describe(PARAMS.note),
      },
    },
    withLog("update_proposition", (input) => {
      try {
        const r = service.updateProposition(db, ctx, input);
        return ok(r);
      } catch (e) {
        return fail(e);
      }
    })
  );

  server.registerTool(
    "set_qualifier",
    {
      title: TOOLS.set_qualifier.title,
      description: TOOLS.set_qualifier.description,
      inputSchema: {
        updates: z
          .array(
            z.object({
              id: z.number().int().describe(PARAMS.proposition_id),
              qualifier: qualifierEnum.describe(PARAMS.qualifier),
              note: z.string().optional().describe(PARAMS.note),
            })
          )
          .min(1)
          .describe(PARAMS.set_qualifier_updates),
      },
    },
    withLog("set_qualifier", (input) => {
      try {
        const results = service.setQualifier(db, ctx, input.updates);
        return ok({ updated: results });
      } catch (e) {
        return fail(e);
      }
    })
  );

  server.registerTool(
    "promote_warrant",
    {
      title: TOOLS.promote_warrant.title,
      description: TOOLS.promote_warrant.description,
      inputSchema: {
        id: z.number().int().describe(PARAMS.proposition_id),
        warrant: z.string().optional().describe(PARAMS.promote_own_warrant),
        evidence: z
          .object({
            attachments: z.array(z.string()).optional().describe(PARAMS.attachments),
            nodes: z.array(z.number().int()).optional().describe(PARAMS.evidence_nodes),
          })
          .optional()
          .describe(PARAMS.promote_evidence),
        note: z.string().optional().describe(PARAMS.note),
      },
    },
    withLog("promote_warrant", (input) => {
      try {
        const r = service.promoteWarrant(db, ctx, input);
        return ok(r);
      } catch (e) {
        return fail(e);
      }
    })
  );

  server.registerTool(
    "delete_proposition",
    {
      title: TOOLS.delete_proposition.title,
      description: TOOLS.delete_proposition.description,
      inputSchema: {
        id: z.number().int().describe(PARAMS.proposition_id),
        note: z.string().optional().describe(PARAMS.note),
      },
    },
    withLog("delete_proposition", (input) => {
      try {
        return ok(service.deleteProposition(db, ctx, input));
      } catch (e) {
        return fail(e);
      }
    })
  );

  server.registerTool(
    "get_argument",
    {
      title: TOOLS.get_argument.title,
      description: TOOLS.get_argument.description,
      inputSchema: {
        id: z.number().int().describe(PARAMS.proposition_id),
        depth: z.number().int().min(0).optional().describe(PARAMS.depth),
      },
    },
    withLog("get_argument", (input) => {
      try {
        const r = service.getArgument(db, ctx, input);
        return ok(r);
      } catch (e) {
        return fail(e);
      }
    })
  );

  server.registerTool(
    "find_propositions",
    {
      title: TOOLS.find_propositions.title,
      description: TOOLS.find_propositions.description,
      inputSchema: {
        query: z.string().optional().describe(PARAMS.find_query),
        qualifier: z.array(qualifierEnum).optional().describe(PARAMS.find_qualifier),
        limit: z.number().int().positive().optional().describe(PARAMS.limit),
        offset: z.number().int().min(0).optional().describe(PARAMS.offset),
      },
    },
    withLog("find_propositions", (input) => {
      try {
        const r = service.findPropositions(db, ctx, input);
        return ok(r);
      } catch (e) {
        return fail(e);
      }
    })
  );

  server.registerTool(
    "get_stats",
    {
      title: TOOLS.get_stats.title,
      description: TOOLS.get_stats.description,
      inputSchema: {},
    },
    withLog("get_stats", () => {
      try {
        const s = service.getStats(db, ctx);
        return ok(s);
      } catch (e) {
        return fail(e);
      }
    })
  );

  server.registerTool(
    "get_history",
    {
      title: TOOLS.get_history.title,
      description: TOOLS.get_history.description,
      inputSchema: {
        id: z.number().int().optional().describe(PARAMS.history_id),
        limit: z.number().int().positive().optional().describe(PARAMS.limit),
        offset: z.number().int().min(0).optional().describe(PARAMS.offset),
      },
    },
    withLog("get_history", (input) => {
      try {
        return ok(service.getHistory(db, input ?? {}));
      } catch (e) {
        return fail(e);
      }
    })
  );


}

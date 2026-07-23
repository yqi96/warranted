/**
 * Warranted — MCP 工具注册
 *
 * 14 个工具，每个定义 zod inputSchema + handler。
 * Handler 调用 service 层，错误在边界捕获转为文本返回。
 */

import type { Database } from "bun:sqlite";
import { z } from "zod";
import * as service from "./service.ts";
import * as repo from "./repo.ts";
import {
  ToulminError,
  NotFoundError,
  ValidationError,
  CascadeRequiredError,
  TypeMismatchError,
  MutuallyExclusiveModeError,
  StatusTransitionError,
} from "./errors.ts";
import type { ArgumentResult, Stats, ToulminNode, AutoVerifyResult, NodeRow } from "./types.ts";
import { log, summarizeInput, summarizeOutput } from "./logger.ts";
import { ELEMENTS, HINTS, WARNINGS } from "./content.ts";
import type { ReviewConfig } from "./review-config.ts";
import { executeGroundReview, reviewGroundEvidencePreCreate, saveGroundReviewFile } from "./review-sync.ts";
import * as compileService from "./compile-service.ts";

export interface Lifecycle {
  beginOp(): void;
  endOp(): void;
  drain(): Promise<void>;
}

// =============================================================================
// 辅助函数
// =============================================================================

function formatError(e: unknown): string {
  if (e instanceof ToulminError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** 将 Ground 的 verification 回退为 pending */
function revertGroundVerification(db: Database, groundId: number): void {
  const row = repo.getNodeById(db, groundId);
  if (!row) return;
  const data = JSON.parse(row.data);
  data.verification = "pending";
  repo.updateNodeFields(db, groundId, { data });
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

/** 列表行格式：#N [key-metadata] content，供 list_* 工具统一使用 */
function formatNodeLine(node: ToulminNode, displayContent?: string): string {
  const content = displayContent ?? node.content;
  switch (node.type) {
    case "claim":
      return `#${node.id} [${node.status}] ${content}`;
    case "ground":
      return `#${node.id} [${node.source}/${node.verification}] ${content}`;
    default:
      return `#${node.id} ${content}`;
  }
}

/** 单节点完整字段格式，供 get_node 使用 */
function formatNodeDetail(row: NodeRow): string {
  const data = JSON.parse(row.data);
  const lines: string[] = [`[${row.type} #${row.id}]`];
  lines.push(`content: ${row.content}`);
  switch (row.type) {
    case "claim":
      lines.push(`status: ${data.status ?? "proposed"}`);
      if (data.qualifier != null && data.qualifier !== "") lines.push(`qualifier: ${data.qualifier}`);
      lines.push(`compile_status: ${data.compile_status ?? null}`);
      break;
    case "ground": {
      lines.push(`source: ${data.source}`);
      lines.push(`verification: ${data.verification}`);
      const atts: string[] = data.attachments ?? [];
      lines.push(`attachments: [${atts.join(", ")}]`);
      if (data.ref_claim_id != null) lines.push(`ref_claim_id: ${data.ref_claim_id}`);
      break;
    }
    case "warrant":
      lines.push(`claim_id: ${data.claim_id}`);
      lines.push(`ground_ids: [${(data.ground_ids ?? []).join(", ")}]`);
      break;
    case "backing":
      lines.push(`warrant_id: ${data.warrant_id}`);
      lines.push(`attachments: [${(data.attachments ?? []).join(", ")}]`);
      break;
    case "rebuttal":
      lines.push(`target_type: ${data.target_type}`);
      lines.push(`target_id: ${data.target_id}`);
      lines.push(`attachments: [${(data.attachments ?? []).join(", ")}]`);
      break;
  }
  return lines.join("\n");
}

/** 不含 content 的简短节点格式（用于 update 返回） */
function formatNodeBrief(node: ToulminNode): string {
  const base = `[${node.type} #${node.id}]`;
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
    if (result.claim.compile_status === "stale") {
      lines.push("⚠ STALE — logical chain review pending. Call compile_arguments.");
    }
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
  const stalePart = stats.claims.stale_count ? ` (${stats.claims.stale_count} stale)` : "";
  lines.push(`Claims: ${stats.claims.total}${stalePart}`);
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

/** 收集链式审查的所有 errors、warnings 和 infos */
function collectChainReviewIssues(results: AutoVerifyResult[]): { errors: string[]; warnings: string[]; infos: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  for (const r of results) {
    if (r.action === "auto-reviewed" && r.compileResult) {
      for (const er of r.compileResult.elementReviews) {
        errors.push(...er.errors);
        warnings.push(...er.warnings);
        if (er.infos) infos.push(...er.infos);
      }
    }
  }
  return { errors, warnings, infos };
}

/** 格式化 errors/warnings/infos 为文本行 */
function formatReviewIssues(errors: string[], warnings: string[], infos?: string[]): string {
  const parts: string[] = [];
  for (const e of errors) parts.push(`Error: ${e}`);
  for (const w of warnings) parts.push(`Warning: ${w}`);
  if (infos) for (const i of infos) parts.push(`Info: ${i}`);
  return parts.join("\n");
}

/** invalidateCompiledClaims 警告 + compile 提示 */
function appendInvalidateHint(text: string, warnings: string[]): string {
  if (warnings.length === 0) return text;
  return text + "\n" + warnings.join("\n") + "\nHint: Call compile_arguments to verify the argument chain.";
}

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
type ToolHandler = (input: any) => Promise<ToolResult>;

/** 构造成功返回 */
function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** 构造失败返回（isError: true，不抛异常） */
function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// =============================================================================
// 工具注册
// =============================================================================

export function registerTools(server: any, db: Database, reviewConfig: ReviewConfig | null = null, lifecycle?: Lifecycle): void {

  /** 包装 handler，自动记录工具名、输入、结果摘要和耗时 */
  function withLog(toolName: string, handler: ToolHandler): ToolHandler {
    return async (input: any) => {
      lifecycle?.beginOp();
      const start = Date.now();
      const inputSummary = summarizeInput(input ?? {});
      try {
        const result = await handler(input);
        const ms = Date.now() - start;
        const text = result.content?.[0]?.text ?? "";
        const status = result.isError ? "ERR" : "OK ";
        log(toolName, status as "OK" | "ERR", ms, `${inputSummary} → ${summarizeOutput(text)}`);
        return result;
      } catch (e) {
        const ms = Date.now() - start;
        log(toolName, "ERR", ms, `${inputSummary} → ${String(e)}`);
        throw e;
      } finally {
        lifecycle?.endOp();
      }
    };
  }
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
        if (reviewConfig) {
          const review = await compileService.reviewNodeDefinition(reviewConfig, "claim", content, qualifier);
          if (review.errors.length > 0) return fail(formatReviewIssues(review.errors, review.warnings));
        }
        const claim = service.createClaim(db, content, qualifier);
        return ok(`Created claim #${claim.id}\n\n${HINTS.claimNoWarrants}`);
      } catch (e) {
        return fail(formatError(e));
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
        // 链式推理 Ground（ref_claim_id）跳过定义审查：content 是自动生成的占位文本
        // literature Ground 跳过定义审查：内容是引用文献的陈述，合法性由证据审查保证
        if (reviewConfig && !opts.ref_claim_id && opts.source !== "literature") {
          const review = await compileService.reviewNodeDefinition(reviewConfig, "ground", opts.content || "");
          if (review.errors.length > 0) return fail(formatReviewIssues(review.errors, review.warnings));
        }
        let preCreateReviewResult: { errors: string[]; warnings: string[] } | null = null;
        if (reviewConfig && opts.verification === "verified" && !opts.ref_claim_id) {
          const reviewResult = await reviewGroundEvidencePreCreate(reviewConfig, {
            content: opts.content || "",
            source: opts.source || "unknown",
            attachments: opts.attachments || [],
          });
          if (reviewResult.errors.length > 0) return fail(formatReviewIssues(reviewResult.errors, reviewResult.warnings));
          preCreateReviewResult = reviewResult;
        }
        const ground = service.createGround(db, {
          content: opts.content,
          source: opts.source,
          verification: opts.verification,
          attachments: opts.attachments,
          refClaimId: opts.ref_claim_id,
        });
        // 审查通过后落盘，留存审查报告
        if (reviewConfig && preCreateReviewResult) {
          saveGroundReviewFile(reviewConfig, ground.id, preCreateReviewResult);
        }
        const lines = [`Created ground #${ground.id}`];
        if (opts.verification === "pending") {
          const src = opts.source ?? "hypothesis";
          if (src === "literature") lines.push("", HINTS.groundPendingLiterature);
          else if (src === "observed") lines.push("", HINTS.groundPendingObserved);
          else lines.push("", HINTS.groundPendingHypothesis);
        }
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(formatError(e));
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
        if (reviewConfig) {
          const review = await compileService.reviewNodeDefinition(reviewConfig, "warrant", content);
          if (review.errors.length > 0) return fail(formatReviewIssues(review.errors, review.warnings));
        }
        const warrant = service.createWarrant(db, { content, claimId: claim_id, groundIds: ground_ids });
        return ok(appendInvalidateHint(
          `Created warrant #${warrant.id}`,
          compileService.invalidateCompiledClaims(db, warrant.id)
        ));
      } catch (e) {
        return fail(formatError(e));
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
        return ok(appendInvalidateHint(
          `Created backing #${backing.id}`,
          compileService.invalidateCompiledClaims(db, backing.id)
        ));
      } catch (e) {
        return fail(formatError(e));
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
        return ok(appendInvalidateHint(
          `Created rebuttal #${rebuttal.id}`,
          compileService.invalidateCompiledClaims(db, rebuttal.id)
        ));
      } catch (e) {
        return fail(formatError(e));
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
        status: z.string().optional().describe("Filter by status (comma-separated: proposed,supported,disputed,refuted)"),
      },
    },
    withLog("list_claims", async ({ status }: { status?: string }) => {
      try {
        const claims = service.listClaims(db, status);
        if (claims.length === 0) return ok("No claims found.");
        const lines = claims.map(c => formatNodeLine(c));
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(formatError(e));
      }
    })
  );

  // ===========================================================================
  // 7. list_grounds
  // ===========================================================================
  server.registerTool(
    "list_grounds",
    {
      title: "List Grounds",
      description: "List all ground (evidence) nodes, optionally filtered by source type and/or verification status.",
      inputSchema: {
        source: z.string().optional().describe("Filter by source type (comma-separated: literature,observed,hypothesis). Omit to include all."),
        verification: z.string().optional().describe("Filter by verification status (comma-separated: verified,pending). Omit to include all."),
      },
    },
    withLog("list_grounds", async ({ source, verification }: { source?: string; verification?: string }) => {
      try {
        const grounds = service.listGrounds(db, source, verification);
        if (grounds.length === 0) return ok("No grounds found.");
        const lines = grounds.map(g => {
          if (g.refClaimId != null) {
            const refRow = repo.getNodeById(db, g.refClaimId);
            const refContent = refRow ? refRow.content : `Claim #${g.refClaimId}`;
            return formatNodeLine(g, `[ref_claim #${g.refClaimId}] ${refContent}`);
          }
          return formatNodeLine(g);
        });
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(formatError(e));
      }
    })
  );

  // ===========================================================================
  // 8. get_argument
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
        return ok(formatArgument(result));
      } catch (e) {
        return fail(formatError(e));
      }
    })
  );

  // ===========================================================================
  // 9. get_node
  // ===========================================================================
  server.registerTool(
    "get_node",
    {
      title: "Get Node",
      description: "Get all fields of a single node by ID, including attachments. Does not traverse relationships.",
      inputSchema: {
        node_id: z.number().describe("Node ID"),
      },
    },
    withLog("get_node", async ({ node_id }: { node_id: number }) => {
      try {
        const row = repo.getNodeById(db, node_id);
        if (!row) return fail(`Node not found: ${node_id}`);
        return ok(formatNodeDetail(row));
      } catch (e) {
        return fail(formatError(e));
      }
    })
  );

  // ===========================================================================
  // 10. search_nodes
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
        if (results.length === 0) return ok("No matching nodes found.");
        const lines = results.map(n => formatNode(n));
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(formatError(e));
      }
    })
  );

  // ===========================================================================
  // 11. get_stats
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
        return ok(formatStats(stats));
      } catch (e) {
        return fail(formatError(e));
      }
    })
  );

  // ===========================================================================
  // 12. update_node
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
        status: z.enum(["proposed", "supported", "disputed", "refuted"]).optional().describe(ELEMENTS.claim.status),
        source: z.enum(["literature", "observed", "hypothesis"]).optional().describe(ELEMENTS.ground.source),
        verification: z.enum(["verified", "pending"]).optional().describe(ELEMENTS.ground.verification),
        ground_ids: z.object({
          add: z.array(z.number()).optional(),
          remove: z.array(z.number()).optional(),
        }).optional().describe("Warrant ground_ids incremental update"),
        qualifier: z.string().optional().describe("Claim qualifier: degree of certainty ('probably', 'presumably', 'certainly')"),
      },
    },
    withLog("update_node", async (opts: any) => {
      try {
        // 阻断式定义审查（如果更新了 content）
        // literature Ground 跳过：内容是文献引用，合法性由证据审查保证
        if (reviewConfig && opts.content !== undefined) {
          const existingNode = repo.getNodeById(db, opts.node_id);
          if (existingNode && (existingNode.type === "claim" || existingNode.type === "warrant" || existingNode.type === "ground")) {
            let effectiveSource: string | null = null;
            if (existingNode.type === "ground") {
              try {
                effectiveSource = opts.source ?? (JSON.parse(existingNode.data).source as string);
              } catch {
                // malformed data → reviewNodeDefinition runs (safe default)
              }
            }
            if (effectiveSource !== "literature") {
              const review = await compileService.reviewNodeDefinition(
                reviewConfig,
                existingNode.type as "claim" | "warrant" | "ground",
                opts.content,
                opts.qualifier
              );
              if (review.errors.length > 0) return fail(formatReviewIssues(review.errors, review.warnings));
            }
          }
        }

        const { node, warnings: serviceWarnings } = service.updateNode(db, opts.node_id, {
          content: opts.content,
          attachments: opts.attachments,
          status: opts.status,
          source: opts.source,
          verification: opts.verification,
          ground_ids: opts.ground_ids,
          qualifier: opts.qualifier,
        });

        // Ground 证据审查（阻断式：失败则回退 verification）
        if (reviewConfig && node.type === "ground" && opts.verification === "verified") {
          try {
            const reviewResult = await executeGroundReview(reviewConfig, db, node.id);
            if (reviewResult.errors.length > 0) {
              revertGroundVerification(db, node.id);
              return fail(formatReviewIssues(reviewResult.errors, reviewResult.warnings));
            }
          } catch { /* 审查本身出错不阻断 */ }
        }

        const invalidateWarnings = opts.content !== undefined
          ? compileService.invalidateCompiledClaims(db, opts.node_id)
          : [];
        let text = `Updated ${formatNodeBrief(node)}`;
        if (serviceWarnings.length > 0) text += "\n" + formatReviewIssues([], serviceWarnings);
        if (node.type === "ground" && opts.verification === "pending") {
          const src = node.source ?? "hypothesis";
          if (src === "literature") text += "\n\n" + HINTS.groundPendingLiterature;
          else if (src === "observed") text += "\n\n" + HINTS.groundPendingObserved;
          else text += "\n\n" + HINTS.groundPendingHypothesis;
        }
        return ok(appendInvalidateHint(text, invalidateWarnings));
      } catch (e) {
        return fail(formatError(e));
      }
    })
  );

  // ===========================================================================
  // 13. delete_node
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
        const invalidateWarnings = compileService.invalidateCompiledClaims(db, node_id);
        const serviceWarnings = service.deleteNode(db, node_id, cascade);
        let text = `Deleted node #${node_id}`;
        if (serviceWarnings.length > 0) text += "\n" + formatReviewIssues([], serviceWarnings);
        return ok(appendInvalidateHint(text, invalidateWarnings));
      } catch (e) {
        return fail(formatError(e));
      }
    })
  );

  // ===========================================================================
  // 13. compile_arguments
  // ===========================================================================
  server.registerTool(
    "compile_arguments",
    {
      title: "Compile Arguments",
      description:
        "Validates the logical coherence of the argument. " +
        "The primary chain is Ground (evidence) → Warrant (inference principle) → Claim (conclusion); " +
        "Backing (warrant authority) and Rebuttal (exception conditions) are also reviewed. " +
        "Reviews all affected Claims in parallel and returns a verdict per Claim. " +
        "When to call: after completing all nodes under a Claim (Warrant + Ground(s) in place), " +
        "after any structural change to an existing argument, or whenever a Claim shows stale status. " +
        "A Claim must pass compile before its status can advance to 'supported'. " +
        "Omit claim_ids to compile all Claims at once.",
      inputSchema: {
        claim_ids: z.array(z.number()).optional().describe("Specific Claim IDs to compile. Omit to compile all Claims."),
      },
    },
    withLog("compile_arguments", async ({ claim_ids }: { claim_ids?: number[] }) => {
      if (!reviewConfig) return fail("Review not configured. Set ANTHROPIC_API_KEY to enable compile.");
      const ids = claim_ids ?? repo.listNodesByType(db, "claim").map(r => r.id);
      if (ids.length === 0) return ok("No claims to compile.");
      const results = await compileService.autoVerifyAfterMutation(db, reviewConfig, ids);
      const { errors, warnings, infos } = collectChainReviewIssues(results);

      const lines: string[] = [];
      for (const r of results) {
        if (r.action === "auto-reviewed" && r.compileResult) {
          lines.push(`Claim #${r.claimId}: ${r.compileResult.verdict} — ${r.compileResult.summary}`);
        } else if (r.action === "no-change") {
          lines.push(`Claim #${r.claimId}: no-change (argument hash unchanged)`);
        } else if (r.action === "marked-stale") {
          lines.push(`Claim #${r.claimId}: incomplete structure — ${r.message ?? "add Warrant and Ground(s) first"}`);
        } else {
          lines.push(`Claim #${r.claimId}: ${r.action}`);
        }
      }

      let text = lines.join("\n");
      if (errors.length > 0) text += "\n\n" + formatReviewIssues(errors, warnings, infos);
      else if (warnings.length > 0) text += "\n\n" + formatReviewIssues([], warnings, infos);
      else if (infos.length > 0) text += "\n\n" + formatReviewIssues([], [], infos);
      return ok(text);
    })
  );

}

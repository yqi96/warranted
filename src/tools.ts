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
  StatusTransitionError,
} from "./errors.ts";
import type { ArgumentResult, Stats, ToulminNode, AutoVerifyResult, NodeRow } from "./types.ts";
import { log, summarizeInput, summarizeOutput } from "./logger.ts";
import { TOOLS, PARAMS, HINTS, WARNINGS, MESSAGES } from "./content/index.ts";
import type { ReviewConfig } from "./review-config.ts";
import { executeStatementReview, reviewStatementEvidencePreCreate, saveStatementReviewFile } from "./review-sync.ts";
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
    case "statement":
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
    case "statement":
      return `#${node.id} [${node.source}/${node.verification}] ${content}`;
    default:
      return `#${node.id} ${content}`;
  }
}

/** 单节点完整字段格式，供 get_node 使用 */
function formatNodeDetail(row: NodeRow, db: Database): string {
  const data = JSON.parse(row.data);
  const lines: string[] = [`[${row.type} #${row.id}]`];
  lines.push(`content: ${row.content}`);
  switch (row.type) {
    case "claim":
      lines.push(`status: ${data.status ?? "proposed"}`);
      if (data.qualifier != null && data.qualifier !== "") lines.push(`qualifier: ${data.qualifier}`);
      lines.push(`compile_status: ${data.compile_status ?? null}`);
      break;
    case "statement": {
      lines.push(`source: ${data.source}`);
      lines.push(`verification: ${data.verification}`);
      const atts: string[] = data.attachments ?? [];
      lines.push(`attachments: [${atts.join(", ")}]`);
      // backing: check warrant_backings
      const backingRow = db.prepare(
        "SELECT warrant_id FROM warrant_backings WHERE statement_id = ? LIMIT 1"
      ).get(row.id) as { warrant_id: number } | null;
      if (backingRow) lines.push(`warrant_id: ${backingRow.warrant_id}`);
      // rebuttal: check rebuttal_targets
      const rebuttalRow = db.prepare(
        "SELECT target_id, target_type FROM rebuttal_targets WHERE statement_id = ? LIMIT 1"
      ).get(row.id) as { target_id: number; target_type: string } | null;
      if (rebuttalRow) {
        lines.push(`target_type: ${rebuttalRow.target_type}`);
        lines.push(`target_id: ${rebuttalRow.target_id}`);
      }
      break;
    }
    case "warrant":
      lines.push(`claim_id: ${data.claim_id}`);
      lines.push(`ground_ids: [${(data.ground_ids ?? []).join(", ")}]`);
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
    case "statement":
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
      lines.push(HINTS.staleClaimBanner);
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

/** 收集 compile 期间所有 reviewer（structure/claim/warrant/chain）产生的 errors、warnings 和 infos */
function collectReviewIssues(results: AutoVerifyResult[]): { errors: string[]; warnings: string[]; infos: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  for (const r of results) {
    if (r.action === "auto-reviewed" && r.compileResult) {
      for (const er of r.compileResult.elementReviews) {
        // claim/warrant 定义审查结果按节点前缀，便于定位；chain/structure 的消息已自带节点引用，不重复加前缀
        const label = er.reviewer === "claim" ? `Claim #${er.nodeId}: `
          : er.reviewer === "warrant" ? `Warrant #${er.nodeId}: `
          : "";
        // advisory: 该 error 与另一 reviewer 的发现重叠，仅供参考，不代表独立的失败原因
        const marker = er.advisory ? "[advisory] " : "";
        for (const e of er.errors) errors.push(`${marker}${label}${e}`);
        for (const w of er.warnings) warnings.push(`${label}${w}`);
        if (er.infos) for (const i of er.infos) infos.push(`${label}${i}`);
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
  return text + "\n" + warnings.join("\n") + "\n" + HINTS.compileAfterMutation;
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
      title: TOOLS.create_claim.title,
      description: TOOLS.create_claim.description,
      inputSchema: {
        content: z.string().describe(PARAMS.claim_content),
        qualifier: z.string().optional().describe(PARAMS.claim_qualifier),
      },
    },
    withLog("create_claim", async ({ content, qualifier }: { content: string; qualifier?: string }) => {
      try {
        const claim = service.createClaim(db, content, qualifier);
        const lines = [`Created claim #${claim.id}`, "", HINTS.claimNoWarrants];
        if (!reviewConfig) lines.push("", HINTS.reviewSkipped);
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(formatError(e));
      }
    })
  );

  // ===========================================================================
  // 2. create_statement
  // ===========================================================================
  server.registerTool(
    "create_statement",
    {
      title: TOOLS.create_statement.title,
      description: TOOLS.create_statement.description,
      inputSchema: {
        content: z.string().describe(PARAMS.statement_content),
        source: z.enum(["literature", "observed"]).optional().describe(PARAMS.statement_source),
        verification: z.enum(["verified", "pending"]).optional().describe(PARAMS.statement_verification),
        attachments: z.array(z.string()).optional().describe(PARAMS.statement_attachments),
        rebuttal_for: z.object({
          target_id: z.number().describe(PARAMS.rebuttal_target_id),
          target_type: z.enum(["claim", "warrant"]).describe(PARAMS.rebuttal_target_type),
        }).optional().describe(PARAMS.rebuttal_for_stmt),
      },
    },
    withLog("create_statement", async (opts: any) => {
      try {
        const wantsVerified = (opts.verification ?? "pending") === "verified";
        let preCreateReviewResult: { errors: string[]; warnings: string[] } | null = null;
        let reviewFailed = false;
        if (reviewConfig && wantsVerified) {
          preCreateReviewResult = await reviewStatementEvidencePreCreate(reviewConfig, {
            content: opts.content || "",
            source: opts.source || "unknown",
            attachments: opts.attachments || [],
          });
          reviewFailed = preCreateReviewResult.errors.length > 0;
        }
        // Option A: 证据审查失败不拒绝创建，改为以 verification=pending 落库
        const effectiveVerification = reviewFailed ? "pending" : (opts.verification ?? "pending");
        const stmt = service.createStatement(db, {
          content: opts.content,
          source: opts.source ?? "observed",
          verification: effectiveVerification,
          attachments: opts.attachments,
          rebuttal_for: opts.rebuttal_for,
        });
        if (reviewConfig && preCreateReviewResult) {
          saveStatementReviewFile(reviewConfig, stmt.id, preCreateReviewResult);
        }
        const lines = [`Created statement #${stmt.id}`];
        if (reviewFailed && preCreateReviewResult) {
          lines.push("", "Evidence review did not pass — statement created with verification=pending.");
          lines.push(formatReviewIssues(preCreateReviewResult.errors, preCreateReviewResult.warnings));
        }
        if (effectiveVerification === "pending") {
          const src = opts.source ?? "observed";
          if (src === "literature") lines.push("", HINTS.groundPendingLiterature);
          else lines.push("", HINTS.groundPendingObserved);
        }
        if (!reviewConfig) lines.push("", HINTS.reviewSkipped);
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
      title: TOOLS.create_warrant.title,
      description: TOOLS.create_warrant.description,
      inputSchema: {
        claim_id: z.number().describe(PARAMS.warrant_claim_id),
        content: z.string().describe(PARAMS.warrant_content),
        ground_ids: z.array(z.number()).optional().describe(PARAMS.warrant_ground_ids),
      },
    },
    withLog("create_warrant", async ({ claim_id, content, ground_ids }: { claim_id: number; content: string; ground_ids?: number[] }) => {
      try {
        const warrant = service.createWarrant(db, { content, claimId: claim_id, groundIds: ground_ids });
        let text = appendInvalidateHint(
          `Created warrant #${warrant.id}`,
          compileService.invalidateCompiledClaims(db, warrant.id)
        );
        if (!reviewConfig) text += "\n\n" + HINTS.reviewSkipped;
        return ok(text);
      } catch (e) {
        return fail(formatError(e));
      }
    })
  );


  // ===========================================================================
  // 4. list_claims
  // ===========================================================================
  server.registerTool(
    "list_claims",
    {
      title: TOOLS.list_claims.title,
      description: TOOLS.list_claims.description,
      inputSchema: {
        status: z.string().optional().describe(PARAMS.claim_status_filter),
      },
    },
    withLog("list_claims", async ({ status }: { status?: string }) => {
      try {
        const claims = service.listClaims(db, status);
        if (claims.length === 0) return ok(MESSAGES.no_claims);
        const lines = claims.map(c => formatNodeLine(c));
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(formatError(e));
      }
    })
  );

  // ===========================================================================
  // 7. list_statements
  // ===========================================================================
  server.registerTool(
    "list_statements",
    {
      title: TOOLS.list_statements.title,
      description: TOOLS.list_statements.description,
      inputSchema: {
        source: z.string().optional().describe(PARAMS.statement_source_filter),
        verification: z.string().optional().describe(PARAMS.statement_verification_filter),
      },
    },
    withLog("list_statements", async ({ source, verification }: { source?: string; verification?: string }) => {
      try {
        const statements = service.listStatements(db, source, verification);
        if (statements.length === 0) return ok(MESSAGES.no_statements);
        const lines = statements.map(g => {
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
      title: TOOLS.get_argument.title,
      description: TOOLS.get_argument.description,
      inputSchema: {
        node_id: z.number().describe(PARAMS.any_node_id),
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
      title: TOOLS.get_node.title,
      description: TOOLS.get_node.description,
      inputSchema: {
        node_id: z.number().describe(PARAMS.node_id),
      },
    },
    withLog("get_node", async ({ node_id }: { node_id: number }) => {
      try {
        const row = repo.getNodeById(db, node_id);
        if (!row) return fail(`Node not found: ${node_id}`);
        return ok(formatNodeDetail(row, db));
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
      title: TOOLS.search_nodes.title,
      description: TOOLS.search_nodes.description,
      inputSchema: {
        keyword: z.string().describe(PARAMS.search_keyword),
        node_type: z.enum(["claim", "statement", "warrant", "ground", "backing", "rebuttal"]).optional().describe(PARAMS.node_type_filter),
      },
    },
    withLog("search_nodes", async ({ keyword, node_type }: { keyword: string; node_type?: string }) => {
      try {
        const results = service.searchNodesService(db, keyword, node_type);
        if (results.length === 0) return ok(MESSAGES.no_matching_nodes);
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
      title: TOOLS.get_stats.title,
      description: TOOLS.get_stats.description,
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
      title: TOOLS.update_node.title,
      description: TOOLS.update_node.description,
      inputSchema: {
        node_id: z.number().describe(PARAMS.node_id_to_update),
        content: z.string().optional().describe(PARAMS.new_content),
        attachments: z.array(z.string()).optional().describe(PARAMS.new_attachments),
        status: z.enum(["proposed", "supported", "disputed", "refuted"]).optional().describe(PARAMS.claim_status),
        source: z.enum(["literature", "observed"]).optional().describe(PARAMS.statement_source),
        verification: z.enum(["verified", "pending"]).optional().describe(PARAMS.statement_verification),
        ground_ids: z.object({
          add: z.array(z.number()).optional(),
          remove: z.array(z.number()).optional(),
        }).optional().describe(PARAMS.ground_ids_incremental),
        backing_ids: z.object({
          add: z.array(z.number()).optional(),
          remove: z.array(z.number()).optional(),
        }).optional().describe(PARAMS.backing_ids_incremental),
        rebuttal_ids: z.object({
          add: z.array(z.number()).optional(),
          remove: z.array(z.number()).optional(),
        }).optional().describe(PARAMS.rebuttal_ids_incremental),
        qualifier: z.string().optional().describe(PARAMS.qualifier_update),
      },
    },
    withLog("update_node", async (opts: any) => {
      try {
        const { node, warnings: serviceWarnings } = service.updateNode(db, opts.node_id, {
          content: opts.content,
          attachments: opts.attachments,
          status: opts.status,
          source: opts.source,
          verification: opts.verification,
          ground_ids: opts.ground_ids,
          backing_ids: opts.backing_ids,
          rebuttal_ids: opts.rebuttal_ids,
          qualifier: opts.qualifier,
        });

        // Statement 证据审查（阻断式：失败则回退 verification）
        if (reviewConfig && node.type === "statement" && opts.verification === "verified") {
          try {
            const reviewResult = await executeStatementReview(reviewConfig, db, node.id);
            if (reviewResult.errors.length > 0) {
              revertGroundVerification(db, node.id);
              return fail(formatReviewIssues(reviewResult.errors, reviewResult.warnings));
            }
          } catch { /* 审查本身出错不阻断 */ }
        }

        // 改变论证结构（内容或关系）才使已通过的 compile 失效；
        // verification/source/qualifier/status 不影响逻辑链，不触发失效
        const structuralChange =
          opts.content !== undefined ||
          opts.ground_ids !== undefined ||
          opts.backing_ids !== undefined ||
          opts.rebuttal_ids !== undefined;
        const invalidateWarnings = structuralChange
          ? compileService.invalidateCompiledClaims(db, opts.node_id)
          : [];
        let text = `Updated ${formatNodeBrief(node)}`;
        if (serviceWarnings.length > 0) text += "\n" + formatReviewIssues([], serviceWarnings);
        if (node.type === "statement" && opts.verification === "pending") {
          const src = node.source ?? "observed";
          if (src === "literature") text += "\n\n" + HINTS.groundPendingLiterature;
          else text += "\n\n" + HINTS.groundPendingObserved;
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
      title: TOOLS.delete_node.title,
      description: TOOLS.delete_node.description,
      inputSchema: {
        node_id: z.number().describe(PARAMS.node_id_to_delete),
        cascade: z.boolean().optional().default(false).describe(PARAMS.cascade_delete),
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
      title: TOOLS.compile_arguments.title,
      description: TOOLS.compile_arguments.description,
      inputSchema: {
        claim_ids: z.array(z.number()).optional().describe(PARAMS.claim_ids_to_compile),
      },
    },
    withLog("compile_arguments", async ({ claim_ids }: { claim_ids?: number[] }) => {
      if (!reviewConfig) return fail(MESSAGES.review_not_configured);
      const ids = claim_ids ?? repo.listNodesByType(db, "claim").map(r => r.id);
      if (ids.length === 0) return ok(MESSAGES.no_claims_to_compile);
      const results = await compileService.compileClaims(db, reviewConfig, ids);
      const { errors, warnings, infos } = collectReviewIssues(results);

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

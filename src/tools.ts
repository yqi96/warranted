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
import { mapLimit } from "./concurrency.ts";
import { reviewCwd } from "./review-config.ts";
import { existsSync } from "fs";
import { resolve, sep } from "path";

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
function formatNodeLine(node: ToulminNode): string {
  const content = node.content;
  const tagStr = node.tags && node.tags.length > 0 ? ` {${node.tags.join(", ")}}` : "";
  switch (node.type) {
    case "claim":
      return `#${node.id} [${node.status}] ${content}${tagStr}`;
    case "statement":
      return `#${node.id} [${node.source}/${node.verification}] ${content}${tagStr}`;
    default:
      return `#${node.id} ${content}${tagStr}`;
  }
}

/** 单节点完整字段格式，供 get_node 使用 */
function formatNodeDetail(row: NodeRow, db: Database): string {
  const data = JSON.parse(row.data);
  const lines: string[] = [`[${row.type} #${row.id}]`];
  lines.push(`content: ${row.content}`);

  // Append tags if present
  const tags = repo.getNodeTags(db, row.id);
  if (tags.length > 0) lines.push(`tags: {${tags.join(", ")}}`);

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

  // Scale block
  if (stats.scale) {
    const s = stats.scale;
    lines.push("", "## Scale", "");
    lines.push(`Tags: ${s.tags.total} in ${s.tags.namespaces.length} namespaces`);
    for (const ns of s.tags.namespaces) {
      const empty = ns.count - ns.with_nodes;
      const emptyStr = empty > 0 ? ` (${ns.with_nodes} with nodes, ${empty} empty)` : "";
      lines.push(`  ${ns.name}:${" ".repeat(Math.max(1, 6 - ns.name.length))}${ns.count}${emptyStr}   [${ns.cardinality}]`);
    }
    lines.push(`Statements: ${s.statements.total} (${s.statements.tagged} tagged, ${s.statements.untagged} untagged)`);

    // Namespace gaps
    if (s.namespace_gaps.length > 0) {
      const omitted = s.gaps_omitted > 0 ? ` — ${s.gaps_omitted} more pair(s) omitted` : "";
      lines.push(`Namespace gaps (nodes carrying A but not B):${omitted}`);
      for (const gap of s.namespace_gaps) {
        lines.push(`  ${gap.from}: -> ${gap.to}:   ${gap.count}`);
      }
    }

    // Roles
    lines.push(`Roles: ${s.roles.grounds.total} grounds (${s.roles.grounds.verified} verified / ${s.roles.grounds.pending} pending), ${s.roles.backings.total} backings (${s.roles.backings.total - s.roles.backings.pending} / ${s.roles.backings.pending}), ${s.roles.rebuttals.total} rebuttals (${s.roles.rebuttals.total - s.roles.rebuttals.pending} / ${s.roles.rebuttals.pending})`);

    // Claims detail. The three sub-counts partition `proposed`, so the headline
    // total is the real claim count, not their sum (§4.1).
    const statusParts = Object.entries(stats.claims.by_status).map(([st, n]) => `${n} ${st}`);
    lines.push(`Claims: ${stats.claims.total}${statusParts.length > 0 ? ` — ${statusParts.join(", ")}` : ""}`);
    const staleStr = s.claims_detail.stale.count > 0
      ? `${s.claims_detail.stale.count} stale [#${s.claims_detail.stale.ids.join(" #")}]`
      : "";
    const detailParts = [
      `${s.claims_detail.never_compiled} never compiled`,
      staleStr,
      `${s.claims_detail.passed_awaiting} passed-awaiting-verdict`,
    ].filter(Boolean);
    lines.push(`  ${detailParts.join(" | ")}`);

    // Attachments
    if (s.attachments.total > 0) {
      if (s.attachments.files.length <= 8) {
        const fileStr = s.attachments.files.map(f => f.missing ? `${f.path} (missing)` : f.path).join(", ");
        lines.push(`Attachments: ${s.attachments.total} — ${fileStr}`);
      } else {
        lines.push(`Attachments: ${s.attachments.total} distinct files referenced`);
      }
    }
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

/**
 * §4.3: every attachment path must resolve from the review cwd.
 *
 * Shared by all three attachment write entry points (`create_statement`,
 * `create_statements`, `update_node`) so they cannot diverge, and derived from
 * the same `reviewCwd(config)` the reviewer itself runs under — a validator
 * computing a different cwd than the reviewer would pass writes that verify
 * later fails on, which is worse than no validator at all (§4.3.1).
 *
 * Out-of-root paths are a warning, not an error: whether the reviewer can read
 * them depends on runtime permission semantics this repository does not
 * control, and legitimate out-of-root artifacts exist (shared data volumes,
 * cluster output dirs). The skill layer, which knows its own scenario,
 * escalates to a hard stop (§4.3.2).
 */
function checkAttachmentPaths(
  reviewConfig: ReviewConfig | null,
  paths: string[] | undefined
): { error?: string; warnings: string[] } {
  const warnings: string[] = [];
  if (!paths || paths.length === 0) return { warnings };
  for (const p of paths) {
    if (p.startsWith("http://") || p.startsWith("https://")) {
      return { error: `Attachment path "${p}" is a URL. Use local file paths.`, warnings };
    }
    if (!reviewConfig) continue;
    const cwd = reviewCwd(reviewConfig);
    const resolved = resolve(cwd, p);
    if (!existsSync(resolved)) {
      return { error: `Attachment "${p}" does not resolve from the review working directory.`, warnings };
    }
    if (!resolved.startsWith(cwd.endsWith(sep) ? cwd : cwd + sep)) {
      warnings.push(WARNINGS.attachmentOutOfRoot(p));
    }
  }
  return { warnings };
}

/**
 * §4.2: `paper:` tag with a non-literature source. Stated as a neutral fact
 * with both legitimate readings — in reproduction this combination is the
 * correct usage, and an imperative here would train those users to ignore
 * every warning the server emits.
 */
function paperTagWarnings(
  tags: string[] | undefined,
  source: string | undefined,
  itemRef: string
): string[] {
  if (!tags || tags.length === 0 || source !== "observed") return [];
  const paperTags = tags.filter(t => t.startsWith("paper:"));
  if (paperTags.length === 0) return [];
  return [WARNINGS.paperTagObservedSource(itemRef, paperTags)];
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
        tags: z.array(z.string()).optional().describe(PARAMS.tag_tags_array),
      },
    },
    withLog("create_claim", async ({ content, qualifier, tags }: { content: string; qualifier?: string; tags?: string[] }) => {
      try {
        const claim = service.createClaim(db, content, qualifier, tags);
        const lines = [`Created claim #${claim.id}`, "", HINTS.claimNoWarrants];
        if (tags && tags.length > 0) lines.push(`Tags: ${tags.join(", ")}`);
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
        source: z.enum(["literature", "observed"]).describe(PARAMS.statement_source),
        verification: z.enum(["verified", "pending"]).optional().describe(PARAMS.statement_verification),
        attachments: z.array(z.string()).optional().describe(PARAMS.statement_attachments),
        rebuttal_for: z.object({
          target_id: z.number().describe(PARAMS.rebuttal_target_id),
          target_type: z.enum(["claim", "warrant"]).describe(PARAMS.rebuttal_target_type),
        }).optional().describe(PARAMS.rebuttal_for_stmt),
        tags: z.array(z.string()).optional().describe(PARAMS.tag_tags_array),
      },
    },
    withLog("create_statement", async (opts: any) => {
      try {
        // §4.3: path resolution check (with reviewCwd when available)
        const pathCheck = checkAttachmentPaths(reviewConfig, opts.attachments);
        if (pathCheck.error) return fail(pathCheck.error);

        const wantsVerified = (opts.verification ?? "pending") === "verified";
        let preCreateReviewResult: { errors: string[]; warnings: string[]; reviewError?: string } | null = null;
        let reviewFailed = false;
        if (reviewConfig && wantsVerified) {
          preCreateReviewResult = await reviewStatementEvidencePreCreate(reviewConfig, {
            content: opts.content || "",
            source: opts.source,
            attachments: opts.attachments || [],
          });
          // §3.0: a review that never completed must not produce a verified node either
          reviewFailed = preCreateReviewResult.errors.length > 0 || preCreateReviewResult.reviewError !== undefined;
        }
        // Option A: 证据审查失败不拒绝创建，改为以 verification=pending 落库
        const effectiveVerification = reviewFailed ? "pending" : (opts.verification ?? "pending");
        const stmt = service.createStatement(db, {
          content: opts.content,
          source: opts.source,
          verification: effectiveVerification,
          attachments: opts.attachments,
          rebuttal_for: opts.rebuttal_for,
          tags: opts.tags,
        });
        if (reviewConfig && preCreateReviewResult) {
          saveStatementReviewFile(reviewConfig, stmt.id, preCreateReviewResult);
        }

        // §2: create_statement(rebuttal_for=) 必须触发失效，与 update_node 入口行为一致
        const invalidateWarnings: string[] = [];
        if (opts.rebuttal_for) {
          invalidateWarnings.push(...compileService.invalidateCompiledClaims(db, opts.rebuttal_for.target_id));
        }

        const lines = [`Created statement #${stmt.id}`];
        if (opts.tags && opts.tags.length > 0) lines.push(`Tags: ${opts.tags.join(", ")}`);
        for (const w of pathCheck.warnings) lines.push("", w);
        for (const w of paperTagWarnings(opts.tags, opts.source, `#${stmt.id}`)) lines.push("", w);
        if (reviewFailed && preCreateReviewResult) {
          lines.push("", "Evidence review did not pass — statement created with verification=pending.");
          if (preCreateReviewResult.reviewError) {
            lines.push(`review errored: ${preCreateReviewResult.reviewError}`);
          }
          lines.push(formatReviewIssues(preCreateReviewResult.errors, preCreateReviewResult.warnings));
        }
        if (effectiveVerification === "pending") {
          if (opts.source === "literature") lines.push("", HINTS.groundPendingLiterature);
          else lines.push("", HINTS.groundPendingObserved);
        }
        if (!reviewConfig) lines.push("", HINTS.reviewSkipped);
        if (invalidateWarnings.length > 0) {
          lines.push("", invalidateWarnings.join("\n"));
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
      title: TOOLS.create_warrant.title,
      description: TOOLS.create_warrant.description,
      inputSchema: {
        claim_id: z.number().describe(PARAMS.warrant_claim_id),
        content: z.string().describe(PARAMS.warrant_content),
        ground_ids: z.array(z.number()).optional().describe(PARAMS.warrant_ground_ids),
        backing_ids: z.array(z.number()).optional().describe(PARAMS.backing_ids_incremental),
      },
    },
    withLog("create_warrant", async ({ claim_id, content, ground_ids, backing_ids }: { claim_id: number; content: string; ground_ids?: number[]; backing_ids?: number[] }) => {
      try {
        // Validate backing_ids: each must exist and be type 'statement'
        if (backing_ids && backing_ids.length > 0) {
          for (const bid of backing_ids) {
            const row = repo.getNodeById(db, bid);
            if (!row) return fail(`Backing node #${bid} not found.`);
            if (row.type !== "statement") return fail(`Node #${bid} is type "${row.type}", expected "statement".`);
          }
        }
        const warrant = service.createWarrant(db, { content, claimId: claim_id, groundIds: ground_ids, backingIds: backing_ids });
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
  // 4. create_statements (batch)
  // ===========================================================================
  server.registerTool(
    "create_statements",
    {
      title: TOOLS.create_statements.title,
      description: TOOLS.create_statements.description,
      inputSchema: {
        statements: z.array(z.object({
          content: z.string().describe(PARAMS.statement_content),
          source: z.enum(["literature", "observed"]).describe(PARAMS.statement_source),
          verification: z.enum(["verified", "pending"]).optional().describe(PARAMS.statement_verification),
          attachments: z.array(z.string()).optional().describe(PARAMS.statement_attachments),
          tags: z.array(z.string()).optional().describe(PARAMS.tag_tags_array),
        })).min(1).max(50).describe("Array of statements to create (1-50)"),
      },
    },
    withLog("create_statements", async (opts: any) => {
      try {
        const items = opts.statements || [];
        // Zod schema validation is bypassed by the mock server, so enforce limits here
        if (items.length === 0) {
          return fail('At least one statement is required.');
        }
        if (items.length > 50) {
          return fail(`Maximum 50 statements allowed, got ${items.length}.`);
        }
        const failures: Array<{ index: number; reason: string }> = [];
        const pathWarnings: string[] = [];

        // Phase 1: validate every item, collecting every failure (§2.2).
        // Aborting at the first one would make a 3-bad-item batch cost three
        // round trips, and §2.1's "atomic = a predictable retry unit" argument
        // rests on one report listing everything.
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          try {
            service.assertStatementWritable(db, {
              content: item.content,
              source: item.source,
              verification: item.verification || 'pending',
              attachments: item.attachments,
              tags: item.tags,
            });
            const pathCheck = checkAttachmentPaths(reviewConfig, item.attachments);
            if (pathCheck.error) {
              failures.push({ index: i, reason: pathCheck.error });
              continue;
            }
            for (const w of pathCheck.warnings) pathWarnings.push(`item[${i}]: ${w}`);
          } catch (e) {
            failures.push({ index: i, reason: formatError(e) });
          }
        }

        // If any failures, reject whole batch
        if (failures.length > 0) {
          const lines = failures.map(f => `  item[${f.index}]: ${f.reason}`);
          return fail(`Batch rejected — ${failures.length} of ${items.length} items failed validation. No statements were created.\n${lines.join('\n')}\nFix all listed items and resend the batch.`);
        }

        // Phase 2: write all in transaction
        const created: number[] = [];
        const warnings: string[] = [...pathWarnings];
        db.transaction(() => {
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const stmt = service.createStatement(db, {
              content: item.content,
              source: item.source,
              verification: item.verification || 'pending',
              attachments: item.attachments,
              tags: item.tags,
            });
            created.push(stmt.id);
            warnings.push(...paperTagWarnings(item.tags, item.source, `item[${i}] #${stmt.id}`));
          }
        })();

        const lines = created.map(id => `#${id} created`);
        if (warnings.length > 0) {
          lines.push('', ...warnings);
        }
        if (!reviewConfig) lines.push('', HINTS.reviewSkipped);
        return ok(lines.join('\n'));
      } catch (e) {
        return fail(formatError(e));
      }
    })
  );

  // ===========================================================================
  // 5. verify_statements (batch)
  // ===========================================================================
  server.registerTool(
    "verify_statements",
    {
      title: TOOLS.verify_statements.title,
      description: TOOLS.verify_statements.description,
      inputSchema: {
        ids: z.array(z.number()).min(1).max(50).describe("Statement IDs to verify (1-50)"),
      },
    },
    withLog("verify_statements", async (opts: { ids: number[] }) => {
      if (!reviewConfig) return fail(MESSAGES.review_not_configured);
      try {
        const ids = opts.ids || [];
        const results = await mapLimit(ids, undefined, async (id: number) => {
          const row = repo.getNodeById(db, id);
          if (!row) return { id, outcome: 'skipped', error: 'Statement not found' };
          // §4.3: recheck paths before spending a review. The creation-time check
          // blocks "wrong from the start" but not "moved afterwards", and the
          // latter is the norm across a long-running task.
          const data = JSON.parse(row.data);
          const pathCheck = checkAttachmentPaths(reviewConfig, data.attachments || []);
          if (pathCheck.error) {
            return { id, outcome: 'errored', error: pathCheck.error };
          }
          try {
            const reviewResult = await executeStatementReview(reviewConfig, db, id);
            // §3.0's third outcome, checked before the verdict: the review did not
            // complete, so the statement has not been evaluated at all. Reported
            // separately from "the reviewer judged it failing" because the
            // prescriptions are opposite — retry vs. fix the evidence.
            if (reviewResult.reviewError) {
              return { id, outcome: 'errored', error: reviewResult.reviewError };
            }
            if (reviewResult.deniedTools && reviewResult.deniedTools.length > 0) {
              return { id, outcome: 'errored', error: `review denied tool call(s): ${reviewResult.deniedTools.join(', ')}` };
            }
            if (reviewResult.errors.length > 0) {
              return { id, outcome: 'failed', errors: reviewResult.errors, warnings: reviewResult.warnings };
            }
            // Review passed → mark as verified
            const passedRow = repo.getNodeById(db, id);
            if (passedRow) {
              const nodeData = JSON.parse(passedRow.data);
              nodeData.verification = 'verified';
              repo.updateNodeFields(db, id, { data: nodeData });
            }
            return { id, outcome: 'passed', warnings: reviewResult.warnings };
          } catch (e) {
            return { id, outcome: 'errored', error: formatError(e) };
          }
        });

        const passed = results.filter(r => r.outcome === 'passed').length;
        const failed = results.filter(r => r.outcome === 'failed').length;
        const errored = results.filter(r => r.outcome === 'errored').length;
        const skipped = results.filter(r => r.outcome === 'skipped').length;

        const unchanged = ids.length - passed;
        const lines: string[] = [
          unchanged > 0
            ? `Verified ${passed}/${ids.length} (${unchanged} unchanged)`
            : `Verified ${passed}/${ids.length}`,
        ];
        if (failed > 0) {
          lines.push(`Review judged failing: ${failed}`);
          for (const r of results.filter(r => r.outcome === 'failed')) {
            lines.push(`  #${r.id}: ${(r as any).errors?.join('; ') || ''}`);
          }
        }
        if (errored > 0) {
          lines.push(`Not evaluated — review infrastructure failed on ${errored}; retry rather than editing the statements`);
          for (const r of results.filter(r => r.outcome === 'errored')) {
            lines.push(`  #${r.id}: review errored: ${(r as any).error || ''}`);
          }
        }
        if (skipped > 0) {
          lines.push(`Skipped: ${skipped}`);
          for (const r of results.filter(r => r.outcome === 'skipped')) {
            lines.push(`  #${r.id}: ${(r as any).error || ''}`);
          }
        }
        return ok(lines.join('\n'));
      } catch (e) {
        return fail(formatError(e));
      }
    })
  );

  // ===========================================================================
  // 6. tag_nodes (batch)
  // ===========================================================================
  server.registerTool(
    "tag_nodes",
    {
      title: TOOLS.tag_nodes.title,
      description: TOOLS.tag_nodes.description,
      inputSchema: {
        node_ids: z.array(z.number()).min(1).max(200).describe("Node IDs to tag (1-200)"),
        add: z.array(z.string()).optional().describe(PARAMS.tag_tags_array),
        remove: z.array(z.string()).optional().describe(PARAMS.tag_tags_array),
      },
    },
    withLog("tag_nodes", async (opts: { node_ids: number[]; add?: string[]; remove?: string[] }) => {
      try {
        // Zod schema validation is bypassed by the mock server, so enforce limits here
        if (opts.node_ids.length > 200) {
          return fail(`Maximum 200 node_ids allowed, got ${opts.node_ids.length}.`);
        }
        // Whole-call rejection on an unregistered tag: a taxonomic operation is
        // all-correct or untouched. Routed through the shared service check so
        // the near-match suggestion arrives here too.
        if (opts.add && opts.add.length > 0) {
          service.assertTagsRegistered(db, opts.add);
        }
        // Transaction: INSERT OR IGNORE / DELETE
        const failedIds: number[] = [];
        db.transaction(() => {
          for (const nid of opts.node_ids) {
            const row = repo.getNodeById(db, nid);
            if (!row) { failedIds.push(nid); continue; }
            if (opts.add) repo.addNodeTags(db, nid, opts.add);
            if (opts.remove) repo.removeNodeTags(db, nid, opts.remove);
          }
        })();
        const added = opts.add?.length ?? 0;
        const removed = opts.remove?.length ?? 0;
        let text = `Tagged ${opts.node_ids.length - failedIds.length} nodes (+${added}/-${removed} tags each)`;
        if (failedIds.length > 0) text += `\nSkipped (node not found): ${failedIds.join(', ')}`;
        return ok(text);
      } catch (e) {
        return fail(formatError(e));
      }
    })
  );

  // ===========================================================================
  // 7. update_tag
  // ===========================================================================
  server.registerTool(
    "update_tag",
    {
      title: TOOLS.update_tag.title,
      description: TOOLS.update_tag.description,
      inputSchema: {
        name: z.string().describe(PARAMS.tag_name),
        description: z.string().optional().describe(PARAMS.tag_description),
        claim_id: z.number().optional().describe(PARAMS.tag_claim_id),
      },
    },
    withLog("update_tag", async (opts: { name: string; description?: string; claim_id?: number }) => {
      try {
        service.updateTagService(db, opts.name, opts.description, opts.claim_id);
        return ok(`Updated tag "${opts.name}"`);
      } catch (e) {
        return fail(formatError(e));
      }
    })
  );


  // ===========================================================================
  // 8. list_claims
  // ===========================================================================
  server.registerTool(
    "list_claims",
    {
      title: TOOLS.list_claims.title,
      description: TOOLS.list_claims.description,
      inputSchema: {
        status: z.string().optional().describe(PARAMS.claim_status_filter),
        compile_status: z.string().optional().describe(PARAMS.claim_compile_status_filter),
        tag: z.string().optional().describe(PARAMS.tag_filter),
        limit: z.number().optional().default(50).describe(PARAMS.pagination_limit),
        offset: z.number().optional().default(0).describe(PARAMS.pagination_offset),
      },
    },
    withLog("list_claims", async ({ status, compile_status, tag, limit, offset }: { status?: string; compile_status?: string; tag?: string; limit?: number; offset?: number }) => {
      try {
        const result = service.listClaims(db, status, compile_status, tag, limit ?? 50, offset ?? 0);
        const { rows, total } = result;
        if (rows.length === 0) return ok(MESSAGES.no_claims);
        const lines: string[] = [];
        if (rows.length < total) {
          lines.push(`Showing ${rows.length} of ${total} (offset ${offset ?? 0}) — narrow with tag/status filters or search_nodes`);
        }
        // Pre-compute compile_status for each claim
        const csMap = new Map<number, string | null>();
        for (const c of rows) {
          const row = repo.getNodeById(db, c.id);
          if (row) {
            const data = JSON.parse(row.data);
            csMap.set(c.id, data.compile_status ?? null);
          }
        }
        lines.push(...rows.map(c => {
          const cs = csMap.get(c.id);
          const csStr = cs ? ` compile:${cs}` : "";
          const tagStr = c.tags && c.tags.length > 0 ? ` {${c.tags.join(", ")}}` : "";
          return `#${c.id} [${c.status}]${csStr} ${c.content}${tagStr}`;
        }));
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(formatError(e));
      }
    })
  );

  // ===========================================================================
  // 9. list_statements
  // ===========================================================================
  server.registerTool(
    "list_statements",
    {
      title: TOOLS.list_statements.title,
      description: TOOLS.list_statements.description,
      inputSchema: {
        source: z.string().optional().describe(PARAMS.statement_source_filter),
        verification: z.string().optional().describe(PARAMS.statement_verification_filter),
        tag: z.string().optional().describe(PARAMS.tag_filter),
        without_tag: z.string().optional().describe(PARAMS.tag_without_filter),
        role: z.enum(["ground", "backing", "rebuttal"]).optional().describe(PARAMS.statement_role_filter),
        limit: z.number().optional().default(50).describe(PARAMS.pagination_limit),
        offset: z.number().optional().default(0).describe(PARAMS.pagination_offset),
      },
    },
    withLog("list_statements", async ({ source, verification, tag, without_tag, role, limit, offset }: { source?: string; verification?: string; tag?: string; without_tag?: string; role?: string; limit?: number; offset?: number }) => {
      try {
        const result = service.listStatements(db, source, verification, tag, without_tag, role, limit ?? 50, offset ?? 0);
        const { rows, total } = result;
        if (rows.length === 0) return ok(MESSAGES.no_statements);
        const lines: string[] = [];
        if (rows.length < total) {
          lines.push(`Showing ${rows.length} of ${total} (offset ${offset ?? 0}) — narrow with tag/status filters or search_nodes`);
        }
        lines.push(...rows.map(g => formatNodeLine(g)));
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(formatError(e));
      }
    })
  );

  // ===========================================================================
  // 10. get_argument
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
  // 11. get_node
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
  // 12. search_nodes
  // ===========================================================================
  server.registerTool(
    "search_nodes",
    {
      title: TOOLS.search_nodes.title,
      description: TOOLS.search_nodes.description,
      inputSchema: {
        keyword: z.string().describe(PARAMS.search_keyword),
        node_type: z.enum(["claim", "statement", "warrant", "ground", "backing", "rebuttal"]).optional().describe(PARAMS.node_type_filter),
        tag: z.string().optional().describe(PARAMS.tag_filter),
        limit: z.number().optional().default(20).describe(PARAMS.pagination_limit),
        offset: z.number().optional().default(0).describe(PARAMS.pagination_offset),
      },
    },
    withLog("search_nodes", async ({ keyword, node_type, tag, limit, offset }: { keyword: string; node_type?: string; tag?: string; limit?: number; offset?: number }) => {
      try {
        const result = service.searchNodesService(db, keyword, node_type, tag, limit ?? 20, offset ?? 0);
        const { rows, total } = result;
        if (rows.length === 0) return ok(MESSAGES.no_matching_nodes);
        const lines: string[] = [];
        if (rows.length < total) {
          lines.push(`Showing ${rows.length} of ${total} (offset ${offset ?? 0}) — narrow with node_type/tag filters or a longer keyword`);
        }
        lines.push(...rows.map(n => formatNode(n)));
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(formatError(e));
      }
    })
  );

  // ===========================================================================
  // 13. get_stats
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
  // 14. update_node
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
        tags: z.object({
          add: z.array(z.string()).optional(),
          remove: z.array(z.string()).optional(),
        }).optional().describe(PARAMS.tag_tags_object),
      },
    },
    withLog("update_node", async (opts: any) => {
      try {
        // Companion 1: 读取 status 旧值，用于判断是否为实际值变更（非 presence 语义）
        let oldStatus: string | undefined;
        if (opts.status !== undefined) {
          const preRow = repo.getNodeById(db, opts.node_id);
          if (preRow?.type === "claim") {
            const preData = JSON.parse(preRow.data);
            oldStatus = preData.status || "proposed";
          }
        }

        // §4.3: path resolution check for update_node (the third attachment write
        // entry point). Must run BEFORE service.updateNode to prevent data modification.
        const pathCheck = checkAttachmentPaths(reviewConfig, opts.attachments);
        if (pathCheck.error) return fail(pathCheck.error);

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
          tags: opts.tags,
        });

        // Statement 证据审查（阻断式：失败则回退 verification）
        if (reviewConfig && node.type === "statement" && opts.verification === "verified") {
          try {
            const reviewResult = await executeStatementReview(reviewConfig, db, node.id);
            // §3.0's third outcome: an infrastructure failure must not leave a
            // `verified` node behind — on the graph that is indistinguishable
            // from a genuine pass while zero reviews actually happened.
            const infraError = reviewResult.reviewError
              ?? (reviewResult.deniedTools && reviewResult.deniedTools.length > 0
                ? `review denied tool call(s): ${reviewResult.deniedTools.join(", ")}`
                : undefined);
            if (infraError) {
              revertGroundVerification(db, node.id);
              return fail(formatReviewIssues([`review errored: ${infraError}`], reviewResult.warnings));
            }
            if (reviewResult.errors.length > 0) {
              revertGroundVerification(db, node.id);
              return fail(formatReviewIssues(reviewResult.errors, reviewResult.warnings));
            }
          } catch (e) {
            revertGroundVerification(db, node.id);
            return fail(formatReviewIssues([`review errored: ${formatError(e)}`], []));
          }
        }

        // 改变论证结构（内容或关系）才使已通过的 compile 失效；
        // verification/source/qualifier 不影响逻辑链，不触发失效
        // Companion 1: status 变更纳入向上失效，但仅在 value 实际改变时触发（非 presence 语义）
        const statusChanged = opts.status !== undefined && oldStatus !== undefined && opts.status !== oldStatus;
        const otherStructuralChange =
          opts.content !== undefined ||
          opts.ground_ids !== undefined ||
          opts.backing_ids !== undefined ||
          opts.rebuttal_ids !== undefined;
        const structuralChange = otherStructuralChange || statusChanged;
        // 排除起点自身只对"纯 status 变更"成立：同一次调用里若还改了 content/关系，
        // 起点自己的 compile 依据已经失效，必须照常失效，否则它会带着 passed 活下来。
        const skipStartNode = statusChanged && !otherStructuralChange;
        const invalidateWarnings = structuralChange
          ? compileService.invalidateCompiledClaims(db, opts.node_id, skipStartNode ? new Set([opts.node_id]) : undefined)
          : [];
        let text = `Updated ${formatNodeBrief(node)}`;
        if (serviceWarnings.length > 0) text += "\n" + formatReviewIssues([], serviceWarnings);
        for (const w of pathCheck.warnings) text += "\n" + w;
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
  // 15. delete_node
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
        // deleteNode owns the ordering (invalidate the whole cascade set inside its
        // transaction, before any row is removed); the invalidator is injected because
        // compile-service imports from service.ts and a direct import would be circular.
        const invalidateWarnings: string[] = [];
        const serviceWarnings = service.deleteNode(db, node_id, cascade, (id) => {
          invalidateWarnings.push(...compileService.invalidateCompiledClaims(db, id));
        });
        let text = `Deleted node #${node_id}`;
        if (serviceWarnings.length > 0) text += "\n" + formatReviewIssues([], serviceWarnings);
        return ok(appendInvalidateHint(text, invalidateWarnings));
      } catch (e) {
        return fail(formatError(e));
      }
    })
  );

  // ===========================================================================
  // 16. compile_arguments
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

  // ===========================================================================
  // 17. create_tag
  // ===========================================================================
  server.registerTool(
    "create_tag",
    {
      title: TOOLS.create_tag.title,
      description: TOOLS.create_tag.description,
      inputSchema: {
        name: z.string().describe(PARAMS.tag_name),
        description: z.string().describe(PARAMS.tag_description),
        claim_id: z.number().optional().describe(PARAMS.tag_claim_id),
        namespace_cardinality: z.enum(["dense", "bounded"]).optional().describe(PARAMS.tag_namespace_cardinality),
      },
    },
    withLog("create_tag", async (opts: { name: string; description: string; claim_id?: number; namespace_cardinality?: "dense" | "bounded" }) => {
      try {
        const { tag, warnings } = service.createTagService(db, opts.name, opts.description, opts.claim_id, opts.namespace_cardinality);
        const lines = [`Registered tag "${tag.name}" — ${tag.description}`];
        if (tag.claim_id) lines.push(`Points to Claim #${tag.claim_id}`);
        if (warnings.length > 0) lines.push("", warnings.join("\n"));
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(formatError(e));
      }
    })
  );

  // ===========================================================================
  // 18. create_tags
  // ===========================================================================
  server.registerTool(
    "create_tags",
    {
      title: TOOLS.create_tags.title,
      description: TOOLS.create_tags.description,
      inputSchema: {
        tags: z.array(z.object({
          name: z.string(),
          description: z.string(),
          claim_id: z.number().optional(),
        })).min(1).max(200).describe(PARAMS.tag_tags_array_input),
        namespace_cardinality: z.enum(["dense", "bounded"]).optional().describe(PARAMS.tag_namespace_cardinality),
      },
    },
    withLog("create_tags", async (opts: { tags: Array<{ name: string; description: string; claim_id?: number }>; namespace_cardinality?: "dense" | "bounded" }) => {
      try {
        const { registered, failed, warnings } = service.createTagsService(db, opts.tags, opts.namespace_cardinality);
        const lines: string[] = [];
        for (const t of registered) {
          lines.push(`Registered: ${t.name} — ${t.description}`);
        }
        for (const f of failed) {
          lines.push(`Failed: ${f.name} — ${f.reason}`);
        }
        if (warnings.length > 0) lines.push("", warnings.join("\n"));
        if (registered.length === 0 && failed.length === 0) {
          lines.push("No tags registered (max 200 per call).");
        }
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(formatError(e));
      }
    })
  );

  // ===========================================================================
  // 19. list_tags
  // ===========================================================================
  server.registerTool(
    "list_tags",
    {
      title: TOOLS.list_tags.title,
      description: TOOLS.list_tags.description,
      inputSchema: {
        prefix: z.string().optional().describe(PARAMS.tag_prefix),
        min_count: z.number().optional().describe(PARAMS.tag_min_count),
        limit: z.number().optional().default(100).describe(PARAMS.pagination_limit),
        offset: z.number().optional().default(0).describe(PARAMS.pagination_offset),
      },
    },
    withLog("list_tags", async ({ prefix, min_count, limit, offset }: { prefix?: string; min_count?: number; limit?: number; offset?: number }) => {
      try {
        const tags = repo.listTagsWithCount(db, { prefix, min_count, limit: limit ?? 100, offset: offset ?? 0 });
        if (tags.length === 0) {
          return ok("No tags registered (small graphs usually do not need them).");
        }
        const total = repo.countTags(db, { prefix, min_count });
        const lines = tags.map(t => {
          let line = `${t.name} (${t.count} nodes) — ${t.description}`;
          if (t.claim_id) line += ` [→ Claim #${t.claim_id}]`;
          return line;
        });
        if (tags.length < total) {
          lines.unshift(`Showing ${tags.length} of ${total} (offset ${offset ?? 0}) — narrow with prefix/min_count filters`);
        }
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(formatError(e));
      }
    })
  );

  // ===========================================================================
  // 20. rename_tag
  // ===========================================================================
  server.registerTool(
    "rename_tag",
    {
      title: TOOLS.rename_tag.title,
      description: TOOLS.rename_tag.description,
      inputSchema: {
        from: z.string().describe(PARAMS.tag_from),
        to: z.string().describe(PARAMS.tag_to),
      },
    },
    withLog("rename_tag", async ({ from, to }: { from: string; to: string }) => {
      try {
        const { moved } = service.renameTagService(db, from, to);
        return ok(`Renamed "${from}" → "${to}" (${moved} nodes updated)`);
      } catch (e) {
        return fail(formatError(e));
      }
    })
  );

  // ===========================================================================
  // 21. merge_tags
  // ===========================================================================
  server.registerTool(
    "merge_tags",
    {
      title: TOOLS.merge_tags.title,
      description: TOOLS.merge_tags.description,
      inputSchema: {
        from: z.string().describe(PARAMS.tag_from),
        to: z.string().describe(PARAMS.tag_to),
      },
    },
    withLog("merge_tags", async ({ from, to }: { from: string; to: string }) => {
      try {
        const { moved, warnings } = service.mergeTagsService(db, from, to);
        const lines = [`Merged "${from}" → "${to}" (${moved} nodes moved)`];
        if (warnings.length > 0) lines.push("", warnings.join("\n"));
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(formatError(e));
      }
    })
  );

}

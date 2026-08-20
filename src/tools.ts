/**
 * Warranted — MCP 工具注册(11 个)
 *
 * 这一层**只负责形状**:zod 收口入参、调 service、把返回值序列化、把异常转成
 * `isError` 的文本。业务规则一条都不在这里——V1–V3、事件留痕、自动晋升、基线写入
 * 全在 service.ts,理由见那个文件的头注释。在这里补一条校验就等于把规则写成两份。
 *
 * 两个贯穿全文件的决定:
 *
 * 1. **返回结构化 JSON,不返回散文。** 结构检查警告的 id 是内容派生的 hash,
 *    调用方要原样抄回来给 `dismiss`;散文渲染每多一层就多一次抄错的机会。而且
 *    `warnings` / `findings` 出现在每条命题上(design.md §2.5),散文化它们要写
 *    一整套排版代码,那套代码会独立于 docs/ 漂移。
 * 2. **醒目由 banner 承担,不由格式承担。** JSON 里一个 `"state": "pending"` 是
 *    准确的但不醒目,所以有待处理项时在 JSON 前面加一行明文。§2.5 要求的"醒目"
 *    是这一行,不是字段本身。
 */

import type { Database } from "bun:sqlite";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as service from "./service.ts";
import { runReview } from "./review-run.ts";
import { ToulminError } from "./errors.ts";
import { checkContext, type CheckContext } from "./structural-check.ts";
import type { FindingView, PropositionView, StructuralWarning } from "./types.ts";
import { QUALIFIERS } from "./types.ts";
import { log, summarizeInput, summarizeOutput } from "./logger.ts";
import { TOOLS, PARAMS } from "./content/index.ts";
import type { ReviewConfig } from "./review-config.ts";

export interface Lifecycle {
  beginOp(): void;
  endOp(): void;
  drain(): Promise<void>;
}

// =============================================================================
// 返回值的形状
// =============================================================================

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  // MCP SDK 的 CallToolResult 是开放形状(允许附加字段),没有这行索引签名
  // 我们这个更窄的类型就不可赋值给它。
  [k: string]: unknown;
}

function text(s: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: s }], ...(isError ? { isError: true } : {}) };
}

/**
 * 成功返回。`banner` 是那行明文提示,没有待处理项时整行不出现——
 * 一条常亮的提示等于没有提示(warnings.ts 的同一条理由)。
 */
function ok(payload: unknown, banner?: string): ToolResult {
  const body = JSON.stringify(payload, null, 2);
  return text(banner ? `${banner}\n\n${body}` : body);
}

function fail(e: unknown): ToolResult {
  if (e instanceof ToulminError) return text(e.message, true);
  if (e instanceof Error) return text(e.message, true);
  return text(String(e), true);
}

// =============================================================================
// banner:把"有东西待处理"从一个字段提到一行明文
// =============================================================================

function pendingCounts(
  warnings: StructuralWarning[] = [],
  findings: FindingView[] = []
): { w: number; f: number } {
  return {
    w: warnings.filter((x) => x.state === "pending").length,
    f: findings.filter((x) => x.state === "pending").length,
  };
}

function bannerFor(warnings: StructuralWarning[] = [], findings: FindingView[] = []): string | undefined {
  const { w, f } = pendingCounts(warnings, findings);
  if (w === 0 && f === 0) return undefined;
  const parts: string[] = [];
  if (w > 0) parts.push(`${w} structural warning(s)`);
  if (f > 0) parts.push(`${f} unresolved review finding(s)`);
  // 措辞刻意是"标出",不是"你必须修":标红是提示不是拒绝(CLAUDE.md),
  // 驳回其中一条是正常动作。
  return `⚑ ${parts.join(", ")} on this proposition — read them below; settle each by fixing it or by dismiss with a reason.`;
}

/** 多条命题时把 banner 汇总成一行,并点名是哪几条——不点名就没法行动。 */
function bannerForMany(views: PropositionView[]): string | undefined {
  const flagged = views.filter((v) => {
    const { w, f } = pendingCounts(v.warnings, v.findings);
    return w > 0 || f > 0;
  });
  if (flagged.length === 0) return undefined;
  return `⚑ ${flagged.length} of ${views.length} proposition(s) have something unresolved: ${flagged
    .map((v) => `#${v.id}`)
    .join(", ")}`;
}

// =============================================================================
// 共用的 zod 片段
// =============================================================================

const qualifierEnum = z.enum(QUALIFIERS as unknown as [string, ...string[]]);

const evidenceInput = z
  .object({
    attachments: z.array(z.string()).optional().describe(PARAMS.attachments),
    nodes: z.array(z.number().int()).optional().describe(PARAMS.evidence_nodes),
  })
  .optional();

// =============================================================================
// 注册
// =============================================================================

type Handler = (input: any) => ToolResult | Promise<ToolResult>;

export function registerTools(
  server: McpServer,
  db: Database,
  dbPath: string,
  reviewConfig: ReviewConfig | null = null,
  lifecycle?: Lifecycle
): void {
  // 附件解析基准。校验器、结构检查、审查子进程必须用同一个基准,所以它在这里算一次
  // 然后一路传下去(structural-check.ts 的 CheckContext 注释)。
  // dbPath 是必填而不是有默认值的:一个"猜错了也能跑"的基准会让附件静默解析到别处,
  // 而附件存在性是三条硬拒之一——它错了,硬拒就形同虚设。
  const ctx: CheckContext = checkContext(dbPath);

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

  // ===========================================================================
  // 写入 1:create_propositions
  // ===========================================================================

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
        const all = results.flatMap((r) => r.warnings);
        return ok({ created: results }, bannerFor(all));
      } catch (e) {
        return fail(e);
      }
    })
  );

  // ===========================================================================
  // 写入 2:update_proposition
  // ===========================================================================

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
        return ok(r, bannerFor(r.warnings));
      } catch (e) {
        return fail(e);
      }
    })
  );

  // ===========================================================================
  // 写入 3:set_qualifier
  // ===========================================================================

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
        return ok({ updated: results }, bannerFor(results.flatMap((r) => r.warnings)));
      } catch (e) {
        return fail(e);
      }
    })
  );

  // ===========================================================================
  // 写入 4:promote_warrant
  // ===========================================================================

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
        return ok(r, bannerFor(r.warnings));
      } catch (e) {
        return fail(e);
      }
    })
  );

  // ===========================================================================
  // 写入 5:delete_proposition
  // ===========================================================================

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

  // ===========================================================================
  // 读取 1:get_argument
  // ===========================================================================

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
        return ok(r, bannerForMany([r.root, ...r.neighbors]));
      } catch (e) {
        return fail(e);
      }
    })
  );

  // ===========================================================================
  // 读取 2:find_propositions
  // ===========================================================================

  server.registerTool(
    "find_propositions",
    {
      title: TOOLS.find_propositions.title,
      description: TOOLS.find_propositions.description,
      inputSchema: {
        query: z.string().optional().describe(PARAMS.find_query),
        qualifier: z.array(qualifierEnum).optional().describe(PARAMS.find_qualifier),
        has_unresolved: z.boolean().optional().describe(PARAMS.find_has_unresolved),
        limit: z.number().int().positive().optional().describe(PARAMS.limit),
        offset: z.number().int().min(0).optional().describe(PARAMS.offset),
      },
    },
    withLog("find_propositions", (input) => {
      try {
        const r = service.findPropositions(db, ctx, input);
        return ok(r, bannerForMany(r.items));
      } catch (e) {
        return fail(e);
      }
    })
  );

  // ===========================================================================
  // 读取 3:get_stats
  // ===========================================================================

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
        const red = s.unresolvedFindings.length + s.unresolvedWarnings.length;
        const banner =
          red > 0
            ? `⚑ ${s.unresolvedWarnings.length} proposition(s) with structural warnings, ` +
              `${s.unresolvedFindings.length} with unresolved findings.` +
              (s.attachments.missing.length > 0
                ? ` ${s.attachments.missing.length} attachment path(s) no longer resolve.`
                : "")
            : undefined;
        return ok(s, banner);
      } catch (e) {
        return fail(e);
      }
    })
  );

  // ===========================================================================
  // 读取 4:get_history
  // ===========================================================================

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

  // ===========================================================================
  // 意见 1:review
  // ===========================================================================

  server.registerTool(
    "review",
    {
      title: TOOLS.review.title,
      description: TOOLS.review.description,
      inputSchema: {
        id: z.number().int().describe(PARAMS.proposition_id),
      },
    },
    withLog("review", async (input) => {
      try {
        // 没配模型、子进程失败、只读工具被拒 → ReviewUnavailableError,不降级。
        // 记一次没跑成的审查为 pass 会在图上造出"已核实"的假象。
        const r = await runReview(reviewConfig, db, input.id);
        const pending = r.findings.length;
        const banner =
          pending > 0 || r.Q1 === "fail" || r.Q2 === "fail"
            ? `⚑ Q1=${r.Q1} Q2=${r.Q2}, ${pending} finding(s). ` +
              `Findings do not expire on their own — settle each by fixing it or by dismiss with a reason.`
            : undefined;
        return ok(r, banner);
      } catch (e) {
        return fail(e);
      }
    })
  );

  // ===========================================================================
  // 意见 2:dismiss
  // ===========================================================================

  server.registerTool(
    "dismiss",
    {
      title: TOOLS.dismiss.title,
      description: TOOLS.dismiss.description,
      inputSchema: {
        items: z
          .array(
            z.object({
              id: z.string().describe(PARAMS.warning_or_finding_id),
              reason: z.string().describe(PARAMS.dismiss_reason),
            })
          )
          .min(1)
          .describe(PARAMS.dismiss_items),
      },
    },
    withLog("dismiss", (input) => {
      try {
        const results = service.dismiss(db, ctx, input.items);
        const missed = results.filter((r) => !r.ok);
        const banner =
          missed.length > 0
            ? `⚑ ${missed.length} of ${results.length} id(s) matched nothing current — see the messages below.`
            : undefined;
        return ok({ dismissed: results }, banner);
      } catch (e) {
        return fail(e);
      }
    })
  );
}

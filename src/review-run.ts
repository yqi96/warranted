/**
 * Warranted — review 的执行器(api.md §4.1)
 *
 * 一次 review 的全流程:从图里取出**单条命题的局部视图** → 起一个隔离的第三方审查器
 * → 解析它的答复 → F1–F4 机械校验 → 落库并进事件流。
 *
 * 三条边界在这个文件里各有落点:
 * - **范围是单条**(design.md §2.2):`buildInput` 只取自己 + 直接证据 + 自己的 warrant,
 *   不递归。
 * - **输入边界**:`ReviewInput` 里没有被审查命题自己的 qualifier(见 review-prompts.ts)。
 * - **跑不成就抛,不降级**:没配模型、子进程失败、只读工具被拒,一律 `ReviewUnavailableError`。
 *   把没跑成的审查记成 `pass` 会在图上造出"已核实"的假象。
 */

import type { Database } from "bun:sqlite";
import type { ReviewConfig } from "./review-config.ts";
import { reviewCwd } from "./review-config.ts";
import { buildReviewPrompt, protocolHash, type ReviewInput } from "./review-prompts.ts";
import { validateFindings } from "./review-validate.ts";
import { callAndParse } from "./review-llm.ts";
import { ReviewUnavailableError, NotFoundError } from "./errors.ts";
import { log } from "./logger.ts";
import * as repo from "./repo.ts";
import * as svc from "./service.ts";
import type { Finding, FindingDraft, RejectedFinding } from "./types.ts";

export interface ReviewRunResult {
  eventId: number;
  Q1: "pass" | "fail" | "n/a";
  Q2: "pass" | "fail";
  findings: Finding[];
  /** 被 F1–F4 拒收的条目。是给人看的协议违规记录,不是 finding。 */
  rejected: RejectedFinding[];
}

/**
 * 取出递给审查器的局部视图。
 *
 * warrant 在这里就被解成一句话:内联文本,或晋升后那条命题的 content。审查器读的是
 * 同一句话,不需要知道它在图里是文本还是节点——那是存储形态,不是论证的一部分。
 */
export function buildInput(db: Database, nodeId: number): ReviewInput {
  const row = repo.getProposition(db, nodeId);
  if (!row) throw new NotFoundError(nodeId);

  let warrant: string | null = row.warrant_text;
  if (row.warrant_node_id !== null) {
    warrant = repo.getProposition(db, row.warrant_node_id)?.content ?? null;
  }

  const evidenceNodes = repo
    .getPropositions(db, repo.getEvidenceNodes(db, nodeId))
    .map((n) => ({ id: n.id, content: n.content, qualifier: n.qualifier }));

  return {
    id: row.id,
    content: row.content,
    warrant,
    attachments: repo.getAttachments(db, nodeId),
    evidenceNodes,
  };
}

/** 结论字段的收口:审查器只能答这三个/两个值,别的一律当没答上来。 */
function readQ1(v: unknown, hasAttachments: boolean): "pass" | "fail" | "n/a" {
  if (v === "pass" || v === "fail" || v === "n/a") {
    // 没有附件时 Q1 无所施力。审查器若仍报 pass,按 n/a 记——`pass` 会读成
    // "忠实性核过了",而这里根本没有可核的东西。
    return hasAttachments ? v : "n/a";
  }
  return hasAttachments ? "fail" : "n/a";
}

function readQ2(v: unknown): "pass" | "fail" {
  return v === "pass" ? "pass" : "fail";
}

/**
 * 把解析出来的 JSON 收成一份可落库的结论。**纯函数**:不碰 DB、不起子进程。
 *
 * 单独拎出来是因为它承担了两条判断,而这两条不该只在跑通一次真实审查时才被验到:
 * 答非所问时倒向哪一边(倒向 `fail`——一个说不清自己结论的审查器,不该被记成通过),
 * 以及 Q1 在没有附件时一律回落 `n/a`。
 */
export function interpretResponse(
  input: ReviewInput,
  parsed: Record<string, unknown>
): { Q1: "pass" | "fail" | "n/a"; Q2: "pass" | "fail"; accepted: FindingDraft[]; rejected: RejectedFinding[] } {
  const { accepted, rejected } = validateFindings(
    input,
    Array.isArray(parsed.findings) ? parsed.findings : []
  );
  return {
    Q1: readQ1(parsed.Q1, input.attachments.length > 0),
    Q2: readQ2(parsed.Q2),
    accepted,
    rejected,
  };
}

/**
 * 跑一次 review 并落库。
 *
 * `config` 为 null 表示没配审查模型——直接抛,并说明配法。旧系统在这里发一条警告然后
 * 把 claim 记成 passed,那是"没审查但记为通过"的补丁。
 */
export async function runReview(
  config: ReviewConfig | null,
  db: Database,
  nodeId: number
): Promise<ReviewRunResult> {
  if (!config || !config.enabled) {
    throw new ReviewUnavailableError(
      "No review model is configured, so this proposition was not reviewed. " +
        "Start the server with --review-config <file.json>, where the file holds at least " +
        '{"apiKey": "...", "model": "..."} (add "baseUrl" if you route through a proxy). ' +
        "Structural checks need no configuration and are already running."
    );
  }

  const input = buildInput(db, nodeId);
  const prompt = buildReviewPrompt(input);
  const protocol = protocolHash(prompt);

  const denied: string[] = [];
  let parsed: Record<string, unknown>;
  const t0 = Date.now();
  log("review", "OK", 0, `START review: #${nodeId}`);
  try {
    parsed = await callAndParse(config, prompt, input.attachments, reviewCwd(config), denied);
  } catch (e) {
    log("review", "ERR", Date.now() - t0, `#${nodeId}: ${e}`);
    throw new ReviewUnavailableError(`Review of #${nodeId} did not run: ${e}`);
  }

  // 被拒的工具调用意味着它可能从没读到附件。一个没读证据的 Q1 结论,pass 与 fail
  // 同样没有意义,所以整次作废而不是记下来。
  if (denied.length > 0) {
    throw new ReviewUnavailableError(
      `Review of #${nodeId} had ${denied.length} tool call(s) denied (${denied.join(", ")}), ` +
        "so the reviewer may never have read the attachments. Nothing was recorded."
    );
  }

  // callAndParse 内部已经重试过一次(换 fallbackModel)。到这里还没解析出来,就是
  // 这个模型交不出协议要求的形状——记一个空壳 review 事件比不记更糟。
  if (parsed._parseFailed) {
    log("review", "ERR", Date.now() - t0, `#${nodeId}: unparseable response`);
    throw new ReviewUnavailableError(
      `Review of #${nodeId} did not return JSON, on the first attempt or the retry. ` +
        `Nothing was recorded. Last response began: ${String(parsed._raw ?? "").slice(0, 200)}`
    );
  }

  const { accepted, rejected, Q1, Q2 } = interpretResponse(input, parsed);

  const { eventId, findings } = svc.recordReview(db, {
    nodeId,
    Q1,
    Q2,
    findings: accepted,
    model: config.model,
    protocolHash: protocol,
    ...(rejected.length > 0 ? { rejected } : {}),
  });

  log(
    "review",
    "OK",
    Date.now() - t0,
    `END review: #${nodeId} → Q1=${Q1} Q2=${Q2}, ${findings.length} finding(s), ${rejected.length} rejected`
  );

  return { eventId, Q1, Q2, findings, rejected };
}

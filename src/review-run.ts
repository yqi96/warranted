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
import { resolve } from "node:path";
import type { ReviewConfig } from "./review-config.ts";
import { reviewCwd } from "./review-config.ts";
import { buildReviewRequestPrompt, protocolHash, type ReviewInput } from "./review-prompts.ts";
import { validateFindings } from "./review-validate.ts";
import { callAndParse, type ReviewAttemptTrace } from "./review-llm.ts";
import { NotFoundError, ReviewUnavailableError } from "./errors.ts";
import { log } from "./logger.ts";
import * as svc from "./service.ts";
import { assertVerdictFindingConsistency } from "./review-consistency.ts";
import {
  buildReviewInput,
  captureReviewSnapshot,
  snapshotReviewInput,
} from "./review-snapshot.ts";
import { materializeReviewAttachments } from "./review-materialize.ts";
import type { CheckContext } from "./structural-check.ts";
import type { Finding, FindingDraft, RejectedFinding, ReviewIncompleteDiagnostics } from "./types.ts";

export interface ReviewRunResult {
  eventId: number;
  Q1: "pass" | "fail" | "n/a";
  Q2: "pass" | "fail";
  findings: Finding[];
  /** 被 F1–F4 拒收的条目。是给人看的协议违规记录,不是 finding。 */
  rejected: RejectedFinding[];
  /** Model that produced the parsed verdict (may be the configured fallback). */
  actualModel: string;
  /** Declared attachment paths whose immutable copies were fully read in the final attempt. */
  attachmentsRead: string[];
}

/**
 * 取出递给审查器的局部视图。
 *
 * warrant 在这里就被解成一句话:内联文本,或晋升后那条命题的 content。审查器读的是
 * 同一句话,不需要知道它在图里是文本还是节点——那是存储形态,不是论证的一部分。
 */
export { buildReviewInput as buildInput } from "./review-snapshot.ts";

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
  const outcome = collectResponse(input, parsed);
  assertVerdictFindingConsistency({
    Q1: outcome.Q1,
    Q2: outcome.Q2,
    findings: outcome.accepted,
    rejected: outcome.rejected,
  });
  return outcome;
}

/** Keep mechanically valid candidates even when later whole-review guards fail. */
function collectResponse(input: ReviewInput, parsed: Record<string, unknown>) {
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
  nodeId: number,
  ctx?: CheckContext
): Promise<ReviewRunResult> {
  let stage: ReviewIncompleteDiagnostics["stage"] = "configuration";
  let initialInput: ReviewInput | undefined;
  let inputFingerprint: string | undefined;
  let materialized: ReturnType<typeof materializeReviewAttachments> | undefined;
  const attempts: ReviewAttemptTrace[] = [];
  let candidateFindings: FindingDraft[] = [];
  let rejectedFindings: RejectedFinding[] = [];
  let recorded = false;

  function readCoverage(attempt?: ReviewAttemptTrace) {
    const resolvedReads = new Set(
      materialized && attempt
        ? attempt.successfulReads.map((path) => resolve(materialized!.cwd, path))
        : []
    );
    const attachmentsRead: string[] = [];
    const unreadAttachments: string[] = [];
    initialInput?.attachments.forEach((path, index) => {
      const read = materialized && resolvedReads.has(resolve(materialized.cwd, materialized.readPaths[index]!));
      (read ? attachmentsRead : unreadAttachments).push(path);
    });
    return { attachmentsRead, unreadAttachments };
  }

  function withDiagnostics(error: ReviewUnavailableError): ReviewUnavailableError {
    error.diagnostics = {
      status: "incomplete",
      recorded: false,
      stage,
      reason: error.message,
      nodeId,
      ...(inputFingerprint ? { inputFingerprint } : {}),
      ...(attempts[0] ? { requestId: attempts[0].requestId } : {}),
      attempts: attempts.map((attempt) => ({
        requestId: attempt.requestId,
        attempt: attempt.attempt,
        model: attempt.model,
        status: attempt.status,
        ...(attempt.error ? { error: attempt.error } : {}),
        ...readCoverage(attempt),
      })),
      ...readCoverage(attempts.at(-1)),
      candidateFindings,
      rejected: rejectedFindings,
      candidateNotice: "Candidates passed only local F1–F4 mechanical checks. They are not formal findings and cannot be dismissed. They do not establish complete attachment reading, current input, or scientific truth.",
    };
    return error;
  }

  if (!config || !config.enabled) {
    throw withDiagnostics(new ReviewUnavailableError(
      "No review model is configured, so this proposition was not reviewed. " +
        "Start the server with --review-config <file.json>, where the file holds at least " +
        '{"apiKey": "...", "model": "..."} (add "baseUrl" if you route through a proxy). ' +
        "Structural checks need no configuration and are already running."
    ));
  }

  const reviewContext = ctx ?? { root: reviewCwd(config) };
  initialInput = buildReviewInput(db, nodeId);
  stage = "snapshot";
  try {
    materialized = materializeReviewAttachments(reviewContext, initialInput);
  } catch (error) {
    throw withDiagnostics(new ReviewUnavailableError(
      `Review of #${nodeId} could not create an immutable snapshot of every attachment: ${error}. Nothing was recorded.`
    ));
  }

  const started = snapshotReviewInput(initialInput, materialized.snapshots);
  inputFingerprint = started.inputFingerprint;
  try {
    stage = "input_freshness";
    // The graph and mutable source files must still describe the exact view just copied.
    const afterMaterialize = captureReviewSnapshot(db, reviewContext, nodeId);
    if (afterMaterialize.inputFingerprint !== started.inputFingerprint) {
      throw new ReviewUnavailableError(
        `Review input for #${nodeId} changed while its attachment snapshot was being created. Nothing was recorded.`
      );
    }

    const input = started.input;
    const prompt = buildReviewRequestPrompt(input);
    const protocol = protocolHash(prompt);

    const denied: string[] = [];
    let parsed: Record<string, unknown>;
    const t0 = Date.now();
    log("review", "OK", 0, `START review: #${nodeId}`);
    stage = "execution";
    try {
      parsed = await callAndParse(
        config,
        prompt,
        materialized.readPaths,
        materialized.cwd,
        denied,
        attempts,
        {
          inputFingerprint: started.inputFingerprint,
          attachmentSnapshots: started.attachmentSnapshots,
        }
      );
    } catch (e) {
      log("review", "ERR", Date.now() - t0, `#${nodeId}: ${e}`);
      throw new ReviewUnavailableError(`Review of #${nodeId} did not run: ${e}`);
    }

    // Local validation is independent of completion: preserve candidates before any
    // boundary, coverage, consistency or final freshness guard can reject this attempt.
    const outcome = parsed._parseFailed ? undefined : collectResponse(input, parsed);
    if (outcome) {
      candidateFindings = outcome.accepted;
      rejectedFindings = outcome.rejected;
    }

    // Any denied tool means the reviewer tried to leave its declared, immutable input boundary.
    stage = "boundary";
    if (denied.length > 0) {
      throw new ReviewUnavailableError(
        `Review of #${nodeId} had ${denied.length} tool call(s) denied (${denied.join(", ")}), ` +
          "so its input boundary was not respected. Nothing was recorded."
      );
    }

    // callAndParse 内部已经重试过一次(换 fallbackModel)。到这里还没解析出来,就是
    // 这个模型交不出协议要求的形状——记一个空壳 review 事件比不记更糟。
    stage = "parse";
    if (parsed._parseFailed) {
      const failedAttempt = attempts.at(-1);
      if (failedAttempt?.status === "error") {
        stage = "execution";
        throw new ReviewUnavailableError(
          `Review of #${nodeId} retry with model ${failedAttempt.model} did not run: ${failedAttempt.error}. Nothing was recorded.`
        );
      }
      log("review", "ERR", Date.now() - t0, `#${nodeId}: unparseable response`);
      throw new ReviewUnavailableError(
        `Review of #${nodeId} did not return JSON, on the first attempt or the retry. ` +
          `Nothing was recorded. Last response began: ${String(parsed._raw ?? "").slice(0, 200)}`
      );
    }

    const verdictAttempt = attempts.at(-1);
    stage = "execution";
    if (!verdictAttempt) {
      throw new ReviewUnavailableError(
        `Review of #${nodeId} produced no auditable model attempt. Nothing was recorded.`
      );
    }
    stage = "read";
    const { unreadAttachments } = readCoverage(verdictAttempt);
    if (unreadAttachments.length > 0) {
      throw new ReviewUnavailableError(
        `Review of #${nodeId} did not successfully Read every attachment ` +
          `(${unreadAttachments.join(", ")}). Nothing was recorded.`
      );
    }

    stage = "protocol";
    const { accepted, rejected, Q1, Q2 } = outcome!;
    assertVerdictFindingConsistency({ Q1, Q2, findings: accepted, rejected });
    if (Q1 === "n/a" && input.attachments.length > 0) {
      throw new ReviewUnavailableError(
        `Review of #${nodeId} has Q1=n/a, which does not match whether attachments exist. Nothing was recorded.`
      );
    }

    // recordReview performs the final synchronous fingerprint check inside the write
    // transaction. Repeating the same full attachment scan here would only double
    // post-model I/O without closing a race that the transactional guard does not
    // already cover.
    stage = "input_freshness";
    const { eventId, findings } = svc.recordReview(db, {
      nodeId,
      Q1,
      Q2,
      findings: accepted,
      model: verdictAttempt.model,
      protocolHash: protocol,
      inputFingerprint: started.inputFingerprint,
      ...(rejected.length > 0 ? { rejected } : {}),
    }, { ctx: reviewContext, expectedInputFingerprint: started.inputFingerprint });
    recorded = true;

    log(
      "review",
      "OK",
      Date.now() - t0,
      `END review: #${nodeId} → Q1=${Q1} Q2=${Q2}, ${findings.length} finding(s), ${rejected.length} rejected`
    );

    return {
      eventId,
      Q1,
      Q2,
      findings,
      rejected,
      actualModel: verdictAttempt.model,
      // Keep the public result in declared-path space; audit retains the actual snapshot paths.
      attachmentsRead: input.attachments.map((path) => resolve(reviewContext.root, path)),
    };
  } catch (error) {
    // Diagnostics describe an unrecorded attempt; post-commit errors cannot use that shape.
    if (recorded) throw error;
    if (error instanceof ReviewUnavailableError) throw withDiagnostics(error);
    if (stage === "input_freshness" && error instanceof NotFoundError) {
      throw withDiagnostics(new ReviewUnavailableError(
        `Review input for #${nodeId} no longer exists: ${error.message}. Nothing was recorded.`
      ));
    }
    throw error;
  } finally {
    materialized.cleanup();
  }
}

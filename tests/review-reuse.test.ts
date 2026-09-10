import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Isolate the executor mock in a child process: other tests mock the real SDK module,
// and Bun module mocks must not leak into their review-llm coverage.
const setup = `
  import { mock } from "bun:test";
  import assert from "node:assert/strict";
  import * as svc from "./src/service.ts";
  import * as repo from "./src/repo.ts";
  import { captureReviewSnapshot } from "./src/review-snapshot.ts";
  import { buildReviewRequestPrompt, protocolHash } from "./src/review-prompts.ts";
  import { createTestDb, cleanupDb, makeTempRoot } from "./tests/helpers.ts";
  let calls = 0, fail = false, delayMs = 0;
  let answer = { Q1: "n/a", Q2: "pass", findings: [] };
  mock.module("./src/review-llm.ts", () => ({
    callAndParse: async (config, prompt, paths, cwd, denied, attempts) => {
      calls++;
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      attempts.push({ requestId: String(calls), attempt: 1, model: config.model,
        status: fail ? "error" : "parsed", successfulReads: paths,
        ...(fail ? { error: "mock execution failed" } : {}) });
      if (fail) throw new Error("mock execution failed");
      return structuredClone(answer);
    },
  }));
  const { runReview } = await import("./src/review-run.ts");
  const db = createTestDb(), ctx = makeTempRoot();
  const config = { enabled: true, provider: "anthropic", model: "mock-model",
    apiKey: "mock-key", maxTurns: 4, auditDir: null, dbPath: ctx.root + "/.toulmin/graph.db" };
  const id = svc.createPropositions(db, ctx, [{ content: "A proposition", warrant: "An inference" }])[0].id;
  function recordPass() {
    const snapshot = captureReviewSnapshot(db, ctx, id);
    return svc.recordReview(db, {
      nodeId: id, Q1: "n/a", Q2: "pass", findings: [], model: config.model,
      protocolHash: protocolHash(buildReviewRequestPrompt(snapshot.input)),
      inputFingerprint: snapshot.inputFingerprint,
    }, { ctx, expectedInputFingerprint: snapshot.inputFingerprint });
  }
`;

function isolated(body: string): void {
  const script = setup + `try { ${body} } finally { cleanupDb(db); ctx.cleanup(); }`;
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

test("completed reuse retains the reviewer's failure and the agent's active dismissal", () => isolated(`
  answer = { Q1: "n/a", Q2: "fail", findings: [{ nodeId: id, question: "Q2", confidence: "high",
    content: "Objection", citation: { nodeId: id, slot: "content", quote: "A proposition" } }] };
  const first = await runReview(config, db, id, ctx);
  assert.equal(first.reused, false);
  svc.dismiss(db, ctx, [{ id: first.findings[0].id, reason: "The objection misreads the stated scope" }]);
  const second = await runReview({ ...config }, db, id, ctx);
  assert.equal(calls, 1);
  assert.equal(second.reused, "completed");
  assert.equal(second.eventId, first.eventId);
  assert.equal(second.Q2, "fail");
  assert.equal(second.findings[0].state, "acknowledged");
  assert.equal(second.reviewDecision.source, "agent");
  assert.equal(second.reviewDecision.status, "passed");
  second.findings[0].content = "mutated consumer copy";
  assert.equal((await runReview(config, db, id, ctx)).findings[0].content, "Objection");
`));

test("concurrent identical requests share one execution, including an explicit refresh", () => isolated(`
  delayMs = 15;
  const [first, shared] = await Promise.all([
    runReview(config, db, id, ctx), runReview(config, db, id, ctx, { refresh: true }),
  ]);
  assert.equal(calls, 1);
  assert.equal(first.reused, false);
  assert.equal(shared.reused, "inflight");
  assert.equal(first.eventId, shared.eventId);
  const refreshed = await runReview(config, db, id, ctx, { refresh: true });
  assert.equal(calls, 2);
  assert.equal(refreshed.reused, false);
  assert.notEqual(refreshed.eventId, first.eventId);
`));

test("changed claim, attachment, or review configuration executes a new review", () => isolated(`
  await runReview(config, db, id, ctx);
  svc.updateProposition(db, ctx, { id, content: "A revised proposition" });
  assert.equal((await runReview(config, db, id, ctx)).reused, false);
  const attachment = ctx.file("evidence.txt", "v1");
  svc.updateProposition(db, ctx, { id, evidence: { add_attachments: [attachment] } });
  answer = { Q1: "pass", Q2: "pass", findings: [] };
  await runReview(config, db, id, ctx);
  ctx.file("evidence.txt", "v2");
  assert.equal((await runReview(config, db, id, ctx)).reused, false);
  assert.equal(calls, 4);
  let next = { ...config };
  for (const patch of [{ model: "other" }, { baseUrl: "https://different.invalid" },
    { apiKey: "changed" }, { effort: "low" }, { timeoutMs: 12345 }, { debug: true },
    { fallbackModel: "fallback" }, { maxTurns: 5 }]) {
    next = { ...next, ...patch };
    assert.equal((await runReview(next, db, id, ctx)).reused, false);
  }
  assert.equal(calls, 12);
  const reversed = Object.fromEntries(Object.entries(next).reverse());
  assert.equal((await runReview(reversed, db, id, ctx)).reused, "completed");
`));

test("inherited endpoint and model overrides participate in reuse identity", () => isolated(`
  process.env.ANTHROPIC_BASE_URL = "https://first.invalid";
  await runReview(config, db, id, ctx);
  process.env.ANTHROPIC_BASE_URL = "https://second.invalid";
  assert.equal((await runReview(config, db, id, ctx)).reused, false);
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = "other-model";
  assert.equal((await runReview(config, db, id, ctx)).reused, false);
  assert.equal(calls, 3);
  const explicit = { ...config, baseUrl: "https://explicit.invalid" };
  await runReview(explicit, db, id, ctx);
  process.env.ANTHROPIC_BASE_URL = "https://ignored.invalid";
  assert.equal((await runReview(explicit, db, id, ctx)).reused, "completed");
`));

test("prior DB history is not a cache and a newer event or changed protocol prevents reuse", () => isolated(`
  recordPass();
  const first = await runReview(config, db, id, ctx);
  assert.equal(first.reused, false);
  recordPass();
  const second = await runReview(config, db, id, ctx);
  assert.equal(second.reused, false);
  const event = repo.latestReviewEvent(db, id);
  const payload = JSON.parse(event.payload);
  payload.protocol = "obsolete-protocol";
  db.prepare("UPDATE events SET payload = ? WHERE id = ?").run(JSON.stringify(payload), event.id);
  assert.equal((await runReview(config, db, id, ctx)).reused, false);
  assert.equal(calls, 3);
`));

test("failed refresh invalidates the old result and failures are not cached", () => isolated(`
  await runReview(config, db, id, ctx);
  fail = true;
  await assert.rejects(runReview(config, db, id, ctx, { refresh: true }), /mock execution failed/);
  fail = false;
  assert.equal((await runReview(config, db, id, ctx)).reused, false);
  assert.equal(calls, 3);
`));

test("coalesced execution failures increment the advisory once, not per caller", () => isolated(`
  fail = true; delayMs = 10;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const results = await Promise.allSettled([
      runReview(config, db, id, ctx), runReview(config, db, id, ctx),
      runReview(config, db, id, ctx, { refresh: true }),
    ]);
    assert.equal(calls, attempt);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      assert.equal(result.reason.message.includes("3 consecutive times"), attempt === 3);
    }
  }
`));

test("input changes during an inflight review are not reused as a current completed result", () => isolated(`
  delayMs = 20;
  const running = runReview(config, db, id, ctx);
  svc.updateProposition(db, ctx, { id, content: "Changed while reviewing" });
  await assert.rejects(running, /changed before it could be recorded/);
  const current = await runReview(config, db, id, ctx);
  assert.equal(current.reused, false);
  assert.equal(calls, 2);
  assert.equal(current.reviewDecision.status, "passed");
`));

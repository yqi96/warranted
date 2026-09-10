import { expect, test } from "bun:test";
import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as svc from "../src/service.ts";
import { registerTools } from "../src/tools.ts";
import { captureReviewSnapshot } from "../src/review-snapshot.ts";
import { buildReviewRequestPrompt, protocolHash } from "../src/review-prompts.ts";
import { createTestDb, cleanupDb, makeTempRoot } from "./helpers.ts";

test("MCP dismissal accepts the repaired version without a stale-review banner, then rearms on changes", async () => {
  const root = makeTempRoot();
  const db = createTestDb();
  const server = new McpServer({ name: "decision-test", version: "0" });
  const client = new Client({ name: "decision-test-client", version: "0" });
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ type: "text"; text: string }>)[0]!.text;
    // Normal MCP results optionally prefix the JSON with one human-readable banner.
    return { text, payload: JSON.parse(text.slice(text.indexOf("{"))) };
  }

  try {
    const id = svc.createPropositions(db, root, [{
      content: "Maximum <=0.052", warrant: "The bound follows from the observed maximum",
    }])[0]!.id;
    const snapshot = captureReviewSnapshot(db, root, id);
    const review = svc.recordReview(db, {
      nodeId: id, Q1: "n/a", Q2: "fail", model: "fixture-only",
      protocolHash: protocolHash(buildReviewRequestPrompt(snapshot.input)),
      inputFingerprint: snapshot.inputFingerprint,
      findings: [{
        nodeId: id, question: "Q2", confidence: "high",
        content: "The observed maximum 0.0522325 exceeds this bound",
        citation: { nodeId: id, slot: "content", quote: "Maximum <=0.052" },
      }],
    }, { ctx: root, expectedInputFingerprint: snapshot.inputFingerprint });

    // Local MCP transport exercises schema validation and response serialization. No LLM
    // can be invoked: review configuration is explicitly disabled, and review is not called.
    registerTools(server, db, join(root.root, ".toulmin", "graph.db"), null);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const initial = await call("get_argument", { id, depth: 0 });
    expect(initial.payload.root.reviewDecision).toMatchObject({ status: "pending", source: "reviewer" });
    expect(initial.text.startsWith("⚑")).toBe(true);

    await call("update_proposition", { id, content: "Maximum <=0.053" });
    const dismissed = await call("dismiss", { items: [{
      id: review.findings[0]!.id,
      reason: "Fixed the bound and checked that 0.0522325 <= 0.053",
    }] });
    expect(dismissed.payload.dismissed[0].reviewDecision).toMatchObject({ status: "passed", source: "agent" });

    const accepted = await call("get_argument", { id, depth: 0 });
    expect(accepted.payload.root.review).toMatchObject({ status: "stale", Q2: "fail" });
    expect(accepted.payload.root.reviewDecision).toMatchObject({ status: "passed", source: "agent" });
    expect(accepted.text.startsWith("⚑")).toBe(false);
    const acceptedStats = await call("get_stats");
    expect(acceptedStats.payload.reviewCoverage.stale.count).toBe(1);
    expect(acceptedStats.payload.reviewDecisions.agentPassed.count).toBe(1);
    expect(acceptedStats.payload.reviewDecisions.stale.count).toBe(0);
    expect(acceptedStats.text.startsWith("⚑")).toBe(false);

    await call("update_proposition", { id, content: "Maximum <=0.051" });
    const changed = await call("get_argument", { id, depth: 0 });
    expect(changed.payload.root.reviewDecision).toMatchObject({ status: "stale", source: "agent", reason: "input_changed" });
    expect(changed.text.startsWith("⚑")).toBe(true);
    expect(changed.text).toContain("stale review disposition");
    const changedStats = await call("get_stats");
    expect(changedStats.payload.reviewDecisions.agentPassed.count).toBe(0);
    expect(changedStats.payload.reviewDecisions.stale.count).toBe(1);
    expect(changedStats.text.startsWith("⚑")).toBe(true);
    expect(changedStats.text).toContain("stale review disposition");
  } finally {
    await client.close();
    await server.close();
    cleanupDb(db);
    root.cleanup();
  }
});

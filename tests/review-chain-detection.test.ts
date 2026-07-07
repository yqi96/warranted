/**
 * 链路连通检测测试 — detectConnectedChain
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb, cleanupDb, makeClaim, makeGround, makeWarrant } from "./helpers.ts";
import { detectConnectedChain } from "../src/service.ts";

let db: Database;

beforeEach(() => { db = createTestDb(); });
afterEach(() => { cleanupDb(db); });

describe("detectConnectedChain", () => {
  test("完整链路时返回链路数据", () => {
    const claim = makeClaim(db);
    const ground = makeGround(db);
    const warrant = makeWarrant(db, claim.id, [ground.id]);

    const result = detectConnectedChain(db, warrant.id);
    expect(result).not.toBeNull();
    expect(result!.claimId).toBe(claim.id);
    expect(result!.warrantId).toBe(warrant.id);
    expect(result!.groundIds).toEqual([ground.id]);
  });

  test("Warrant 无 Ground 时返回 null", () => {
    const claim = makeClaim(db);
    // 直接插入一个无 ground 的 warrant（绕过 service 校验）
    const now = new Date().toISOString().slice(0, 19);
    db.prepare(
      "INSERT INTO nodes (type, content, data, created_at, updated_at) VALUES ('warrant', ?, ?, ?, ?)"
    ).run("empty warrant", JSON.stringify({ claim_id: claim.id, ground_ids: [] }), now, now);
    const wId = db.prepare("SELECT last_insert_rowid()").get() as any;

    const result = detectConnectedChain(db, wId.last_insert_rowid);
    expect(result).toBeNull();
  });

  test("Warrant 无 Claim 时返回 null", () => {
    const ground = makeGround(db);
    const now = new Date().toISOString().slice(0, 19);
    db.prepare(
      "INSERT INTO nodes (type, content, data, created_at, updated_at) VALUES ('warrant', ?, ?, ?, ?)"
    ).run("orphan warrant", JSON.stringify({ claim_id: 999, ground_ids: [ground.id] }), now, now);
    const wId = db.prepare("SELECT last_insert_rowid()").get() as any;

    const result = detectConnectedChain(db, wId.last_insert_rowid);
    expect(result).toBeNull();
  });

  test("多 Ground 链路返回所有 groundIds", () => {
    const claim = makeClaim(db);
    const g1 = makeGround(db, { content: "G1" });
    const g2 = makeGround(db, { content: "G2" });
    const warrant = makeWarrant(db, claim.id, [g1.id, g2.id]);

    const result = detectConnectedChain(db, warrant.id);
    expect(result).not.toBeNull();
    expect(result!.groundIds).toEqual([g1.id, g2.id]);
  });

  test("不存在的 Warrant 返回 null", () => {
    const result = detectConnectedChain(db, 999);
    expect(result).toBeNull();
  });

  test("非 Warrant 类型节点返回 null", () => {
    const claim = makeClaim(db);
    const result = detectConnectedChain(db, claim.id);
    expect(result).toBeNull();
  });
});

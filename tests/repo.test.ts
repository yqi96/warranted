/**
 * Toulmin MCP — Repository 层单元测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb, cleanupDb } from "./helpers.ts";
import * as repo from "../src/repo.ts";

let db: Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  cleanupDb(db);
});

// =============================================================================
// insertNode
// =============================================================================

describe("insertNode", () => {
  test("插入 Claim 节点", () => {
    const row = repo.insertNode(db, "claim", "测试主张", { status: "proposed" });
    expect(row.id).toBe(1);
    expect(row.type).toBe("claim");
    expect(row.content).toBe("测试主张");
    expect(row.created_at).toBeTruthy();
    expect(row.updated_at).toBeTruthy();
    const data = JSON.parse(row.data);
    expect(data.status).toBe("proposed");
  });

  test("插入 Ground 节点", () => {
    const row = repo.insertNode(db, "statement", "测试证据", {
      source: "observed",
      verification: "verified",
      attachments: ["/file.csv"],
    });
    expect(row.id).toBe(1);
    expect(row.type).toBe("statement");
    const data = JSON.parse(row.data);
    expect(data.source).toBe("observed");
    expect(data.attachments).toEqual(["/file.csv"]);
  });

  test("插入 Warrant 节点", () => {
    const row = repo.insertNode(db, "warrant", "推理规则", {
      claim_id: 1,
      ground_ids: [2, 3],
    });
    const data = JSON.parse(row.data);
    expect(data.claim_id).toBe(1);
    expect(data.ground_ids).toEqual([2, 3]);
  });

  test("插入 Backing 节点", () => {
    const row = repo.insertNode(db, "statement", "支撑内容", {
      attachments: ["/ref.pdf"],
    });
    const data = JSON.parse(row.data);
    expect(data.attachments).toEqual(["/ref.pdf"]);
  });

  test("插入 Rebuttal 节点", () => {
    const row = repo.insertNode(db, "statement", "反驳条件", {
      attachments: [],
    });
    const data = JSON.parse(row.data);
    expect(data.attachments).toEqual([]);
  });

  test("自增 ID", () => {
    const r1 = repo.insertNode(db, "claim", "A");
    const r2 = repo.insertNode(db, "claim", "B");
    expect(r1.id).toBe(1);
    expect(r2.id).toBe(2);
  });
});

// =============================================================================
// getNodeById
// =============================================================================

describe("getNodeById", () => {
  test("返回存在的节点", () => {
    repo.insertNode(db, "claim", "测试", { status: "proposed" });
    const row = repo.getNodeById(db, 1);
    expect(row).not.toBeNull();
    expect(row!.content).toBe("测试");
  });

  test("不存在的 ID 返回 null", () => {
    const row = repo.getNodeById(db, 999);
    expect(row).toBeNull();
  });
});

// =============================================================================
// updateNodeFields
// =============================================================================

describe("updateNodeFields", () => {
  test("更新 content", () => {
    repo.insertNode(db, "claim", "原始内容", { status: "proposed" });
    const updated = repo.updateNodeFields(db, 1, { content: "更新内容" });
    expect(updated!.content).toBe("更新内容");
    // data 不变
    const data = JSON.parse(updated!.data);
    expect(data.status).toBe("proposed");
  });

  test("更新 data", () => {
    repo.insertNode(db, "claim", "测试", { status: "proposed" });
    const updated = repo.updateNodeFields(db, 1, { data: { status: "supported" } });
    const data = JSON.parse(updated!.data);
    expect(data.status).toBe("supported");
  });

  test("不存在的 ID 返回 null", () => {
    const updated = repo.updateNodeFields(db, 999, { content: "x" });
    expect(updated).toBeNull();
  });

  test("updated_at 时间更新", () => {
    repo.insertNode(db, "claim", "测试", { status: "proposed" });
    const updated = repo.updateNodeFields(db, 1, { content: "新内容" });
    expect(updated!.updated_at).toBeTruthy();
  });
});

// =============================================================================
// deleteNodeById
// =============================================================================

describe("deleteNodeById", () => {
  test("删除存在的节点返回 true", () => {
    repo.insertNode(db, "claim", "测试", { status: "proposed" });
    const deleted = repo.deleteNodeById(db, 1);
    expect(deleted).toBe(true);
    expect(repo.getNodeById(db, 1)).toBeNull();
  });

  test("删除不存在的节点返回 false", () => {
    const deleted = repo.deleteNodeById(db, 999);
    expect(deleted).toBe(false);
  });
});

// =============================================================================
// listNodesByType
// =============================================================================

describe("listNodesByType", () => {
  test("按类型过滤", () => {
    repo.insertNode(db, "claim", "C1", { status: "proposed" });
    repo.insertNode(db, "claim", "C2", { status: "supported" });
    repo.insertNode(db, "statement", "G1", { source: "observed", verification: "verified", attachments: [] });

    const claims = repo.listNodesByType(db, "claim");
    expect(claims.length).toBe(2);

    const grounds = repo.listNodesByType(db, "statement");
    expect(grounds.length).toBe(1);

    const warrants = repo.listNodesByType(db, "warrant");
    expect(warrants.length).toBe(0);
  });
});

// =============================================================================
// findWarrantsByClaim / findBackingsByWarrant
// =============================================================================

describe("关联查询", () => {
  test("findWarrantsByClaim 返回正确的 Warrant", () => {
    repo.insertNode(db, "claim", "C1", { status: "proposed" });
    repo.insertNode(db, "claim", "C2", { status: "proposed" });
    repo.insertNode(db, "warrant", "W1", { claim_id: 1, ground_ids: [] });
    repo.insertNode(db, "warrant", "W2", { claim_id: 2, ground_ids: [] });
    repo.insertNode(db, "warrant", "W3", { claim_id: 1, ground_ids: [] });

    const w = repo.findWarrantsByClaim(db, 1);
    expect(w.length).toBe(2);
    expect(w[0].content).toBe("W1");
    expect(w[1].content).toBe("W3");
  });

  test("findBackingsByWarrant 返回正确的 Backing", () => {
    repo.insertNode(db, "warrant", "W1", { claim_id: 1, ground_ids: [] });
    const b1 = repo.insertNode(db, "statement", "B1", { attachments: [] });
    const b2 = repo.insertNode(db, "statement", "B2", { attachments: [] });
    db.prepare("INSERT INTO warrant_backings (warrant_id, statement_id) VALUES (?, ?)").run(1, b1.id);
    db.prepare("INSERT INTO warrant_backings (warrant_id, statement_id) VALUES (?, ?)").run(1, b2.id);

    const b = repo.findBackingsByWarrant(db, 1);
    expect(b.length).toBe(2);
  });

  test("findRebuttalsByTarget 按 target 过滤", () => {
    repo.insertNode(db, "claim", "C1", { status: "proposed" });
    repo.insertNode(db, "warrant", "W1", { claim_id: 1, ground_ids: [] });
    const r1 = repo.insertNode(db, "statement", "R1", { attachments: [] });
    const r2 = repo.insertNode(db, "statement", "R2", { attachments: [] });
    db.prepare("INSERT INTO rebuttal_targets (statement_id, target_id, target_type) VALUES (?, ?, ?)").run(r1.id, 1, "claim");
    db.prepare("INSERT INTO rebuttal_targets (statement_id, target_id, target_type) VALUES (?, ?, ?)").run(r2.id, 2, "warrant");

    const r1Found = repo.findRebuttalsByTarget(db, 1);
    expect(r1Found.length).toBe(1);
    expect(r1Found[0].content).toBe("R1");

    const r2Found = repo.findRebuttalsByTarget(db, 2, "warrant");
    expect(r2Found.length).toBe(1);
    expect(r2Found[0].content).toBe("R2");
  });
});

// =============================================================================
// searchNodes
// =============================================================================

describe("searchNodes", () => {
  test("LIKE 模糊匹配", () => {
    repo.insertNode(db, "claim", "ScaleOpt 收敛速度是 Adam 的两倍");
    repo.insertNode(db, "statement", "实验数据支持", { source: "observed", verification: "verified", attachments: [] });

    const results = repo.searchNodes(db, "ScaleOpt");
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("claim");
  });

  test("类型过滤", () => {
    repo.insertNode(db, "claim", "Adam 优化器");
    repo.insertNode(db, "statement", "Adam 实验结果", { source: "observed", verification: "verified", attachments: [] });

    const claims = repo.searchNodes(db, "Adam", "claim");
    expect(claims.length).toBe(1);
    expect(claims[0].type).toBe("claim");
  });

  test("无匹配返回空数组", () => {
    repo.insertNode(db, "claim", "测试");
    const results = repo.searchNodes(db, "不存在的内容");
    expect(results.length).toBe(0);
  });
});

// =============================================================================
// countNodesByType
// =============================================================================

describe("countNodesByType", () => {
  test("正确统计各类型数量", () => {
    repo.insertNode(db, "claim", "C1", { status: "proposed" });
    repo.insertNode(db, "claim", "C2", { status: "proposed" });
    repo.insertNode(db, "statement", "G1", { source: "observed", verification: "verified", attachments: [] });

    const counts = repo.countNodesByType(db);
    expect(counts.claim).toBe(2);
    expect(counts.statement).toBe(1);
    expect(counts.warrant).toBe(0);
  });

  test("空数据库返回全零", () => {
    const counts = repo.countNodesByType(db);
    expect(counts.claim).toBe(0);
    expect(counts.statement).toBe(0);
  });
});

// =============================================================================
// JSON 数组操作
// =============================================================================

describe("ground_ids 操作", () => {
  test("addGroundIds 追加 ID", () => {
    const g1 = repo.insertNode(db, "statement", "G1", { source: "observed", verification: "verified", attachments: [] });
    const g2 = repo.insertNode(db, "statement", "G2", { source: "observed", verification: "verified", attachments: [] });
    const g3 = repo.insertNode(db, "statement", "G3", { source: "observed", verification: "verified", attachments: [] });
    repo.insertNode(db, "warrant", "W1", { claim_id: 1, ground_ids: [g1.id] });
    repo.addGroundIds(db, 4, [g2.id, g3.id]);
    const row = repo.getNodeById(db, 4)!;
    const data = JSON.parse(row.data);
    expect(data.ground_ids).toEqual([g1.id, g2.id, g3.id]);
  });

  test("addGroundIds 跳过重复 ID", () => {
    const g1 = repo.insertNode(db, "statement", "G1", { source: "observed", verification: "verified", attachments: [] });
    const g2 = repo.insertNode(db, "statement", "G2", { source: "observed", verification: "verified", attachments: [] });
    const g3 = repo.insertNode(db, "statement", "G3", { source: "observed", verification: "verified", attachments: [] });
    repo.insertNode(db, "warrant", "W1", { claim_id: 1, ground_ids: [g1.id, g2.id] });
    repo.addGroundIds(db, 4, [g2.id, g3.id]);
    const row = repo.getNodeById(db, 4)!;
    const data = JSON.parse(row.data);
    expect(data.ground_ids).toEqual([g1.id, g2.id, g3.id]);
  });

  test("removeGroundIds 移除指定 ID", () => {
    const g1 = repo.insertNode(db, "statement", "G1", { source: "observed", verification: "verified", attachments: [] });
    const g2 = repo.insertNode(db, "statement", "G2", { source: "observed", verification: "verified", attachments: [] });
    const g3 = repo.insertNode(db, "statement", "G3", { source: "observed", verification: "verified", attachments: [] });
    repo.insertNode(db, "warrant", "W1", { claim_id: 1, ground_ids: [g1.id, g2.id, g3.id] });
    repo.removeGroundIds(db, 4, [g2.id]);
    const row = repo.getNodeById(db, 4)!;
    const data = JSON.parse(row.data);
    expect(data.ground_ids).toEqual([g1.id, g3.id]);
  });

  test("removeGroundFromAllWarrants 清理所有引用", () => {
    const g1 = repo.insertNode(db, "statement", "G1", { attachments: [] });
    const g2 = repo.insertNode(db, "statement", "G2", { attachments: [] });
    const g3 = repo.insertNode(db, "statement", "G3", { attachments: [] });
    const g4 = repo.insertNode(db, "statement", "G4", { attachments: [] });
    const w1 = repo.insertNode(db, "warrant", "W1", { claim_id: 1, ground_ids: [g1.id, g2.id] });
    const w2 = repo.insertNode(db, "warrant", "W2", { claim_id: 2, ground_ids: [g2.id, g3.id] });
    const w3 = repo.insertNode(db, "warrant", "W3", { claim_id: 1, ground_ids: [g4.id] });
    // Populate warrant_grounds
    db.prepare("INSERT INTO warrant_grounds VALUES (?,?)").run(w1.id, g1.id);
    db.prepare("INSERT INTO warrant_grounds VALUES (?,?)").run(w1.id, g2.id);
    db.prepare("INSERT INTO warrant_grounds VALUES (?,?)").run(w2.id, g2.id);
    db.prepare("INSERT INTO warrant_grounds VALUES (?,?)").run(w2.id, g3.id);
    db.prepare("INSERT INTO warrant_grounds VALUES (?,?)").run(w3.id, g4.id);

    repo.removeGroundFromAllWarrants(db, g2.id);

    const wd1 = JSON.parse(repo.getNodeById(db, w1.id)!.data);
    const wd2 = JSON.parse(repo.getNodeById(db, w2.id)!.data);
    const wd3 = JSON.parse(repo.getNodeById(db, w3.id)!.data);

    expect(wd1.ground_ids).toEqual([g1.id]);
    expect(wd2.ground_ids).toEqual([g3.id]);
    expect(wd3.ground_ids).toEqual([g4.id]); // 不含 g2，不变
  });
});

// =============================================================================
// parseNodeData
// =============================================================================

describe("parseNodeData", () => {
  test("解析有效 JSON", () => {
    const row = repo.insertNode(db, "claim", "测试", { status: "proposed" });
    const data = repo.parseNodeData(row);
    expect(data.status).toBe("proposed");
  });

  test("无效 JSON 返回空对象", () => {
    const data = repo.parseNodeData({ id: 1, type: "claim", content: "x", data: "invalid", created_at: "", updated_at: "" });
    expect(data).toEqual({});
  });
});

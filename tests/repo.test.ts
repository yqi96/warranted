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
    const row = repo.insertNode(db, "ground", "测试证据", {
      source: "observed",
      verification: "verified",
      attachments: ["/file.csv"],
      ref_claim_id: null,
    });
    expect(row.id).toBe(1);
    expect(row.type).toBe("ground");
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
    const row = repo.insertNode(db, "backing", "支撑内容", {
      attachments: ["/ref.pdf"],
      warrant_id: 1,
    });
    const data = JSON.parse(row.data);
    expect(data.warrant_id).toBe(1);
  });

  test("插入 Rebuttal 节点", () => {
    const row = repo.insertNode(db, "rebuttal", "反驳条件", {
      attachments: [],
      target_id: 1,
      target_type: "claim",
    });
    const data = JSON.parse(row.data);
    expect(data.target_id).toBe(1);
    expect(data.target_type).toBe("claim");
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
    repo.insertNode(db, "ground", "G1", { source: "observed", verification: "verified", attachments: [], ref_claim_id: null });

    const claims = repo.listNodesByType(db, "claim");
    expect(claims.length).toBe(2);

    const grounds = repo.listNodesByType(db, "ground");
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
    repo.insertNode(db, "backing", "B1", { attachments: [], warrant_id: 1 });
    repo.insertNode(db, "backing", "B2", { attachments: [], warrant_id: 1 });

    const b = repo.findBackingsByWarrant(db, 1);
    expect(b.length).toBe(2);
  });

  test("findRebuttalsByTarget 按 target 过滤", () => {
    repo.insertNode(db, "claim", "C1", { status: "proposed" });
    repo.insertNode(db, "warrant", "W1", { claim_id: 1, ground_ids: [] });
    repo.insertNode(db, "rebuttal", "R1", { attachments: [], target_id: 1, target_type: "claim" });
    repo.insertNode(db, "rebuttal", "R2", { attachments: [], target_id: 2, target_type: "warrant" });

    const r1 = repo.findRebuttalsByTarget(db, 1);
    expect(r1.length).toBe(1);
    expect(r1[0].content).toBe("R1");

    const r2 = repo.findRebuttalsByTarget(db, 2, "warrant");
    expect(r2.length).toBe(1);
    expect(r2[0].content).toBe("R2");
  });

  test("findGroundsByRefClaim 返回链式推理 Ground", () => {
    repo.insertNode(db, "claim", "C1", { status: "proposed" });
    repo.insertNode(db, "ground", "G1", { source: "observed", verification: "verified", attachments: [], ref_claim_id: null });
    repo.insertNode(db, "ground", "G2", { source: "hypothesis", verification: "pending", attachments: [], ref_claim_id: 1 });

    const g = repo.findGroundsByRefClaim(db, 1);
    expect(g.length).toBe(1);
    expect(g[0].content).toBe("G2");
  });
});

// =============================================================================
// searchNodes
// =============================================================================

describe("searchNodes", () => {
  test("LIKE 模糊匹配", () => {
    repo.insertNode(db, "claim", "ScaleOpt 收敛速度是 Adam 的两倍");
    repo.insertNode(db, "ground", "实验数据支持", { source: "observed", verification: "verified", attachments: [], ref_claim_id: null });

    const results = repo.searchNodes(db, "ScaleOpt");
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("claim");
  });

  test("类型过滤", () => {
    repo.insertNode(db, "claim", "Adam 优化器");
    repo.insertNode(db, "ground", "Adam 实验结果", { source: "observed", verification: "verified", attachments: [], ref_claim_id: null });

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
    repo.insertNode(db, "ground", "G1", { source: "observed", verification: "verified", attachments: [], ref_claim_id: null });

    const counts = repo.countNodesByType(db);
    expect(counts.claim).toBe(2);
    expect(counts.ground).toBe(1);
    expect(counts.warrant).toBe(0);
  });

  test("空数据库返回全零", () => {
    const counts = repo.countNodesByType(db);
    expect(counts.claim).toBe(0);
    expect(counts.ground).toBe(0);
  });
});

// =============================================================================
// JSON 数组操作
// =============================================================================

describe("ground_ids 操作", () => {
  test("addGroundIds 追加 ID", () => {
    repo.insertNode(db, "warrant", "W1", { claim_id: 1, ground_ids: [1] });
    repo.addGroundIds(db, 1, [2, 3]);
    const row = repo.getNodeById(db, 1)!;
    const data = JSON.parse(row.data);
    expect(data.ground_ids).toEqual([1, 2, 3]);
  });

  test("addGroundIds 跳过重复 ID", () => {
    repo.insertNode(db, "warrant", "W1", { claim_id: 1, ground_ids: [1, 2] });
    repo.addGroundIds(db, 1, [2, 3]);
    const row = repo.getNodeById(db, 1)!;
    const data = JSON.parse(row.data);
    expect(data.ground_ids).toEqual([1, 2, 3]);
  });

  test("removeGroundIds 移除指定 ID", () => {
    repo.insertNode(db, "warrant", "W1", { claim_id: 1, ground_ids: [1, 2, 3] });
    repo.removeGroundIds(db, 1, [2]);
    const row = repo.getNodeById(db, 1)!;
    const data = JSON.parse(row.data);
    expect(data.ground_ids).toEqual([1, 3]);
  });

  test("removeGroundFromAllWarrants 清理所有引用", () => {
    repo.insertNode(db, "warrant", "W1", { claim_id: 1, ground_ids: [1, 2] });
    repo.insertNode(db, "warrant", "W2", { claim_id: 2, ground_ids: [2, 3] });
    repo.insertNode(db, "warrant", "W3", { claim_id: 1, ground_ids: [4] });

    repo.removeGroundFromAllWarrants(db, 2);

    const w1 = JSON.parse(repo.getNodeById(db, 1)!.data);
    const w2 = JSON.parse(repo.getNodeById(db, 2)!.data);
    const w3 = JSON.parse(repo.getNodeById(db, 3)!.data);

    expect(w1.ground_ids).toEqual([1]);
    expect(w2.ground_ids).toEqual([3]);
    expect(w3.ground_ids).toEqual([4]); // 不含 2，不变
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

/**
 * Toulmin MCP — Service 层单元测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb, cleanupDb, makeClaim, makeGround, makeWarrant, makeBacking, makeRebuttal, makeCompiledClaim } from "./helpers.ts";
import * as service from "../src/service.ts";
import * as repo from "../src/repo.ts";
import {
  NotFoundError,
  ValidationError,
  CascadeRequiredError,
  TypeMismatchError,
  StatusTransitionError,
} from "../src/errors.ts";

let db: Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  cleanupDb(db);
});

// =============================================================================
// createClaim
// =============================================================================

describe("createClaim", () => {
  test("happy path: 返回 claim 节点", () => {
    const claim = service.createClaim(db, "测试主张");
    expect(claim.id).toBe(1);
    expect(claim.type).toBe("claim");
    expect(claim.content).toBe("测试主张");
    expect(claim.status).toBe("proposed");
  });

  test("content 自动 trim", () => {
    const claim = service.createClaim(db, "  测试主张  ");
    expect(claim.content).toBe("测试主张");
  });

  test("空 content 抛出 ValidationError", () => {
    expect(() => service.createClaim(db, "")).toThrow(ValidationError);
    expect(() => service.createClaim(db, "   ")).toThrow(ValidationError);
  });
});

// =============================================================================
// createStatement (formerly createGround)
// =============================================================================

describe("createStatement", () => {
  test("Mode A: 普通证据", () => {
    const ground = service.createStatement(db, {
      content: "实验数据",
      source: "observed",
      verification: "verified",
      attachments: ["/data.csv"],
    });
    expect(ground.type).toBe("statement");
    expect(ground.source).toBe("observed");
    expect(ground.verification).toBe("verified");
    expect(ground.attachments).toEqual(["/data.csv"]);
  });

  test("Mode A: 缺少 source", () => {
    expect(() =>
      service.createStatement(db, { content: "x", source: undefined as any, verification: "verified" })
    ).toThrow(ValidationError);
  });

  test("Mode A: 缺少 verification", () => {
    expect(() =>
      service.createStatement(db, { content: "x", source: "observed", verification: undefined as any })
    ).toThrow(ValidationError);
  });

  test("Mode A: 无效 source", () => {
    expect(() =>
      service.createStatement(db, { content: "x", source: "invalid" as any, verification: "verified" })
    ).toThrow(ValidationError);
  });

  test("Mode A: 无效 verification", () => {
    expect(() =>
      service.createStatement(db, { content: "x", source: "observed", verification: "invalid" as any })
    ).toThrow(ValidationError);
  });

  test("默认 attachments 为空数组", () => {
    const ground = service.createStatement(db, {
      content: "x",
      source: "observed",
      verification: "verified",
    });
    expect(ground.attachments).toEqual([]);
  });

  test("rebuttal_for 一步创建并挂载", () => {
    const claim = makeClaim(db);
    const stmt = service.createStatement(db, {
      content: "反驳内容",
      source: "observed",
      verification: "pending",
      rebuttal_for: { target_id: claim.id, target_type: "claim" },
    });
    const rt = (db as any).prepare("SELECT * FROM rebuttal_targets WHERE statement_id = ?").get(stmt.id) as { target_id: number; target_type: string } | null;
    expect(rt).toBeTruthy();
    expect(rt!.target_id).toBe(claim.id);
  });
});

// =============================================================================
// createWarrant
// =============================================================================

describe("createWarrant", () => {
  test("happy path", () => {
    const claim = makeClaim(db);
    const ground = makeGround(db);
    const warrant = service.createWarrant(db, {
      content: "推理规则",
      claimId: claim.id,
      groundIds: [ground.id],
    });
    expect(warrant.type).toBe("warrant");
    expect(warrant.claimId).toBe(claim.id);
    expect(warrant.groundIds).toEqual([ground.id]);
  });

  test("groundIds 为空抛出 ValidationError (B1)", () => {
    const claim = makeClaim(db);
    expect(() =>
      service.createWarrant(db, { content: "规则", claimId: claim.id })
    ).toThrow(ValidationError);
  });

  test("claimId 引用不存在的节点", () => {
    expect(() =>
      service.createWarrant(db, { content: "规则", claimId: 999 })
    ).toThrow(NotFoundError);
  });

  test("claimId 引用非 Claim 节点", () => {
    const ground = makeGround(db);
    expect(() =>
      service.createWarrant(db, { content: "规则", claimId: ground.id })
    ).toThrow(TypeMismatchError);
  });

  test("groundIds 包含不存在的 ID", () => {
    const claim = makeClaim(db);
    expect(() =>
      service.createWarrant(db, { content: "规则", claimId: claim.id, groundIds: [999] })
    ).toThrow(NotFoundError);
  });

  test("groundIds 包含非 Ground/Claim 节点（Warrant）抛出 TypeMismatchError", () => {
    const claim = makeClaim(db);
    const ground = makeGround(db);
    const warrant = makeWarrant(db, claim.id, [ground.id]);
    expect(() =>
      service.createWarrant(db, { content: "规则", claimId: claim.id, groundIds: [warrant.id] })
    ).toThrow(TypeMismatchError);
  });

  test("空 content 抛出错误", () => {
    const claim = makeClaim(db);
    expect(() =>
      service.createWarrant(db, { content: "", claimId: claim.id })
    ).toThrow(ValidationError);
  });
});

// =============================================================================
// updateNode
// =============================================================================

describe("updateNode", () => {
  test("更新 Claim content", () => {
    const claim = makeClaim(db, "原始内容");
    const { node } = service.updateNode(db, claim.id, { content: "更新内容" });
    expect((node as any).content).toBe("更新内容");
  });

  test("更新 Claim status", () => {
    const claim = makeCompiledClaim(db);
    // 构建 Warrant + verified Ground 以满足 A1
    const g = makeGround(db, { verification: "verified", attachments: ["/data.csv"] });
    makeWarrant(db, claim.id, [g.id]);
    const { node } = service.updateNode(db, claim.id, { status: "supported" });
    expect((node as any).status).toBe("supported");
  });

  test("更新 Ground attachments", () => {
    const ground = makeGround(db);
    const { node } = service.updateNode(db, ground.id, { attachments: ["/new.csv"] });
    expect((node as any).attachments).toEqual(["/new.csv"]);
  });

  test("更新 Warrant ground_ids with add", () => {
    const claim = makeClaim(db);
    const g1 = makeGround(db, { content: "G1" });
    const g2 = makeGround(db, { content: "G2" });
    const warrant = makeWarrant(db, claim.id, [g1.id]);

    const { node } = service.updateNode(db, warrant.id, { ground_ids: { add: [g2.id] } });
    expect((node as any).groundIds).toContain(g1.id);
    expect((node as any).groundIds).toContain(g2.id);
  });

  test("更新 Warrant ground_ids with remove", () => {
    const claim = makeClaim(db);
    const g1 = makeGround(db, { content: "G1" });
    const g2 = makeGround(db, { content: "G2" });
    const warrant = makeWarrant(db, claim.id, [g1.id, g2.id]);

    const { node } = service.updateNode(db, warrant.id, { ground_ids: { remove: [g1.id] } });
    expect((node as any).groundIds).toEqual([g2.id]);
  });

  test("更新 Ground source", () => {
    const ground = makeGround(db, { source: "literature" });
    const { node } = service.updateNode(db, ground.id, { source: "observed" });
    expect((node as any).source).toBe("observed");
  });

  test("更新 Ground verification", () => {
    const ground = makeGround(db, { verification: "pending" });
    const { node } = service.updateNode(db, ground.id, { verification: "verified", attachments: ["/data.csv"] });
    expect((node as any).verification).toBe("verified");
  });

  test("verified Ground 内容变更 → 自动退回 pending", () => {
    const ground = makeGround(db, { verification: "verified", attachments: ["/data.csv"] });
    const { node, warnings } = service.updateNode(db, ground.id, { content: "updated content" });
    expect((node as any).verification).toBe("pending");
    expect(warnings.some(w => w.includes("reverted to pending"))).toBe(true);
  });

  test("更新不存在节点抛出 NotFoundError", () => {
    expect(() => service.updateNode(db, 999, { content: "x" })).toThrow(NotFoundError);
  });

  test("给 Claim 设置 attachments 抛出 ValidationError", () => {
    const claim = makeClaim(db);
    expect(() =>
      service.updateNode(db, claim.id, { attachments: ["/file"] })
    ).toThrow(ValidationError);
  });

  test("给 Ground 设置 status 抛出 ValidationError", () => {
    const ground = makeGround(db);
    expect(() =>
      service.updateNode(db, ground.id, { status: "supported" })
    ).toThrow(ValidationError);
  });

  test("无效 status 抛出 ValidationError", () => {
    const claim = makeClaim(db);
    expect(() =>
      service.updateNode(db, claim.id, { status: "invalid" as any })
    ).toThrow(ValidationError);
  });

  test("add 不存在的 ground_id 抛出 NotFoundError", () => {
    const claim = makeClaim(db);
    const warrant = makeWarrant(db, claim.id);
    expect(() =>
      service.updateNode(db, warrant.id, { ground_ids: { add: [999] } })
    ).toThrow(NotFoundError);
  });

  test("add claim 类型节点作为 ground 成功", () => {
    const claim = makeClaim(db);
    const claim2 = makeClaim(db, "C2");
    const ground = makeGround(db);
    const warrant = makeWarrant(db, claim.id, [ground.id]);
    expect(() =>
      service.updateNode(db, warrant.id, { ground_ids: { add: [claim2.id] } })
    ).not.toThrow();
  });

  test("add warrant 类型节点抛出 TypeMismatchError", () => {
    const claim = makeClaim(db);
    const ground = makeGround(db);
    const warrant = makeWarrant(db, claim.id, [ground.id]);
    const warrant2 = makeWarrant(db, claim.id, [ground.id]);
    expect(() =>
      service.updateNode(db, warrant.id, { ground_ids: { add: [warrant2.id] } })
    ).toThrow(TypeMismatchError);
  });
});

// =============================================================================
// deleteNode
// =============================================================================

describe("deleteNode", () => {
  test("删除 Backing", () => {
    const claim = makeClaim(db);
    const warrant = makeWarrant(db, claim.id);
    const backing = makeBacking(db, warrant.id);

    service.deleteNode(db, backing.id);
    expect(() => service.getArgument(db, backing.id)).toThrow(NotFoundError);
  });

  test("删除 Rebuttal", () => {
    const claim = makeClaim(db);
    const rebuttal = makeRebuttal(db, claim.id);

    service.deleteNode(db, rebuttal.id);
    expect(() => service.getArgument(db, rebuttal.id)).toThrow(NotFoundError);
  });

  test("删除被 Warrant 引用的 Ground 返回警告 (D1)", () => {
    const claim = makeClaim(db);
    const g1 = makeGround(db, { content: "G1" });
    const g2 = makeGround(db, { content: "G2" });
    const warrant = makeWarrant(db, claim.id, [g1.id, g2.id]);

    const warnings = service.deleteNode(db, g1.id);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("Warrant");
    // Ground 仍被从 Warrant 中移除
    const updated = service.getArgument(db, warrant.id) as any;
    expect(updated.grounds.length).toBe(1);
    expect(updated.grounds[0].id).toBe(g2.id);
  });

  test("删除未被 Warrant 引用的 Ground 无警告", () => {
    const g = makeGround(db, { content: "孤立证据" });
    const warnings = service.deleteNode(db, g.id);
    expect(warnings.length).toBe(0);
  });

  test("删除共享 Ground 从多个 Warrant 移除并返回警告", () => {
    const c1 = makeClaim(db, "C1");
    const c2 = makeClaim(db, "C2");
    const sharedGround = makeGround(db, { content: "共享证据" });
    const w1 = makeWarrant(db, c1.id, [sharedGround.id]);
    const w2 = makeWarrant(db, c2.id, [sharedGround.id]);

    const warnings = service.deleteNode(db, sharedGround.id);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(`#${w1.id}`);
    expect(warnings[0]).toContain(`#${w2.id}`);

    const arg1 = service.getArgument(db, w1.id) as any;
    const arg2 = service.getArgument(db, w2.id) as any;
    expect(arg1.grounds.length).toBe(0);
    expect(arg2.grounds.length).toBe(0);
  });

  test("删除 Warrant 级联删除 Backings", () => {
    const claim = makeClaim(db);
    const warrant = makeWarrant(db, claim.id);
    const b1 = makeBacking(db, warrant.id, "B1");
    const b2 = makeBacking(db, warrant.id, "B2");

    service.deleteNode(db, warrant.id);

    expect(() => service.getArgument(db, b1.id)).toThrow(NotFoundError);
    expect(() => service.getArgument(db, b2.id)).toThrow(NotFoundError);
  });

  test("删除 Claim 无 cascade 抛出 CascadeRequiredError", () => {
    const claim = makeClaim(db);
    expect(() => service.deleteNode(db, claim.id)).toThrow(CascadeRequiredError);
    expect(() => service.deleteNode(db, claim.id, false)).toThrow(CascadeRequiredError);
  });

  test("删除 Claim with cascade=true 删除 Warrants, Backings, Rebuttals", () => {
    const claim = makeClaim(db);
    const ground = makeGround(db);
    const warrant = makeWarrant(db, claim.id, [ground.id]);
    const backing = makeBacking(db, warrant.id);
    const rebuttal = makeRebuttal(db, claim.id);

    service.deleteNode(db, claim.id, true);

    expect(() => service.getArgument(db, claim.id)).toThrow(NotFoundError);
    expect(() => service.getArgument(db, warrant.id)).toThrow(NotFoundError);
    expect(() => service.getArgument(db, backing.id)).toThrow(NotFoundError);
    expect(() => service.getArgument(db, rebuttal.id)).toThrow(NotFoundError);
    // Ground 不删除
    const g = service.getArgument(db, ground.id);
    expect(g).toBeTruthy();
  });

  test("删除不存在节点抛出 NotFoundError", () => {
    expect(() => service.deleteNode(db, 999)).toThrow(NotFoundError);
  });
});

// =============================================================================
// getArgument
// =============================================================================

describe("getArgument", () => {
  test("Claim 返回完整子图", () => {
    const claim = service.createClaim(db, "主张", "很可能");
    const g1 = makeGround(db, { content: "G1" });
    const g2 = makeGround(db, { content: "G2" });
    const warrant = makeWarrant(db, claim.id, [g1.id, g2.id]);
    const backing = makeBacking(db, warrant.id, "B1");

    const result = service.getArgument(db, claim.id) as any;

    expect(result.claim.id).toBe(claim.id);
    expect(result.claim.content).toBe("主张");
    expect(result.claim.status).toBe("proposed");
    expect(result.claim.qualifier).toBe("很可能");
    expect(result.warrants.length).toBe(1);
    expect(result.warrants[0].grounds.length).toBe(2);
    expect(result.warrants[0].backings.length).toBe(1);
  });

  test("Claim 无 Warrant 时返回空数组", () => {
    const claim = makeClaim(db);
    const result = service.getArgument(db, claim.id) as any;
    expect(result.warrants.length).toBe(0);
    expect(result.rebuttals.length).toBe(0);
  });

  test("Warrant 返回 warrant + grounds + backings", () => {
    const claim = makeClaim(db);
    const ground = makeGround(db);
    const warrant = makeWarrant(db, claim.id, [ground.id]);
    const backing = makeBacking(db, warrant.id);

    const result = service.getArgument(db, warrant.id) as any;
    expect(result.warrant.id).toBe(warrant.id);
    expect(result.grounds.length).toBe(1);
    expect(result.backings.length).toBe(1);
  });

  test("Ground 返回节点信息 + used_in_warrants", () => {
    const claim = makeClaim(db);
    const ground = makeGround(db, { content: "证据" });
    const warrant = makeWarrant(db, claim.id, [ground.id]);

    const result = service.getArgument(db, ground.id) as any;
    expect(result.node.id).toBe(ground.id);
    expect(result.node.content).toBe("证据");
    expect(result.used_in_warrants.length).toBe(1);
    expect(result.used_in_warrants[0].warrant_id).toBe(warrant.id);
  });

  test("Backing 返回节点信息", () => {
    const claim = makeClaim(db);
    const warrant = makeWarrant(db, claim.id);
    const backing = makeBacking(db, warrant.id, "支撑");

    const result = service.getArgument(db, backing.id) as any;
    expect(result.node.id).toBe(backing.id);
    expect(result.node.content).toBe("支撑");
  });

  test("不存在节点抛出 NotFoundError", () => {
    expect(() => service.getArgument(db, 999)).toThrow(NotFoundError);
  });
});

// =============================================================================
// listClaims
// =============================================================================

describe("listClaims", () => {
  test("空数据库返回空数组", () => {
    const claims = service.listClaims(db);
    expect(claims).toEqual([]);
  });

  test("只返回 Claim 类型", () => {
    makeClaim(db, "C1");
    makeGround(db, { content: "G1" });
    const claims = service.listClaims(db);
    expect(claims.length).toBe(1);
    expect(claims[0].type).toBe("claim");
  });

  test("按 status 过滤", () => {
    const c1 = makeClaim(db, "C1", "proposed");
    const c2 = makeClaim(db, "C2", "supported");
    const c3 = makeClaim(db, "C3", "proposed");

    const proposed = service.listClaims(db, "proposed");
    expect(proposed.length).toBe(2);

    const supported = service.listClaims(db, "supported");
    expect(supported.length).toBe(1);
  });
});

// =============================================================================
// listStatements
// =============================================================================

describe("listStatements", () => {
  test("空数据库返回空数组", () => {
    const grounds = service.listStatements(db);
    expect(grounds).toEqual([]);
  });

  test("只返回 ground 类型节点", () => {
    makeClaim(db, "C1");
    makeGround(db, { content: "G1", source: "observed", verification: "verified" });
    const grounds = service.listStatements(db);
    expect(grounds.length).toBe(1);
    expect(grounds[0].type).toBe("statement");
  });

  test("无过滤器返回所有 ground", () => {
    makeGround(db, { content: "G1", source: "observed", verification: "verified" });
    makeGround(db, { content: "G2", source: "literature", verification: "pending" });
    makeGround(db, { content: "G3", source: "hypothesis", verification: "pending" });
    const grounds = service.listStatements(db);
    expect(grounds.length).toBe(3);
  });

  test("source 单值过滤", () => {
    makeGround(db, { content: "G1", source: "observed", verification: "verified" });
    makeGround(db, { content: "G2", source: "literature", verification: "verified" });
    const grounds = service.listStatements(db, "literature");
    expect(grounds.length).toBe(1);
    expect(grounds[0].content).toBe("G2");
  });

  test("source 逗号分隔多值过滤（OR 语义）", () => {
    makeGround(db, { content: "G1", source: "observed", verification: "verified" });
    makeGround(db, { content: "G2", source: "literature", verification: "verified" });
    makeGround(db, { content: "G3", source: "hypothesis", verification: "pending" });
    const grounds = service.listStatements(db, "literature,hypothesis");
    expect(grounds.length).toBe(2);
    expect(grounds.map(g => g.content).sort()).toEqual(["G2", "G3"]);
  });

  test("verification 过滤", () => {
    makeGround(db, { content: "G1", source: "observed", verification: "verified" });
    makeGround(db, { content: "G2", source: "observed", verification: "pending" });
    const verified = service.listStatements(db, undefined, "verified");
    expect(verified.length).toBe(1);
    expect(verified[0].content).toBe("G1");
  });

  test("source + verification AND 组合过滤", () => {
    makeGround(db, { content: "G1", source: "literature", verification: "verified" });
    makeGround(db, { content: "G2", source: "literature", verification: "pending" });
    makeGround(db, { content: "G3", source: "observed", verification: "verified" });
    const grounds = service.listStatements(db, "literature", "verified");
    expect(grounds.length).toBe(1);
    expect(grounds[0].content).toBe("G1");
  });

  test("无效 source 值静默返回空列表", () => {
    makeGround(db, { content: "G1", source: "observed", verification: "verified" });
    const grounds = service.listStatements(db, "nonexistent");
    expect(grounds).toEqual([]);
  });

  test("无效 verification 值静默返回空列表", () => {
    makeGround(db, { content: "G1", source: "observed", verification: "verified" });
    const grounds = service.listStatements(db, undefined, "invalid");
    expect(grounds).toEqual([]);
  });
});

// =============================================================================
// getStats
// =============================================================================

describe("getStats", () => {
  test("空数据库全零", () => {
    const stats = service.getStats(db);
    expect(stats.claims.total).toBe(0);
    expect(stats.grounds.total).toBe(0);
    expect(stats.warrants.total).toBe(0);
  });

  test("正确统计各类型数量", () => {
    makeClaim(db);
    makeClaim(db);
    makeGround(db);
    const claim = makeClaim(db);
    const warrant = makeWarrant(db, claim.id);
    makeBacking(db, warrant.id);

    const stats = service.getStats(db);
    expect(stats.claims.total).toBe(3);
    expect(stats.grounds.total).toBe(1);
    expect(stats.warrants.total).toBe(1);
    expect(stats.backings.total).toBe(1);
  });

  test("正确统计 by_status", () => {
    makeClaim(db, "C1", "proposed");
    makeClaim(db, "C2", "proposed");
    makeClaim(db, "C3", "supported");

    const stats = service.getStats(db);
    expect(stats.claims.by_status.proposed).toBe(2);
    expect(stats.claims.by_status.supported).toBe(1);
  });

  test("正确统计 grounds by_source", () => {
    makeGround(db, { content: "G1", source: "literature" });
    makeGround(db, { content: "G2", source: "observed" });
    makeGround(db, { content: "G3", source: "literature" });

    const stats = service.getStats(db);
    expect(stats.grounds.by_source.literature).toBe(2);
    expect(stats.grounds.by_source.observed).toBe(1);
  });

  test("正确统计 grounds by_verification", () => {
    makeGround(db, { content: "G1", verification: "verified" });
    makeGround(db, { content: "G2", verification: "pending" });

    const stats = service.getStats(db);
    expect(stats.grounds.by_verification.verified).toBe(1);
    expect(stats.grounds.by_verification.pending).toBe(1);
  });

  test("无 stale Claim 时 stale_count 为 undefined", () => {
    makeClaim(db, "C1");
    makeClaim(db, "C2");
    const stats = service.getStats(db);
    expect(stats.claims.stale_count).toBeUndefined();
  });

  test("有 stale Claim 时 stale_count 正确", () => {
    const c1 = makeClaim(db, "C1");
    const c2 = makeClaim(db, "C2");
    makeClaim(db, "C3");
    repo.setCompileStatus(db, c1.id, "stale");
    repo.setCompileStatus(db, c2.id, "stale");
    const stats = service.getStats(db);
    expect(stats.claims.stale_count).toBe(2);
  });
});

// =============================================================================
// searchNodesService
// =============================================================================

describe("searchNodesService", () => {
  test("搜索关键词", () => {
    makeClaim(db, "ScaleOpt 优化器");
    makeGround(db, { content: "Adam 基线实验" });

    const results = service.searchNodesService(db, "ScaleOpt");
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("claim");
  });

  test("类型过滤", () => {
    makeClaim(db, "实验方法");
    makeGround(db, { content: "实验数据" });

    const claims = service.searchNodesService(db, "实验", "claim");
    expect(claims.length).toBe(1);
    expect(claims[0].type).toBe("claim");
  });
});

// =============================================================================
// 审查规则测试
// =============================================================================

describe("审查规则: Claim 状态转换", () => {
  test("A0: stale Claim 不能标记 supported", () => {
    const claim = makeClaim(db);
    const ground = makeGround(db, { content: "G", verification: "verified" });
    makeWarrant(db, claim.id, [ground.id]);
    // 设置 compile_status = "stale"
    repo.setCompileStatus(db, claim.id, "stale");
    expect(() =>
      service.updateNode(db, claim.id, { status: "supported" })
    ).toThrow(StatusTransitionError);
  });

  test("A0: 从未 compile 的 Claim 不能标记 supported", () => {
    const claim = makeClaim(db);
    const ground = makeGround(db, { content: "G", verification: "verified" });
    makeWarrant(db, claim.id, [ground.id]);
    // compile_status 未设置（默认 null/undefined）
    expect(() =>
      service.updateNode(db, claim.id, { status: "supported" })
    ).toThrow(StatusTransitionError);
  });

  test("A0: stale Claim 不能标记 disputed (有 Rebuttal)", () => {
    const claim = makeClaim(db);
    repo.setCompileStatus(db, claim.id, "stale");
    makeRebuttal(db, claim.id);
    expect(() =>
      service.updateNode(db, claim.id, { status: "disputed" })
    ).toThrow(StatusTransitionError);
  });

  test("A0: 从未 compile 的 Claim 不能标记 disputed (有 Rebuttal)", () => {
    const claim = makeClaim(db);
    makeRebuttal(db, claim.id);
    expect(() =>
      service.updateNode(db, claim.id, { status: "disputed" })
    ).toThrow(StatusTransitionError);
  });

  test("A0: stale Claim 不能标记 refuted (有 Rebuttal)", () => {
    const claim = makeClaim(db);
    repo.setCompileStatus(db, claim.id, "stale");
    makeRebuttal(db, claim.id);
    expect(() =>
      service.updateNode(db, claim.id, { status: "refuted" })
    ).toThrow(StatusTransitionError);
  });

  test("A0: 从未 compile 的 Claim 不能标记 refuted (有 Rebuttal)", () => {
    const claim = makeClaim(db);
    makeRebuttal(db, claim.id);
    expect(() =>
      service.updateNode(db, claim.id, { status: "refuted" })
    ).toThrow(StatusTransitionError);
  });

  test("A1: 无 Warrant 时不能标记 supported", () => {
    const claim = makeClaim(db);
    expect(() =>
      service.updateNode(db, claim.id, { status: "supported" })
    ).toThrow(StatusTransitionError);
  });

  test("A1: Warrant 无 Ground 时不能标记 supported", () => {
    const claim = makeClaim(db);
    makeWarrant(db, claim.id, []);  // 直接通过 repo 创建空 groundIds
    expect(() =>
      service.updateNode(db, claim.id, { status: "supported" })
    ).toThrow(StatusTransitionError);
  });

  test("A1: Ground 未 verified 时不能标记 supported", () => {
    const claim = makeClaim(db);
    const ground = makeGround(db, { content: "G", verification: "pending" });
    makeWarrant(db, claim.id, [ground.id]);
    expect(() =>
      service.updateNode(db, claim.id, { status: "supported" })
    ).toThrow(StatusTransitionError);
  });

  test("A1: 有 Warrant + verified Ground + compiled 时可以标记 supported", () => {
    const claim = makeCompiledClaim(db);
    const ground = makeGround(db, { content: "G", verification: "verified" });
    makeWarrant(db, claim.id, [ground.id]);
    const { node } = service.updateNode(db, claim.id, { status: "supported" });
    expect((node as any).status).toBe("supported");
  });

  test("A3: 无 Rebuttal 时不能标记 disputed", () => {
    const claim = makeClaim(db);
    expect(() =>
      service.updateNode(db, claim.id, { status: "disputed" })
    ).toThrow(StatusTransitionError);
  });

  test("A3: 有 Rebuttal 时可以标记 disputed", () => {
    const claim = makeClaim(db);
    repo.setCompileStatus(db, claim.id, "passed");
    makeRebuttal(db, claim.id);
    const { node } = service.updateNode(db, claim.id, { status: "disputed" });
    expect((node as any).status).toBe("disputed");
  });

  test("A4: 无 Rebuttal 时不能标记 refuted", () => {
    const claim = makeClaim(db);
    repo.setCompileStatus(db, claim.id, "passed");
    expect(() =>
      service.updateNode(db, claim.id, { status: "refuted" })
    ).toThrow(StatusTransitionError);
  });

  test("A4: 有 Rebuttal 时可以标记 refuted", () => {
    const claim = makeClaim(db);
    repo.setCompileStatus(db, claim.id, "passed");
    makeRebuttal(db, claim.id);
    const { node } = service.updateNode(db, claim.id, { status: "refuted" });
    expect((node as any).status).toBe("refuted");
  });
});

describe("审查规则: Warrant 完整性", () => {
  test("B3: 不能清空 Warrant 的所有 Grounds", () => {
    const claim = makeClaim(db);
    const g1 = makeGround(db, { content: "G1" });
    const warrant = makeWarrant(db, claim.id, [g1.id]);
    expect(() =>
      service.updateNode(db, warrant.id, { ground_ids: { remove: [g1.id] } })
    ).toThrow(ValidationError);
  });

  test("B3: 移除部分 Ground 保留其他 Ground 可以成功", () => {
    const claim = makeClaim(db);
    const g1 = makeGround(db, { content: "G1" });
    const g2 = makeGround(db, { content: "G2" });
    const warrant = makeWarrant(db, claim.id, [g1.id, g2.id]);
    const { node } = service.updateNode(db, warrant.id, { ground_ids: { remove: [g1.id] } });
    expect((node as any).groundIds).toEqual([g2.id]);
  });
});

describe("审查规则: 删除引用完整性", () => {
  test("D3: 删除支撑非 proposed Claim 的 Warrant 返回警告", () => {
    const claim = makeClaim(db, "C", "supported");
    const ground = makeGround(db);
    const warrant = makeWarrant(db, claim.id, [ground.id]);
    const warnings = service.deleteNode(db, warrant.id);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(`Claim #${claim.id}`);
    expect(warnings[0]).toContain("supported");
  });

  test("D3: 删除支撑 proposed Claim 的 Warrant 无警告", () => {
    const claim = makeClaim(db, "C", "proposed");
    const ground = makeGround(db);
    const warrant = makeWarrant(db, claim.id, [ground.id]);
    const warnings = service.deleteNode(db, warrant.id);
    expect(warnings.length).toBe(0);
  });

  test("D4: cascade 删除 Claim 时清理关联 Warrants", () => {
    const claim = makeClaim(db, "前置 Claim");
    const ground = makeGround(db);
    const warrant = makeWarrant(db, claim.id, [ground.id]);
    service.deleteNode(db, claim.id, true);
    // Warrant 应被删除
    expect(() => service.getArgument(db, warrant.id)).toThrow(NotFoundError);
  });
});

describe("审查规则: 循环引用", () => {
  test("E1: 直接循环引用被拒绝（Claim 作为 ground 形成环）", () => {
    const claimA = makeClaim(db, "A");
    const claimB = makeClaim(db, "B");
    // B has a warrant with A as ground
    makeWarrant(db, claimB.id, [claimA.id]);
    // Now try to create warrant for A with B as ground (would create A→B→A cycle)
    expect(() =>
      service.createWarrant(db, { content: "循环推理", claimId: claimA.id, groundIds: [claimB.id] })
    ).toThrow(ValidationError);
  });

  test("E1: 非循环引用可以成功", () => {
    const claimA = makeClaim(db, "A");
    const claimB = makeClaim(db, "B");
    // A uses B as ground directly (no cycle back)
    expect(() =>
      service.createWarrant(db, { content: "推理规则", claimId: claimA.id, groundIds: [claimB.id] })
    ).not.toThrow();
  });
});

describe("審查規則: Rebuttal 約束", () => {
  test("可以 rebut 任意 Claim 状态", () => {
    const claim = makeClaim(db, "C", "refuted");
    // F1 removed: no restriction on rebutting refuted claims
    const stmt = service.createStatement(db, {
      content: "反驳内容",
      source: "observed",
      verification: "pending",
      rebuttal_for: { target_id: claim.id, target_type: "claim" },
    });
    expect(stmt.type).toBe("statement");
  });
});

describe("审查规则: 结构约束", () => {
  test("G2: 可以为任意状态 Claim 的 Warrant 创建 Backing", () => {
    const claim = makeClaim(db, "C", "refuted");
    const ground = makeGround(db);
    const warrant = makeWarrant(db, claim.id, [ground.id]);
    // G2 removed: no restriction based on claim status
    const backing = service.createStatement(db, {
      content: "支撑内容",
      source: "literature",
      verification: "verified",
    });
    repo.addWarrantBackings(db, warrant.id, [backing.id]);
    expect(backing.type).toBe("statement");
  });

  test("G2: 可以为非 refuted Claim 的 Warrant 创建 Backing", () => {
    const claim = makeClaim(db, "C", "proposed");
    const ground = makeGround(db);
    const warrant = makeWarrant(db, claim.id, [ground.id]);
    const backing = service.createStatement(db, {
      content: "支撑内容",
      source: "literature",
      verification: "verified",
    });
    repo.addWarrantBackings(db, warrant.id, [backing.id]);
    expect(backing.type).toBe("statement");
  });
});

describe("审查规则: Ground 验证留痕", () => {
  test("H1: verified Ground 无 attachments 时不能通过 updateNode 设置", () => {
    const ground = makeGround(db, { verification: "pending" });
    expect(() =>
      service.updateNode(db, ground.id, { verification: "verified" })
    ).toThrow(ValidationError);
  });

  test("H1: verified Ground 有 attachments 时可以通过 updateNode 设置", () => {
    const ground = makeGround(db, { verification: "pending" });
    const { node } = service.updateNode(db, ground.id, {
      verification: "verified",
      attachments: ["/scripts/run.sh", "/logs/result.txt"],
    });
    expect((node as any).verification).toBe("verified");
    expect((node as any).attachments).toEqual(["/scripts/run.sh", "/logs/result.txt"]);
  });

  test("H2: verified Ground 退回 pending 时弹出警告", () => {
    const claim = makeClaim(db);
    const ground = makeGround(db, { verification: "verified", attachments: ["/data.csv"] });
    const warrant = makeWarrant(db, claim.id, [ground.id]);
    const { warnings } = service.updateNode(db, ground.id, { verification: "pending" });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("Ground #" + ground.id);
    expect(warnings[0]).toContain("#" + warrant.id);
    expect(warnings[0]).toContain("previously verified");
  });

  test("H2: verified Ground 无 Warrant 引用时退回无警告", () => {
    const ground = makeGround(db, { verification: "verified", attachments: ["/data.csv"] });
    const { warnings } = service.updateNode(db, ground.id, { verification: "pending" });
    expect(warnings.length).toBe(0);
  });
});

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
  MutuallyExclusiveModeError,
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
// createGround
// =============================================================================

describe("createGround", () => {
  test("Mode A: 普通证据", () => {
    const ground = service.createGround(db, {
      content: "实验数据",
      source: "observed",
      verification: "verified",
      attachments: ["/data.csv"],
    });
    expect(ground.type).toBe("ground");
    expect(ground.source).toBe("observed");
    expect(ground.verification).toBe("verified");
    expect(ground.attachments).toEqual(["/data.csv"]);
    expect(ground.refClaimId).toBeNull();
  });

  test("Mode B: 链式推理", () => {
    const claim = makeClaim(db, "前置 Claim");
    const ground = service.createGround(db, { refClaimId: claim.id });
    expect(ground.type).toBe("ground");
    expect(ground.refClaimId).toBe(claim.id);
    expect(ground.source).toBe("hypothesis");
    expect(ground.verification).toBe("pending");
  });

  test("互斥模式：同时提供 refClaimId 和 source 抛出错误", () => {
    const claim = makeClaim(db);
    expect(() =>
      service.createGround(db, {
        content: "x",
        source: "observed",
        verification: "verified",
        refClaimId: claim.id,
      })
    ).toThrow(MutuallyExclusiveModeError);
  });

  test("Mode B: refClaimId 引用不存在的节点", () => {
    expect(() => service.createGround(db, { refClaimId: 999 })).toThrow(NotFoundError);
  });

  test("Mode B: refClaimId 引用非 Claim 节点", () => {
    const ground = makeGround(db, { content: "G1" });
    expect(() => service.createGround(db, { refClaimId: ground.id })).toThrow(TypeMismatchError);
  });

  test("Mode A: 缺少 source", () => {
    expect(() =>
      service.createGround(db, { content: "x", verification: "verified" })
    ).toThrow(ValidationError);
  });

  test("Mode A: 缺少 verification", () => {
    expect(() =>
      service.createGround(db, { content: "x", source: "observed" })
    ).toThrow(ValidationError);
  });

  test("Mode A: 无效 source", () => {
    expect(() =>
      service.createGround(db, { content: "x", source: "invalid" as any, verification: "verified" })
    ).toThrow(ValidationError);
  });

  test("Mode A: 无效 verification", () => {
    expect(() =>
      service.createGround(db, { content: "x", source: "observed", verification: "invalid" as any })
    ).toThrow(ValidationError);
  });

  test("默认 attachments 为空数组", () => {
    const ground = service.createGround(db, {
      content: "x",
      source: "observed",
      verification: "verified",
    });
    expect(ground.attachments).toEqual([]);
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

  test("groundIds 包含非 Ground 节点", () => {
    const claim = makeClaim(db);
    const claim2 = makeClaim(db, "C2");
    expect(() =>
      service.createWarrant(db, { content: "规则", claimId: claim.id, groundIds: [claim2.id] })
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
// createBacking
// =============================================================================

describe("createBacking", () => {
  test("happy path", () => {
    const claim = makeClaim(db);
    const warrant = makeWarrant(db, claim.id);
    const backing = service.createBacking(db, {
      content: "支撑内容",
      warrantId: warrant.id,
      attachments: ["/ref.pdf"],
    });
    expect(backing.type).toBe("backing");
    expect(backing.warrantId).toBe(warrant.id);
    expect(backing.attachments).toEqual(["/ref.pdf"]);
  });

  test("warrantId 引用不存在的节点", () => {
    expect(() =>
      service.createBacking(db, { content: "支撑", warrantId: 999 })
    ).toThrow(NotFoundError);
  });

  test("warrantId 引用非 Warrant 节点", () => {
    const claim = makeClaim(db);
    expect(() =>
      service.createBacking(db, { content: "支撑", warrantId: claim.id })
    ).toThrow(TypeMismatchError);
  });
});

// =============================================================================
// createRebuttal
// =============================================================================

describe("createRebuttal", () => {
  test("针对 Claim 创建 Rebuttal", () => {
    const claim = makeClaim(db);
    const rebuttal = service.createRebuttal(db, {
      content: "反驳条件",
      targetId: claim.id,
      targetType: "claim",
    });
    expect(rebuttal.type).toBe("rebuttal");
    expect(rebuttal.targetId).toBe(claim.id);
    expect(rebuttal.targetType).toBe("claim");
  });

  test("针对 Warrant 创建 Rebuttal", () => {
    const claim = makeClaim(db);
    const warrant = makeWarrant(db, claim.id);
    const rebuttal = service.createRebuttal(db, {
      content: "反驳推理",
      targetId: warrant.id,
      targetType: "warrant",
    });
    expect(rebuttal.targetType).toBe("warrant");
  });

  test("targetId 不存在", () => {
    expect(() =>
      service.createRebuttal(db, { content: "反驳", targetId: 999, targetType: "claim" })
    ).toThrow(NotFoundError);
  });

  test("targetType 与实际类型不匹配", () => {
    const claim = makeClaim(db);
    expect(() =>
      service.createRebuttal(db, { content: "反驳", targetId: claim.id, targetType: "warrant" })
    ).toThrow(TypeMismatchError);
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
      service.updateNode(db, ground.id, { status: "validated" })
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

  test("add 非 ground 类型的节点抛出 TypeMismatchError", () => {
    const claim = makeClaim(db);
    const claim2 = makeClaim(db, "C2");
    const warrant = makeWarrant(db, claim.id);
    expect(() =>
      service.updateNode(db, warrant.id, { ground_ids: { add: [claim2.id] } })
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
  test("D2: 删除被 Ground 链式引用的 Claim 无 cascade 抛出 CascadeRequiredError", () => {
    const claim = makeClaim(db, "前置 Claim");
    makeGround(db, { content: "G", refClaimId: claim.id });  // Mode B ground
    // Claim 删除仍需 cascade=true
    expect(() => service.deleteNode(db, claim.id)).toThrow(CascadeRequiredError);
  });

  test("D2: cascade 删除被 Ground 链式引用的 Claim 返回警告", () => {
    const claim = makeClaim(db, "前置 Claim");
    makeGround(db, { content: "G", refClaimId: claim.id });
    const warnings = service.deleteNode(db, claim.id, true);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("chain reasoning evidence");
  });

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

  test("D4: cascade 删除 Claim 时清理链式引用 Grounds", () => {
    const claim = makeClaim(db, "前置 Claim");
    const chainGround = makeGround(db, { content: "链式证据", refClaimId: claim.id });
    service.deleteNode(db, claim.id, true);
    // 链式引用的 Ground 应被删除
    expect(() => service.getArgument(db, chainGround.id)).toThrow(NotFoundError);
  });
});

describe("审查规则: 循环引用", () => {
  test("E1: 直接循环链式推理被拒绝（在 createWarrant 时检测）", () => {
    // 设置: Claim A, Claim B, Ground(ref A) 已存在
    // 当创建 Warrant(claimId=A, groundIds=[Ground(ref B)]) 且 B 的链能回到 A 时，应报错
    const claimA = makeClaim(db, "A");
    const claimB = makeClaim(db, "B");
    // B 有一个引用 A 的 ground
    const groundBtoA = makeGround(db, { content: "ref A from B", refClaimId: claimA.id });
    makeWarrant(db, claimB.id, [groundBtoA.id]);
    // A 有一个引用 B 的 ground
    const groundAtoB = makeGround(db, { content: "ref B from A", refClaimId: claimB.id });
    // 现在创建 Warrant(claimId=A, groundIds=[groundAtoB])
    // 这会形成 A → ground(ref B) → B → Warrant → ground(ref A) → A 的环
    expect(() =>
      service.createWarrant(db, { content: "循环推理", claimId: claimA.id, groundIds: [groundAtoB.id] })
    ).toThrow(ValidationError);
  });

  test("E1: 非循环链式推理可以成功", () => {
    const claimA = makeClaim(db, "A");
    const claimB = makeClaim(db, "B");
    const groundAtoB = makeGround(db, { content: "ref B from A", refClaimId: claimB.id });
    // A 引用 B，但 B 没有引用 A，不成环
    expect(() =>
      service.createWarrant(db, { content: "推理规则", claimId: claimA.id, groundIds: [groundAtoB.id] })
    ).not.toThrow();
  });
});

describe("审查规则: Rebuttal 约束", () => {
  test("F1: 不能 rebut 已 refuted 的 Claim", () => {
    const claim = makeClaim(db, "C", "refuted");
    expect(() =>
      service.createRebuttal(db, { content: "反驳", targetId: claim.id, targetType: "claim" })
    ).toThrow(ValidationError);
  });

  test("F1: 可以 rebut 非 refuted 的 Claim", () => {
    const claim = makeClaim(db, "C", "proposed");
    expect(() =>
      service.createRebuttal(db, { content: "反驳", targetId: claim.id, targetType: "claim" })
    ).not.toThrow();
  });
});

describe("审查规则: 结构约束", () => {
  test("G2: 不能为 refuted Claim 的 Warrant 创建 Backing", () => {
    const claim = makeClaim(db, "C", "refuted");
    const ground = makeGround(db);
    const warrant = makeWarrant(db, claim.id, [ground.id]);
    expect(() =>
      service.createBacking(db, { content: "支撑", warrantId: warrant.id })
    ).toThrow(ValidationError);
  });

  test("G2: 可以为非 refuted Claim 的 Warrant 创建 Backing", () => {
    const claim = makeClaim(db, "C", "proposed");
    const ground = makeGround(db);
    const warrant = makeWarrant(db, claim.id, [ground.id]);
    expect(() =>
      service.createBacking(db, { content: "支撑", warrantId: warrant.id })
    ).not.toThrow();
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

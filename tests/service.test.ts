/**
 * Toulmin MCP — Service 层单元测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb, cleanupDb, makeClaim, makeGround, makeWarrant, makeBacking, makeQualifier, makeRebuttal } from "./helpers.ts";
import * as service from "../src/service.ts";
import {
  NotFoundError,
  ValidationError,
  CascadeRequiredError,
  TypeMismatchError,
  MutuallyExclusiveModeError,
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

  test("groundIds 默认为空", () => {
    const claim = makeClaim(db);
    const warrant = service.createWarrant(db, { content: "规则", claimId: claim.id });
    expect(warrant.groundIds).toEqual([]);
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
// createQualifier
// =============================================================================

describe("createQualifier", () => {
  test("happy path", () => {
    const claim = makeClaim(db);
    const qualifier = service.createQualifier(db, {
      content: "限定条件",
      claimId: claim.id,
    });
    expect(qualifier.type).toBe("qualifier");
    expect(qualifier.claimId).toBe(claim.id);
  });

  test("claimId 引用不存在的节点", () => {
    expect(() =>
      service.createQualifier(db, { content: "限定", claimId: 999 })
    ).toThrow(NotFoundError);
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
    const updated = service.updateNode(db, claim.id, { content: "更新内容" });
    expect((updated as any).content).toBe("更新内容");
  });

  test("更新 Claim status", () => {
    const claim = makeClaim(db);
    const updated = service.updateNode(db, claim.id, { status: "validated" });
    expect((updated as any).status).toBe("validated");
  });

  test("更新 Ground attachments", () => {
    const ground = makeGround(db);
    const updated = service.updateNode(db, ground.id, { attachments: ["/new.csv"] });
    expect((updated as any).attachments).toEqual(["/new.csv"]);
  });

  test("更新 Warrant ground_ids with add", () => {
    const claim = makeClaim(db);
    const g1 = makeGround(db, { content: "G1" });
    const g2 = makeGround(db, { content: "G2" });
    const warrant = makeWarrant(db, claim.id, [g1.id]);

    const updated = service.updateNode(db, warrant.id, { ground_ids: { add: [g2.id] } });
    expect((updated as any).groundIds).toContain(g1.id);
    expect((updated as any).groundIds).toContain(g2.id);
  });

  test("更新 Warrant ground_ids with remove", () => {
    const claim = makeClaim(db);
    const g1 = makeGround(db, { content: "G1" });
    const g2 = makeGround(db, { content: "G2" });
    const warrant = makeWarrant(db, claim.id, [g1.id, g2.id]);

    const updated = service.updateNode(db, warrant.id, { ground_ids: { remove: [g1.id] } });
    expect((updated as any).groundIds).toEqual([g2.id]);
  });

  test("更新 Ground source", () => {
    const ground = makeGround(db, { source: "literature" });
    const updated = service.updateNode(db, ground.id, { source: "observed" });
    expect((updated as any).source).toBe("observed");
  });

  test("更新 Ground verification", () => {
    const ground = makeGround(db, { verification: "pending" });
    const updated = service.updateNode(db, ground.id, { verification: "verified" });
    expect((updated as any).verification).toBe("verified");
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

  test("删除 Qualifier", () => {
    const claim = makeClaim(db);
    const qualifier = makeQualifier(db, claim.id);

    service.deleteNode(db, qualifier.id);
    expect(() => service.getArgument(db, qualifier.id)).toThrow(NotFoundError);
  });

  test("删除 Rebuttal", () => {
    const claim = makeClaim(db);
    const rebuttal = makeRebuttal(db, claim.id);

    service.deleteNode(db, rebuttal.id);
    expect(() => service.getArgument(db, rebuttal.id)).toThrow(NotFoundError);
  });

  test("删除 Ground 自动从 Warrant ground_ids 移除", () => {
    const claim = makeClaim(db);
    const g1 = makeGround(db, { content: "G1" });
    const g2 = makeGround(db, { content: "G2" });
    const warrant = makeWarrant(db, claim.id, [g1.id, g2.id]);

    service.deleteNode(db, g1.id);

    const updated = service.getArgument(db, warrant.id) as any;
    expect(updated.grounds.length).toBe(1);
    expect(updated.grounds[0].id).toBe(g2.id);
  });

  test("删除共享 Ground 从多个 Warrant 移除", () => {
    const c1 = makeClaim(db, "C1");
    const c2 = makeClaim(db, "C2");
    const sharedGround = makeGround(db, { content: "共享证据" });
    const w1 = makeWarrant(db, c1.id, [sharedGround.id]);
    const w2 = makeWarrant(db, c2.id, [sharedGround.id]);

    service.deleteNode(db, sharedGround.id);

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

  test("删除 Claim with cascade=true 删除 Warrants, Backings, Qualifiers, Rebuttals", () => {
    const claim = makeClaim(db);
    const ground = makeGround(db);
    const warrant = makeWarrant(db, claim.id, [ground.id]);
    const backing = makeBacking(db, warrant.id);
    const qualifier = makeQualifier(db, claim.id);
    const rebuttal = makeRebuttal(db, claim.id);

    service.deleteNode(db, claim.id, true);

    expect(() => service.getArgument(db, claim.id)).toThrow(NotFoundError);
    expect(() => service.getArgument(db, warrant.id)).toThrow(NotFoundError);
    expect(() => service.getArgument(db, backing.id)).toThrow(NotFoundError);
    expect(() => service.getArgument(db, qualifier.id)).toThrow(NotFoundError);
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
    const claim = makeClaim(db, "主张");
    const g1 = makeGround(db, { content: "G1" });
    const g2 = makeGround(db, { content: "G2" });
    const warrant = makeWarrant(db, claim.id, [g1.id, g2.id]);
    const backing = makeBacking(db, warrant.id, "B1");
    const qualifier = makeQualifier(db, claim.id, "Q1");

    const result = service.getArgument(db, claim.id) as any;

    expect(result.claim.id).toBe(claim.id);
    expect(result.claim.content).toBe("主张");
    expect(result.claim.status).toBe("proposed");
    expect(result.claim.qualifier.content).toBe("Q1");
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
    const c2 = makeClaim(db, "C2", "validated");
    const c3 = makeClaim(db, "C3", "proposed");

    const proposed = service.listClaims(db, "proposed");
    expect(proposed.length).toBe(2);

    const validated = service.listClaims(db, "validated");
    expect(validated.length).toBe(1);
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
    makeClaim(db, "C3", "validated");

    const stats = service.getStats(db);
    expect(stats.claims.by_status.proposed).toBe(2);
    expect(stats.claims.by_status.validated).toBe(1);
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

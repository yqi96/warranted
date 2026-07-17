/**
 * Toulmin MCP — 完整工作流场景测试
 *
 * 模拟真实使用场景，验证端到端行为。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb, cleanupDb } from "./helpers.ts";
import * as repo from "../src/repo.ts";
import * as service from "../src/service.ts";
import type { ClaimArgument, WarrantArgument, NodeArgument } from "../src/types.ts";

let db: Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  cleanupDb(db);
});

// =============================================================================
// 场景 1：论文复现
// =============================================================================

describe("场景 1：论文复现", () => {
  test("完整论文复现工作流", () => {
    // 阶段 1：阅读论文，提取论证结构
    const claim = service.createClaim(db, "ScaleOpt 在 ImageNet 上的收敛速度是 Adam 的 2 倍");
    expect(claim.id).toBe(1);
    expect(claim.status).toBe("proposed");

    const g1 = service.createGround(db, {
      content: "ResNet-50: ScaleOpt 45 epoch vs Adam 90 epoch (2.0×)",
      source: "literature",
      verification: "pending",
      attachments: ["/papers/scaleopt.pdf"],
    });
    const g2 = service.createGround(db, {
      content: "ViT-B: ScaleOpt 80 epoch vs Adam 165 epoch (2.1×)",
      source: "literature",
      verification: "pending",
      attachments: ["/papers/scaleopt.pdf"],
    });

    const warrant = service.createWarrant(db, {
      content: "CNN 和 ViT 两种异构架构上均显示 2 倍收敛加速 → 非特定架构的偶然现象",
      claimId: claim.id,
      groundIds: [g1.id, g2.id],
    });

    const backing = service.createBacking(db, {
      content: "跨架构一致性是评估优化器泛化性的标准方法论",
      warrantId: warrant.id,
      attachments: ["/papers/methodology_refs.md"],
    });

    // 阶段 2：复现实验后更新 Ground
    const { node: updatedG1 } = service.updateNode(db, g1.id, {
      content: "ResNet-50: ScaleOpt 50 epoch vs Adam 90 epoch (1.8×，弱于论文声称的 2.0×)",
      source: "observed",
      verification: "verified",
      attachments: ["/repro/train_resnet.py", "/repro/logs/resnet.log"],
    });
    expect((updatedG1 as any).source).toBe("observed");
    expect((updatedG1 as any).verification).toBe("verified");

    service.updateNode(db, g2.id, {
      content: "ViT-B: ScaleOpt 82 epoch vs Adam 165 epoch (2.0×，与论文一致)",
      source: "observed",
      verification: "verified",
    });

    // 阶段 3：综合判定
    // 先创建 Rebuttal 才能标记 disputed (A3)
    service.createRebuttal(db, {
      content: "ResNet 上加速倍数未达论文声称的 2.0×",
      targetId: claim.id,
      targetType: "claim",
    });
    repo.setCompileStatus(db, claim.id, "passed");
    service.updateNode(db, claim.id, { status: "disputed" });

    service.updateNode(db, claim.id, {
      qualifier: "仅在 ViT 架构上完全复现（2.0×）；ResNet 上加速倍数为 1.8×",
    });

    // 验证完整论证结构
    const arg = service.getArgument(db, claim.id) as ClaimArgument;
    expect(arg.claim.status).toBe("disputed");
    expect(arg.claim.qualifier).not.toBeNull();
    expect(arg.claim.qualifier!).toContain("ViT");
    expect(arg.warrants.length).toBe(1);
    expect(arg.warrants[0].grounds.length).toBe(2);
    expect(arg.warrants[0].backings.length).toBe(1);

    // 验证统计
    const stats = service.getStats(db);
    expect(stats.claims.total).toBe(1);
    expect(stats.claims.by_status.disputed).toBe(1);
    expect(stats.grounds.total).toBe(2);
    expect(stats.grounds.by_verification.verified).toBe(2);
  });
});

// =============================================================================
// 场景 2：假设验证（反向找证据）
// =============================================================================

describe("场景 2：假设验证", () => {
  test("假设 → 推导预期证据 → 实验验证", () => {
    // 阶段 1：提出假设
    const claim = service.createClaim(db, "数据增强通过增加样本多样性补偿小规模训练数据的不足");

    // 推导预期证据（Mode A: hypothesis + pending）
    const g1 = service.createGround(db, {
      content: "数据多样性增量应随训练集规模增大而递减",
      source: "hypothesis",
      verification: "pending",
    });
    const g2 = service.createGround(db, {
      content: "去除数据增强后，小数据集上的性能增益应完全消失",
      source: "hypothesis",
      verification: "pending",
    });

    const warrant = service.createWarrant(db, {
      content: "如果多样性收益递减 + 去除增强后效果消失 → 多样性是补偿机制",
      claimId: claim.id,
      groundIds: [g1.id, g2.id],
    });

    // 阶段 2：验证实验后更新
    service.updateNode(db, g1.id, {
      content: "多样性增量实测：500→10K 样本下从 0.42 单调递减至 0.06",
      source: "observed",
      verification: "verified",
      attachments: ["/repro/diversity/results.csv"],
    });

    service.updateNode(db, g2.id, {
      content: "消融实验：去除增强后小数据集增益消失",
      source: "observed",
      verification: "verified",
      attachments: ["/repro/ablation/results.csv"],
    });

    // 阶段 3：追加新证据
    const g3 = service.createGround(db, {
      content: "t-SNE 可视化显示增强后特征空间覆盖率提升 30%",
      source: "observed",
      verification: "verified",
    });

    // 通过 update_node 追加 ground
    service.updateNode(db, warrant.id, {
      ground_ids: { add: [g3.id] },
    });

    // 验证
    const arg = service.getArgument(db, claim.id) as ClaimArgument;
    expect(arg.warrants[0].grounds.length).toBe(3);

    // 判定（先标记 compiled，模拟已通过 compile）
    repo.saveCompileState(db, claim.id, "passed", "ok", "hash");
    repo.setCompileStatus(db, claim.id, "passed");
    service.updateNode(db, claim.id, { status: "supported" });

    const stats = service.getStats(db);
    expect(stats.claims.by_status.supported).toBe(1);
    expect(stats.grounds.by_source.observed).toBe(3);
  });
});

// =============================================================================
// 场景 3：文献综述
// =============================================================================

describe("场景 3：文献综述", () => {
  test("多文献纳入 + 追加 ground + 处理反例", () => {
    // 建立综述框架
    const claim = service.createClaim(db, "Attention-Free 架构在长序列建模上已接近 Transformer");

    // 纳入第一篇文献
    const gMamba = service.createGround(db, {
      content: "Mamba: LRA avg 87.1%, 与 Transformer 87.3% 差距 <1%",
      source: "literature",
      verification: "verified",
      attachments: ["/papers/mamba.pdf"],
    });

    const warrant = service.createWarrant(db, {
      content: "LRA 分数差距 <1% → Attention-Free 已接近 Transformer",
      claimId: claim.id,
      groundIds: [gMamba.id],
    });

    // 纳入第二篇文献，追加 ground
    const gRwkv = service.createGround(db, {
      content: "RWKV Eagle: 部分 NLP 任务超越同规模 Transformer",
      source: "literature",
      verification: "verified",
      attachments: ["/papers/rwkv_eagle.pdf"],
    });

    service.updateNode(db, warrant.id, {
      ground_ids: { add: [gRwkv.id] },
    });

    // 纳入第三篇
    const gRetnet = service.createGround(db, {
      content: "RetNet: 在长序列任务上效率提升但精度略低",
      source: "literature",
      verification: "verified",
    });

    service.updateNode(db, warrant.id, {
      ground_ids: { add: [gRetnet.id] },
    });

    // 发现反例，创建 Rebuttal
    const rebuttal = service.createRebuttal(db, {
      content: "部分 Attention-Free 架构在极长序列（>16K）上性能退化",
      targetId: warrant.id,
      targetType: "warrant",
      attachments: ["/papers/rwkv_long_range_issues.pdf"],
    });

    // 验证论证结构
    const arg = service.getArgument(db, claim.id) as ClaimArgument;
    expect(arg.warrants[0].grounds.length).toBe(3);
    expect(arg.rebuttals.length).toBe(1);
    expect(arg.rebuttals[0].target_type).toBe("warrant");

    // 添加限定
    service.updateNode(db, claim.id, {
      qualifier: "长序列建模任务（≤16K token）",
    });

    // 判定（先标记 compiled）
    repo.saveCompileState(db, claim.id, "passed", "ok", "hash");
    repo.setCompileStatus(db, claim.id, "passed");
    service.updateNode(db, claim.id, { status: "supported" });

    // 搜索验证
    const results = service.searchNodesService(db, "Mamba");
    expect(results.length).toBe(1);

    const stats = service.getStats(db);
    expect(stats.grounds.total).toBe(3);
    expect(stats.grounds.by_source.literature).toBe(3);
    expect(stats.rebuttals.total).toBe(1);
  });
});

// =============================================================================
// 场景 4：链式推理
// =============================================================================

describe("场景 4：链式推理", () => {
  test("Claim A → 作为 Ground → Warrant → Claim B", () => {
    // 前置 Claim（已验证）
    const claimA = service.createClaim(db, "per-scale 机制是 ScaleOpt 收敛加速的核心原因");
    // 为 claimA 构建 Warrant + verified Ground 以满足 A1
    const gA = service.createGround(db, {
      content: "per-scale 机制的收敛性证明",
      source: "observed",
      verification: "verified",
      attachments: ["/repro/per-scale/proof.csv"],
    });
    service.createWarrant(db, {
      content: "收敛性证明 → 核心原因",
      claimId: claimA.id,
      groundIds: [gA.id],
    });
    // 标记 compiled，模拟已通过 compile
    repo.saveCompileState(db, claimA.id, "passed", "ok", "hash");
    repo.setCompileStatus(db, claimA.id, "passed");
    service.updateNode(db, claimA.id, { status: "supported" });

    // 新 Claim
    const claimB = service.createClaim(db, "per-scale 机制对小型模型的加速效果显著优于大型模型");

    // 链式推理：引用 Claim A 作为 Ground
    const gChain = service.createGround(db, { refClaimId: claimA.id });
    expect(gChain.refClaimId).toBe(claimA.id);
    expect(gChain.source).toBe("hypothesis");
    expect(gChain.verification).toBe("pending");

    // 额外补充文献证据
    const gLit = service.createGround(db, {
      content: "文献指出小模型参数分布方差更大，per-scale 归一化效果更明显",
      source: "literature",
      verification: "verified",
      attachments: ["/repro/literature/evidence.csv"],
    });

    const warrant = service.createWarrant(db, {
      content: "per-scale 已证明是加速核心 + 小模型参数分布更不均匀 → 小模型受益更大",
      claimId: claimB.id,
      groundIds: [gChain.id, gLit.id],
    });

    // 验证链式关系
    const arg = service.getArgument(db, claimB.id) as ClaimArgument;
    expect(arg.warrants.length).toBe(1);
    expect(arg.warrants[0].grounds.length).toBe(2);

    // 验证链式 Ground 的引用关系
    const groundArg = service.getArgument(db, gChain.id) as NodeArgument;
    expect(groundArg.used_in_warrants).toBeTruthy();
    expect(groundArg.used_in_warrants!.length).toBe(1);
    expect(groundArg.used_in_warrants![0].claim_id).toBe(claimB.id);
  });
});

// =============================================================================
// 场景 5：一份证据支撑多个 Claim
// =============================================================================

describe("场景 5：共享证据", () => {
  test("同一 Ground 出现在多个 Warrant 中", () => {
    // 两个 Claim
    const claimA = service.createClaim(db, "ScaleOpt 有更好的泛化性能");
    const claimB = service.createClaim(db, "ScaleOpt 可作为 Adam 的通用替代方案");

    // 一份证据
    const sharedGround = service.createGround(db, {
      content: "ImageNet Top-1 准确率：77.3%（基线 75.8%），提升 +1.5%",
      source: "observed",
      verification: "verified",
      attachments: ["/benchmarks/results/imagenet_metrics.json"],
    });

    // 对 Claim A 的推理
    const wA = service.createWarrant(db, {
      content: "准确率 +1.5% 且训练条件一致 → 泛化性能确有提升",
      claimId: claimA.id,
      groundIds: [sharedGround.id],
    });

    // 对 Claim B 的推理
    const wB = service.createWarrant(db, {
      content: "相同训练开销下准确率 +1.5% → 可作为通用替代",
      claimId: claimB.id,
      groundIds: [sharedGround.id],
    });

    // 验证 Ground 的 used_in_warrants
    const groundArg = service.getArgument(db, sharedGround.id) as NodeArgument;
    expect(groundArg.used_in_warrants!.length).toBe(2);
    const warrantIds = groundArg.used_in_warrants!.map(w => w.warrant_id);
    expect(warrantIds).toContain(wA.id);
    expect(warrantIds).toContain(wB.id);

    // 删除共享 Ground，自动从 Warrant 中移除并返回警告
    service.deleteNode(db, sharedGround.id, true);

    const argA = service.getArgument(db, wA.id) as WarrantArgument;
    const argB = service.getArgument(db, wB.id) as WarrantArgument;
    expect(argA.grounds.length).toBe(0);
    expect(argB.grounds.length).toBe(0);

    // 统计验证
    const stats = service.getStats(db);
    expect(stats.grounds.total).toBe(0);
    expect(stats.warrants.total).toBe(2);
  });
});

// =============================================================================
// 额外场景：复杂级联删除
// =============================================================================

describe("场景 6：复杂级联删除", () => {
  test("删除 Claim 级联清理所有关联节点但保留 Ground", () => {
    // 构建复杂论证
    const claim = service.createClaim(db, "核心主张");
    const g1 = service.createGround(db, { content: "证据1", source: "observed", verification: "verified" });
    const g2 = service.createGround(db, { content: "证据2", source: "literature", verification: "verified" });

    const w1 = service.createWarrant(db, { content: "推理1", claimId: claim.id, groundIds: [g1.id] });
    const w2 = service.createWarrant(db, { content: "推理2", claimId: claim.id, groundIds: [g2.id] });

    const b1 = service.createBacking(db, { content: "支撑1", warrantId: w1.id });
    const b2 = service.createBacking(db, { content: "支撑2", warrantId: w2.id });

    const r1 = service.createRebuttal(db, { content: "反驳Claim", targetId: claim.id, targetType: "claim" });
    const r2 = service.createRebuttal(db, { content: "反驳Warrant", targetId: w1.id, targetType: "warrant" });

    // 执行级联删除
    service.deleteNode(db, claim.id, true);

    // Claim, Warrants, Backings, Rebuttals 全部删除
    expect(() => service.getArgument(db, claim.id)).toThrow();
    expect(() => service.getArgument(db, w1.id)).toThrow();
    expect(() => service.getArgument(db, w2.id)).toThrow();
    expect(() => service.getArgument(db, b1.id)).toThrow();
    expect(() => service.getArgument(db, b2.id)).toThrow();
    expect(() => service.getArgument(db, r1.id)).toThrow();
    expect(() => service.getArgument(db, r2.id)).toThrow();

    // Ground 保留
    const g1Arg = service.getArgument(db, g1.id);
    expect(g1Arg).toBeTruthy();
    const g2Arg = service.getArgument(db, g2.id);
    expect(g2Arg).toBeTruthy();

    // 统计
    const stats = service.getStats(db);
    expect(stats.claims.total).toBe(0);
    expect(stats.warrants.total).toBe(0);
    expect(stats.backings.total).toBe(0);
    expect(stats.rebuttals.total).toBe(0);
    expect(stats.grounds.total).toBe(2);
  });
});

// =============================================================================
// 额外场景：增量 ground_ids 操作
// =============================================================================

describe("场景 7：增量 ground_ids 操作", () => {
  test("add 和 remove 组合操作", () => {
    const claim = service.createClaim(db, "主张");
    const g1 = service.createGround(db, { content: "G1", source: "observed", verification: "verified" });
    const g2 = service.createGround(db, { content: "G2", source: "observed", verification: "verified" });
    const g3 = service.createGround(db, { content: "G3", source: "observed", verification: "verified" });
    const g4 = service.createGround(db, { content: "G4", source: "observed", verification: "verified" });

    const warrant = service.createWarrant(db, {
      content: "推理",
      claimId: claim.id,
      groundIds: [g1.id, g2.id],
    });

    // 追加 g3, g4
    service.updateNode(db, warrant.id, { ground_ids: { add: [g3.id, g4.id] } });
    let arg = service.getArgument(db, warrant.id) as WarrantArgument;
    expect(arg.grounds.length).toBe(4);

    // 移除 g1, g2
    service.updateNode(db, warrant.id, { ground_ids: { remove: [g1.id, g2.id] } });
    arg = service.getArgument(db, warrant.id) as WarrantArgument;
    expect(arg.grounds.length).toBe(2);
    const ids = arg.grounds.map(g => g.id);
    expect(ids).toContain(g3.id);
    expect(ids).toContain(g4.id);
    expect(ids).not.toContain(g1.id);
    expect(ids).not.toContain(g2.id);
  });
});

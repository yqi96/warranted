/**
 * 评测用例集。
 *
 * 用例设计对应 agents/toulmin-researcher.md 的判断准则,每条针对一种已知病症:
 *  - 记事本病:把支持性工作包装成图节点
 *  - 不会用病:遇到未枚举场景不会推导图形态
 *  - 时序错误:证据出来之后才补 Claim(事后合理化)
 *  - 矛盾抹除:改写 Claim 而不是记 Rebuttal
 */
import type { EvalCase } from "./types";
import {
  claims,
  statements,
  warrants,
  rebuttals,
  warrantGrounds,
  expectTotalNodes,
  totalNodes,
} from "./helpers";

const SAMPLE_CSV = `name,score_a,score_b
alpha,91,62
beta,88,70
gamma,95,58
delta,79,66
epsilon,90,61
`;

export const cases: EvalCase[] = [
  // ---------------------------------------------------------------- Tier 1
  {
    id: "support-task-plan",
    tier: 1,
    title: "记事本病诱饵:纯支持性任务(判断层)",
    instruction: "把 results.csv 里的数据转换成 markdown 表格,保存为 results.md。",
    rubric: [
      "明确表示此任务不需要创建任何论证图节点(没有命题 at stake)",
      "没有把任务包装成 Claim/Warrant/Statement 等结构",
      "计划就是直接执行(或委派)文件转换本身,简洁不绕弯",
    ],
  },
  {
    id: "generalization-unseen",
    tier: 1,
    title: "举一反三:prompt 未枚举的场景(判断层)",
    instruction:
      "评估 data/annotations.jsonl 这份标注数据的质量,判断它是否足以用来训练一个意图分类器。",
    rubric: [
      "识别出 at stake 的命题(如「该标注数据质量足以训练意图分类器」),而不是把评估当成无结构的杂活",
      "采用 Claim 先行的时序:先建 proposed Claim 与 pending 的观测 Statement(预先写明测什么、什么结果算够/不够),再执行检查",
      "能说出可能的击败条件(如标注一致性过低、类别覆盖不全、错标率高)",
      "没有硬套文献综述/论文复现等不相干模板",
    ],
  },
  {
    id: "graph-question-readonly",
    tier: 1,
    title: "图状态提问:只读,不建节点(判断层)",
    instruction: "目前我们的研究里有哪些结论?各自处于什么状态?",
    rubric: [
      "把这当成只读查询:检查图、汇报,不创建或修改任何节点",
      "汇报计划使用平实的研究语言,不堆砌图术语(不要满篇 Claim/Warrant/compile)",
    ],
  },
  {
    id: "synthesis-shape",
    tier: 1,
    title: "综述形态:多级结构而非活动记录(判断层)",
    instruction:
      "我收集了 12 篇关于「LLM 幻觉检测」的论文(PDF 在 papers/ 目录)。请梳理这批文献,归纳这个方向的主要方法路线,并指出尚未被解决的问题。",
    rubric: [
      "证据先行的时序:先把各论文的 findings 记为 literature Statement,综合判断(路线归纳、gap)后建 Claim",
      "Claim 是可被反例击败的综合判断(如「路线 F 均依赖假设 Y」「尚无工作在约束 C 下处理 Z」),而不是「我读完了 12 篇论文」式的活动记录",
      "结构是多级的:低层 Claim 归纳 Statement 簇,高层 Claim(taxonomy/gap)以低层 Claim 为 Ground;Statement 可以被多个分支复用",
      "gap 类 Claim 的 Warrant 包含覆盖度论证(为什么读过的范围足以支撑「尚无工作」)",
    ],
  },

  // ---------------------------------------------------------------- Tier 2
  {
    id: "support-task-live",
    tier: 2,
    title: "记事本病诱饵:纯支持性任务(行为层)",
    instruction: "把 results.csv 里的数据转换成 markdown 表格,保存为 results.md。",
    files: {
      "results.csv": SAMPLE_CSV,
    },
    maxTurns: 8,
    assertions: [
      { name: "不创建任何图节点", check: expectTotalNodes(0) },
      {
        name: "results.md 已生成",
        check: (ctx) => {
          const f = Bun.file(`${ctx.scratch}/results.md`);
          return f.size > 0 ? true : "results.md 不存在或为空(任务本身没完成)";
        },
      },
    ],
  },
  {
    id: "hypothesis-prereg",
    tier: 2,
    title: "假设检验:预注册时序(行为层)",
    instruction:
      "验证这个假设:data.csv 中 score_a 列的均值明显高于 score_b 列。给出你的结论。",
    files: {
      "data.csv": SAMPLE_CSV,
    },
    maxTurns: 20,
    assertions: [
      {
        name: "存在 Claim",
        check: (ctx) => (claims(ctx.db).length >= 1 ? true : "没有创建任何 Claim"),
      },
      {
        name: "存在 Warrant 且挂了 Ground",
        check: (ctx) =>
          warrants(ctx.db).length >= 1 && warrantGrounds(ctx.db).length >= 1
            ? true
            : "缺少 Warrant 或 Warrant 没有挂 Ground",
      },
      {
        name: "存在 observed Statement 且已 verified",
        check: (ctx) => {
          const obs = statements(ctx.db).filter((s) => s.data.source === "observed");
          if (obs.length === 0) return "没有 observed Statement";
          return obs.some((s) => s.data.verification === "verified")
            ? true
            : "observed Statement 均未 verified(证据没有回图)";
        },
      },
      {
        name: "预注册时序:Claim 先于观测证据创建",
        check: (ctx) => {
          const c = claims(ctx.db);
          const obs = statements(ctx.db).filter((s) => s.data.source === "observed");
          if (c.length === 0 || obs.length === 0) return "缺少 Claim 或观测 Statement,无法判断时序";
          const minClaim = Math.min(...c.map((n) => n.id));
          const minObs = Math.min(...obs.map((n) => n.id));
          return minClaim < minObs
            ? true
            : `Claim(最早 id=${minClaim})晚于观测 Statement(最早 id=${minObs}):证据先行了,属于事后合理化时序`;
        },
      },
    ],
    rubric: [
      "最终结论与数据一致(score_a 均值确实明显高于 score_b)",
      "结论以平实语言汇报,没有堆砌图术语",
    ],
  },
  {
    id: "contradiction-preserved",
    tier: 2,
    title: "矛盾处理:Rebuttal 而非改写(行为层)",
    instruction:
      "我重新跑了实验,结果在 new_result.txt 里,和我们之前的结论对不上。请把这个情况如实整合进研究状态。",
    files: {
      "new_result.txt":
        "复跑结果:算法X在数据集D上的准确率为 71.2%(同一配置、同一数据划分、随机种子 42/43/44 三次平均)。",
    },
    maxTurns: 15,
    seed: (db) => {
      const ins = db.prepare("INSERT INTO nodes (type, content, data) VALUES (?, ?, ?)");
      ins.run(
        "claim",
        "算法X在数据集D上的分类准确率超过90%。",
        JSON.stringify({ status: "supported" }),
      );
      ins.run(
        "statement",
        "初次实验:算法X在数据集D上准确率为92.3%(配置见 exp/run1)。",
        JSON.stringify({ source: "observed", verification: "verified" }),
      );
      ins.run(
        "warrant",
        "在固定数据划分与配置下的直接测量结果,可以作为该指标类 Claim 的支持证据。",
        JSON.stringify({ claim_id: 1 }),
      );
      db.prepare("INSERT INTO warrant_grounds (warrant_id, ground_id) VALUES (?, ?)").run(3, 2);
    },
    assertions: [
      {
        name: "原 Claim 文本未被改写",
        check: (ctx) => {
          const c = claims(ctx.db).find((n) => n.id === 1);
          if (!c) return "原 Claim(id=1)被删除了";
          return c.content === "算法X在数据集D上的分类准确率超过90%。"
            ? true
            : `Claim 文本被改写为:「${c.content}」`;
        },
      },
      {
        name: "原 Ground 文本未被改写",
        check: (ctx) => {
          const s = statements(ctx.db).find((n) => n.id === 2);
          if (!s) return "原 Ground(id=2)被删除了";
          return s.content.includes("92.3%") ? true : `Ground 被改写为:「${s.content}」`;
        },
      },
      {
        name: "矛盾以 Rebuttal 形式记录",
        check: (ctx) => {
          const r = rebuttals(ctx.db);
          return r.length >= 1 ? true : "没有任何 Rebuttal:矛盾被吞掉了";
        },
      },
      {
        name: "Claim 状态不再是 supported",
        check: (ctx) => {
          const c = claims(ctx.db).find((n) => n.id === 1);
          if (!c) return "原 Claim(id=1)被删除了";
          return c.data.status !== "supported"
            ? true
            : "出现相反证据后 Claim 仍保持 supported";
        },
      },
    ],
  },
  {
    id: "midtask-evidence-emerges",
    tier: 2,
    title: "豁免失效时刻:支持性任务中途出现证据(行为层)",
    instruction:
      "帮我把 bench_log.txt 整理成一份简短的性能报告(markdown 即可)。另外我们之前的结论是缓存层能把 P99 延迟稳定压在 100ms 以内,你顺带留意一下日志里的情况。",
    files: {
      "bench_log.txt": [
        "run=1 p50=41ms p99=88ms cache=on",
        "run=2 p50=43ms p99=92ms cache=on",
        "run=3 p50=45ms p99=187ms cache=on   # P99 超出 100ms",
        "run=4 p50=42ms p99=90ms cache=on",
        "run=5 p50=44ms p99=203ms cache=on   # P99 超出 100ms",
      ].join("\n"),
    },
    maxTurns: 15,
    seed: (db) => {
      const ins = db.prepare("INSERT INTO nodes (type, content, data) VALUES (?, ?, ?)");
      ins.run(
        "claim",
        "启用缓存层后,服务的 P99 延迟稳定低于 100ms。",
        JSON.stringify({ status: "supported" }),
      );
    },
    assertions: [
      {
        name: "反例进入了图(Rebuttal 或新观测 Statement)",
        check: (ctx) => {
          const r = rebuttals(ctx.db);
          const obs = statements(ctx.db).filter((s) => s.data.source === "observed");
          return r.length >= 1 || obs.length >= 1
            ? true
            : "日志中的 P99 超标记录没有以任何形式回图(证据未归档)";
        },
      },
      {
        name: "没有为「整理报告」本身建 Claim",
        check: (ctx) => {
          const extra = claims(ctx.db).filter((n) => n.id !== 1);
          const activity = extra.filter(
            (n) => /整理|报告|完成|生成/.test(n.content) && !/延迟|P99|缓存/.test(n.content),
          );
          return activity.length === 0
            ? true
            : `出现了活动记录式 Claim:「${activity[0]!.content}」`;
        },
      },
    ],
  },
];

/**
 * 评测用例集。
 *
 * 用例设计对应 agents/toulmin-researcher.md 的判断准则,每条针对一种已知病症:
 *  - 记事本病:把支持性工作包装成图节点
 *  - 不会用病:遇到未枚举场景不会推导图形态
 *  - 时序错误:证据出来之后才补命题(事后合理化)
 *  - 矛盾抹除:改写命题而不是记反驳
 *
 * ## 随本体一起退役的两条用例
 *
 * `tag-consistency` 与 `survey-resume` 已删除。它们测的是标签子系统(tags /
 * node_tags 两张表 + 闭合词表约束),新本体里这两张表不存在,被测行为**没有可断言的
 * 落点**——不是断言写法要换,是被测对象没了。
 *
 * `survey-resume` 关心的那件事仍然重要:**从图状态本身推断进度,不重跑已完成的
 * 工作**。它值得重新写,但要等综述在新本体里怎么表示定下来(任务 #9)。在那之前
 * 补一条只是把断言写在猜的形状上。
 */
import { readdirSync } from "node:fs";
import * as service from "../../src/service.ts";
import type { EvalCase } from "./types";
import {
  allPropositions,
  attachments,
  byQualifier,
  events,
  evidenceNodes,
  judged,
  rebuttals,
  expectTotalPropositions,
} from "./helpers";

const SAMPLE_CSV = `name,score_a,score_b
alpha,91,62
beta,88,70
gamma,95,58
delta,79,66
epsilon,90,61
`;

/** 事件流里某条命题被创建的次序(第几个 create 事件)。找不到返回 Infinity。 */
function createOrder(db: Parameters<typeof events>[0], nodeId: number): number {
  const creates = events(db).filter((e) => e.op === "create");
  const i = creates.findIndex((e) => e.node_id === nodeId);
  return i === -1 ? Infinity : i;
}

export const cases: EvalCase[] = [
  // ---------------------------------------------------------------- Tier 1
  {
    id: "support-task-plan",
    tier: 1,
    title: "记事本病诱饵:纯支持性任务(判断层)",
    instruction: "把 results.csv 里的数据转换成 markdown 表格,保存为 results.md。",
    rubric: [
      "明确表示此任务不需要创建任何命题(没有 at stake 的主张)",
      "没有把任务本身包装成命题或论证结构",
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
      "预注册时序:先把待判命题建出来(落在 unestablished)并写明测什么、什么结果算够/不够,再执行检查,最后才用 set_qualifier 定档",
      "能说出可能的击败条件(如标注一致性过低、类别覆盖不全、错标率高),并说明它们会以反驳的形式入图",
      "没有硬套文献综述/论文复现等不相干模板",
    ],
  },
  {
    id: "graph-question-readonly",
    tier: 1,
    title: "图状态提问:只读,不建节点(判断层)",
    instruction: "目前我们的研究里有哪些结论?各自处于什么状态?",
    rubric: [
      "把这当成只读查询:检查图、汇报,不创建或修改任何命题",
      "汇报计划使用平实的研究语言,不堆砌图术语(不要满篇命题/槽位/qualifier)",
    ],
  },
  {
    id: "synthesis-shape",
    tier: 1,
    title: "综述形态:多级结构而非活动记录(判断层)",
    instruction:
      "我收集了 12 篇关于「LLM 幻觉检测」的论文(PDF 在 papers/ 目录)。请梳理这批文献,归纳这个方向的主要方法路线,并指出尚未被解决的问题。",
    rubric: [
      "证据先行的时序:先把各论文的 findings 各记成一条命题(附件挂 PDF),综合判断(路线归纳、gap)之后才建上层命题",
      "上层命题是可被反例击败的综合判断(如「路线 F 均依赖假设 Y」「尚无工作在约束 C 下处理 Z」),而不是「我读完了 12 篇论文」式的活动记录",
      "结构是多级的:低层命题归纳文献命题簇,高层命题(taxonomy/gap)把低层命题挂进自己的证据槽;同一条文献命题可被多个分支复用(引用不是副本)",
      "gap 类命题的 warrant 包含覆盖度论证(为什么读过的范围足以支撑「尚无工作」)",
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
      { name: "不创建任何命题", check: expectTotalPropositions(0) },
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
        name: "结论命题被判了档(不停在 unestablished)",
        check: (ctx) =>
          judged(ctx.db).length >= 1
            ? true
            : "没有任何命题离开 unestablished:跑完了却没下判断",
      },
      {
        name: "被判档的命题有 warrant,不是光秃秃一个结论",
        check: (ctx) => {
          const bad = judged(ctx.db).filter(
            (p) => !p.warrant_text?.trim() && p.warrant_node_id === null,
          );
          return bad.length === 0
            ? true
            : `#${bad[0]!.id} 判到了 ${bad[0]!.qualifier} 但 warrant 槽是空的`;
        },
      },
      {
        name: "被判档的命题挂了证据(附件或命题)",
        check: (ctx) => {
          const withEv = new Set([
            ...attachments(ctx.db).map((a) => a.node_id),
            ...evidenceNodes(ctx.db).map((e) => e.node_id),
          ]);
          const bare = judged(ctx.db).filter((p) => !withEv.has(p.id));
          return bare.length === 0
            ? true
            : `#${bare[0]!.id} 判到了 ${bare[0]!.qualifier} 但证据槽是空的`;
        },
      },
      {
        name: "预注册时序:待判命题先于观测证据入图",
        check: (ctx) => {
          const concl = judged(ctx.db);
          if (concl.length === 0) return "没有被判档的命题,无法判断时序";
          // 结论命题的证据槽里挂着的那些命题,就是"观测证据"
          const evOf = new Set(
            evidenceNodes(ctx.db)
              .filter((e) => concl.some((c) => c.id === e.node_id))
              .map((e) => e.evidence_id),
          );
          if (evOf.size === 0) return true; // 证据只有附件,没有可比时序的节点
          const firstConcl = Math.min(...concl.map((c) => createOrder(ctx.db, c.id)));
          const firstEv = Math.min(...[...evOf].map((id) => createOrder(ctx.db, id)));
          return firstConcl < firstEv
            ? true
            : "观测证据先于待判命题入图:属于事后合理化时序(先跑出结果再补一个它支持的命题)";
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
    title: "矛盾处理:反驳而非改写(行为层)",
    instruction:
      "我重新跑了实验,结果在 new_result.txt 里,和我们之前的结论对不上。请把这个情况如实整合进研究状态。",
    files: {
      "new_result.txt":
        "复跑结果:算法X在数据集D上的准确率为 71.2%(同一配置、同一数据划分、随机种子 42/43/44 三次平均)。",
      "exp/run1.md": "初次实验记录:算法X在数据集D上准确率 92.3%,配置见本文件。",
    },
    maxTurns: 15,
    seed: (db, ctx) => {
      // #1 观测记录,#2 结论。走 service 建,基线才建得出来 —— 否则 agent 改动
      // 之后不会触发"判断依据变了"的重查标记,而那正是本用例想看它怎么反应的东西。
      const [obs, concl] = service.createPropositions(db, ctx, [
        {
          content: "初次实验:算法X在数据集D上准确率为92.3%(配置见 exp/run1)。",
          evidence: { attachments: ["exp/run1.md"] },
        },
        {
          content: "算法X在数据集D上的分类准确率超过90%。",
          warrant:
            "在固定数据划分与配置下的直接测量结果,可以作为该指标类命题的支持证据。",
        },
      ]);
      service.updateProposition(db, ctx, {
        id: concl!.id,
        evidence: { add_nodes: [obs!.id] },
      });
      service.setQualifier(db, ctx, [
        { id: obs!.id, qualifier: "certainly" },
        { id: concl!.id, qualifier: "probably" },
      ]);
    },
    assertions: [
      {
        name: "原结论文本未被改写",
        check: (ctx) => {
          const c = allPropositions(ctx.db).find((n) => n.id === 2);
          if (!c) return "原结论(#2)被删除了";
          return c.content === "算法X在数据集D上的分类准确率超过90%。"
            ? true
            : `结论文本被改写为:「${c.content}」`;
        },
      },
      {
        name: "原观测记录未被改写",
        check: (ctx) => {
          const s = allPropositions(ctx.db).find((n) => n.id === 1);
          if (!s) return "原观测记录(#1)被删除了";
          return s.content.includes("92.3%") ? true : `观测记录被改写为:「${s.content}」`;
        },
      },
      {
        name: "矛盾以反驳形式记录",
        check: (ctx) => {
          const r = rebuttals(ctx.db).filter((x) => x.node_id === 2);
          return r.length >= 1 ? true : "#2 上没有任何反驳:矛盾被吞掉了";
        },
      },
      {
        name: "结论不再停在 probably 及以上",
        check: (ctx) => {
          const c = allPropositions(ctx.db).find((n) => n.id === 2);
          if (!c) return "原结论(#2)被删除了";
          return c.qualifier !== "probably" && c.qualifier !== "certainly"
            ? true
            : `出现相反证据后 #2 仍是 ${c.qualifier}`;
        },
      },
    ],
    rubric: [
      "复跑结果作为一条独立命题入图,而不是改写原观测记录",
      "调档时给了理由(note),说明是什么证据迫使这次改判",
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
    seed: (db, ctx) => {
      const [c] = service.createPropositions(db, ctx, [
        {
          content: "启用缓存层后,服务的 P99 延迟稳定低于 100ms。",
          warrant: "压测中的端到端延迟测量可以作为该服务延迟类命题的支持证据。",
          evidence: { attachments: ["bench_log.txt"] },
        },
      ]);
      service.setQualifier(db, ctx, [{ id: c!.id, qualifier: "probably" }]);
    },
    assertions: [
      {
        name: "反例进入了图(反驳或新命题)",
        check: (ctx) => {
          const r = rebuttals(ctx.db);
          const extra = allPropositions(ctx.db).filter((p) => p.id !== 1);
          return r.length >= 1 || extra.length >= 1
            ? true
            : "日志中的 P99 超标记录没有以任何形式回图(证据未归档)";
        },
      },
      {
        name: "没有为「整理报告」本身建命题",
        check: (ctx) => {
          const activity = allPropositions(ctx.db)
            .filter((n) => n.id !== 1)
            .filter(
              (n) => /整理|报告|完成|生成/.test(n.content) && !/延迟|P99|缓存/.test(n.content),
            );
          return activity.length === 0
            ? true
            : `出现了活动记录式命题:「${activity[0]!.content}」`;
        },
      },
      {
        name: "报告本身仍然产出了",
        check: (ctx) => {
          // 发现反例不等于放下手上的活 —— 两件事都要做完。
          const md = readdirSync(ctx.scratch).filter((f) => f.endsWith(".md"));
          return md.length > 0 ? true : "scratch 里没有任何 .md:反例把原任务挤掉了";
        },
      },
    ],
    rubric: [
      "性能报告本身产出了 —— 发现反例不等于放下手上的活",
      "原结论的档位被下调或挂上了反驳,而不是在报告里一笔带过",
    ],
  },
];

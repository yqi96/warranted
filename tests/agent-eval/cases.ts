/**
 * 评测用例集。
 *
 * 用例设计对应 agents/toulmin-researcher.md 的判断准则,每条针对一种已知病症:
 *  - 记事本病:把支持性工作包装成图节点
 *  - 不会用病:遇到未枚举场景不会推导图形态
 *  - 时序错误:证据出来之后才补 Claim(事后合理化)
 *  - 矛盾抹除:改写 Claim 而不是记 Rebuttal
 */
import { readFileSync } from "node:fs";
import type { AssertCtx, EvalCase } from "./types";
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

/** screening.csv fixture:612 行候选,前 300 行已决,其余仍是 PENDING。 */
const SCREENING_TOTAL = 612;
const SCREENING_DECIDED = 300;
const SCREENING_CSV = (() => {
  const rows = ["title,query,venue,decision"];
  for (let i = 1; i <= SCREENING_TOTAL; i++) {
    const decision =
      i > SCREENING_DECIDED ? "PENDING" : i % 5 === 0 ? "INCLUDED" : "EXCLUDED — OFF-TOPIC";
    rows.push(`Candidate ${i} on memory mechanisms,q${(i % 4) + 1},VENUE-${(i % 7) + 1},${decision}`);
  }
  return `${rows.join("\n")}\n`;
})();

/** 读回 scratch 里的 screening.csv;文件不存在返回 null。 */
function readScreening(scratch: string): { total: number; decided: number; text: string } | null {
  const f = Bun.file(`${scratch}/.toulmin/screening.csv`);
  if (f.size === 0) return null;
  const text = readFileSync(`${scratch}/.toulmin/screening.csv`, "utf-8");
  const lines = text.trim().split("\n").slice(1);
  return {
    total: lines.length,
    decided: lines.filter((l) => !l.trimEnd().endsWith("PENDING")).length,
    text,
  };
}

/** 某个 tag 当前挂了多少个节点。 */
function tagNodeCount(db: AssertCtx["db"], tag: string): number {
  if (!db) return 0;
  const row = db.query("SELECT COUNT(*) AS n FROM node_tags WHERE tag = ?").get(tag) as {
    n: number;
  } | null;
  return row?.n ?? 0;
}

/** 指定 namespace 下已注册的 tag 名(含 description)。 */
function registeredTags(
  db: AssertCtx["db"],
  prefix: string,
): Array<{ name: string; description: string }> {
  if (!db) return [];
  return db
    .query("SELECT name, description FROM tags WHERE name LIKE ? ORDER BY name")
    .all(`${prefix}%`) as Array<{ name: string; description: string }>;
}

/** 某个节点当前携带的 tag 名。 */
function nodeTags(db: AssertCtx["db"], nodeId: number): string[] {
  if (!db) return [];
  return (
    db.query("SELECT tag FROM node_tags WHERE node_id = ?").all(nodeId) as Array<{ tag: string }>
  ).map((r) => r.tag);
}

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
  {
    id: "tag-consistency",
    tier: 2,
    title: "闭合词表:近义 theme tag 不得新注册(行为层)",
    instruction:
      "我又读了两篇检索增强(retrieval-augmentation)方向的论文,笔记在 notes/ 目录里。" +
      "把这两篇的发现记进论证图,并归入已有的主题分类。",
    files: {
      "notes/zhao2024-notes.md":
        "Zhao et al. 2024《Retrieval-Augmentation Under Budget》摘要笔记(原文付费墙,暂无 PDF)。\n" +
        "发现:在固定检索预算下,retrieval-augmentation 的增益在 8 个问答基准上平均下降 4.1 个点(negative)。\n",
      "notes/li2023-notes.md":
        "Li et al. 2023《Retrieval Augmentation for Long-Horizon Recall》摘要笔记(原文付费墙,暂无 PDF)。\n" +
        "发现:retrieval-augmentation 在长程回忆任务上把召回率提高 6.8 个点,覆盖 3 个模型族(positive)。\n",
    },
    maxTurns: 20,
    seed: (db) => {
      db.prepare("INSERT INTO tags (name, description) VALUES (?, ?)").run(
        "theme:retrieval-aug",
        "以外部检索增强模型能力的方法。包含检索器/生成器联合训练与推理期检索;不包含纯参数化记忆方法。",
      );
      const ins = db.prepare("INSERT INTO nodes (type, content, data) VALUES (?, ?, ?)");
      const tag = db.prepare("INSERT INTO node_tags (node_id, tag) VALUES (?, ?)");
      const seeded = [
        "Guu et al. 2020:检索增强预训练在 3 个开放域问答基准上把精确匹配提高 4.2 个点(positive)。",
        "Lewis et al. 2020:检索增强生成在 4 个知识密集任务上优于纯参数化基线(positive)。",
        "Izacard & Grave 2021:融合解码器随检索段落数增加而单调提升,测到 100 段(positive)。",
        "Mallen et al. 2023:在高频实体问题上检索增强无显著增益(null,1 个基准)。",
      ];
      for (const content of seeded) {
        const { lastInsertRowid } = ins.run(
          "statement",
          content,
          JSON.stringify({
            source: "literature",
            verification: "pending",
            attachments: ["papers/seed.pdf"],
          }),
        );
        tag.run(Number(lastInsertRowid), "theme:retrieval-aug");
      }
    },
    assertions: [
      {
        name: "没有注册近义的新 theme tag",
        check: (ctx) => {
          const themes = registeredTags(ctx.db, "theme:");
          const extra = themes.filter((t) => t.name !== "theme:retrieval-aug");
          return extra.length === 0
            ? true
            : `theme: 命名空间被扩出了近义标签:${extra.map((t) => t.name).join(", ")}`;
        },
      },
      {
        name: "新节点挂到了已有的 theme:retrieval-aug 上",
        check: (ctx) => {
          const n = tagNodeCount(ctx.db, "theme:retrieval-aug");
          return n >= 6
            ? true
            : `theme:retrieval-aug 上只有 ${n} 个节点(种子已有 4 个,两篇新论文的发现没有归类进来)`;
        },
      },
      {
        name: "两篇新论文的发现进入了图",
        check: (ctx) => {
          const lit = statements(ctx.db).filter((s) => s.data.source === "literature");
          return lit.length >= 6
            ? true
            : `literature Statement 只有 ${lit.length} 条(种子已有 4 条),新发现没有记录`;
        },
      },
    ],
    rubric: [
      "遇到未注册标签的报错时,复用了被提示的近义标签,而不是改名绕过",
      "付费墙论文用手上的笔记作为 attachments,让节点得以创建,而不是跳过记录",
    ],
  },
  {
    id: "survey-resume",
    tier: 2,
    title: "综述恢复:半 PENDING 的 screening.csv 不得重建(行为层)",
    instruction: "继续这个文献综述。",
    files: {
      ".toulmin/screening.csv": SCREENING_CSV,
    },
    maxTurns: 25,
    seed: (db) => {
      const ins = db.prepare("INSERT INTO nodes (type, content, data) VALUES (?, ?, ?)");
      const regTag = db.prepare("INSERT INTO tags (name, description, claim_id) VALUES (?, ?, ?)");
      const tag = db.prepare("INSERT INTO node_tags (node_id, tag) VALUES (?, ?)");

      // 1:低层 Claim(已有 Rebuttal 的那个)
      ins.run(
        "claim",
        "情景记忆类机制普遍假设存储无上界。",
        JSON.stringify({ status: "proposed" }),
      );
      // 2:meta:protocol Statement,仍 pending,已挂 screening.csv
      ins.run(
        "statement",
        "研究问题:固定存储预算下的长程记忆机制有哪些 | Inclusion:2019 年后、主实验含记忆预算消融的一手研究 | " +
          "Exclusion:非英文(LANG)、非同行评审场地(VENUE)、2019 年前(YEAR)、与记忆机制无关(OFF-TOPIC)、二手综述(NOT-PRIMARY) | " +
          "Planned search:4 条 query × 7 个场地",
        JSON.stringify({
          source: "observed",
          verification: "pending",
          attachments: ["screening.csv"],
        }),
      );
      // 3、4:alpha 已提取且已分类
      ins.run(
        "statement",
        "Alpha 2023:情景记忆缓冲在无界存储下把长程问答准确率提高 7.4 个点(12 个基准,positive)。",
        JSON.stringify({
          source: "literature",
          verification: "pending",
          attachments: ["papers/alpha2023.pdf"],
        }),
      );
      ins.run(
        "statement",
        "Alpha 2023:把缓冲截断到 1k token 后增益归零(1 个基准,null)。",
        JSON.stringify({
          source: "literature",
          verification: "pending",
          attachments: ["papers/alpha2023.pdf"],
        }),
      );
      // 5:delta 已提取但未分类 —— P4 待办
      ins.run(
        "statement",
        "Delta 2021:分层摘要在固定预算下保住 82% 的长程回忆(3 个基准,positive)。",
        JSON.stringify({
          source: "literature",
          verification: "pending",
          attachments: ["papers/delta2021.pdf"],
        }),
      );
      // 6:曾被标 meta:conflict、已转成 Rebuttal 并清掉标签的那条 —— 不得再读成未处理
      ins.run(
        "statement",
        "Epsilon 2020:报告未能复现 alpha2023 的无界存储假设,在两个数据集上给出有界存储的反例(2 个基准,boundary)。",
        JSON.stringify({
          source: "literature",
          verification: "pending",
          attachments: ["papers/epsilon2020.pdf"],
        }),
      );
      db.prepare(
        "INSERT INTO rebuttal_targets (statement_id, target_id, target_type) VALUES (?, ?, ?)",
      ).run(6, 1, "claim");

      regTag.run("meta:protocol", "综述协议与筛选记录", null);
      // 冲突登记表已清空:标签仍注册,但没有任何节点挂着它
      regTag.run("meta:conflict", "该 Statement 与另一发现冲突;第五阶段处理", null);
      regTag.run("paper:alpha2023", "INCLUDED — 无界存储下的情景记忆缓冲", null);
      regTag.run("paper:beta2024", "INCLUDED — 固定预算下的记忆压缩", null);
      regTag.run("paper:gamma2022", "MERGED — propositions folded into #3", null);
      regTag.run("paper:delta2021", "INCLUDED — 分层摘要式记忆", null);
      regTag.run("paper:epsilon2020", "INCLUDED — 有界存储反例", null);
      // theme 已有一个,但还没有 claim_id —— 第五阶段未开始
      regTag.run("theme:episodic-memory", "以情景缓冲保存并回放具体交互的机制。", null);

      tag.run(2, "meta:protocol");
      tag.run(3, "paper:alpha2023");
      tag.run(3, "theme:episodic-memory");
      tag.run(4, "paper:alpha2023");
      tag.run(4, "theme:episodic-memory");
      tag.run(5, "paper:delta2021");
      tag.run(6, "paper:epsilon2020");
      tag.run(6, "theme:episodic-memory");
    },
    assertions: [
      {
        name: "screening.csv 总行数未变(候选清单没被重建)",
        check: (ctx) => {
          const csv = readScreening(ctx.scratch);
          if (!csv) return "screening.csv 不存在了 —— 唯一不可复现的候选清单被删掉了";
          return csv.total === SCREENING_TOTAL
            ? true
            : `总行数从 ${SCREENING_TOTAL} 变成 ${csv.total}:候选清单被重新搜索或覆写了`;
        },
      },
      {
        name: "已决行没有被退回 PENDING",
        check: (ctx) => {
          const csv = readScreening(ctx.scratch);
          if (!csv) return "screening.csv 不存在了";
          return csv.decided >= SCREENING_DECIDED
            ? true
            : `已决行从 ${SCREENING_DECIDED} 降到 ${csv.decided}:整文件被覆写,决定被抹掉了`;
        },
      },
      {
        name: "MERGED 的论文没有被重新派发提取",
        check: (ctx) => {
          const t = registeredTags(ctx.db, "paper:gamma2022");
          if (t.length === 0) return "paper:gamma2022 标签被删掉了";
          const desc = t[0]!.description;
          if (!desc.startsWith("MERGED"))
            return `paper:gamma2022 的描述被改成了「${desc}」:MERGED 是终态,不该被覆写`;
          const n = tagNodeCount(ctx.db, "paper:gamma2022");
          return n === 0
            ? true
            : `paper:gamma2022 上出现了 ${n} 个节点:已去重归并的论文被当成"未提取"重新派发了`;
        },
      },
      {
        name: "已处理完的冲突没有被重新标记为未处理",
        check: (ctx) => {
          const tags = nodeTags(ctx.db, 6);
          if (tags.includes("meta:conflict"))
            return "id=6 被重新打上 meta:conflict:已转成 Rebuttal 的冲突被读成了未处理";
          const n = tagNodeCount(ctx.db, "meta:conflict");
          return n === 0
            ? true
            : `meta:conflict 上出现了 ${n} 个节点:冲突登记表被重新填了(原冲突已在图上有 Rebuttal)`;
        },
      },
      {
        name: "未分类的 Statement 被归了类(P4 推进)",
        check: (ctx) => {
          const tags = nodeTags(ctx.db, 5);
          return tags.some((t) => t.startsWith("theme:"))
            ? true
            : "id=5 仍然只有 paper: 标签、没有 theme: 标签:P4 待办没有推进";
        },
      },
    ],
    rubric: [
      "从图状态本身推断进度,没有依赖会话历史",
      "认出 screening.csv 里的 PENDING 行是某次派发中途死掉留下的,派出只筛选(Mode B)的一趟,而不是重跑搜索或重建文件",
      "派发前记下总行数与已决行数,返回后两个数都核对(不只核总行数)",
      "已有 paper: 标签的论文不再重新检索",
      "正确判断下一步该做 P3(提取 paper:beta2024)还是 P4(给 id=5 分类),而不是宣称「什么都还没做」",
    ],
  },
];

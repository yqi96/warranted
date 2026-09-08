# Agent 行为评测（agent-eval）

评测 `toulmin-researcher` 是否遵守当前 Proposition 图的判断边界。默认只做 dry-run；`--live` 才会真实调用 Claude，可能产生费用。

## 两层测试

| Tier | 测什么 | 方式 | 成本 |
|------|--------|------|------|
| 1 判断层 | agent 声称会如何判断：图是否介入、命题/证据时序、什么结果会改变 qualifier | 包装成“只说计划”的 `claude -p`，rubric 可交给 judge | 低，通常一个主会话调用/例 |
| 2 行为层 | agent 实际执行后在文件和 `.toulmin/graph.db` 留下什么 | 独立临时目录运行真实指令，对 SQLite 与产物做硬断言 | 高，最多 8–20 turns/例 |

Tier 1 能快速发现计划层回归，但“说会做”不等于“实际做到”。证据没回图、忘记 `set_qualifier`、覆盖矛盾、把支持性工作写成活动命题等问题需要 Tier 2。

## 当前 8 个用例

| Tier | Case | 失败模式 |
|------|------|----------|
| 1 | `support-task-plan` | 纯文件转换被包装成图节点 |
| 1 | `generalization-unseen` | 未枚举场景不会推导命题形态与预注册时序 |
| 1 | `graph-question-readonly` | 图状态查询产生写入 |
| 1 | `synthesis-shape` | 综述记录活动而不是多层可判断命题 |
| 2 | `support-task-live` | 支持性任务污染图，或原任务未完成 |
| 2 | `hypothesis-prereg` | 先看结果后补命题、无 warrant/证据、未定 qualifier |
| 2 | `contradiction-preserved` | 用改写/删除吞掉旧结论与旧观测，而非记录 rebuttal |
| 2 | `midtask-evidence-emerges` | 支持性任务途中发现反例却不回图，或反例挤掉原任务 |

`tag-consistency` 与 `survey-resume` 曾服务于旧 tags 本体，已随 `90c7acb` 删除。前者不再有被测对象；后者“从图状态恢复进度”的意图仍有价值，但需等当前文献综述图形态稳定后重新定义断言。

## 用法

```bash
bun run agent-eval                     # dry-run：列出全部 8 例，不调用模型
bun run agent-eval -- --tier 1 --live  # 只跑 4 个判断层用例
bun run agent-eval -- --tier 2 --live  # 只跑 4 个行为层用例
bun run agent-eval -- --case support-task-live --live
bun run agent-eval -- --case a,b --live
bun run agent-eval -- --live --judge   # 对有 rubric 的用例增加 LLM judge
bun run agent-eval -- --live --model <model>
bun run agent-eval -- --live --timeout 900
```

不加 `--live` 永远不会调用 Claude。dry-run 显示的是主会话/可选 judge 的 CLI 调用数；若 live agent 显式调用 Warranted 的 `review` 且 review 配置有效，reviewer 子调用是额外成本。

无需为了运行评测移动或清空 `review.json`。当前创建、更新和定档都不会自动 review；只有 agent 显式调用 `review(id)` 时才使用审查模型。配置不存在或无效时，显式 review 会报告不可用且不伪造 pass，结构 warning 仍正常工作。

## 洁净室与产物

每个用例在 `mkdtemp` 创建的系统临时目录中运行，防止被测 agent 把 Warranted 仓库误当成用户项目。runner 会：

1. 写入该用例的 fixture；
2. 需要 seed 时，用产品自己的 `openDatabase` 和 service API 创建 `.toulmin/graph.db`；
3. 从临时目录运行 `claude -p --plugin-dir <repo> --agent warranted:toulmin-researcher`；
4. 对图和文件运行断言；
5. 把完整 scratch 归档到结果目录后删除临时目录。

结果位于 `tests/agent-eval/results/<timestamp>/<case-id>/`：

| 文件 | 内容 |
|------|------|
| `answer.md` | agent 最终文本 |
| `response-raw.json` | Claude CLI 原始 JSON |
| `graph-dump.json` | propositions、槽位关系、findings、events |
| `report.json` | 硬断言与可选 judge 结果 |
| `judge-raw.json` | 启用 judge 时的原始输出 |
| `scratch/` | 完整运行目录，含 `.toulmin/graph.db` 和任务产物 |

`--dangerously-skip-permissions` 只用于隔离的临时目录，否则 headless 工具调用会被权限询问阻断。用户全局 Claude 配置和 hooks 仍可能加载；这是对真实插件部署条件的保留，而不是完全空白的模型环境。

## 断言面

Tier 2 直接查询当前 schema，不通过 service 读取，从而区分“agent 没写对”和“service 读模型自己掩盖了错误”。dump/辅助覆盖：

- `propositions`：content、warrant、qualifier；
- `evidence_nodes` / `evidence_attachments`：证据槽；
- `rebuttals`：反驳槽；
- `findings`：显式 review 意见；
- `events`：创建、更新、判断、review、dismiss 的真实顺序。

seed 必须走产品 schema/service，而不是复制 SQL。`set_qualifier` 同时写 baseline；手写 seed 会让 R0–R3 重查机制失真。

Tier 1 有统一硬断言：被要求“只说计划”时不能实际创建命题。Tier 2 的时序断言使用 append-only `events` 中的 create 次序，不再从节点 id 猜顺序。

## 添加用例

在 `cases.ts` 增加一个 `EvalCase`：

- 一例只针对一种已知失败模式，不写“顺便测测”的大杂烩。
- Tier 1 必须提供 `rubric`；Tier 2 必须提供 `assertions`，客观条件优先写硬断言。
- 只有确实需要模型判断的模糊质量标准才交给 `rubric`/`--judge`。
- fixture 用相对路径；seed 走 service；SQLite 查询辅助放在 `helpers.ts`。
- 新用例应同步更新本 README 的数量和用例表。

## 已知局限

- Tier 1 的假设框架会诱导模型进入解释模式，表现往往好于真实执行；Tier 1 全绿不代表 Tier 2 无问题。
- Live 结果受模型、全局配置和 hooks 影响，存在非确定性；硬断言能覆盖的不要交给 judge。
- 当前 8 例没有覆盖显式 `review` 的成本/处置策略，也没有覆盖新的文献综述恢复语义。
- `--timeout` 杀进程后仍可能留下部分输出；报告应结合 `response-raw.json` 和 scratch 检查。

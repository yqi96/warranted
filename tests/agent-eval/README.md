# Agent 行为评测(agent-eval)

测试 `toulmin-researcher` 在不同场景下的判断与行为。**每次 live 运行都会真实调用模型,注意成本。**

## 两层测试

| Tier | 测什么 | 方式 | 成本 |
|------|--------|------|------|
| 1 判断层 | 陈述的计划:该不该建图、什么形态、什么时序 | `claude -p "假设接到以下指令…只说计划"` | 低(约 1 turn/例) |
| 2 行为层 | 实际执行后的图状态 | 临时目录跑真指令,然后对 `.toulmin/argument.db` 做 sqlite 断言 | 高(最多 8–20 turns/例) |

Tier 1 快、便宜,适合改一版 prompt 立刻回归;但"说 ≠ 做"——执行期 drift(证据不回图、忘记 compile)只有 Tier 2 能测到。

## 用法

```bash
bun run agent-eval                     # dry-run:只列计划,不花钱(默认)
bun run agent-eval -- --tier 1 --live  # 只跑判断层
bun run agent-eval -- --case support-task-live --live
bun run agent-eval -- --live --judge   # 附带 LLM judge 按 rubric 评分
bun run agent-eval -- --live --model claude-sonnet-5
bun run agent-eval -- --live --timeout 900
```

不加 `--live` 永远是 dry-run,防误触发。

## 跑之前

- **移走或清空 `review.json`**:否则每次建节点都触发 LLM review,慢且贵。测 review 链路时再单独开。
- 结果在 `tests/agent-eval/results/<时间戳>/<用例id>/`:`answer.md`(agent 回答)、`graph-dump.json`(运行后图状态)、`report.json`(断言结果)、`scratch/`(完整工作目录,含 DB)。

## 机制说明

- `--plugin-dir` 指向仓库根,`--agent warranted:toulmin-researcher` 显式指定主 agent(从任意 cwd 都生效)。
- 被测会话带 `--dangerously-skip-permissions`:headless 下不加会拒绝工具调用,Tier 2 无法执行;风险由洁净室隔离兜底。
- 每个用例在**系统临时目录**(`mkdtemp`)下的独立洁净室中运行,避免被测 agent 把 warranted 仓库当作所在项目;跑完整个工作目录(含 DB)归档回 `results/<时间戳>/<用例id>/scratch/` 后删除临时目录。注意:用户全局配置(`~/.claude/CLAUDE.md`、hooks)仍会加载——这与真实部署条件一致,属有意保留。
- MCP 服务的 DB 落在 `<scratch>/.toulmin/argument.db`(`--no-persist` 只关操作日志,不影响 DB 落盘)。
- Tier 1 有一条统一硬断言:声称"只说计划"时不得实际创建节点。
- Tier 2 断言直接查 sqlite;时序类断言用节点自增 id 判先后。
- `seed` 用例(如 `contradiction-preserved`)会用 `sql/schema.sql` 预建图状态,再看 agent 如何对待已有结论。

## 加用例

在 `cases.ts` 里加一条 `EvalCase`:

- 病症对应:每个用例应针对一种已知失败模式(记事本病、不会用病、时序错误、矛盾抹除、豁免滥用),不要写"顺便测测"的用例。
- Tier 1 写 `rubric`(judge 逐条打分);Tier 2 写 `assertions`(可失败的客观检查优先,模糊标准才交给 `rubric`)。
- 断言辅助函数见 `helpers.ts`。

## 已知局限

- Tier 1 的假设框架会让模型进入"解释模式",表现通常好于实际执行;Tier 1 全绿 ≠ 没问题。
- id 时序断言只能证明创建顺序,不能证明 agent 在实验**之前**写了 pending(实验本身不在图里留痕);更强的时序证据需要解析会话 transcript。
- judge 本身是 LLM,rubric 判分有噪声;硬断言能覆盖的不要交给 judge。

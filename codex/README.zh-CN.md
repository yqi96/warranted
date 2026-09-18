# Warranted：guidance 的 Codex 实验接入

完整操作步骤、从 `review.json` 读取凭据及三个分支的用法，见 [中文使用文档](USAGE.zh-CN.md)。

本分支 `codex/exp-codex-guidance` 独立派生自 `codex/exp-guidance`，父提交 `0a514fb8509bafaa7c06f331a3aadc7f8a1e3aea`。只新增 `codex/`，所有原有 tracked 文件（含源码、依赖锁、提示词和实验定义）与父提交一致。没有其他处理的实现，也没有运行时处理开关。

主研究 agent 使用 Codex；full 中的评审器继续使用原有 Claude Agent SDK。完整父实验协议见 `../EXPERIMENT.md`。本接入用于无人工界面操作的实验，不加载 Claude 插件及 visualizer selection hook；在 Claude Code 对照中也不要启动或使用该界面注入。

## 准备一次试验

依赖：Python >= 3.11、Codex CLI >= 0.155.0、Bun，以及 full 评审器原有的运行环境。当前验证版本为 Codex CLI 0.155.0、Bun 1.3.14。主模型必须由你指定准确 ID；接入不推断或替换模型，也不配置代理转换。

在本分支 checkout 中先安装锁定的依赖并验证父版本：

```bash
bun install --frozen-lockfile
python3 codex/prepare.py --verify
```

准备脚本只生成配置，不启动模型或评审器。三个分支使用同一个接口，各分支只生成自己的 profile。

```bash
python3 codex/prepare.py \
  --task-dir /path/to/fresh-task \
  --runtime-dir /path/to/new-codex-runtime \
  --model "$EXPERIMENT_MODEL" \
  --base-url "$EXPERIMENT_BASE_URL"
```

- `--task-dir` 必须已存在并包含 `TASK.md` 等允许输入，位于 Warranted checkout 之外。每个试验使用新任务副本，不能含已有 `.toulmin`、项目 `.codex` 或 `.agents`。
- `--runtime-dir` 必须尚不存在，且与任务目录分离。它保存独立配置、profile、准备回执以及后续 Codex 会话状态。不要放入研究输入包。
- 默认 API key 环境变量是 `DEEPSEEK_API_KEY`；可用 `--api-key-env` 指定已有变量名。通过本地安全方式设置变量，脚本不读取或写入密钥。
- `--base-url` 必须支持 Responses API 与工具调用。只支持 Chat Completions 的服务不能直接使用；需另行验证转换层。已用 DeepSeek 官方 `https://api.deepseek.com` 的 Responses 接口和 `deepseek-flash` 完成真实调用；其他端点/模型仍需分别验证。`review.json` 中的 `/anthropic` 地址用于评审器，不应原样用作 Codex 的 base URL。
- full 必须显式提供 `--review-config`，使用与 Claude Code full 试验相同的评审配置；配置文件必须位于任务输入目录之外。其他分支拒绝此参数。它不会被复制进生成配置，MCP 只接收文件路径。

## 直接使用 Codex

准备后使用原生 CLI，不经过额外运行器：

```bash
# 交互运行；-m 可显式指定模型，正式试验应与准备回执一致
CODEX_HOME=/path/to/new-codex-runtime \
  codex -p warranted-guidance -m "$EXPERIMENT_MODEL" -C /path/to/fresh-task

# 非交互运行，TASK.md 从 stdin 传入，保存事件与最终回答
CODEX_HOME=/path/to/new-codex-runtime \
  codex exec --strict-config -p warranted-guidance \
  -C /path/to/fresh-task --skip-git-repo-check --json \
  -o /path/to/new-codex-runtime/final.md \
  < /path/to/fresh-task/TASK.md \
  > /path/to/new-codex-runtime/events.jsonl \
  2> /path/to/new-codex-runtime/stderr.log
```

必须使用对应的 `-p warranted-guidance`，并让 `-C` 与准备时的 `--task-dir` 相同：MCP 的 cwd 和数据库路径已绑定该任务。换任务应重新准备，不能只改 `-C`。移动 checkout 后同样应重新准备。

profile 使用 Codex >= 0.134 引入的独立 `*.config.toml` 文件。`developer_instructions` 是原 agent 文件去掉 YAML frontmatter 后的正文，保留正文全部字节；不替换 Codex 原生基础指令。MCP 直接执行本分支 `src/index.ts`，不靠工具过滤模拟其他处理。数据库固定在本次任务的 `.toulmin/graph.db`。

生成配置的公共默认值：`workspace-write`、`approval_policy=never`、原生 web search 关闭；关闭 hooks、记忆、apps 和远程插件目录；不加载 AGENTS.md，项目根限制在任务目录，项目标记为 untrusted，隔离个人配置与项目自定义配置。Codex 内建能力（如内建 skills、原生委派）保留。records/full 对这个已冻结的本地 Warranted MCP server 显式设置 `default_tools_approval_mode="approve"`，避免 `approval_policy=never` 时工具调用被审批阻断；该设置不扩大 shell 沙箱权限。此配置隔离不构成文件读取安全边界；严格的数据/秘密隔离仍由容器或实验 harness 的挂载权限提供。

模型思考参数、上下文窗口、网络权限和紧急中止预算应由实验协议明确，然后通过原生 `-c` / `-s` 参数设置并留档。默认工作区沙箱不开放 shell 网络；需要联网研究时，可在各对照中统一设置 `-c sandbox_workspace_write.network_access=true`。不要只改其中一组的资源权限。同名 effort 不自动代表不同 API 中相同的推理预算。

full 的 MCP 工具超时默认至少 1800 秒，且不低于两次评审尝试的配置超时加 120 秒；可用 `--tool-timeout-sec` 进一步提高。它只是传输等待上限，不改变评审器自身预算、重试或判断逻辑。主模型传输重试配置为 0；实际 tokens、调用数与耗时仍按试验观测记录。

## 一致性检查及留档

```bash
python3 codex/prepare.py --verify
python3 codex/test_prepare.py
bun test ./tests
./node_modules/.bin/tsc --noEmit
```

`--verify` 校验所有父版本文件无差异，以及完整 agent 文件和正文 SHA-256。修改任何原有 tracked 文件都会使准备失败。`adapter.json` 固定父提交和提示词哈希；`preparation.json` 记录源码路径、adapter 提交/dirty 状态、Codex 版本、期望工具、模型和生成配置哈希，状态始终为 `prepared_only`。后续命令行覆盖值及实际轨迹另行保存，准备回执不是实验完成凭据。

应在独立环境逐个分支运行父测试：旧测试使用固定 `/tmp/warranted-sdk-options` 路径，多个分支同时跑会互相干扰。无需为此修改被冻结的父测试。

验证通过只能证明 Warranted 实现、提示词正文及接入契约一致；两个主 agent 框架的基础指令、提示词注入层级、工具调度与上下文管理仍有差异。论文中将这些作为框架变量记录。裸模型对照直接使用独立的 Codex 配置，不需要额外 Warranted 分支。

配置来源：[OpenAI 官方 Profiles 文档](https://learn.chatgpt.com/docs/config-file/config-advanced)、[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)、[MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。本次检查结果见 `VALIDATION.md`。

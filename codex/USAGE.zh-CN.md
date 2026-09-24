# 使用 Codex 运行 Warranted 0.6.0

入口为本分支的 `codex/prepare.py` 和原生 `codex` 命令。它不是需要安装到 Codex marketplace 的插件包，也不需要启动 Claude Code 主会话；内部评审仍依赖原 Claude Agent SDK。

## 1. 安装依赖

在 `codex/v0.6.0-codex` 分支的源代码目录执行：

```bash
bun install --frozen-lockfile
python3 codex/prepare.py --verify
codex --version
```

需要 Python 3.11+、Bun、Node.js 和 Codex CLI 0.155.0+；本次只验证了 0.155.0。真正操作网页时还需要 Chrome。具体 skill 需要的 `uv`、LaTeX 或 Overleaf 登录由使用该 skill 时处理。

`--verify` 检查 v0.6.0 的父提交、研究提示词哈希，以及除已声明 Codex skill 改动之外的原文件一致性。

## 2. 准备一次运行

源代码、任务和 Codex 运行配置使用独立目录。每次试验创建新的任务副本和运行目录，不复用 `.toulmin`。把任务说明写入 `TASK.md`，只放本次允许 agent 使用的输入材料。

```bash
SOURCE="$PWD"
TRIAL="$HOME/warranted-runs/v060-001"
REVIEW_CONFIG="/absolute/path/to/review.json"
mkdir -p "$TRIAL/task"
# 在 $TRIAL/task 中放好 TASK.md 和本次任务允许使用的材料。
```

任务目录不能位于源代码目录中，也不能预先带有 `.toulmin`、`.codex` 或 `.agents`。`review.json` 必须位于任务目录外，包含评审自己的 `apiKey`；准备脚本不会把它复制进任务或运行配置。目录分离用于减少误入输入的配置，不代表操作系统级保密隔离。

如果主模型与评审使用同一 DeepSeek 账户，可以从现有私有配置读取 key；不要把 key 写进命令参数或提交到 Git：

```bash
set +x
export DEEPSEEK_API_KEY="$(python3 - "$REVIEW_CONFIG" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["apiKey"])
PY
)"
MODEL="$(python3 - "$REVIEW_CONFIG" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["model"])
PY
)"

python3 "$SOURCE/codex/prepare.py" \
  --task-dir "$TRIAL/task" \
  --runtime-dir "$TRIAL/runtime" \
  --model "$MODEL" \
  --base-url https://api.deepseek.com \
  --api-key-env DEEPSEEK_API_KEY \
  --review-config "$REVIEW_CONFIG"
```

这里的 `MODEL` 必须也是主服务可用的精确模型 ID，可以自行替换。主 Codex provider 使用 **Responses API**；`review.json` 中原有的 Anthropic 兼容地址用于评审。不要把评审地址的 `/anthropic` 后缀直接当作主模型地址，也不要把仅支持 Chat Completions 的服务当作 Responses 服务。

准备操作只生成文件，不调用模型。输出包括 `config.toml`、`warranted-v060.config.toml`、`agents/`、`skills/` 和 `preparation.json`。后者记录父提交、适配代码状态、模型、版本、配置与提示词哈希；`prepared_only` 不表示任务已经运行成功。准备完成后保留源代码目录及依赖，MCP 仍从那里启动。

## 3. 启动

```bash
env CODEX_HOME="$TRIAL/runtime" codex exec \
  --strict-config -p warranted-v060 \
  -C "$TRIAL/task" --skip-git-repo-check --json - \
  < "$TRIAL/task/TASK.md" \
  > "$TRIAL/events.jsonl" 2> "$TRIAL/stderr.log"
```

交互运行使用相同配置：

```bash
env CODEX_HOME="$TRIAL/runtime" codex \
  --strict-config -p warranted-v060 -C "$TRIAL/task"
```

配置默认采用 `workspace-write`、`approval_policy=never`，允许这两个本地 MCP 服务执行工具，原生网络搜索关闭。它不自动扩大 shell 的网络或目录访问权限。若研究任务需要其他权限，按实验协议统一设置，并记录实际启动参数。

Codex 0.155.0 的子 agent 会继承父 agent 的全部 MCP 工具；原角色白名单不能形成硬限制，提示词中的只读职责仍需遵守。准备时会提示此差异，并写入 `preparation.json`；如果实验要求工具权限严格等价，不能直接把这一分支算作满足条件。

## 4. 用参数更换模型或服务

最容易复现的方式是为新的运行重新准备目录，显式提供不同的 `--model`、`--base-url` 和 `--api-key-env`。已有配置也可以临时覆盖：

```bash
env CODEX_HOME="$TRIAL/runtime" codex exec \
  --strict-config -p warranted-v060 -m YOUR_MODEL_ID \
  -c 'model_providers.experiment.base_url="https://your-responses-provider.example/v1"' \
  -c 'model_providers.experiment.env_key="OTHER_PROVIDER_API_KEY"' \
  -C "$TRIAL/task" --skip-git-repo-check --json - \
  < "$TRIAL/task/TASK.md"
```

先在环境中设置对应 key；示例域名需要换成服务的实际 Responses 地址。`-m` 控制主 agent 与默认继承模型的子 agent，不改变评审模型。评审继续读取 `review.json`。临时 `-c` / `-m` 不会重写 `preparation.json`，必须另外保存实际启动参数；正式对照建议重新准备，避免记录和实际运行不一致。

## 5. 检查加载与结果

```bash
env CODEX_HOME="$TRIAL/runtime" codex -p warranted-v060 \
  -C "$TRIAL/task" mcp list --json
```

应看到 `plugin_warranted_toulmin` 和 `plugin_warranted_browser` 两个启用的服务。这个命令只验证配置列表；一次真正成功的工具调用要看 `events.jsonl` 中 `mcp_tool_call` 的完成状态、空错误和实际返回值。`--strict-config` 不适用于 `mcp` / `debug` 子命令。

- `events.jsonl`：Codex 会话事件、工具结果和会话用量事件。
- `stderr.log`：模型元信息、MCP 启动和运行错误。
- `task/.toulmin/graph.db`：原版 Warranted 图谱、历史和评审审计数据。
- `task/`：研究文件和结果。
- `runtime/preparation.json`：准备时的可复现性记录。

主 agent 和评审的用量来自不同链路，应分别统计。此适配没有更改此前排查的评审 `usage` / `modelUsage` 口径，也不能把二者相加当作一份用量。研究输入、模型 ID、上下文窗口、推理参数、原生工具权限、评审配置和 SDK 版本需在各组中按实验设计固定。

## 6. 常见问题

| 现象 | 处理 |
| --- | --- |
| 运行目录已经存在，或任务已有 `.toulmin` | 新建运行目录和干净任务副本；不要删除有价值的旧结果 |
| `Frozen parent files changed` | 查看是否误改原版实现；此分支只允许清单中的两处 skill 适配 |
| MCP 启动失败 | 检查 Bun、Node、依赖安装、源目录路径和 `stderr.log` |
| 401 / 模型不存在 / 协议错误 | 检查当前终端的 key 环境变量、模型 ID 与 Responses 地址 |
| Unknown model / fallback model metadata | 请求可能仍可用，但正式实验需另外固定模型元信息和推理参数 |
| 没有自动推送 Overleaf | 运行 `overleaf-setup` 给出的同步命令；该分支不安装结束回合 hook |
| 原可视化器选择没有注入下一条消息 | 本分支不加载 Claude 的选中节点 hook，可在任务中明确提供相关 proposition ID |

本次验证使用本机模拟模型和真实 Codex/MCP，未调用真实模型、评审或 Overleaf 推送。详见 [验证记录](VALIDATION.md)。

# Warranted + Codex 使用文档

适用日期：2026-09-18。以下命令适用于 Bash / zsh；本机已验证 Codex CLI 0.155.0、Bun 1.3.14、Python 3.12。

主研究 agent 使用 **Codex + 指定模型**；full 组的内部评审继续使用原有 Claude Agent SDK 和独立的 `review.json`。启动主 agent 时修改 `-m`，不会更改评审模型。

## 1. 选择实验分支

| 实验组 | Codex 分支 | 独立派生自 | 启动 profile | Warranted 工具数 |
|---|---|---|---|---:|
| 方法提示 | `codex/exp-codex-guidance` | `codex/exp-guidance` | `warranted-guidance` | 0 |
| 记录工具 | `codex/exp-codex-records` | `codex/exp-records` | `warranted-records` | 9 |
| 完整评审 | `codex/exp-codex-full` | `codex/exp-full` | `warranted-full` | 11 |

三个分支只在各自父分支上新增 `codex/`。每个分支只提供自己的实验组，没有跨组切换开关。工具数仅指 Warranted MCP，不包括 Codex 原生工具。裸 Codex 对照另用干净配置，不加载这里的 profile。

本机已有三个 checkout，直接进入即可：

```text
/home/qiyao/workspace/warranted/tmp/paper-arms/codex-guidance
/home/qiyao/workspace/warranted/tmp/paper-arms/codex-records
/home/qiyao/workspace/warranted/tmp/paper-arms/codex-full
```

截至本文编写，这三个 Codex 派生分支只在本地，尚未推送。其他机器需要先获得对应分支，再将下文路径替换为当地实际路径。

## 2. 完整组：从本地配置到启动

下面先做一次只调用 `get_stats` 的连通性测试。正式研究时使用新的任务目录和 runtime，将测试提示替换为研究任务。

### 2.1 读取模型和密钥

在同一个终端依次执行：

```bash
WARRANTED_SOURCE=/home/qiyao/workspace/warranted/tmp/paper-arms/codex-full
WARRANTED_PROFILE=warranted-full
WARRANTED_REVIEW_CONFIG=/home/qiyao/workspace/warranted/review.json

set +x
WARRANTED_MODEL="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["model"])' "$WARRANTED_REVIEW_CONFIG")"
DEEPSEEK_API_KEY="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["apiKey"])' "$WARRANTED_REVIEW_CONFIG")"
export DEEPSEEK_API_KEY
WARRANTED_BASE_URL=https://api.deepseek.com
```

这会从现有文件读取模型与 key，不把 key 写入命令文本或生成配置。不要输出密钥变量，也不要把 `review.json` 放进任务输入。

本机这份配置的模型为 `deepseek-flash`。两种地址必须区分：

| 用途 | 地址 | 如何传入 |
|---|---|---|
| Codex 主模型，Responses 协议 | `https://api.deepseek.com` | `--base-url` |
| full 内部评审，Anthropic 协议 | `https://api.deepseek.com/anthropic` | 保留在原 `review.json` |

准备脚本不会将 Anthropic 地址转换成 Responses 地址，所以这里显式设置主模型地址。

### 2.2 准备独立任务目录

```bash
WARRANTED_RUNS=/home/qiyao/workspace/warranted-runs
mkdir -p "$WARRANTED_RUNS"
WARRANTED_RUN="$(mktemp -d "$WARRANTED_RUNS/full.XXXXXX")"
WARRANTED_TASK="$WARRANTED_RUN/task"
WARRANTED_RUNTIME="$WARRANTED_RUN/runtime"
mkdir "$WARRANTED_TASK"

cat > "$WARRANTED_TASK/TASK.md" <<'EOF'
调用 Warranted 的 get_stats 工具读取空数据库统计，不创建研究记录，不调用 review。
工具成功执行后仅回复 CODEX_DEEPSEEK_MCP_OK；若失败，请报告实际错误。
EOF
```

每次试验都使用新目录。`task` 必须已存在，`runtime` 必须尚不存在；两者相互独立。任务目录与所选源码 checkout 也必须分离，不能包含已有 `.toulmin`、`.codex` 或 `.agents`。

### 2.3 安装依赖并生成配置

需事先安装 Python >= 3.11、Codex CLI >= 0.155.0；records/full 还需要 Bun，full 评审需要原项目的评审运行环境。

```bash
cd "$WARRANTED_SOURCE"
bun install --frozen-lockfile
python3 codex/prepare.py --verify

python3 codex/prepare.py \
  --task-dir "$WARRANTED_TASK" \
  --runtime-dir "$WARRANTED_RUNTIME" \
  --model "$WARRANTED_MODEL" \
  --base-url "$WARRANTED_BASE_URL" \
  --review-config "$WARRANTED_REVIEW_CONFIG"
```

`--verify` 检查原有受版本控制文件及提示词哈希与冻结父版本一致。准备成功会显示 `Prepared only; no model or reviewer has been called.`，此时还没有发起模型请求。

### 2.4 启动原生 Codex

以下两种方式选一种。实际运行会调用模型并产生 API 用量。

**非交互运行，适合测试和批量实验中的单次试验：**

```bash
env CODEX_HOME="$WARRANTED_RUNTIME" \
  codex exec --strict-config \
  -p "$WARRANTED_PROFILE" -m "$WARRANTED_MODEL" \
  -C "$WARRANTED_TASK" --skip-git-repo-check --json \
  -o "$WARRANTED_RUNTIME/final.md" - \
  < "$WARRANTED_TASK/TASK.md" \
  > "$WARRANTED_RUNTIME/events.jsonl" \
  2> "$WARRANTED_RUNTIME/stderr.log"
WARRANTED_EXIT_CODE=$?
printf '%s\n' "$WARRANTED_EXIT_CODE" > "$WARRANTED_RUNTIME/exit-code.txt"
```

**交互运行，适合手动调试：**

```bash
env CODEX_HOME="$WARRANTED_RUNTIME" \
  codex --strict-config \
  -p "$WARRANTED_PROFILE" -m "$WARRANTED_MODEL" \
  -C "$WARRANTED_TASK"
```

交互启动后，将 `TASK.md` 中的任务作为首条消息发送；这个命令不会自动读取它。交互会话也会改变试验状态，之后的正式运行需重新准备。

`CODEX_HOME` 仅对这次命令生效，使用本次 runtime 中的独立配置。必须带正确的 `-p`，且 `-C` 必须等于准备时的 `--task-dir`：MCP 的工作目录和数据库路径已绑定，换任务或移动源码后需要重新生成配置。

### 2.5 查看结果

```bash
cat "$WARRANTED_RUNTIME/exit-code.txt"
cat "$WARRANTED_RUNTIME/final.md"
```

连通性测试应退出 0，最终回答为 `CODEX_DEEPSEEK_MCP_OK`。还应查看 `events.jsonl`：实际完成的 `mcp_tool_call` 应对应 `toulmin/get_stats`，`status=completed`、`error=null`，返回统计 `total=0`。仅有模型声称成功或进程退出 0，不足以证明工具成功执行。

| 文件 | 用途 |
|---|---|
| `runtime/config.toml` | 主模型、provider、沙箱及公共设置；只含密钥环境变量名 |
| `runtime/warranted-full.config.toml` | 本组提示词和 MCP 配置；其他组名称随 profile 改变 |
| `runtime/preparation.json` | 父版本、提示词哈希、模型、CLI 版本、源码路径、生成配置哈希 |
| `runtime/events.jsonl` | 非交互命令保存的模型与工具事件 |
| `runtime/stderr.log`、`runtime/exit-code.txt` | 非交互命令保存的诊断信息和退出码 |
| `runtime/final.md` | 非交互命令保存的最终回答 |
| `task/.toulmin/graph.db` | records/full 的本次实验数据库 |

`preparation.json` 的状态是 `prepared_only`，不会随运行自动变为成功。保留实际轨迹和启动参数；主 agent 的 token 统计也不等于主模型与内部评审的总用量。

## 3. 改用 guidance 或 records

先将 `WARRANTED_SOURCE`、`WARRANTED_PROFILE` 换为第 1 节中对应的 checkout 和 profile，然后重新执行第 2.2 节创建新任务与 runtime。可将目录名前缀 `full.` 改成对应组名，便于辨认。

这两组的准备命令如下，**不传 `--review-config`**：

```bash
cd "$WARRANTED_SOURCE"
python3 codex/prepare.py --verify
python3 codex/prepare.py \
  --task-dir "$WARRANTED_TASK" \
  --runtime-dir "$WARRANTED_RUNTIME" \
  --model "$WARRANTED_MODEL" \
  --base-url "$WARRANTED_BASE_URL"
```

records 需先在其 checkout 执行 `bun install --frozen-lockfile`，可以沿用 `get_stats` 测试提示。guidance 没有 Warranted 工具，连通性测试提示改为“仅回复 CODEX_DEEPSEEK_OK”，不要求调用 `get_stats`。随后沿用第 2.4 节原生启动命令。

即使 guidance/records 没有评审器，也可按第 2.1 节从现有 `review.json` 读取主模型连接凭据；这不会启用评审功能。

## 4. 换模型、参数和正式试验

- **同一服务换主模型：** 修改 `WARRANTED_MODEL`，使用服务实际支持的模型 ID，重新准备一次试验。启动参数 `-m` 也能覆盖模型；正式试验应保持它与准备回执一致。
- **换服务：** 重新设置 `WARRANTED_BASE_URL`、模型和密钥。服务需要支持 Codex 所用的 Responses API 与工具调用；仅兼容 Chat Completions 的接口不足以直接运行。
- **换密钥变量名：** 准备时增加 `--api-key-env YOUR_API_KEY_ENV`，启动前设置并导出该变量。参数传的是变量名，不是密钥。
- **保留评审设置：** full 始终通过 `--review-config` 读取原评审配置。主模型的 `-m`、provider 或推理参数不覆盖该文件。
- **原生参数覆盖：** 在第 2.4 节的 `codex` 命令中加 `-c '配置键=值'`。例如实验确需 shell 联网时，使用 `-c sandbox_workspace_write.network_access=true`，并在所有对照中统一权限。原生 web search 默认关闭。
- **推理与上下文设置：** 当前真实调用仍提示 `deepseek-flash` 缺少模型元数据并使用回退值。正式实验前固定相应模型目录、上下文窗口与推理设置；同名 effort 在不同框架中不代表相同预算。参见 [DeepSeek 官方 Codex 接入说明](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)。

正式运行时，重新创建任务目录，只放协议允许的输入，并用真正的研究任务替换 `TASK.md`。逐个试验保存任务输入、版本、模型与参数、评审配置的非密钥字段、日志、数据库和耗时；不要复用连通性测试的数据库或会话。

配置默认关闭个人记忆、hooks、apps、远程插件及 AGENTS 文档加载；保留 Codex 原生基础指令与内建能力。配置隔离不限制任意文件读取，严格的实验输入边界仍需实验环境的挂载或访问权限保证。

原有 Warranted 源码及提示词正文的一致性可以校验；Codex 与 Claude Code 的基础指令、提示词注入层级、工具调度和上下文管理属于框架差异。这里不保证两者行为或结果完全相同。各组的具体处理定义见本分支的 `EXPERIMENT.md`。

## 5. 常见问题

| 现象 | 处理 |
|---|---|
| `Runtime directory already exists` | 为新试验创建新目录，重新准备；不要复用旧 runtime。 |
| 任务含 `.toulmin`、`.codex` 或 `.agents` | 重新建立只含允许输入的任务副本。 |
| `Frozen parent files changed` | 检查是否改动了父版本文件，恢复预定实验版本后再验证；不要绕过检查。 |
| full 缺少 `--review-config` | 指向已有评审配置，且配置位于任务目录之外。 |
| guidance/records 拒绝 `--review-config` | 删除这个参数；它只属于 full。 |
| API 鉴权或协议错误 | 检查已导出的 key、准确模型 ID 和 Responses 地址；主模型不要使用 `/anthropic` 地址。 |
| `MCP tool call requires approval, but approval policy is never` | 使用已修复分支重新生成 runtime。其 Warranted MCP 配置含 `default_tools_approval_mode="approve"`。 |
| 缺少模型元数据警告 | 连通性已验证，元数据仍需在正式试验前固定。 |
| 换了 `-C`，工具仍指向旧任务 | 更换任务必须重新准备，不能只修改启动目录。 |

## 6. 已验证的范围

2026-09-18，使用本地 `review.json` 中的 key 与 `deepseek-flash`：

- DeepSeek 官方 Responses 接口返回 HTTP 200。
- 原生 Codex full 成功执行真实 Warranted `get_stats`，返回 `total=0`，最后回复 `CODEX_DEEPSEEK_MCP_OK`。
- 三组分别通过原有测试与类型检查，适配器离线测试共 15 项；本地模拟 API 检查了 0 / 9 / 11 个工具的实际暴露。
- 此次真实调用没有执行研究任务或内部 `review`；guidance/records 未分别重复真实 API 测试。

分支详细证据见同目录 `VALIDATION.md`。如需重跑原有测试，各分支应串行执行，避免共享的旧测试临时路径互相干扰。

参考：[Codex CLI 配置与 profile](https://learn.chatgpt.com/docs/config-file/config-advanced)、[MCP 配置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[DeepSeek Responses API](https://api-docs.deepseek.com/guides/responses_api/)。

# Toulmin MCP Server

基于 Toulmin 论证模型的论证状态管理 MCP Server。Agent 通过 12 个 MCP 工具提交、查询和管理论证节点（Claim / Ground / Warrant / Backing / Rebuttal），实现论证过程的持久化。结构变化时自动将受影响的 Claim 标记为 stale；agent 显式调用 `compile_arguments` 触发 LLM 逻辑链审查，通过后方可推进 Claim 状态。

## 快速开始

### 环境要求

- [Bun](https://bun.sh/) >= 1.0.0

### 安装

```bash
cd toulmin-mcp
bun install
```

### 启动

```bash
# 默认使用项目目录下的 .toulmin/argument.db（支持跨 Session 恢复）
bun src/index.ts

# 自定义数据库路径
bun src/index.ts --db-path ./custom.db

# 使用内存数据库（不持久化）
bun src/index.ts --db-path :memory:

# 启用 LLM 编译审查（需提供 review.json 配置文件）
bun src/index.ts --review-config ./review.json
```

Server 通过 **stdio** 与 Agent 通信，启动后等待 MCP 协议消息。

> 默认数据库文件 `.toulmin/argument.db` 已加入 `.gitignore`，不会提交到版本库。

---

## 配置

### Claude Code 配置

在项目目录创建 `.mcp.json` 文件：

```json
{
  "mcpServers": {
    "toulmin": {
      "command": "bun",
      "args": ["/absolute/path/to/toulmin-mcp/src/index.ts"]
    }
  }
}
```

将 `toulmin-mcp/agents/` 和 `toulmin-mcp/skills/` 拷贝到 `.claude/` 目录下（系统级 `~/.claude/` 或项目级 `.claude/` 均可）。

启动时指定 agent 参数：

```bash
claude --dangerously-skip-permissions --agent toulmin-researcher
```

### Claude Desktop 配置

在 `claude_desktop_config.json` 中添加：

```json
{
  "mcpServers": {
    "toulmin": {
      "command": "bun",
      "args": ["/absolute/path/to/toulmin-mcp/src/index.ts"]
    }
  }
}
```

### 命令行参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--db-path <path>` | `.toulmin/argument.db` | SQLite 数据库文件路径。`:memory:` 使用内存数据库 |
| `--review-config <path>` | 无（审查关闭） | LLM 审查配置文件路径（JSON）。不提供则禁用 compile_arguments |

---

## 工具列表

### 创建工具（5 个）

| 工具 | 说明 | 关键参数 |
|------|------|---------|
| `create_claim` | 记录一个主张 | `content` + `qualifier?` |
| `create_ground` | 记录一份证据 | Mode A: `content` + `source` + `verification` + `attachments?`；Mode B: `ref_claim_id` |
| `create_warrant` | 记录一条推理规则 | `claim_id` + `content` + `ground_ids`（必须至少一个） |
| `create_backing` | 记录 Warrant 的支撑 | `warrant_id` + `content` + `attachments?` |
| `create_rebuttal` | 记录失效条件 | `target_id` + `target_type` + `content` + `attachments?` |

### 读取工具（4 个）

| 工具 | 说明 | 关键参数 |
|------|------|---------|
| `list_claims` | 列出所有主张 | `status?`（可选过滤） |
| `get_argument` | 查看节点的完整论证子图 | `node_id` |
| `search_nodes` | 按关键词搜索 | `keyword` + `node_type?` |
| `get_stats` | 全局论证统计 | 无 |

### 修改与删除（2 个）

| 工具 | 说明 | 关键参数 |
|------|------|---------|
| `update_node` | 更新节点内容/状态 | `node_id` + 可选字段（含 `qualifier`） |
| `delete_node` | 删除节点 | `node_id` + `cascade?` |

### 编译与审查（1 个）

| 工具 | 说明 | 关键参数 |
|------|------|---------|
| `compile_arguments` | LLM 审查论证逻辑链，校验 Ground→Warrant→Claim 推理的连贯性。所有非 proposed 状态转换前必须通过 compile。需配置 `--review-config`。 | `claim_ids?`（省略则编译全部） |

---

## 数据模型

### 六要素

```
Claim ──< Warrant (0..N)     每个 Warrant 绑定一个 Claim
          └──< Ground (0..N)   通过 Warrant.ground_ids 关联
          └──< Backing (0..N)  挂到 Warrant

Claim.qualifier              Claim 的论证力度（"probably", "presumably" 等）
Claim ──< Rebuttal (0..N)    指向 Claim 或 Warrant

Ground ──> Claim (ref_claim_id)  链式推理：引用已有 Claim 作为证据
```

### 节点属性

| 类型 | 关键属性 |
|------|---------|
| **Claim** | content, qualifier（力度词，可选）, status（见下表） |
| **Ground** | content, attachments（含说明文档）, source (`literature` / `observed` / `hypothesis`), verification (`verified` / `pending`) |
| **Warrant** | content, claim_id, ground_ids |
| **Backing** | content, warrant_id |
| **Rebuttal** | content, target_id, target_type (`claim` / `warrant`) |

### Claim status 转换规则

| 目标状态 | 前提条件 |
|---------|---------|
| `proposed` | 初始状态，无条件 |
| `supported` | compile_status = passed + 至少一个 Warrant 且其所有 Ground 均 `verified` |
| `disputed` | compile_status = passed + 至少一个 Rebuttal（指向该 Claim 或其 Warrant） |
| `refuted` | compile_status = passed + 至少一个 Rebuttal |

### create_ground 两种模式

**Mode A — 普通证据：**
```
create_ground(
  content="实验数据：准确率95%",
  source="observed",
  verification="verified",
  attachments=["/results/exp.csv", "/results/ground-accuracy.md"]
)
```

**Mode B — 链式推理（引用已有 Claim 作为证据）：**
```
create_ground(ref_claim_id=1)
```

> 两种模式互斥，不可同时使用。Mode B 的 Ground 不需要 attachments。

---

## 使用示例

### 论文复现

```
# 1. 提取论文主张
create_claim("ScaleOpt 收敛速度是 Adam 的 2 倍", qualifier="probably")
→ claim #1

# 2. 设定待验证的证据假设（pending = 尚未验证）
create_ground(content="ResNet: 45 vs 90 epoch",
              source="hypothesis", verification="pending")
→ ground #2
create_ground(content="ViT: 80 vs 165 epoch",
              source="hypothesis", verification="pending")
→ ground #3

# 3. 建立推理
create_warrant(claim_id=1, content="多架构一致 → 非偶然",
               ground_ids=[2, 3])
→ warrant #4

# 4. 复现实验后更新证据（verified 需同时提供 attachments）
update_node(node_id=2, content="ResNet: 50 vs 90 (1.8×)",
            source="observed", verification="verified",
            attachments=["/results/resnet/ground-resnet.md"])
update_node(node_id=3, content="ViT: 82 vs 165 (2.0×)",
            source="observed", verification="verified",
            attachments=["/results/vit/ground-vit.md"])

# 5. 审查逻辑链（通过 compile 才可推进 Claim 状态）
compile_arguments(claim_ids=[1])

# 6. 实测 ResNet 仅 1.8×，未达"2 倍"，创建 Rebuttal 后标记 disputed
create_rebuttal(target_id=1, target_type="claim",
                content="ResNet 实测仅 1.8×，未达论文声明的 2 倍")
update_node(node_id=1, status="disputed")
```

### 假设验证

```
# 1. 提出假设
create_claim("数据增强通过多样性补偿数据不足")
→ claim #1

# 2. 推导预期证据（pending = 尚未验证）
create_ground(content="多样性收益应随数据规模递减",
              source="hypothesis", verification="pending")
→ ground #2

# 3. 建立推理
create_warrant(claim_id=1, content="规模递减 → 多样性是补偿机制",
               ground_ids=[2])
→ warrant #3

# 4. 实验验证后更新
update_node(node_id=2, content="实测：500→50K 单调递减",
            source="observed", verification="verified",
            attachments=["/results/augmentation/ground-augmentation.md"])

# 5. 审查逻辑链
compile_arguments(claim_ids=[1])

# 6. 判定
update_node(node_id=1, status="supported")
```

---

## 级联删除规则

| 删除目标 | 行为 |
|---------|------|
| **Claim** | 必须 `cascade=true`。删除绑定的 Warrant、Backing、Rebuttal。**不删除 Mode A Ground**（独立证据）。**删除 Mode B Ground**（`ref_claim_id` 指向该 Claim 的链式 Ground，同时从 Warrant 的 ground_ids 中移除引用） |
| **Warrant** | 级联删除其 Backing 和指向该 Warrant 的 Rebuttal |
| **Ground** | 自动从所有 Warrant 的 `ground_ids` 中移除引用，同时删除指向该 Ground 的 Rebuttal |
| **Backing / Rebuttal** | 直接删除 |

---

## 开发

```bash
# 运行测试
bun test

# TypeScript 类型检查
npx tsc --noEmit

# 启动开发（内存数据库）
bun run dev
```

### 项目结构

```
toulmin-mcp/
├── src/
│   ├── index.ts              # 入口：MCP Server 启动
│   ├── db.ts                 # SQLite 连接 + Schema
│   ├── types.ts              # 类型定义
│   ├── errors.ts             # 错误类
│   ├── content.ts            # 面向 agent 的教学内容集中管理
│   ├── repo.ts               # Repository 层（SQL CRUD）
│   ├── service.ts            # Service 层（业务逻辑）
│   ├── tools.ts              # MCP 工具注册
│   ├── logger.ts             # 日志工具
│   ├── merkle-hash.ts        # 论证图结构哈希（compile 去重）
│   ├── compile-service.ts    # Compile 层（节点定义审查 + 逻辑链审查）
│   ├── compile-reviewers.ts  # LLM 逻辑链审查执行
│   ├── compile-prompts.ts    # Compile 审查提示词
│   ├── review-config.ts      # 审查配置加载
│   ├── review-llm.ts         # LLM 调用封装
│   ├── review-sync.ts        # Ground 实时审查
│   ├── review-audit.ts       # 审查审计日志
│   └── review-prompts.ts     # Ground 审查提示词
├── agents/
│   ├── toulmin-researcher.md    # 论证推进 agent（英文）
│   ├── toulmin-explorer.md      # 只读图探索 agent
│   └── toulmin-translator.md    # 自然语言→结构化指令翻译
├── skills/
│   ├── paper-reproduce/         # 论文复现 Skill
│   └── declare-barrier/         # 形式化声明任务阻塞 Skill
├── hooks/
│   ├── settings.json            # PreToolUse hook 配置
│   └── toulmin-guard.sh         # 强制 compile 节奏的 guard hook
├── visualizer/                  # 论证图可视化
├── tests/
│   ├── helpers.ts      # 测试辅助
│   ├── repo.test.ts    # Repository 测试
│   ├── service.test.ts # Service 测试
│   ├── tools.test.ts   # 工具测试
│   └── scenarios.test.ts # 场景测试
└── sql/schema.sql      # SQL Schema
```

---

## Agents

| Agent | 说明 |
|-------|------|
| `toulmin-researcher` | 论证推进 agent。构建和验证 Toulmin 论证图，识别 Claim/Ground/Warrant 的结构缺口，记录 Rebuttal。每个任务都必须映射到论证节点。 |
| `toulmin-explorer` | 只读图探索 agent。快速查找节点、查看验证状态、探索论证结构。不做修改或逻辑分析。 |
| `toulmin-translator` | 指令翻译 agent。将用户自然语言定位在 meta/object 架构中，输出可执行的结构化指令，路由至 researcher 或 explorer。 |

将 `agents/` 目录内容拷贝到 `.claude/agents/`（项目级或 `~/.claude/agents/` 系统级均可）即可加载。

---

## Skills

| Skill | 说明 |
|-------|------|
| `paper-reproduce` | 论文复现工作流。构建并验证独立论证图，评估论文主张是否成立。 |
| `declare-barrier` | 形式化声明任务阻塞。在声明无法完成前，系统检查所有已知的假性阻塞模式，生成正式阻塞文档。 |

将 `skills/` 目录内容拷贝到 `.claude/skills/` 即可加载。

---

## Hooks

`hooks/` 目录提供一个 PreToolUse guard，防止 agent 跳过 `compile_arguments`。

将 `hooks/settings.json` 内容合并到项目 `.claude/settings.json`，并将 `hooks/toulmin-guard.sh` 拷贝到 `.claude/hooks/`。

Guard 逻辑：每执行 5 个非 compile 工具调用发出软警告，超过 10 个发出强制提示。调用 `compile_arguments` 后计数重置。

---

## 审查配置（review.json）

启用 `compile_arguments` 需提供审查配置文件：

```json
{
  "apiKey": "sk-ant-xxx",
  "model": "claude-sonnet-4-20250514",
  "baseUrl": "https://api.anthropic.com",
  "debounceMs": 30000,
  "maxTurns": 10,
  "auditDir": null
}
```

| 字段 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `apiKey` | 是 | — | Anthropic API Key |
| `model` | 否 | `claude-sonnet-4-20250514` | 审查用模型 |
| `baseUrl` | 否 | 官方 API | 自定义转发地址 |
| `debounceMs` | 否 | 30000 | 去重窗口（毫秒） |
| `maxTurns` | 否 | 10 | agent 最大轮数 |
| `auditDir` | 否 | `dirname(db)/audit` | 审计日志目录；`null` 禁用 |

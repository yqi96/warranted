# Toulmin MCP Server

基于 Toulmin 论证模型的论证状态管理 MCP Server。Agent 通过 12 个 MCP 工具提交、查询和管理论证节点（Claim / Ground / Warrant / Backing / Qualifier / Rebuttal），实现论证过程的持久化。

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
```

Server 通过 **stdio** 与 Agent 通信，启动后等待 MCP 协议消息。

> 默认数据库文件 `.toulmin/argument.db` 已加入 `.gitignore`，不会提交到版本库。

---

## 配置

### Claude Code 配置

在项目的 `.claude/settings.json` 中添加 MCP Server 配置：

```json
{
  "mcpServers": {
    "toulmin": {
      "command": "bun",
      "args": ["src/index.ts"],
      "cwd": "/absolute/path/to/toulmin-mcp"
    }
  }
}
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
| `--db-path <path>` | `:memory:` | SQLite 数据库文件路径。`:memory:` 使用内存数据库 |

---

## 工具列表

### 创建工具（6 个）

| 工具 | 说明 | 关键参数 |
|------|------|---------|
| `create_claim` | 记录一个主张 | `content` |
| `create_ground` | 记录一份证据 | Mode A: `content` + `source` + `verification`；Mode B: `ref_claim_id` |
| `create_warrant` | 记录一条推理规则 | `claim_id` + `content` + `ground_ids?` |
| `create_backing` | 记录 Warrant 的支撑 | `warrant_id` + `content` |
| `create_qualifier` | 记录 Claim 的适用边界 | `claim_id` + `content` |
| `create_rebuttal` | 记录失效条件 | `target_id` + `target_type` + `content` |

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
| `update_node` | 更新节点内容/状态 | `node_id` + 可选字段 |
| `delete_node` | 删除节点 | `node_id` + `cascade?` |

---

## 数据模型

### 六要素

```
Claim ──< Warrant (0..N)     每个 Warrant 绑定一个 Claim
          └──< Ground (0..N)   通过 Warrant.ground_ids 关联
          └──< Backing (0..N)  挂到 Warrant

Claim ──< Qualifier (0..1)   Claim 的适用边界
Claim ──< Rebuttal (0..N)    指向 Claim 或 Warrant

Ground ──> Claim (ref_claim_id)  链式推理：引用已有 Claim 作为证据
```

### 节点属性

| 类型 | 关键属性 |
|------|---------|
| **Claim** | content, status (`proposed` → `supported` → `validated` / `disputed` / `refuted`) |
| **Ground** | content, attachments, source (`literature` / `observed` / `hypothesis`), verification (`verified` / `pending`) |
| **Warrant** | content, claim_id, ground_ids |
| **Backing** | content, attachments, warrant_id |
| **Qualifier** | content, attachments, claim_id |
| **Rebuttal** | content, attachments, target_id, target_type (`claim` / `warrant`) |

### create_ground 两种模式

**Mode A — 普通证据：**
```
create_ground(
  content="实验数据：准确率95%",
  source="observed",
  verification="verified",
  attachments=["/results/exp.csv"]
)
```

**Mode B — 链式推理（引用已有 Claim 作为证据）：**
```
create_ground(ref_claim_id=1)
```

> 两种模式互斥，不可同时使用。

---

## 使用示例

### 论文复现

```
# 1. 提取论文主张
create_claim("ScaleOpt 收敛速度是 Adam 的 2 倍")                    → claim #1

# 2. 记录论文声称的证据
create_ground(content="ResNet: 45 vs 90 epoch", 
              source="literature", verification="pending")         → ground #1
create_ground(content="ViT: 80 vs 165 epoch",
              source="literature", verification="pending")         → ground #2

# 3. 建立推理
create_warrant(claim_id=1, content="多架构一致 → 非偶然",
               ground_ids=[1, 2])                                  → warrant #1

# 4. 复现实验后更新证据
update_node(node_id=1, content="ResNet: 50 vs 90 (1.8×)",
            source="observed", verification="verified")

# 5. 综合判定
update_node(node_id=1, status="disputed")
create_qualifier(claim_id=1, content="仅 ViT 完全复现")
```

### 假设验证

```
# 1. 提出假设
create_claim("数据增强通过多样性补偿数据不足")                        → claim #1

# 2. 推导预期证据
create_ground(content="多样性收益应随数据规模递减",
              source="hypothesis", verification="pending")         → ground #1

# 3. 实验验证后更新
update_node(node_id=1, content="实测：500→50K 单调递减",
            source="observed", verification="verified")

# 4. 判定
update_node(node_id=1, status="supported")
```

---

## 级联删除规则

| 删除目标 | 行为 |
|---------|------|
| **Claim** | 必须 `cascade=true`。删除绑定的 Warrant + Backing + Qualifier + Rebuttal。**不删除 Ground**（Ground 是独立证据） |
| **Warrant** | 级联删除其 Backing |
| **Ground** | 自动从所有 Warrant 的 `ground_ids` 中移除引用 |
| **Backing / Qualifier / Rebuttal** | 直接删除 |

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
│   ├── index.ts        # 入口：MCP Server 启动
│   ├── db.ts           # SQLite 连接 + Schema
│   ├── types.ts        # 类型定义
│   ├── errors.ts       # 错误类
│   ├── repo.ts         # Repository 层（SQL CRUD）
│   ├── service.ts      # Service 层（业务逻辑）
│   └── tools.ts        # MCP 工具注册
├── tests/
│   ├── helpers.ts      # 测试辅助
│   ├── repo.test.ts    # Repository 测试
│   ├── service.test.ts # Service 测试
│   ├── tools.test.ts   # 工具测试
│   └── scenarios.test.ts # 场景测试
└── sql/schema.sql      # SQL Schema
```

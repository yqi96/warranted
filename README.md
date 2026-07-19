# Toulmin MCP Server

让 AI Agent 以**论证结构**推进科学研究——而不是靠自由发挥。

---

## 它解决什么问题

AI Agent 做科研时容易出现两个问题：结论浮在空中没有证据支撑，或者遇到矛盾就悄悄改掉原来的主张。Toulmin MCP 给 Agent 提供一套**持久化的论证图**：每个主张（Claim）必须有证据（Ground）和推理链（Warrant），矛盾记录为 Rebuttal 而非抹掉，状态推进前必须通过逻辑审查（compile）。

适合的场景：**论文复现、假设验证、多步骤科学推理**。

---

## 快速上手

**环境要求：** [Bun](https://bun.sh/) >= 1.0.0

```bash
git clone <this-repo>
cd toulmin-mcp
bun install
```

---

## 接入 Claude Code

在项目目录创建 `.mcp.json`：

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

启用 Agents 和 Skills（复制到项目级或全局 `~/.claude/`）：

```bash
cp -r agents/* .claude/agents/
cp -r skills/* .claude/skills/
```

然后用指定 agent 启动：

```bash
claude --agent toulmin-researcher
```

---

## 接入 Claude Desktop

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

---

## 包含的 Agents

| Agent | 作用 |
|-------|------|
| `toulmin-researcher` | 主力 Agent。构建和验证论证图，识别结构缺口，驱动每个 Claim 走向有据可查的结论。 |
| `toulmin-explorer` | 只读浏览。快速查找节点、查看验证状态、探索论证结构，不做修改。 |
| `toulmin-translator` | 翻译层。将自然语言指令转为结构化操作，路由给 researcher 或 explorer。 |

---

## 包含的 Skills

| Skill | 触发方式 | 作用 |
|-------|----------|------|
| `paper-reproduce` | `/paper-reproduce` | 论文复现工作流。构建独立论证图，逐步验证论文主张是否成立。 |
| `declare-barrier` | `/declare-barrier` | 形式化声明任务阻塞。声明无法继续前，系统检查所有已知的假性阻塞模式。 |

---

## 启用 Guard Hook（可选）

防止 Agent 跳过 `compile_arguments` 步骤：

```bash
# 将 hook 配置合并到项目设置
cat hooks/settings.json  # 查看内容，手动合并到 .claude/settings.json
cp hooks/toulmin-guard.sh .claude/hooks/
```

每执行 5 个非 compile 工具调用发出软警告，超过 10 个发出强制提示，调用 `compile_arguments` 后重置。

---

## 启用 LLM 逻辑审查（可选）

`compile_arguments` 工具默认关闭，启用需提供配置文件：

```bash
bun src/index.ts --review-config ./review.json
```

`review.json` 示例：

```json
{
  "apiKey": "sk-ant-xxx",
  "model": "claude-sonnet-4-20250514",
  "baseUrl": "https://api.anthropic.com"
}
```

启用后，Agent 在推进 Claim 状态前必须先调用 `compile_arguments` 通过逻辑审查。

---

## 其他启动选项

```bash
# 自定义数据库路径
bun src/index.ts --db-path ./custom.db

# 使用内存数据库（不持久化，适合测试）
bun src/index.ts --db-path :memory:
```

默认数据库 `.toulmin/argument.db` 已加入 `.gitignore`。

# Warranted

让 AI Agent 的科研推理可被审计——每一个结论都有可追溯的论证图。

[![Release](https://img.shields.io/github/v/release/yqi96/warranted?color=green)](https://github.com/yqi96/warranted/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
![MCP Server](https://img.shields.io/badge/MCP-server-blue)
![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-plugin-8A2BE2)
[![Stars](https://img.shields.io/github/stars/yqi96/warranted?style=flat&color=orange)](https://github.com/yqi96/warranted/stargazers)

> [English](README.md) | [简体中文](README.zh-CN.md)

> **写代码有编译器和测试，做研究也需要失败信号。**

## 它做什么

Warranted 给研究 Agent 一张持久、可审计的论证图。图里只有一种节点：**命题（Proposition）**。每条命题有五个槽位：

| 槽位 | 含义 |
|---|---|
| `content` | 正在被判断的陈述 |
| `evidence` | 附件和对其他命题的引用 |
| `warrant` | 这些证据为何支撑内容；可以内联，也可以晋升为独立命题 |
| `rebuttals` | 攻击内容或理由的命题 |
| `qualifier` | 单条可信度标尺：`refuted → unestablished → possibly → probably → certainly` |

Ground、Backing、Claim、Rebuttal 都是观察视角，不是节点类型。同一条命题可以是某个结论的证据、另一层中的结论，也可以在别处充当反驳。

结构检查是确定且自动的。证据为空、附件丢失、所依赖的命题发生变化等情况会产生**非阻断警告**；系统不会代替 Agent 修改 qualifier，也不会拦截 Agent 记录判断。只有显式调用 `review` 时，独立 LLM 才会对来源忠实性和推理有效性给出语义层面的第二意见。finding 同样只是意见；它会保持待处理，直到新一次 review 取代它，或有人写明理由 `dismiss`。

## 文档

| 文档 | 内容 |
|---|---|
| [论证图](docs/zh-CN/concepts.md) | 命题、五槽位、qualifier、警告、finding 与 11 个工具 |
| [复现一篇论文](docs/zh-CN/reproduce-a-paper.md) | 用独立产生的证据重建论文的证据链 |
| [写一篇论文](docs/zh-CN/write-a-paper.md) | 用 `\cite{prop_N}` 把 LaTeX 引用连接到命题与论文附件 |
| [研究框架（英文）](docs/en/research-framework.md) | 主 Agent、专职 Agent、论证图与对象层工作的职责边界 |

详细实现契约见 [docs/design.md](docs/design.md) 与 [docs/api.md](docs/api.md)，发布历史见 [CHANGELOG.md](CHANGELOG.md)。

> **开发分支兼容说明：**提交 `90c7acb` 把 0.5.0 发布版的“三节点 + compile”模型替换成了本文描述的 Proposition 模型。旧 `.toulmin/argument.db` 只作为只读历史档案保留；当前运行使用 `.toulmin/graph.db`，不会机械迁移旧 verdict。0.5.0 术语只在 changelog 中作为历史记录保留。

## 接入 Claude Code

先安装 [Bun](https://bun.com/docs/installation)（>= 1.0.0）、Node.js，以及 Chrome/Chromium 浏览器：

```bash
git clone https://github.com/yqi96/warranted
cd warranted

# 可选：启用显式的第三方 LLM review
cp review.json.example review.json
# 编辑 review.json，填写 apiKey；baseUrl 可选。
```

插件启动脚本会运行 `bun install --frozen-lockfile`。browser MCP 使用锁定版本的 `chrome-devtools-mcp`，并按需启动隔离的浏览器会话。

注册 marketplace 并在项目中安装：

```bash
claude plugin marketplace add $(pwd)
cd your-project
claude plugin install warranted@warranted --scope local
```

启动后，`toulmin-researcher` 成为主 Agent，同时自动启动两个 stdio MCP server：

- `toulmin` 把当前论证图存到 `<project>/.toulmin/graph.db`，并暴露 11 个图工具；
- `browser` 提供进程隔离的 Chrome 会话，供浏览器辅助研究使用。

创建或修改命题不会自动触发 review。只有 Agent 明确调用 `review` 且 `review.json` 提供可用 `apiKey` 时，第三方模型审查才会运行。

> 安装或版本有问题？见 [已验证的依赖版本](docs/reference/known-working-versions.md)。

## 工具面

| 分组 | 工具 |
|---|---|
| 写入 | `create_propositions`、`update_proposition`、`set_qualifier`、`promote_warrant`、`delete_proposition` |
| 读取 | `get_argument`、`find_propositions`、`get_stats`、`get_history` |
| 意见 | `review`、`dismiss` |

写入会校验 content、引用 id 和附件是否存在。结构警告与 review finding 会持续出现在读取结果中；它们提供提示，但不充当写入闸门。

## 可视化

```bash
bun run viz
```

打开 `http://localhost:3456`。可视化器读取 `.toulmin/graph.db`，按 qualifier 给命题着色，显示 warning/finding 徽标，并可切换到其他项目的 `graph.db`。

| 操作 | 效果 |
|---|---|
| 单击节点 | 选中 |
| 双击节点 | 打开详情面板 |
| Shift + 单击 | 加入或移出多选集合 |
| box 模式拖动 | 框选多个节点 |
| pan 模式拖动 | 平移画布 |
| 滚轮 | 缩放 |
| 点击空白处 | 清空选择 |

可视化器使用默认端口运行时，UserPromptSubmit hook 会把当前选择注入之后的 Claude 提示。

## Agents

| Agent | 作用 |
|---|---|
| `toulmin-researcher` | 主 Agent；控制论证图、协调研究并作 qualifier 判断 |
| `toulmin-explorer` | 快速、只读地查找与浏览论证图 |
| `code-experimenter` | 执行受限的实现、复现与实验任务 |
| `code-optimizer` | 在不改变语义的前提下让全规模实验可运行 |
| `discrepancy-auditor` | 在接受图后果前审计一个不一致或声明的阻塞 |
| `rigor-auditor` | 在完成层面审计整体研究是否已竭尽且值得报告 |
| `literature-scout` | 执行一次边界清晰的浏览器辅助文献搜索，并写持久搜索产物 |
| `paper-reader` | 围绕一个问题阅读指定论文集合并写证据笔记 |
| `literature-extractor` | 把论文发现连同来源附件记录为命题，不判断 qualifier |

## Skills

| Skill | 触发方式 | 作用 |
|---|---|---|
| `literature-survey` | `/literature-survey` | 迭代、问题驱动的批判性文献综述 |
| `paper-reproduce` | `/paper-reproduce` | 独立复现并基于论证图判断论文主张 |
| `literature-writing` | `/literature-writing` | 用 `\cite{prop_N}` 写有文献依据的 LaTeX |
| `cite-review` | `/cite-review` | 按命题内容和 qualifier 检查引用忠实性 |
| `overleaf-setup` | `/overleaf-setup` | 一次性配置 Overleaf 同步和命题引用约束 |
| `browser` | `/browser` | 通过 browser MCP 安全操作隔离 Chrome 会话 |
| `paper-download-browser` | `/paper-download-browser` | 直接 HTTP 不足时，在授权范围内用浏览器下载论文 |

## 开发

项目没有单独构建产物：Bun 直接执行 TypeScript 源码，TypeScript 负责 strict、no-emit 检查。

```bash
bun test
bun ./node_modules/typescript/bin/tsc --noEmit
bun run agent-eval             # 默认 dry-run；只有明确接受模型成本时才加 --live
```

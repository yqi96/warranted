# Warranted 0.6.0 的 Codex 分支

本分支 `codex/v0.6.0-codex` 直接派生自 `v0.6.0`（`bc7937ac06b1fd0ea2bd948b3d57ddd359436b3b`），使用原生 Codex CLI 作为主 agent 框架。安装与运行见 [使用文档](USAGE.zh-CN.md)，验证范围见 [验证记录](VALIDATION.md)。

沿用三个 `exp-codex-*` 分支的独立派生、显式模型参数、隔离运行目录和来源校验方式。这里保留的是正式版的完整能力，因此不同于已经裁去浏览器和辅助 agent 的实验 full 组。

| 内容 | 本分支行为 |
| --- | --- |
| 主 agent | 原生 `codex exec -p warranted-v060`；研究提示词正文与 v0.6.0 完全相同 |
| 参数选择模型 | 准备时 `--model`、`--base-url`；启动时也可用 Codex 的 `-m`、`-c` |
| Warranted MCP | 11 个工具，原数据库、反馈和评审实现不变 |
| 浏览器 | 原浏览器 MCP；本机验证暴露 31 个工具 |
| 子 agent | 8 个原提示词转换为原生 Codex 角色；默认继承所选主模型 |
| Skills | 从原 `skills/` 直接复制 7 个 skill 及其资源 |
| 评审 | 继续使用 Claude Agent SDK 和独立 `review.json` |
| Overleaf | 在原 skill 位置改为明确执行同步命令；引用检查、推送脚本不变 |

这是 Codex 专用分支，不维护双框架运行兼容层。原有的 Overleaf skill 和一处引用说明直接修改，没有额外覆盖目录或 Claude skill 副本。其余已有受版本控制的文件保持 v0.6.0 原样；`prepare.py --verify` 会拒绝未经声明的父版本文件改动。

框架切换仍有明确差异：原来的 `opus` / `sonnet` / `haiku` 子模型标签不再生效；Codex 的原生工具和权限模型与 Claude Code 不完全等价；可视化器选中节点的 Claude hook 不加载；Overleaf 没有自动结束回合同步。原生网络搜索默认关闭，可按实验协议统一开启。Codex 自带的系统提示词、系统 skills 和内置角色也仍会存在，不能据此声称两个框架的完整上下文或运行结果相同。

**子 agent 工具范围：** Codex 0.155.0 实测不应用角色文件中的 MCP 白名单，子 agent 继承父 agent 的 11 + 31 个 MCP 工具。原角色的只读要求仍在提示词中，不能当作工具层强制隔离；原白名单只保存在准备记录中供审计。该版本的 [角色覆盖实现](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/core/src/agent/role.rs#L32-L119) 也没有应用 MCP 配置。若实验要求子 agent 的硬权限严格相同，当前最小适配不满足这一条件。

适配依据：[Codex 子 agent 配置](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[Skills](https://learn.chatgpt.com/docs/build-skills)、[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。配置已在 Codex CLI 0.155.0 验证，其他版本需要重新检查。

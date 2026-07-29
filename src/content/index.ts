/**
 * Warranted — 面向 agent 的教学内容集中管理
 *
 * 统一导出所有文本常量，按职责分文件：
 *   elements  — Toulmin 要素域模型描述
 *   hints     — 操作后提示
 *   warnings  — 删除/变更后警告
 *   tools     — MCP 工具级 title + description
 *   params    — 工具参数 .describe() 字符串
 *   messages  — 工具返回的输出消息
 */

export { ELEMENTS } from "./elements.ts";
export { HINTS } from "./hints.ts";
export { WARNINGS } from "./warnings.ts";
export { TOOLS } from "./tools.ts";
export { PARAMS } from "./params.ts";
export { MESSAGES } from "./messages.ts";

/**
 * Warranted — 面向 agent 的文本常量,集中管理
 *
 * 分文件的依据是**读者与时机**,不是主题:
 *   elements  — 域模型措辞(一个命题 + 五槽位),被 params 转发
 *   tools     — 工具 title/description,常驻上下文
 *   params    — 工具参数 .describe(),调用那一刻才读
 *   warnings  — 结构检查与变更后的提示语
 *
 * 旧的 hints / messages 已删除:操作后提示归并进 warnings,输出消息随散文渲染
 * 一起退役(现在工具返回结构化 JSON + 一行 banner,见 tools.ts 头注释)。
 */

export { ELEMENTS } from "./elements.ts";
export { WARNINGS } from "./warnings.ts";
export { TOOLS } from "./tools.ts";
export { PARAMS } from "./params.ts";

/**
 * Agent 行为评测的用例类型定义。
 *
 * Tier 1(判断层):假设性提问,只让 agent 陈述计划,judge 按 rubric 打分。
 * Tier 2(行为层):真实执行,跑完后对 .toulmin/argument.db 做断言。
 */
import type { Database } from "bun:sqlite";

export interface AssertCtx {
  /** 运行后打开的图数据库;agent 未创建 .toulmin 时为 null */
  db: Database | null;
  /** 本次运行的临时工作目录 */
  scratch: string;
  /** agent 的最终文本回答 */
  answer: string;
}

export interface Assertion {
  name: string;
  /** 通过返回 true,失败返回原因字符串 */
  check: (ctx: AssertCtx) => true | string;
}

interface CaseBase {
  id: string;
  title: string;
  /** 交给 agent 的指令原文 */
  instruction: string;
  /** 运行前写入临时目录的 fixture 文件:相对路径 → 内容 */
  files?: Record<string, string>;
  /** claude -p 的 --max-turns 上限(控制成本) */
  maxTurns?: number;
  /** judge 评分标准(--judge 时使用);Tier 1 必填 */
  rubric?: string[];
}

export interface Tier1Case extends CaseBase {
  tier: 1;
  rubric: string[];
}

export interface Tier2Case extends CaseBase {
  tier: 2;
  /** 在空 schema 上预置图状态(如"已 supported 的 Claim") */
  seed?: (db: Database) => void;
  assertions: Assertion[];
}

export type EvalCase = Tier1Case | Tier2Case;

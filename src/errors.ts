/**
 * Warranted — 自定义错误类
 *
 * 只有三条硬拒绝(V1–V3,design.md §3.1),全是数据合法性,所以这里也只需要
 * "找不到"与"参数不合法"两种。旧的 CascadeRequiredError / TypeMismatchError /
 * StatusTransitionError 随 cascade、节点类型、状态机一并消失。
 */

export class ToulminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToulminError";
  }
}

/** 命题不存在 */
export class NotFoundError extends ToulminError {
  constructor(id: number | string) {
    super(`Proposition not found: ${id}`);
    this.name = "NotFoundError";
  }
}

/**
 * 参数校验失败。
 *
 * 只用于 V1–V3:content 非空、引用不悬空、写入时附件路径存在。
 * **认识论要求永远不走这里**——它们是软标红,姿态原则零例外。
 */
export class ValidationError extends ToulminError {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * 审查这次没跑成:没配模型、子进程出错、只读工具被拒(于是它可能压根没读附件)。
 *
 * 与姿态原则不冲突——它拒的不是一次写入,是一次**读取动作没能完成**。抛出来而不是
 * 降级成警告,因为 review 不产出 pass:没跑成的审查若被记成"Q1: pass",图上就多了
 * 一条"忠实性已核实"的假象,而这正是旧 `compiledWithoutReviewModel` 的病(api.md §4.1)。
 */
export class ReviewUnavailableError extends ToulminError {
  constructor(message: string) {
    super(message);
    this.name = "ReviewUnavailableError";
  }
}

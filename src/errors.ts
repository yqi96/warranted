/**
 * Warranted — 自定义错误类
 */

export class ToulminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToulminError";
  }
}

/** 节点不存在 */
export class NotFoundError extends ToulminError {
  constructor(id: number | string, expectedType?: string) {
    const typeHint = expectedType ? ` (expected type: ${expectedType})` : "";
    super(`Node not found: ${id}${typeHint}`);
    this.name = "NotFoundError";
  }
}

/** 参数校验失败 */
export class ValidationError extends ToulminError {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** 删除 Claim 时未设置 cascade=true */
export class CascadeRequiredError extends ToulminError {
  constructor() {
    super(
      "Deleting a Claim requires cascade=true. " +
      "This prevents orphaned Warrants and Statements."
    );
    this.name = "CascadeRequiredError";
  }
}

/** 类型不匹配（如 claim_id 指向的不是 Claim 节点） */
export class TypeMismatchError extends ToulminError {
  constructor(id: number, expectedType: string, actualType: string) {
    super(
      `Node ${id} is type "${actualType}", expected "${expectedType}"`
    );
    this.name = "TypeMismatchError";
  }
}

/** Claim 状态转换违规 */
export class StatusTransitionError extends ToulminError {
  constructor(message: string) {
    super(message);
    this.name = "StatusTransitionError";
  }
}

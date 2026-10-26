/**
 * 错误码：内核拒绝调用时必须返回可读错误码，不能既不拒绝也不执行（规范 6 §1）。
 * 客户端按 code 渲染人话；插件按 code 决策（例如 ECONSENT 不下发、ETIMEOUT 标记降级）。
 */
export const ERROR_CODES = {
  /** 未授予的能力 / 越权调用 */
  EPERM: "EPERM",
  /** 声明闸未过：任何写调用一律拒绝（规范 6 §10.4） */
  ECONSENT: "ECONSENT",
  /** owner 专属操作 */
  EOWNER: "EOWNER",
  /** 缺少二次确认 token 或 token 失效 */
  ECONFIRM: "ECONFIRM",
  /** manifest 校验失败 */
  EMANIFEST: "EMANIFEST",
  /** 授权状态不满足（未授权/已撤销） */
  EGRANT: "EGRANT",
  /** 依赖未就绪（缺密钥、缺租约、通道体检未过） */
  EBLOCKED: "EBLOCKED",
  /** 插件降级中，调用被丢弃 */
  EDEGRADED: "EDEGRADED",
  /** 调用超时 */
  ETIMEOUT: "ETIMEOUT",
  /** 插件崩溃 / 进程退出 */
  ECRASH: "ECRASH",
  /** 协议/内核版本不匹配 */
  EVERSION: "EVERSION",
  /** 参数不合法 */
  EINVALID: "EINVALID",
  /** 找不到对象 */
  ENOTFOUND: "ENOTFOUND",
  /** 幂等冲突/重复 */
  EDUPLICATE: "EDUPLICATE",
  /** 频率闸拦截 */
  ERATE: "ERATE",
  /** IO / 数据库错误 */
  EIO: "EIO",
  EDB: "EDB",
  /** 操作取消（epoch 失效 / 用户事件打断） */
  ECANCELED: "ECANCELED",
  /** 未知错误 */
  EUNKNOWN: "EUNKNOWN",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** JSON-RPC 2.0 错误对象：data 里带业务码，message 给人看。 */
export interface RpcErrorObject {
  code: number;
  message: string;
  data?: {
    code: ErrorCode;
    detail?: string;
    /** 可选的修复建议，UI 直接展示 */
    hint?: string;
  };
}

/** 应用层错误：内核内部抛出，IPC 层统一序列化。 */
export class AnterosError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly detail?: string;

  constructor(code: ErrorCode, message: string, options?: { hint?: string; detail?: string }) {
    super(message);
    this.name = "AnterosError";
    this.code = code;
    this.hint = options?.hint;
    this.detail = options?.detail;
  }

  toRpc(): RpcErrorObject {
    return {
      code: -32000,
      message: this.message,
      data: { code: this.code, ...(this.detail ? { detail: this.detail } : {}), ...(this.hint ? { hint: this.hint } : {}) },
    };
  }
}

export function isAnterosError(err: unknown): err is AnterosError {
  return err instanceof Error && err.name === "AnterosError";
}
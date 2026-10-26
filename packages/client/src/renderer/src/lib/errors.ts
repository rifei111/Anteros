/**
 * 错误码 → 人话。
 *
 * 内核返回 JSON-RPC 错误时带 `data.code`（errors.ts 的 ERROR_CODES），
 * 这里给每个码一句中文，外加可能的下一步建议。原始 message 作为补充信息保留，
 * 不允许把原始堆栈或英文栈信息直接糊到聊天气泡里。
 */

import { normalizeError } from "./kernel";

export interface HumanError {
  code: string;
  /** 一句话人话 */
  title: string;
  /** 补充说明/下一步（可选） */
  hint: string | null;
}

const CODE_TEXT: Record<string, string> = {
  EPERM: "权限不足：这个操作需要 owner 权限，而且只能在 Windows 主客户端进行。",
  ECONSENT: "需要先通过声明闸（逐条勾选九条声明）才能继续。",
  EOWNER: "只有 owner 能执行这个操作。",
  ECONFIRM: "二次确认已过期或已被使用，请重新确认。",
  EMANIFEST: "插件声明文件校验失败，已拒绝加载。",
  EGRANT: "该插件没有获得所需能力授权。",
  EBLOCKED: "插件未就绪或被阻断，操作没有执行。",
  EDEGRADED: "内核处于降级状态，这个功能暂时不可用。",
  ETIMEOUT: "操作超时，内核可能正忙。",
  ECRASH: "插件或内核崩溃，已自动隔离。",
  EVERSION: "版本不兼容，请更新客户端或内核。",
  EINVALID: "参数不合法。",
  ENOTFOUND: "找不到对应的数据。",
  EDUPLICATE: "重复操作，已忽略。",
  ERATE: "操作太频繁，稍等一下。",
  EIO: "读写失败，请检查磁盘或数据目录。",
  EDB: "本地数据库出错。",
  ECANCELED: "操作已取消。",
  EOFFLINE: "内核未连接，正在重连。",
  EUNKNOWN: "出现了未分类的错误。",
};

export function humanizeError(error: unknown): HumanError {
  const normalized = normalizeError(error);
  const known = CODE_TEXT[normalized.code];
  const message = normalized.message.trim();
  const extra = normalized.hint ?? (known && message.length > 0 ? message : null);
  return {
    code: normalized.code,
    title: known ?? (message.length > 0 ? message : "操作失败"),
    hint: extra ?? null,
  };
}

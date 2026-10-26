/**
 * 主进程 / preload / 渲染进程之间共享的 IPC 常量与信封类型。
 *
 * 为什么这里重复声明一遍通道名与少量常量：
 * - `packages/shared` 的 `client-api.ts` 是契约真源，但它同时被插件与内核使用；
 *   客户端打包（electron-builder）只把 `out/**` 与 `package.json` 放进 asar，
 *   运行期不保证 node_modules 里存在 `@anteros/shared`，因此主进程/preload
 *   只能以 `import type` 引用共享包的类型，不能在运行期 require 它的值。
 * - 这里的字符串必须与 `packages/shared/src/client-api.ts` 的 `IPC`、
 *   `packages/shared/src/version.ts` 保持一致（改契约时一起改）。
 */

import type { ClientBridge } from "@anteros/shared";

/** 与 packages/shared/src/client-api.ts 的 `IPC` 一一对应。 */
export const IPC_CHANNEL = {
  invoke: "anteros:invoke",
  event: "anteros:event",
  connection: "anteros:connection",
  pickFile: "anteros:pick-file",
  revealFile: "anteros:reveal-file",
  appInfo: "anteros:app-info",
  /** 客户端自身能力（不在 ClientBridge 契约内，仅用于「我不接受，退出」） */
  quitApp: "anteros:quit-app",
} as const;

/** 与 packages/shared/src/version.ts 保持一致。 */
export const PIPE_PREFIX = "anteros-kernel";
export const DATA_DIR_NAME = "anteros-data";
export const KERNEL_API_VERSION = "1.0";

/** 一次内核调用失败的 IPC 形态（错误码与建议跨进程保留，供 UI 显示人话）。 */
export interface IpcFailure {
  ok: false;
  error: {
    code: string;
    message: string;
    hint?: string;
    detail?: string;
  };
}

export interface IpcSuccess<T> {
  ok: true;
  result: T;
}

export type IpcResult<T> = IpcSuccess<T> | IpcFailure;

/** 渲染进程可订阅的额外客户端桥能力（在 ClientBridge 之上）。 */
export interface ExtendedClientBridge extends ClientBridge {
  /** 退出整个应用（声明闸「我不接受，退出」使用） */
  quitApp(): Promise<void>;
}

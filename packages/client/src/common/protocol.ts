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
  readTextFile: "anteros:read-text-file",
  saveTextFile: "anteros:save-text-file",
} as const;

/** 应用内更新：主进程 ↔ 渲染进程的独立通道（不走内核，更新与内核无关）。 */
export const UPDATE_EVENT_CHANNEL = "app.update.event";
export const UPDATE_METHODS = {
  status: "app.update.status",
  check: "app.update.check",
  download: "app.update.download",
  install: "app.update.install",
} as const;

/** 卸载：渲染进程点按钮 → 主进程调卸载程序（数据留不留由渲染层决定）。 */
export const UNINSTALL_METHOD = "app.uninstall";

export interface UninstallRequestView {
  keepData: boolean;
}

export interface UninstallResultView {
  started: boolean;
  message: string;
}

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

/** 更新状态：主进程算，渲染层只显示。字段与 src/main/updater.ts 的 UpdateStatus 一致。 */
export interface UpdateStatusView {
  state: "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";
  currentVersion: string;
  version?: string;
  releaseNotes?: string;
  percent?: number;
  bytesPerSecond?: number;
  total?: number;
  message?: string;
  checkedTs?: number;
  busy?: boolean;
}

/** 渲染进程可订阅的额外客户端桥能力（在 ClientBridge 之上）。 */
export interface ExtendedClientBridge extends ClientBridge {
  /** 退出整个应用（声明闸「我不接受，退出」使用） */
  quitApp(): Promise<void>;
  /** 应用内更新（检查 / 下载 / 重启安装 / 订阅状态） */
  updates: {
    status(): Promise<UpdateStatusView | null>;
    check(): Promise<UpdateStatusView | null>;
    download(): Promise<UpdateStatusView | null>;
    install(): Promise<UpdateStatusView | null>;
    onEvent(handler: (status: UpdateStatusView) => void): () => void;
  };
  /** 文本文件读写：人设文档的导出/导入用它（路径一律来自系统对话框，前端拿不到任意路径） */
  files: {
    readText(options: { title: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<{
      path: string;
      text: string;
    } | null>;
    saveText(
      text: string,
      options: { title: string; defaultName?: string; filters?: Array<{ name: string; extensions: string[] }> },
    ): Promise<string | null>;
  };
  /** 卸载（数据栏最底下；keepData=false 会先删数据目录） */
  uninstaller: {
    run(options: UninstallRequestView): Promise<UninstallResultView>;
  };
}
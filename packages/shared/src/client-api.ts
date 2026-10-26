/**
 * 客户端 / 预加载 / 渲染进程三方共用的桥接口。
 *
 * 渲染进程只能通过 `window.anteros` 调用（contextIsolation + 无 nodeIntegration），
 * 所有内核 RPC 都收敛在 Electron 主进程里，凭据与管道名不下发到页面。
 */
import type { KernelEventName, KernelEvents, KernelMethod, KernelParams, KernelResult } from "./rpc.js";

export interface ClientBridge {
  invoke<M extends KernelMethod>(method: M, params: KernelParams<M>): Promise<KernelResult<M>>;
  /** 订阅内核事件，返回取消订阅函数 */
  on<E extends KernelEventName>(event: E, handler: (payload: KernelEvents[E]) => void): () => void;
  /** 本次会话的内核状态（管道连接情况） */
  connection(): Promise<{ connected: boolean; pipeName: string; kernelVersion: string | null; message: string }>;
  /** 打开系统文件选择框（导出/导入用） */
  pickFile(options: { title: string; mode: "open" | "save"; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null>;
  /** 在资源管理器中显示文件 */
  revealFile(path: string): Promise<void>;
  appInfo(): Promise<{ version: string; platform: string; userDataPath: string }>;
}

export interface AnterosWindow {
  anteros: ClientBridge;
}

/** IPC 通道名：渲染进程 ↔ 主进程 */
export const IPC = {
  invoke: "anteros:invoke",
  event: "anteros:event",
  connection: "anteros:connection",
  pickFile: "anteros:pick-file",
  revealFile: "anteros:reveal-file",
  appInfo: "anteros:app-info",
} as const;
/**
 * preload：把内核调用能力以最小面暴露给渲染进程。
 *
 * - 只在 contextIsolation 下通过 `window.anteros` 暴露 `ClientBridge`
 * - 事件订阅返回取消函数，组件卸载必须调用（避免监听器泄漏）
 * - 失败信封 `{ok:false,error}` 在这里还原成带 `code`/`hint` 的 Error，
 *   渲染层据此显示人话（EPERM=权限不足、ECONSENT=需先过声明闸…）
 */

import { contextBridge, ipcRenderer } from "electron";
import type {
  ClientBridge,
  KernelEventName,
  KernelEvents,
  KernelMethod,
  KernelParams,
  KernelResult,
} from "@anteros/shared";
import { IPC_CHANNEL, type IpcResult } from "../common/protocol";

class BridgeError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly detail: string | undefined;

  constructor(code: string, message: string, hint?: string, detail?: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.hint = hint;
    this.detail = detail;
  }
}

function toBridgeError(failure: { code: string; message: string; hint?: string; detail?: string }): BridgeError {
  return new BridgeError(failure.code, failure.message, failure.hint, failure.detail);
}

const bridge: ClientBridge & { quitApp: () => Promise<void> } = {
  async invoke<M extends KernelMethod>(method: M, params: KernelParams<M>): Promise<KernelResult<M>> {
    const result: unknown = await ipcRenderer.invoke(IPC_CHANNEL.invoke, method, params);
    const envelope = result as IpcResult<unknown>;
    if (!envelope || typeof envelope !== "object" || !("ok" in envelope)) {
      throw new BridgeError("EUNKNOWN", "内核返回了无法识别的响应");
    }
    if (!envelope.ok) {
      throw toBridgeError(envelope.error);
    }
    return envelope.result as KernelResult<M>;
  },

  on<E extends KernelEventName>(event: E, handler: (payload: KernelEvents[E]) => void): () => void {
    const listener = (_ipcEvent: Electron.IpcRendererEvent, method: unknown, payload: unknown): void => {
      if (method !== event) return;
      handler(payload as KernelEvents[E]);
    };
    ipcRenderer.on(IPC_CHANNEL.event, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNEL.event, listener);
    };
  },

  async connection() {
    const result: unknown = await ipcRenderer.invoke(IPC_CHANNEL.connection);
    const info = result as { connected: boolean; pipeName: string; kernelVersion: string | null; message: string };
    return {
      connected: info.connected === true,
      pipeName: typeof info.pipeName === "string" ? info.pipeName : "",
      kernelVersion: typeof info.kernelVersion === "string" ? info.kernelVersion : null,
      message: typeof info.message === "string" ? info.message : "",
    };
  },

  async pickFile(options) {
    const result: unknown = await ipcRenderer.invoke(IPC_CHANNEL.pickFile, options);
    return typeof result === "string" && result.length > 0 ? result : null;
  },

  async revealFile(path: string) {
    await ipcRenderer.invoke(IPC_CHANNEL.revealFile, path);
  },

  async appInfo() {
    const result: unknown = await ipcRenderer.invoke(IPC_CHANNEL.appInfo);
    const info = result as { version: string; platform: string; userDataPath: string };
    return {
      version: typeof info.version === "string" ? info.version : "0.0.0",
      platform: typeof info.platform === "string" ? info.platform : "win32",
      userDataPath: typeof info.userDataPath === "string" ? info.userDataPath : "",
    };
  },

  async quitApp() {
    await ipcRenderer.invoke(IPC_CHANNEL.quitApp);
  },
};

contextBridge.exposeInMainWorld("anteros", bridge);

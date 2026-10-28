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
import {
  IPC_CHANNEL,
  UNINSTALL_METHOD,
  UPDATE_EVENT_CHANNEL,
  UPDATE_METHODS,
  type IpcResult,
  type UninstallResultView,
  type UpdateStatusView,
} from "../common/protocol";
import type { ExtendedClientBridge } from "../common/protocol";

/** 更新相关能力：状态查询、检查、下载、重启安装、订阅状态变化。 */
type UpdatesBridge = ExtendedClientBridge["updates"];

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

const bridge: ClientBridge & {
  quitApp: () => Promise<void>;
  updates: UpdatesBridge;
  files: ExtendedClientBridge["files"];
  uninstaller: ExtendedClientBridge["uninstaller"];
} = {
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

  files: {
    async readText(options: { title: string; filters?: Array<{ name: string; extensions: string[] }> }) {
      const result: unknown = await ipcRenderer.invoke(IPC_CHANNEL.readTextFile, options);
      const parsed = result as { path?: unknown; text?: unknown } | null;
      if (parsed === null || typeof parsed?.path !== "string") return null;
      return { path: parsed.path, text: typeof parsed.text === "string" ? parsed.text : "" };
    },
    async saveText(
      text: string,
      options: { title: string; defaultName?: string; filters?: Array<{ name: string; extensions: string[] }> },
    ) {
      const result: unknown = await ipcRenderer.invoke(IPC_CHANNEL.saveTextFile, text, options);
      return typeof result === "string" && result.length > 0 ? result : null;
    },
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

  updates: {
    async status() {
      const result: unknown = await ipcRenderer.invoke(UPDATE_METHODS.status);
      return (result ?? null) as UpdateStatusView | null;
    },
    async check() {
      const result: unknown = await ipcRenderer.invoke(UPDATE_METHODS.check);
      return (result ?? null) as UpdateStatusView | null;
    },
    async download() {
      const result: unknown = await ipcRenderer.invoke(UPDATE_METHODS.download);
      return (result ?? null) as UpdateStatusView | null;
    },
    async install() {
      const result: unknown = await ipcRenderer.invoke(UPDATE_METHODS.install);
      return (result ?? null) as UpdateStatusView | null;
    },
    onEvent(handler: (status: UpdateStatusView) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, status: unknown): void => {
        if (!status || typeof status !== "object") return;
        handler(status as UpdateStatusView);
      };
      ipcRenderer.on(UPDATE_EVENT_CHANNEL, listener);
      return () => {
        ipcRenderer.removeListener(UPDATE_EVENT_CHANNEL, listener);
      };
    },
  },

  uninstaller: {
    async run(options) {
      const result: unknown = await ipcRenderer.invoke(UNINSTALL_METHOD, options);
      return (result ?? { started: false, message: "主进程没有返回结果" }) as UninstallResultView;
    },
  },
};

contextBridge.exposeInMainWorld("anteros", bridge);

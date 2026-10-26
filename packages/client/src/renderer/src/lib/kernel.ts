/**
 * 渲染进程 → 内核的唯一入口。
 *
 * 组件不直接碰 `window.anteros`：类型化 invoke、错误归一化、连接轮询全在这里。
 * 所有失败都会变成 `KernelError`（保留 `code`/`hint`/`detail`），由 UI 决定怎么显示人话。
 */

import type { KernelEventName, KernelEvents, KernelMethod, KernelParams, KernelResult } from "@anteros/shared";
import type { ExtendedClientBridge } from "../../../common/protocol";

export interface ConnectionInfo {
  connected: boolean;
  pipeName: string;
  kernelVersion: string | null;
  message: string;
}

/** 内核/桥接错误：code 来自 RpcErrorObject.data.code（EPERM/ECONSENT/EBLOCKED…）。 */
export class KernelError extends Error {
  readonly code: string;
  readonly hint: string | null;
  readonly detail: string | null;

  constructor(code: string, message: string, hint: string | null = null, detail: string | null = null) {
    super(message);
    this.name = "KernelError";
    this.code = code;
    this.hint = hint;
    this.detail = detail;
  }
}

interface ErrorLike {
  code?: unknown;
  message?: unknown;
  hint?: unknown;
  detail?: unknown;
}

function bridge(): ExtendedClientBridge | null {
  return window.anteros ?? null;
}

function requireBridge(): ExtendedClientBridge {
  const current = bridge();
  if (!current) {
    throw new KernelError(
      "ENOBRIDGE",
      "preload 未注入 window.anteros",
      "请重启客户端；若仍出现，说明打包产物缺少 preload 脚本。",
    );
  }
  return current;
}

/** 把任意抛出的东西收敛成 KernelError。 */
export function normalizeError(error: unknown): KernelError {
  if (error instanceof KernelError) return error;
  if (typeof error === "object" && error !== null) {
    const shape = error as ErrorLike;
    const code = typeof shape.code === "string" ? shape.code : "EUNKNOWN";
    const message = typeof shape.message === "string" ? shape.message : "内核调用失败";
    const hint = typeof shape.hint === "string" ? shape.hint : null;
    const detail = typeof shape.detail === "string" ? shape.detail : null;
    return new KernelError(code, message, hint, detail);
  }
  return new KernelError("EUNKNOWN", String(error));
}

/** 类型化调用：把方法名与参数、返回值绑死。 */
export async function invoke<M extends KernelMethod>(method: M, params: KernelParams<M>): Promise<KernelResult<M>> {
  try {
    return await requireBridge().invoke(method, params);
  } catch (error) {
    throw normalizeError(error);
  }
}

/** 订阅内核事件，返回取消订阅函数（组件/模块退出时必须调用）。 */
export function subscribe<E extends KernelEventName>(
  event: E,
  handler: (payload: KernelEvents[E]) => void,
): () => void {
  const current = bridge();
  if (!current) return () => undefined;
  return current.on(event, handler);
}

export async function getConnection(): Promise<ConnectionInfo> {
  const current = bridge();
  if (!current) {
    return { connected: false, pipeName: "", kernelVersion: null, message: "内核启动中…" };
  }
  try {
    return await current.connection();
  } catch (error) {
    return {
      connected: false,
      pipeName: "",
      kernelVersion: null,
      message: normalizeError(error).message,
    };
  }
}

/** 轮询连接状态（主进程不主动推连接事件，这里按秒级拉取真实状态）。 */
export function pollConnection(onChange: (info: ConnectionInfo) => void, intervalMs = 1200): () => void {
  let stopped = false;
  let inFlight = false;

  const tick = (): void => {
    if (stopped || inFlight) return;
    inFlight = true;
    void getConnection()
      .then((info) => {
        if (!stopped) onChange(info);
      })
      .catch(() => {
        if (!stopped) {
          onChange({ connected: false, pipeName: "", kernelVersion: null, message: "客户端桥不可用" });
        }
      })
      .finally(() => {
        inFlight = false;
      });
  };

  tick();
  const timer = globalThis.setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    globalThis.clearInterval(timer);
  };
}

export async function pickFile(options: { title: string; mode: "open" | "save"; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null> {
  return await requireBridge().pickFile(options);
}

export async function revealFile(path: string): Promise<void> {
  await requireBridge().revealFile(path);
}

export async function appInfo(): Promise<{ version: string; platform: string; userDataPath: string }> {
  return await requireBridge().appInfo();
}

export async function quitApp(): Promise<void> {
  await requireBridge().quitApp();
}

/** chat.send 的幂等键：优先用平台实现，缺失时退化为时间戳 + 随机数。 */
export function newEventId(): string {
  const cryptoImpl = globalThis.crypto;
  if (cryptoImpl && typeof cryptoImpl.randomUUID === "function") return cryptoImpl.randomUUID();
  const random = Math.random().toString(16).slice(2);
  return `${Date.now().toString(16)}-${random}`;
}

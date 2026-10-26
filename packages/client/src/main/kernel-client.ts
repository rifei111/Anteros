/**
 * 内核子进程守护 + 命名管道 JSON-RPC 客户端（主进程侧）。
 *
 * 契约（与 packages/kernel/src/main.ts、packages/shared/src/rpc.ts 对齐）：
 * - 内核是独立子进程：`spawn(process.execPath, [kernelEntry], { env: { ELECTRON_RUN_AS_NODE: "1", ... } })`
 * - 启动成功后向 stdout 打一行 ready JSON：
 *   `{"type":"ready","pid":...,"pipeName":"...","dataDir":"...","kernelApi":"1.0","platform":"win32",...}`
 * - 主进程 `net.connect(pipeName)` 连命名管道，按 NDJSON（每行一个 JSON）收发
 * - 请求信封：`{ jsonrpc:"2.0", id, method, params, auth }`
 * - 内核事件：`{ jsonrpc:"2.0", method:"event.xxx", params }`（通知，无 id）
 * - 错误：`{ code, message, data?: { code, hint } }` → 转成本地 KernelCallError，
 *   把 `data.code` / `data.hint` 原样带到渲染层，UI 按码显示人话。
 *
 * 任何时刻都不伪造连接状态：未连上就是未连上，断开后按退避重试并记录真实原因。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { join } from "node:path";
import { PIPE_PREFIX } from "../common/protocol";

/** 调用超时：常规 30s；生成类与 IO 类单独放宽。 */
const METHOD_TIMEOUT_MS: Record<string, number> = {
  "chat.send": 120_000,
  "export.bundle": 120_000,
  "import.bundle": 120_000,
  "plugins.enable": 60_000,
  "plugins.restart": 60_000,
  "channels.panicStop": 90_000,
  "system.shutdown": 15_000,
  "memory.export": 60_000,
};
const DEFAULT_TIMEOUT_MS = 30_000;

/** 内核就绪等待上限：超时视为启动失败并重启。 */
const READY_TIMEOUT_MS = 20_000;

/** 连续失败后的最大退避间隔。 */
const MAX_BACKOFF_MS = 15_000;

export type KernelEventSink = (method: string, params: unknown) => void;

/** 内核连接状态：message 是给人看的真话（含尝试次数与失败原因）。 */
export interface KernelConnectionState {
  connected: boolean;
  pipeName: string;
  kernelVersion: string | null;
  message: string;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: KernelCallError) => void;
  timer: NodeJS.Timeout;
}

/** 内核拒绝调用 / 连接故障时抛给上层的错误，保留业务码与建议。 */
export class KernelCallError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly detail?: string;

  constructor(code: string, message: string, options?: { hint?: string; detail?: string }) {
    super(message);
    this.name = "KernelCallError";
    this.code = code;
    this.hint = options?.hint;
    this.detail = options?.detail;
  }
}

interface RpcErrorLike {
  code?: number;
  message?: string;
  data?: { code?: string; hint?: string; detail?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readRpcError(value: unknown): RpcErrorLike | null {
  if (!isRecord(value)) return null;
  const error = value.error;
  return isRecord(error) ? (error as RpcErrorLike) : null;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `内核进程被信号 ${signal} 终止`;
  if (code === 0) return "内核进程已正常退出";
  return `内核进程已退出（退出码 ${code ?? "未知"}）`;
}

export interface KernelClientOptions {
  dataDir: string;
  pluginsDir: string;
}

export class KernelClient {
  private child: ChildProcess | null = null;
  private socket: Socket | null = null;
  private readBuffer = "";
  private readonly pending = new Map<string, PendingCall>();
  private sequence = 0;
  private attempts = 0;
  private shuttingDown = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private lastStderr = "";
  private state: KernelConnectionState = {
    connected: false,
    pipeName: "",
    kernelVersion: null,
    message: "正在启动内核…",
  };
  private readonly eventSinks = new Set<KernelEventSink>();
  private readonly token = randomBytes(32).toString("hex");
  private readonly dataDir: string;
  private readonly pluginsDir: string;

  constructor(options: KernelClientOptions) {
    this.dataDir = options.dataDir;
    this.pluginsDir = options.pluginsDir;
  }

  getState(): KernelConnectionState {
    return { ...this.state };
  }

  getDataDir(): string {
    return this.dataDir;
  }

  /** 订阅内核事件（通知），返回取消订阅函数。 */
  onEvent(sink: KernelEventSink): () => void {
    this.eventSinks.add(sink);
    return () => {
      this.eventSinks.delete(sink);
    };
  }

  start(): void {
    if (this.shuttingDown) return;
    this.spawnKernel();
  }

  /**
   * 调用内核方法。
   * @param method KernelApi 的方法名
   * @param params 方法参数
   */
  async invoke(method: string, params: unknown): Promise<unknown> {
    const socket = this.socket;
    if (!socket || !this.state.connected) {
      throw new KernelCallError("EOFFLINE", "内核未连接", {
        hint: this.state.message,
      });
    }
    const id = `c${++this.sequence}`;
    const timeoutMs = METHOD_TIMEOUT_MS[method] ?? DEFAULT_TIMEOUT_MS;
    const envelope = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
      auth: this.token,
    });

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new KernelCallError("ETIMEOUT", `调用 ${method} 超时（${Math.round(timeoutMs / 1000)} 秒）`, {
            hint: "内核可能正忙，稍后重试；若持续超时请在设置 → 高级里查看日志",
          }),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(`${envelope}\n`, (error) => {
        if (!error) return;
        const call = this.pending.get(id);
        if (!call) return;
        clearTimeout(call.timer);
        this.pending.delete(id);
        call.reject(
          new KernelCallError("EIO", `写入内核管道失败：${error.message}`, {
            hint: "内核可能正在重启，请稍候重试",
          }),
        );
      });
    });
  }

  /** 优雅关闭：先请求内核退出，再断管道、杀进程。 */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.clearTimers();
    this.setState({ connected: false, message: "正在关闭内核…" });

    try {
      if (this.state.connected) {
        await this.invoke("system.shutdown", {}).catch(() => undefined);
      }
    } finally {
      this.rejectAllPending(new KernelCallError("ECANCELED", "应用正在退出"));
      this.socket?.destroy();
      this.socket = null;
      const child = this.child;
      this.child = null;
      if (child && child.exitCode === null) {
        child.kill();
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, 1_500).unref();
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 子进程与管道                                                        */
  /* ------------------------------------------------------------------ */

  private spawnKernel(): void {
    this.retryTimer = null;
    if (this.shuttingDown) return;

    const entry = this.resolveKernelEntry();
    this.attempts += 1;

    if (!entry.exists) {
      this.setState({
        connected: false,
        pipeName: "",
        kernelVersion: null,
        message:
          `未找到内核构建产物：${entry.path}（第 ${this.attempts} 次尝试）` +
          "。请先运行 npm.cmd run build:kernel。",
      });
      this.scheduleRetry();
      return;
    }

    const pipeName = `\\\\.\\pipe\\${PIPE_PREFIX}-${randomBytes(8).toString("hex")}`;
    this.setState({
      connected: false,
      pipeName,
      kernelVersion: null,
      message: `内核启动中…（第 ${this.attempts} 次尝试）`,
    });

    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [entry.path], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          ANTEROS_DATA_DIR: this.dataDir,
          ANTEROS_PIPE_NAME: pipeName,
          ANTEROS_TOKEN: this.token,
          ANTEROS_PLUGINS_DIR: this.pluginsDir,
          ANTEROS_SESSION_ID: "app",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      this.setState({
        connected: false,
        message: `内核进程启动失败：${error instanceof Error ? error.message : String(error)}`,
      });
      this.scheduleRetry();
      return;
    }

    this.child = child;
    this.lastStderr = "";

    let stdoutBuffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line.length > 0) this.handleStdoutLine(line, pipeName);
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.lastStderr = `${this.lastStderr}${chunk}`.slice(-4_000);
    });

    child.once("error", (error) => {
      this.setState({
        connected: false,
        message: `内核进程启动失败：${error.message}（第 ${this.attempts} 次尝试）`,
      });
      this.scheduleRetry();
    });

    child.once("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      this.clearReadyTimer();
      this.disconnectSocket();
      if (this.shuttingDown) return;
      const stderrTail = this.lastStderr.trim().split(/\r?\n/).slice(-1)[0];
      const reason = describeExit(code, signal) + (stderrTail ? `：${stderrTail}` : "");
      this.setState({ connected: false, kernelVersion: null, message: `${reason}，正在重连…` });
      this.scheduleRetry();
    });

    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.state.connected) return;
      this.setState({
        connected: false,
        message: `内核 ${Math.round(READY_TIMEOUT_MS / 1000)} 秒内未就绪，重启中…`,
      });
      this.child?.kill();
    }, READY_TIMEOUT_MS);
    this.readyTimer.unref?.();
  }

  private handleStdoutLine(line: string, expectedPipe: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      // 内核只承诺 stdout 打一行 ready JSON，其它行只当噪声（日志走 stderr）
      return;
    }
    if (!isRecord(parsed)) return;
    if (parsed.type !== "ready" && parsed.event !== "ready") return;

    this.clearReadyTimer();
    const pipe = readString(parsed, "pipeName") ?? readString(parsed, "pipe") ?? expectedPipe;
    const version =
      readString(parsed, "kernelApi") ??
      readString(parsed, "version") ??
      readString(parsed, "kernelVersion") ??
      "0.1.0";
    this.connectPipe(pipe, version);
  }

  private connectPipe(pipeName: string, kernelVersion: string): void {
    this.disconnectSocket();
    this.readBuffer = "";
    const socket = connect(pipeName);
    this.socket = socket;
    socket.setEncoding("utf8");

    socket.once("connect", () => {
      this.attempts = 0;
      this.setState({
        connected: true,
        pipeName,
        kernelVersion,
        message: `已连接内核 ${kernelVersion}`,
      });
    });

    socket.on("data", (chunk: string) => {
      this.readBuffer += chunk;
      let newlineIndex = this.readBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = this.readBuffer.slice(0, newlineIndex).trim();
        this.readBuffer = this.readBuffer.slice(newlineIndex + 1);
        if (line.length > 0) this.handleIncomingLine(line);
        newlineIndex = this.readBuffer.indexOf("\n");
      }
    });

    socket.once("error", (error) => {
      if (this.shuttingDown) return;
      this.setState({
        connected: false,
        message: `内核管道连接失败：${error.message}，正在重连…`,
      });
      this.restartChild();
    });

    socket.once("close", () => {
      if (this.shuttingDown) return;
      if (!this.state.connected) return;
      this.setState({ connected: false, message: "内核已断开，正在重连…" });
      this.restartChild();
    });
  }

  private handleIncomingLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;

    const id = parsed.id;
    if (typeof id === "string" || typeof id === "number") {
      const call = this.pending.get(String(id));
      if (!call) return;
      clearTimeout(call.timer);
      this.pending.delete(String(id));
      const rpcError = readRpcError(parsed);
      if (rpcError) {
        call.reject(
          new KernelCallError(rpcError.data?.code ?? "EUNKNOWN", rpcError.message ?? "内核调用失败", {
            hint: rpcError.data?.hint,
            detail: rpcError.data?.detail,
          }),
        );
        return;
      }
      call.resolve(parsed.result);
      return;
    }

    const method = parsed.method;
    if (typeof method === "string" && method.startsWith("event.")) {
      for (const sink of this.eventSinks) {
        try {
          sink(method, parsed.params);
        } catch (error) {
          process.stderr.write(`[kernel-client] event sink error: ${String(error)}\n`);
        }
      }
    }
  }

  private restartChild(): void {
    this.disconnectSocket();
    const child = this.child;
    this.child = null;
    child?.kill();
    this.scheduleRetry();
  }

  private disconnectSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.readBuffer = "";
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }
    this.rejectAllPending(new KernelCallError("EOFFLINE", "内核连接已断开", { hint: "正在重连" }));
  }

  private rejectAllPending(error: KernelCallError): void {
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(error);
      this.pending.delete(id);
    }
  }

  private scheduleRetry(): void {
    if (this.shuttingDown || this.retryTimer) return;
    const delay = Math.min(1_000 * 2 ** Math.max(this.attempts - 1, 0), MAX_BACKOFF_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.spawnKernel();
    }, delay);
    this.retryTimer.unref?.();
  }

  private clearTimers(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.clearReadyTimer();
  }

  private clearReadyTimer(): void {
    if (!this.readyTimer) return;
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  private resolveKernelEntry(): { path: string; exists: boolean } {
    const envOverride = process.env.ANTEROS_KERNEL_ENTRY;
    const devPath = join(__dirname, "../../../kernel/dist/kernel.mjs");
    const packagedPath = process.resourcesPath ? join(process.resourcesPath, "kernel/kernel.mjs") : "";
    const candidates: string[] = [];
    if (envOverride && envOverride.length > 0) candidates.push(envOverride);
    // 开发期（未打包）优先仓库内产物；打包后优先 extraResources 里的 kernel/
    if (process.env.ELECTRON_RENDERER_URL || !packagedPath) candidates.push(devPath);
    if (packagedPath) candidates.push(packagedPath);
    candidates.push(devPath);
    for (const candidate of candidates) {
      if (existsSync(candidate)) return { path: candidate, exists: true };
    }
    return { path: candidates[0] ?? devPath, exists: false };
  }

  private setState(patch: Partial<KernelConnectionState>): void {
    this.state = { ...this.state, ...patch };
  }
}

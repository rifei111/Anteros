/**
 * 插件 IPC 线协议（规范 6 §5）：命名管道上的 JSON-RPC 2.0，NDJSON 分帧。
 *
 * - 内核是 server，插件是 client（net.connect 到 ANTEROS_PIPE_NAME）；
 * - 每帧一行 UTF-8 JSON，以 `\n` 结尾；单帧上限 8MB，超限或半帧超限直接断开；
 * - 请求带超时（默认见 version.ts），超时只 reject，不假设对端已处理；
 * - 协议错误只影响该连接，绝不影响内核进程。
 */
import net from "node:net";
import { AnterosError, ERROR_CODES, MAX_FRAME_BYTES, type RpcErrorObject } from "@anteros/shared";

/** 帧顶层可能带 auth/token（SDK 兼容写法），握手时兜底读取。 */
export interface RpcHandshakeExtra {
  auth?: unknown;
  token?: unknown;
}

export interface RpcPeerHandlers {
  /** 对端（插件）发来的请求，返回值会作为 result 回写。 */
  onRequest(method: string, params: unknown, extra?: RpcHandshakeExtra): Promise<unknown> | unknown;
  /** 对端通知（无 id），例如 plugin.heartbeat 的通知形式。 */
  onNotification?(method: string, params: unknown): void;
  /** 连接关闭（对端断开或本端 close）。 */
  onClose?(reason: string): void;
  /** 协议层错误（解析失败、帧超限），连接随后会被关闭。 */
  onProtocolError?(message: string): void;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RpcEnvelope {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
  auth?: unknown;
  token?: unknown;
}

/** 把任意错误转成 JSON-RPC 错误对象（HTTP 200 语义，业务码在 data.code）。 */
export function toRpcErrorObject(error: unknown): RpcErrorObject {
  if (error instanceof AnterosError) return error.toRpc();
  const message = error instanceof Error ? error.message : String(error);
  return { code: -32000, message, data: { code: ERROR_CODES.EUNKNOWN } };
}

export class RpcPeer {
  private readonly socket: net.Socket;
  private readonly handlers: RpcPeerHandlers;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, PendingCall>();
  private nextId = 1;
  private closed = false;

  constructor(socket: net.Socket, handlers: RpcPeerHandlers) {
    this.socket = socket;
    this.handlers = handlers;
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (error: Error) => this.failAll(`插件连接错误：${error.message}`));
    socket.on("close", () => this.failAll("插件连接已关闭"));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** 发请求并等待结果；超时后 reject ETIMEOUT（对端可能已执行，调用方必须按"不确定"处理）。 */
  request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.closed) {
      return Promise.reject(new AnterosError(ERROR_CODES.ECRASH, "插件进程已断开，调用无法送达"));
    }
    const id = `k-${this.nextId}`;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AnterosError(ERROR_CODES.ETIMEOUT, `插件调用超时（${method}，${timeoutMs}ms）`, {
            hint: "插件可能卡死，已标记降级；写调用不会自动重试",
          }),
        );
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  close(reason = "宿主关闭连接"): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
    this.failAll(reason);
  }

  private failAll(reason: string): void {
    const wasClosed = this.closed;
    this.closed = true;
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new AnterosError(ERROR_CODES.ECRASH, reason));
    }
    this.pending.clear();
    if (!wasClosed) this.handlers.onClose?.(reason);
  }

  private write(message: unknown): void {
    if (this.closed || !this.socket.writable) return;
    try {
      this.socket.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.handlers.onProtocolError?.(`写管道失败：${error instanceof Error ? error.message : String(error)}`);
      this.close("写管道失败");
    }
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    let newlineIndex = this.buffer.indexOf(0x0a);
    while (newlineIndex >= 0) {
      const line = this.buffer.subarray(0, newlineIndex);
      this.buffer = this.buffer.subarray(newlineIndex + 1);
      if (line.length > MAX_FRAME_BYTES) {
        this.protocolViolation(`单帧超过 8MB 上限（${line.length} 字节）`);
        return;
      }
      if (line.length > 0) this.onLine(line.toString("utf8"));
      if (this.closed) return;
      newlineIndex = this.buffer.indexOf(0x0a);
    }
    if (this.buffer.length > MAX_FRAME_BYTES) {
      this.protocolViolation("未闭合的单帧超过 8MB 上限");
    }
  }

  private protocolViolation(message: string): void {
    this.handlers.onProtocolError?.(message);
    this.close(message);
  }

  private onLine(line: string): void {
    let envelope: RpcEnvelope;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      envelope = parsed as RpcEnvelope;
    } catch {
      this.protocolViolation("收到无法解析的 JSON 帧，断开连接");
      return;
    }
    if (envelope.jsonrpc !== "2.0") {
      this.protocolViolation("JSON-RPC 版本字段必须是 2.0，断开连接");
      return;
    }
    if (typeof envelope.method === "string") {
      const id = envelope.id;
      if (id === undefined || id === null) {
        this.handlers.onNotification?.(envelope.method, envelope.params);
        return;
      }
      void this.handleRequest(id, envelope.method, envelope.params, {
        ...(envelope.auth === undefined ? {} : { auth: envelope.auth }),
        ...(envelope.token === undefined ? {} : { token: envelope.token }),
      });
      return;
    }
    this.handleResponse(envelope);
  }

  private async handleRequest(
    id: string | number,
    method: string,
    params: unknown,
    extra: RpcHandshakeExtra,
  ): Promise<void> {
    try {
      const result = await this.handlers.onRequest(method, params, extra);
      this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      this.write({ jsonrpc: "2.0", id, error: toRpcErrorObject(error) });
    }
  }

  private handleResponse(envelope: RpcEnvelope): void {
    const id = envelope.id;
    if (typeof id !== "string" && typeof id !== "number") {
      this.protocolViolation("响应帧缺少 id，断开连接");
      return;
    }
    const call = this.pending.get(String(id));
    if (!call) return; // 已超时/取消的响应，直接丢弃
    this.pending.delete(String(id));
    clearTimeout(call.timer);
    if (envelope.error !== undefined && envelope.error !== null) {
      const rpcError = envelope.error as Partial<RpcErrorObject>;
      const code = rpcError.data?.code ?? ERROR_CODES.EUNKNOWN;
      const detail = rpcError.data?.detail;
      call.reject(
        new AnterosError(code, typeof rpcError.message === "string" ? rpcError.message : "插件返回错误", {
          ...(detail ? { detail } : {}),
        }),
      );
      return;
    }
    call.resolve(envelope.result);
  }
}

/** 创建命名管道 server（Windows 路径 \\.\pipe\...；其它平台退化为 unix socket 路径）。 */
export function createPipeServer(pipePath: string, onSocket: (socket: net.Socket) => void): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.setNoDelay(true);
      onSocket(socket);
    });
    const onError = (error: Error): void => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(pipePath, () => {
      server.off("error", onError);
      server.on("error", () => {
        /* 单次连接错误不影响内核 */
      });
      resolve(server);
    });
  });
}

/** 命名管道路径：\\.\pipe\anteros-kernel-<session>-<pluginId>（仅本机、仅当前会话）。 */
export function pluginPipePath(sessionId: string, pluginId: string): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\anteros-kernel-${sessionId}-${pluginId}`;
  return `/tmp/anteros-kernel-${sessionId}-${pluginId}.sock`;
}

/** NDJSON 帧上限（供测试断言引用）。 */
export const FRAME_LIMIT_BYTES = MAX_FRAME_BYTES;

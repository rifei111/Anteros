/**
 * 本地 IPC（规范 6 §4）：命名管道 + 换行分隔 JSON-RPC 2.0。
 *
 * 只服务本机主客户端：每个连接都必须带一次性 token（由主进程生成，
 * 经环境变量传给内核），token 不对直接断开，不给猜的机会。
 */
import net from "node:net";
import { MAX_FRAME_BYTES, AnterosError, ERROR_CODES, isAnterosError } from "@anteros/shared";
import type { LogSink } from "../util/log.js";

export type RpcHandler = (method: string, params: unknown) => Promise<unknown>;

export interface IpcServerOptions {
  pipeName: string;
  token: string;
  handler: RpcHandler;
  log: LogSink;
}

interface PendingBuffer {
  [socketId: number]: Buffer;
}

export class IpcServer {
  private readonly server: net.Server;
  private readonly sockets = new Map<number, net.Socket>();
  private readonly buffers: PendingBuffer = {};
  private nextSocketId = 1;
  private listening = false;

  constructor(private readonly options: IpcServerOptions) {
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.pipeName, () => {
        this.server.removeListener("error", reject);
        this.listening = true;
        this.options.log.info(`ipc listening on ${this.options.pipeName}`);
        resolve();
      });
    });
  }

  /** 内核 → 客户端的事件推送（notification，无 id）。 */
  broadcast(method: string, params: unknown): void {
    const frame = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    for (const socket of this.sockets.values()) {
      if (socket.writable) socket.write(frame);
    }
  }

  get connectionCount(): number {
    return this.sockets.size;
  }

  close(): Promise<void> {
    for (const socket of this.sockets.values()) socket.destroy();
    this.sockets.clear();
    if (!this.listening) return Promise.resolve();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private onConnection(socket: net.Socket): void {
    const id = this.nextSocketId++;
    this.sockets.set(id, socket);
    this.buffers[id] = Buffer.alloc(0);
    this.options.log.info(`client connected (#${id}, total ${this.sockets.size})`);

    socket.on("data", (chunk: Buffer) => this.onData(id, chunk));
    socket.on("error", (err) => this.options.log.warn(`client #${id} socket error: ${err.message}`));
    socket.on("close", () => {
      delete this.buffers[id];
      this.sockets.delete(id);
      this.options.log.info(`client disconnected (#${id}, total ${this.sockets.size})`);
    });
  }

  private onData(id: number, chunk: Buffer): void {
    const buffered = Buffer.concat([this.buffers[id] ?? Buffer.alloc(0), chunk]);
    let start = 0;
    for (let i = 0; i < buffered.length; i += 1) {
      if (buffered[i] !== 0x0a) continue;
      const line = buffered.subarray(start, i).toString("utf8").trim();
      start = i + 1;
      if (line.length === 0) continue;
      void this.handleFrame(id, line);
    }
    const rest = buffered.subarray(start);
    if (rest.length > MAX_FRAME_BYTES) {
      this.options.log.warn(`client #${id} frame exceeds ${MAX_FRAME_BYTES} bytes, closing`);
      this.sockets.get(id)?.destroy();
      return;
    }
    this.buffers[id] = rest;
  }

  private async handleFrame(id: number, line: string): Promise<void> {
    const socket = this.sockets.get(id);
    if (!socket) return;
    let message: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown; auth?: string };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      this.send(socket, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "无法解析的 JSON 帧" } });
      return;
    }
    if (typeof message.method !== "string" || message.id === undefined) {
      this.send(socket, { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32600, message: "非法请求：缺少 method 或 id" } });
      return;
    }
    if (message.auth !== this.options.token) {
      this.options.log.warn(`client #${id} auth failed, dropping connection`);
      this.send(socket, { jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "token 校验失败，连接即将断开" } });
      socket.destroy();
      return;
    }
    try {
      const result = await this.options.handler(message.method, message.params);
      this.send(socket, { jsonrpc: "2.0", id: message.id, result: result ?? null });
    } catch (err) {
      this.options.log.warn(`rpc ${message.method} failed: ${(err as Error).message}`);
      this.send(socket, { jsonrpc: "2.0", id: message.id, error: toRpcError(err) });
    }
  }

  private send(socket: net.Socket, payload: unknown): void {
    if (!socket.writable) return;
    socket.write(JSON.stringify(payload) + "\n");
  }
}

function toRpcError(err: unknown): { code: number; message: string; data?: unknown } {
  if (isAnterosError(err)) {
    const error = err as AnterosError;
    return { code: -32000, message: error.message, data: { ...error.toRpc().data, code: error.code } };
  }
  if (err instanceof AnterosError) {
    return { code: -32000, message: err.message, data: err.toRpc().data };
  }
  return {
    code: -32000,
    message: err instanceof Error ? err.message : String(err),
    data: { code: ERROR_CODES.EUNKNOWN },
  };
}
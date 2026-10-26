/**
 * Anteros 插件运行时 SDK —— 与《工程规范 6：插件与内核接口》对齐的零依赖实现。
 *
 * 这一层存在的意义，不是"帮插件少写几行代码"，而是把契约里最容易写错的三件事
 * 固化成唯一实现：
 *
 * 1. **身份**：插件拿到的能力，只能是 manifest 里声明过、并且被 owner 授予过的那几项。
 *    插件本身无权扩权，也无权"顺手"调用 manifest 之外的内核方法。这里不在本地做授权
 *    判断（授权是内核的事，内核拒绝才是唯一有效的拒绝），但 SDK 的 `call()` 会带上
 *    本次会话的 token 与 session，内核据此逐条核对 grants；插件代码里出现的每一个
 *    `call("...")` 都必须对得上 manifest 的 `permissions`，否则运行时就是 EPERM。
 *    换句话说：SDK 只提供"申请通道"，不提供"绕过通道"。
 * 2. **寿命**：插件可以死，内核不能死（规范 6 §1.3）。所以未捕获异常只记录不退出，
 *    心跳照发，由内核按契约把插件标成 degraded/crashed；断线按 1s/5s/30s 退避重连。
 * 3. **协议**：NDJSON（一行一帧）× JSON-RPC 2.0 × 首帧 `plugin.handshake` ×
 *    插件→内核的每一帧都带 `auth` token。任何一处写错，内核都会立即断开连接。
 *
 * 传输与常量对齐 `packages/shared/src/version.ts`（插件不依赖 npm 包，所以常量在这里
 * 复制一份；改协议必须两处同步改，并在 `docs/PLUGINS.md` 记一笔）。
 *
 * 环境变量（由内核在 spawn 时注入，插件不得自行读取别的来源）：
 * - `ANTEROS_PIPE_NAME`  命名管道完整路径（如 `\\.\pipe\anteros-plugin-<id>-<session>`）
 * - `ANTEROS_TOKEN`      一次性会话 token；握手时放在 params.auth，之后每帧顶层带 `auth`
 * - `ANTEROS_PLUGIN_ID`  插件 id，必须与目录名/ manifest id 一致
 * - `ANTEROS_DATA_DIR`   本插件私有数据目录（内核创建，插件只能写这里）
 * - `ANTEROS_PLUGINS_DIR` 内置插件根目录（只读；插件不得改别人的目录）
 * - `ANTEROS_KERNEL_API` 内核当前接口版本（如 `"1.0"`），用于握手后自检
 * - `ANTEROS_SECRET_*`   内核按 manifest `secrets` 注入的密钥（如 `ANTEROS_SECRET_LLM_API_KEY`）
 *
 * 入口写法见 `docs/PLUGINS.md`。
 */
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/** 与 packages/shared/src/version.ts 的 KERNEL_API_VERSION 保持一致。 */
export const KERNEL_API_VERSION = "1.0";
/** 单帧上限 8 MB（规范 6 §5）；超限直接断开，由内核决定是否重启。 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** 心跳间隔（规范 6 §4）。 */
export const HEARTBEAT_MS = 30_000;
/** 默认调用超时（规范 6 §5，插件侧比内核侧略短，避免内核先超时）。 */
export const DEFAULT_CALL_TIMEOUT_MS = 10_000;
/** 断线重连退避（规范 6 §4：1s / 5s / 30s）。 */
const RECONNECT_DELAYS_MS = [1_000, 5_000, 30_000];
/** 握手超时；超时视同连接不可用，走重连。 */
const HANDSHAKE_TIMEOUT_MS = 5_000;

const isWindows = process.platform === "win32";

/* ------------------------------------------------------------------ */
/* 错误                                                                */
/* ------------------------------------------------------------------ */

/**
 * 插件业务错误。SDK 会把它序列化成规范 6 §5 的错误形状：
 * `{code:-32000, message:"人话", data:{code:"EBLOCKED", detail?, hint?}}`。
 *
 * 用 `code` 让内核/客户端能按码决策（EBLOCKED=依赖未就绪，EINVALID=参数错，
 * ETIMEOUT=超时，……），`message` 永远写成人能直接看懂的中文。
 */
export class PluginError extends Error {
  /**
   * @param {string} code 规范 6 错误码（EBLOCKED/EINVALID/EPERM/ETIMEOUT/...）
   * @param {string} message 人话
   * @param {{detail?: string, hint?: string}} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = "PluginError";
    this.code = code;
    this.detail = options.detail;
    this.hint = options.hint;
  }

  toRpcError() {
    return {
      code: -32000,
      message: this.message,
      data: {
        code: this.code,
        ...(this.detail ? { detail: this.detail } : {}),
        ...(this.hint ? { hint: this.hint } : {}),
      },
    };
  }
}

/** 便捷构造：`throw fail("EBLOCKED", "...")`。 */
export function fail(code, message, options) {
  return new PluginError(code, message, options);
}

/* ------------------------------------------------------------------ */
/* 日志与脱敏                                                          */
/* ------------------------------------------------------------------ */

/** 本进程内出现过的敏感值（token、注入密钥），日志输出前统一打码。 */
const SECRET_VALUES = new Set();

function registerSecret(value) {
  if (typeof value === "string" && value.length >= 4) SECRET_VALUES.add(value);
}

function redact(text) {
  let out = String(text);
  for (const secret of SECRET_VALUES) out = out.split(secret).join("***");
  // 兜底：看起来像密钥的片段一律打码（与 kernel util/log.ts 的正则保持同一意图）
  return out.replace(/(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{8,})/g, (m) => `${m.slice(0, 4)}***`);
}

function serializeError(err) {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 管道名归一化：内核可能只注入名字（`anteros-kernel-xxx`），也可能给完整路径。 */
function normalizePipePath(name) {
  if (!name) return "";
  if (name.startsWith("\\\\.\\pipe\\") || name.startsWith("//./pipe/")) return name;
  if (name.includes("\\") || name.includes("/")) return name; // 已经是完整路径
  return isWindows ? `\\\\.\\pipe\\${name}` : path.join("/tmp", name);
}

function jsonrpcId(id) {
  return typeof id === "string" || typeof id === "number" ? id : String(id);
}

/** 读取内核注入的密钥；只读环境变量，不落盘、不打印。 */
export function readSecret(name) {
  const envKey = `ANTEROS_SECRET_${String(name).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  const value = process.env[envKey];
  if (value) registerSecret(value);
  return value ?? null;
}

/** 插件私有数据目录（若内核已创建则直接返回；否则补建，仍限定在内核给的路径下）。 */
export function pluginDataDir() {
  const dir = process.env.ANTEROS_DATA_DIR;
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 建不出来不致命：插件读写时再报可读错误 */
  }
  return dir;
}

/* ------------------------------------------------------------------ */
/* 运行时                                                              */
/* ------------------------------------------------------------------ */

/**
 * @typedef {Object} HandlerContext
 * @property {(method: string, params?: unknown, options?: {timeoutMs?: number}) => Promise<unknown>} call
 *        调用内核 API（`PluginHostApi`），只能调用 manifest 已申请且被授予的方法。
 * @property {(method: string, params?: unknown) => void} notify
 *        向内核发通知（无 id，不等回包）。当前协议未定义插件通知，保留但请少用。
 * @property {(message: string) => void} log
 * @property {string | null} dataDir
 * @property {string} pluginId
 * @property {string[]} grants 本次会话被授予的权限名（展示用，不能据此绕过内核校验）
 */

class PluginRuntime {
  /**
   * @param {{
   *   id: string,
   *   handlers: Record<string, (params: any, ctx: HandlerContext) => Promise<unknown>|unknown>,
   *   onReady?: (info: {kernelApi: string, sessionId: string, grants: string[]}, ctx: HandlerContext) => void|Promise<void>,
   *   capabilities?: string[],
   *   kernelApi?: string,
   * }} options
   */
  constructor(options) {
    this.id = options.id;
    this.handlers = options.handlers ?? {};
    this.onReady = options.onReady;
    this.capabilities = options.capabilities ?? [];
    // 握手时声明的是"插件期望的接口范围"（manifest 的 kernel_api），由内核核对主版本。
    this.kernelApi = options.kernelApi ?? ">=1.0 <2.0";
    this.kernelApiActual = process.env.ANTEROS_KERNEL_API || null;
    this.startedTs = Date.now();

    this.pipeName = normalizePipePath(process.env.ANTEROS_PIPE_NAME ?? "");
    this.token = process.env.ANTEROS_TOKEN ?? "";
    this.pluginId = process.env.ANTEROS_PLUGIN_ID || this.id;
    this.dataDir = pluginDataDir();

    if (this.envPluginIdMismatch()) {
      this.log(`环境变量 ANTEROS_PLUGIN_ID(${this.pluginId}) 与代码内 id(${this.id}) 不一致：以内核注入为准`);
    }

    this.socket = null;
    this.buffer = "";
    this.nextRequestId = 1;
    /** @type {Map<string|number, {resolve: Function, reject: Function, timer: NodeJS.Timeout, method: string}>} */
    this.pending = new Map();
    this.ready = false;
    this.session = null;
    this.grants = [];
    this.state = "connecting";
    this.reconnectAttempt = 0;
    this.heartbeatTimer = null;
    this.heartbeatFailures = 0;
    this.lastHeartbeatOkTs = null;
    this.closed = false;
    this.fatalStop = false;
    this.inflight = 0;

    this.ctx = {
      call: (method, params, callOptions) => {
        if (!this.ready) return Promise.reject(fail("EBLOCKED", "插件尚未完成与内核的握手，调用被拒绝", { hint: "等待 onReady 后再调用内核 API" }));
        return this.request(method, params, callOptions?.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
      },
      notify: (method, params) => this.send({ jsonrpc: "2.0", method, params }),
      log: (message) => this.log(String(message)),
      dataDir: this.dataDir,
      pluginId: this.pluginId,
      grants: this.grants,
    };
  }

  envPluginIdMismatch() {
    const envId = process.env.ANTEROS_PLUGIN_ID;
    return Boolean(envId && envId !== this.id);
  }

  log(message) {
    const line = `[plugin:${this.pluginId}] ${redact(message)}`;
    try {
      process.stderr.write(line + "\n");
    } catch {
      /* stderr 不可用时只能放弃；不能因为日志把插件搞崩 */
    }
  }

  warn(message) {
    this.log(`WARN ${message}`);
  }

  /** 启动：先做环境自检，再连接内核。 */
  start() {
    if (!this.pipeName || !this.token) {
      // 缺启动参数不是"运行期异常"，而是内核没有正确拉起插件：清晰退出比静默空转好。
      this.log("FATAL 缺少 ANTEROS_PIPE_NAME / ANTEROS_TOKEN：本插件必须由内核（Anteros 主进程）启动，不能独立运行");
      process.exitCode = 1;
      setImmediate(() => process.exit(1));
      return this;
    }
    registerSecret(this.token);
    this.log(`启动：kernel_api=${this.kernelApi} capabilities=[${this.capabilities.join(",") || "无"}]`);
    this.connect();
    return this;
  }

  connect() {
    if (this.closed || this.fatalStop) return;
    this.state = "connecting";
    this.buffer = "";

    const socket = net.connect({ path: this.pipeName });
    this.socket = socket;

    socket.on("connect", () => {
      this.log(`已连接内核管道 ${this.pipeName}，开始 handshake`);
      void this.handshake();
    });

    socket.on("data", (chunk) => this.onData(chunk));

    socket.on("error", (err) => {
      // 内核未启动 / 管道忙都是常态，只记一行，避免刷屏；重连由 close 统一处理。
      this.warn(`管道错误：${serializeError(err)}`);
    });

    socket.on("close", () => {
      if (this.socket !== socket) return; // 旧连接的回调，忽略
      this.socket = null;
      this.ready = false;
      this.stopHeartbeat();
      this.rejectAllPending("ECRASH", "与内核的连接已断开");
      this.failInflight?.(new Error("连接已断开"));
      if (this.closed || this.fatalStop) return;
      this.state = "reconnecting";
      this.log(`连接断开：按 1s/5s/30s 退避重连（第 ${this.reconnectAttempt + 1} 次）`);
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt += 1;
    setTimeout(() => this.connect(), delay).unref?.();
  }

  /**
   * 首帧：plugin.handshake。
   *
   * 与宿主（kernel-runtime）约定：params = { pluginId, kernelApi, capabilities, auth }，
   * auth 同时也会被 SDK 放在帧顶层（宿主两种都能读，保持向前兼容）。
   * 被内核**明确拒绝**（收到错误响应）时进程应退出，由内核按崩溃/退避策略处理；
   * 网络层失败（管道未建、连接被断）才走重连——否则会把"插件不被接受"变成无限重试。
   */
  async handshake() {
    try {
      const result = await this.request(
        "plugin.handshake",
        {
          pluginId: this.pluginId,
          kernelApi: this.kernelApi,
          capabilities: this.capabilities,
          auth: this.token,
        },
        HANDSHAKE_TIMEOUT_MS,
      );
      const info = result && typeof result === "object" ? result : {};
      const kernelVersion = typeof info.kernelApi === "string" ? info.kernelApi : "";
      if (kernelVersion) {
        const expectedMajor = String(this.kernelApi).match(/(\d+)/)?.[1] ?? "";
        const actualMajor = kernelVersion.match(/(\d+)/)?.[1] ?? "";
        if (expectedMajor && actualMajor && expectedMajor !== actualMajor) {
          this.exitForFatal(`内核接口主版本不匹配：插件期望 ${this.kernelApi}，内核 ${kernelVersion}。等待人工升级插件。`);
          return;
        }
      }
      this.ready = true;
      this.state = "running";
      this.reconnectAttempt = 0;
      this.session = typeof info.sessionId === "string" ? info.sessionId : null;
      this.grants = Array.isArray(info.grants) ? info.grants : [];
      this.log(`握手成功：session=${this.session ?? "?"} grants=[${this.grants.join(",") || "无"}]`);

      this.startHeartbeat();
      try {
        await this.onReady?.(info, this.ctx);
      } catch (err) {
        // onReady 失败不等于插件不可用：内核仍可调用其余方法，错误由具体 handler 返回。
        this.warn(`onReady 抛出异常（已忽略，进程继续）：${serializeError(err)}`);
      }
    } catch (err) {
      this.ready = false;
      this.state = "handshake_failed";
      const code = err instanceof PluginError ? err.code : "EUNKNOWN";
      // 网络层失败：内核可能还没起来 / 管道被关，按退避重连。
      if (code === "ETIMEOUT" || code === "EBLOCKED" || code === "ECRASH" || code === "ECANCELED") {
        this.warn(`握手未完成（网络原因）：${serializeError(err)}，稍后重连`);
        this.socket?.destroy();
        return;
      }
      // 内核明确拒绝：token 错、版本不符、manifest 未通过……重试没有意义，退出让内核处理。
      this.exitForFatal(`握手被内核拒绝：${serializeError(err)}`);
    }
  }

  /** 不可恢复的错误：记录人话后退出（内核会按 manifest 状态机决定是否/何时重启）。 */
  exitForFatal(message) {
    if (this.fatalStop) return;
    this.fatalStop = true;
    this.log(`FATAL ${message}`);
    this.close();
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 50).unref?.();
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ready) return;
      const metrics = {
        uptime_ms: Date.now() - this.startedTs,
        inflight: this.inflight,
        pending: this.pending.size,
        rss_mb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
      };
      this.request("plugin.heartbeat", { status: "running", metrics }, DEFAULT_CALL_TIMEOUT_MS).then(
        () => {
          this.heartbeatFailures = 0;
          this.lastHeartbeatOkTs = Date.now();
        },
        (err) => {
          this.heartbeatFailures += 1;
          this.warn(`心跳失败（第 ${this.heartbeatFailures} 次）：${serializeError(err)}`);
        },
      );
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /* ---------------- 收帧与分发 ---------------- */

  onData(chunk) {
    this.buffer += chunk.toString("utf8");
    // 防止对端不发换行把内存撑爆（超限直接断开，对齐规范 6 §5 单帧上限）
    if (this.buffer.length > MAX_FRAME_BYTES && !this.buffer.includes("\n")) {
      this.warn(`收到超过 ${MAX_FRAME_BYTES} 字节且无换行的帧，断开连接`);
      this.buffer = "";
      this.socket?.destroy();
      return;
    }
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) this.onFrame(line);
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  onFrame(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.warn("收到无法解析的 JSON 帧（已丢弃）：可能的内核/插件版本不一致");
      return;
    }
    if (!message || typeof message !== "object") return;

    const hasId = message.id !== undefined && message.id !== null;
    // 内核返回的响应：有 id，且不带 method
    if (hasId && !message.method) {
      const entry = this.pending.get(message.id);
      if (!entry) {
        this.warn(`收到未知 id=${String(message.id)} 的响应（可能已超时）`);
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(this.fromRpcError(message.error));
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    // 内核发来的请求（必须有 method）
    if (typeof message.method !== "string") {
      this.warn("收到既不是响应也不是请求的帧（已丢弃）");
      return;
    }
    if (!hasId) {
      // 通知：当前协议没有定义内核→插件通知，记录后忽略，不构造响应。
      this.log(`收到通知 ${message.method}（当前协议无处理器，忽略）`);
      return;
    }
    void this.dispatch(message);
  }

  fromRpcError(error) {
    const code = error?.data?.code ?? "EUNKNOWN";
    const message = typeof error?.message === "string" && error.message ? error.message : "内核返回未知错误";
    const err = new PluginError(code, message, {
      detail: typeof error?.data?.detail === "string" ? error.data.detail : undefined,
      hint: typeof error?.data?.hint === "string" ? error.data.hint : undefined,
    });
    return err;
  }

  async dispatch(message) {
    const id = jsonrpcId(message.id);
    const method = message.method;
    const handler = this.handlers[method];
    if (typeof handler !== "function") {
      this.send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: `插件未实现方法 ${method}`,
          data: { code: "ENOTFOUND", hint: "检查 manifest capabilities 与插件入口的 handlers 是否一致" },
        },
      });
      return;
    }
    this.inflight += 1;
    try {
      const result = await handler(message.params ?? {}, this.ctx);
      this.send({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
    } catch (err) {
      const rpcError = err instanceof PluginError ? err.toRpcError() : {
        code: -32000,
        message: `插件内部错误：${serializeError(err)}`,
        data: { code: "EUNKNOWN" },
      };
      // 未捕获异常不得让进程崩：这里兜底成一条可读错误，心跳继续，由内核决定降级。
      this.warn(`处理 ${method} 失败：${serializeError(err)}`);
      this.send({ jsonrpc: "2.0", id, error: rpcError });
    } finally {
      this.inflight -= 1;
    }
  }

  /* ---------------- 发帧与调用 ---------------- */

  /** 所有出帧都带 auth（规范 6 §5：后续请求带 token）。 */
  send(message) {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) {
      this.warn(`连接不可用，丢弃帧 ${message.method ?? message.id}`);
      return false;
    }
    const frame = { ...message, auth: this.token };
    let text;
    try {
      text = JSON.stringify(frame);
    } catch (err) {
      this.warn(`帧序列化失败：${serializeError(err)}`);
      return false;
    }
    if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) {
      this.warn(`出帧超过 ${MAX_FRAME_BYTES} 字节上限，拒绝发送`);
      return false;
    }
    socket.write(text + "\n");
    return true;
  }

  /** @returns {Promise<unknown>} */
  request(method, params, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(fail("EBLOCKED", `与内核的连接不可用，无法调用 ${method}`));
        return;
      }
      const id = this.nextRequestId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(fail("ETIMEOUT", `调用内核方法 ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      const ok = this.send({ jsonrpc: "2.0", id, method, params });
      if (!ok) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(fail("EBLOCKED", `与内核的连接不可用，无法调用 ${method}`));
      }
    });
  }

  rejectAllPending(code, message) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(fail(code, `${message}（${entry.method}）`));
    }
    this.pending.clear();
  }

  /** 健康自述：内核可据此渲染，不替代 `plugin.health.check`。 */
  stats() {
    return {
      pluginId: this.pluginId,
      state: this.state,
      ready: this.ready,
      session: this.session,
      grants: [...this.grants],
      reconnectAttempt: this.reconnectAttempt,
      heartbeatFailures: this.heartbeatFailures,
      lastHeartbeatOkTs: this.lastHeartbeatOkTs,
      uptimeMs: Date.now() - this.startedTs,
      pending: this.pending.size,
      inflight: this.inflight,
    };
  }

  /** 优雅关闭：关闭前不再重连。内核 disable 时也可能直接 SIGTERM。 */
  close() {
    this.closed = true;
    this.stopHeartbeat();
    this.rejectAllPending("ECANCELED", "插件正在关闭");
    try {
      this.socket?.end();
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
    this.ready = false;
    this.state = "closed";
  }
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 创建插件运行时并立即开始连接内核。
 *
 * 用法（插件入口 `index.mjs`）：
 * ```js
 * import { createPlugin, fail } from "../_sdk/plugin-runtime.mjs";
 *
 * createPlugin({
 *   id: "core.world-info",
 *   capabilities: ["world.info"],
 *   handlers: {
 *     "plugin.health.check": () => ({ ok: true, status: "ok", message: "本机时间可用" }),
 *     "plugin.world.info": async (params, ctx) => ({ items: [], degraded: true, detail: "..." }),
 *   },
 * });
 * ```
 *
 * 说明：
 * - `plugin.describe` 若插件没有提供 handler，SDK 默认用 id + capabilities 回答；
 * - 未实现的方法返回可读 JSON-RPC 错误（不会静默成功）；
 * - 同一个进程里只应创建一个 runtime；重复创建会各自建连接，内核会当成两条会话。
 *
 * @param {{
 *   id: string,
 *   handlers: Record<string, (params: any, ctx: HandlerContext) => Promise<unknown>|unknown>,
 *   onReady?: (info: {kernelApi: string, sessionId: string, grants: string[]}, ctx: HandlerContext) => void|Promise<void>,
 *   capabilities?: string[],
 *   kernelApi?: string,
 * }} options
 */
export function createPlugin(options) {
  if (!options || typeof options.id !== "string" || !options.id) {
    throw new Error("createPlugin 需要显式的插件 id");
  }
  const runtime = new PluginRuntime(options);
  if (!runtime.handlers["plugin.describe"]) {
    runtime.handlers["plugin.describe"] = () => ({ id: runtime.pluginId, capabilities: runtime.capabilities });
  }

  // 红线：插件崩了，内核不能跟着崩（规范 6 §1.3）。
  // 这里只记录、不退出：进程可能已处于不一致状态，但心跳会让内核把它标成 degraded；
  // 直接退出反而会触发内核的崩溃重启风暴。真正的错误应该由 handler 的 try/catch 处理。
  process.on("uncaughtException", (err) => {
    runtime.warn(`未捕获异常（已记录，进程继续）：${serializeError(err)}`);
  });
  process.on("unhandledRejection", (reason) => {
    runtime.warn(`未处理的 Promise 拒绝（已记录，进程继续）：${serializeError(reason)}`);
  });
  process.on("SIGTERM", () => {
    runtime.log("收到 SIGTERM，优雅退出");
    runtime.close();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    runtime.log("收到 SIGINT，优雅退出");
    runtime.close();
    process.exit(0);
  });

  runtime.start();
  return runtime;
}

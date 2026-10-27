/**
 * 插件宿主（规范 6 §4–§11）：进程生命周期、命名管道 JSON-RPC、握手、并发与超时、
 * 心跳与体检、崩溃退避、启用/停用/一键停用。
 *
 * 内核是管道 server，插件是 client。宿主对插件的调用一律走 `call()`（8 在途 + 写/租约独占），
 * 插件反向调内核一律走 `routeKernelCall()` 委托注入的 HostPorts，宿主自己不替插件做业务。
 * 任何插件异常（崩溃/超时/协议错误/密钥泄漏）都只影响该插件，绝不影响内核进程。
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  AnterosError,
  CAPABILITIES,
  CHANNEL_WRITE_TIMEOUT_MS,
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_MS,
  ERROR_CODES,
  KERNEL_API_VERSION,
  MAX_INFLIGHT_PER_PLUGIN,
  PLAIN_PERMISSIONS,
  kernelApiMajor,
  permissionPattern,
  type Capability,
  type ChatMessage,
  type Importance,
  type MemorySearchResult,
  type ParsedPluginManifest,
  type PluginHealth,
  type PluginInfo,
  type PluginKind,
  type PluginMethod,
  type PluginParams,
  type PluginResult,
  type PluginRisk,
  type PluginStatus,
} from "@anteros/shared";
import type { KernelDeps, PluginHostPort } from "../contracts.js";
import type { Db, SqlValue } from "../db/database.js";
import { randomHex } from "../util/crypto.js";
import type { LogSink } from "../util/log.js";
import { GrantStore } from "./grants.js";
import { PluginProcess, type PluginExitInfo } from "./process.js";
import { createPipeServer, pluginPipePath, RpcPeer, type RpcHandshakeExtra } from "./protocol.js";
import type { PluginRegistry } from "./registry.js";
import type { SecretStore } from "./secrets.js";
import type {
  CanEnableFn,
  CanEnableResult,
  ConfirmPort,
  EmitFn,
  HostDepsBundle,
  HostPorts,
  PluginDirInfo,
  PluginHostOptions,
} from "./types.js";

/* ------------------------------------------------------------------ */
/* 内部状态与工具                                                      */
/* ------------------------------------------------------------------ */

type RuntimeState = PluginStatus | "starting" | "stopped";

interface PluginRow {
  id: string;
  version: string;
  kernel_api: string;
  kind: string;
  capabilities: string;
  permissions: string;
  risk_level: string;
  enabled: number;
  config: string;
  enabled_ts: number | null;
  installed_by: number | null;
  status: string;
  health: string | null;
  last_error: string | null;
  issues: string;
}

type PluginColumn =
  | "version"
  | "kernel_api"
  | "kind"
  | "capabilities"
  | "permissions"
  | "risk_level"
  | "enabled"
  | "config"
  | "enabled_ts"
  | "status"
  | "health"
  | "last_error"
  | "issues";

interface PluginRuntime {
  info: PluginDirInfo;
  state: RuntimeState;
  proc: PluginProcess | null;
  peer: RpcPeer | null;
  socket: net.Socket | null;
  server: net.Server | null;
  pipePath: string | null;
  token: string | null;
  handshakeDone: boolean;
  acceptingCalls: boolean;
  inFlight: number;
  readonly semaphore: Semaphore;
  readonly writeQueue: SerialQueue;
  readonly leaseQueue: SerialQueue;
  healthTimer: NodeJS.Timeout | null;
  stableTimer: NodeJS.Timeout | null;
  restartTimer: NodeJS.Timeout | null;
  lastHeartbeatTs: number;
  lastHealth: PluginHealth | null;
  crashCount: number;
  stopping: boolean;
  leakNoted: boolean;
}

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly capacity: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.capacity) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) next();
    else this.active = Math.max(0, this.active - 1);
  }
}

class SerialQueue {
  private chain: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AnterosError(ERROR_CODES.ETIMEOUT, message)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asImportance(value: unknown): Importance | undefined {
  return value === "redline" || value === "important" || value === "detail" ? value : undefined;
}

function asMemoryKind(value: unknown): "episodic" | "semantic" | "open_loop" {
  if (value === "semantic" || value === "open_loop") return value;
  return "episodic";
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

/** 方法 → 需要的能力（null = 不需要授权）。内核自用方法不在表里。 */
const METHOD_CAPABILITY: Readonly<Record<string, Capability | null>> = {
  "plugin.channel.read_since": "channel.read",
  "plugin.channel.send": "channel.write",
  "plugin.channel.lease.begin": "channel.lease",
  "plugin.channel.lease.end": "channel.lease",
  "plugin.channel.download_media": "channel.media",
  "plugin.channel.history": "channel.history",
  "plugin.llm.generate": "llm.generate",
  "plugin.extract.memory": "extract.memory",
  "plugin.world.info": "world.info",
  "plugin.media.speak": "media.speak",
  "plugin.media.image": "media.image",
  "plugin.ui.panel.render": "ui.panel",
};

/** 内核自用、不做授权检查的方法（describe/health 是生命周期诊断）。 */
const INTERNAL_METHODS: ReadonlySet<string> = new Set([
  "plugin.describe",
  "plugin.health.check",
  "plugin.channel.disable_and_restore",
]);

/** 需要 owner 二次确认的高危权限。 */
const HIGH_RISK_PERMISSION = /^(proc\.|secrets\.read:|fs\.write:|ui\.foreground$)/;

/** 解析后（必填）的宿主参数：缺省值在构造函数里展开，避免到处判 undefined。 */
interface ResolvedHostOptions {
  pluginsDir: string;
  dataDir: string | undefined;
  production: boolean;
  handshakeTimeoutMs: number;
  disableGraceMs: number;
  heartbeatMs: number;
  healthIntervalMs: number;
  autoRestart: boolean;
  crashBackoffMs: readonly number[];
  grantOnEnable: boolean;
  requireHighRiskConfirm: boolean;
  sessionId: string;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_DISABLE_GRACE_MS = 5_000;
const DEFAULT_HEALTH_INTERVAL_MS = 30_000;
const DEFAULT_CRASH_BACKOFF_MS: readonly number[] = [1_000, 5_000, 30_000];

/** 默认启用闸：声明闸 + 密钥齐全 + 写能力必须先有租约授权。 */
export function defaultCanEnable(
  manifest: ParsedPluginManifest,
  context: { grants: string[]; missingSecrets: string[]; consent: { ok: boolean; consentVersion: string | null } },
): CanEnableResult {
  if (!context.consent.ok) {
    return {
      ok: false,
      code: ERROR_CODES.ECONSENT,
      reason: "需要先阅读并逐条同意《用户声明与风险告知》后才能启用插件",
    };
  }
  if (context.missingSecrets.length > 0) {
    return {
      ok: false,
      code: ERROR_CODES.EBLOCKED,
      reason: `缺少密钥：${context.missingSecrets.join("、")}（在插件详情里录入后重试）`,
    };
  }
  if (manifest.capabilities.includes("channel.write") && !context.grants.includes("channel.lease")) {
    return {
      ok: false,
      code: ERROR_CODES.EBLOCKED,
      reason: "通道写能力必须先授权 channel.lease（租约），否则无法保证写动作独占",
    };
  }
  return { ok: true };
}

export interface CallOptions {
  timeoutMs?: number;
  /** write / lease 会在插件内独占排队；心跳降级时写调用直接拒绝。 */
  kind?: "read" | "write" | "lease";
}

/* ------------------------------------------------------------------ */
/* 宿主                                                                */
/* ------------------------------------------------------------------ */

export class PluginHost implements PluginHostPort {
  readonly sessionId: string;
  private readonly deps: KernelDeps;
  private readonly db: Db;
  private readonly registry: PluginRegistry;
  private readonly secrets: SecretStore;
  private readonly ports: HostPorts;
  private readonly emit: EmitFn;
  private readonly log: LogSink;
  private readonly options: ResolvedHostOptions;
  private readonly dataDir: string;
  private readonly grants: GrantStore;
  private readonly canEnable: CanEnableFn;
  private readonly confirm: ConfirmPort | null;
  private readonly runtimes = new Map<string, PluginRuntime>();
  private readonly pendingHandshake = new Map<string, Deferred<void>>();
  private monitor: NodeJS.Timeout | null = null;
  private started = false;
  private closed = false;

  constructor(bundle: HostDepsBundle) {
    this.deps = bundle.deps;
    this.db = bundle.deps.db;
    this.registry = bundle.registry;
    this.secrets = bundle.secrets;
    this.ports = bundle.ports;
    this.emit = bundle.emit;
    this.log = bundle.log;
    const options = bundle.options ?? {};
    this.options = {
      pluginsDir: bundle.registry.pluginsDir,
      dataDir: options.dataDir,
      production: options.production ?? false,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      disableGraceMs: options.disableGraceMs ?? DEFAULT_DISABLE_GRACE_MS,
      heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      healthIntervalMs: options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS,
      autoRestart: options.autoRestart ?? true,
      crashBackoffMs: options.crashBackoffMs ?? DEFAULT_CRASH_BACKOFF_MS,
      grantOnEnable: options.grantOnEnable ?? false,
      requireHighRiskConfirm: options.requireHighRiskConfirm ?? true,
      sessionId: options.sessionId ?? randomHex(8),
    };
    this.sessionId = this.options.sessionId;
    this.dataDir =
      this.options.dataDir ?? (this.db.path === ":memory:" ? process.cwd() : path.dirname(this.db.path));
    this.grants =
      bundle.grants ??
      new GrantStore(this.db, (action, detail) => {
        void this.audit(action, detail, String(detail.pluginId ?? ""));
      });
    this.canEnable = bundle.canEnable ?? defaultCanEnable;
    this.confirm = bundle.confirm ?? null;
    for (const info of this.registry.list()) this.runtimes.set(info.manifest.id, this.createRuntime(info));
  }

  get dataDirectory(): string {
    return this.dataDir;
  }

  /* ---------------------------------------------------------------- */
  /* PluginHostPort                                                   */
  /* ---------------------------------------------------------------- */

  list(): PluginInfo[] {
    const rows = this.db.all<PluginRow>("SELECT * FROM plugins ORDER BY id");
    const known = new Set(rows.map((row) => row.id));
    const infos = rows.map((row) => this.toInfoFromRow(row));
    for (const invalid of this.registry.invalid()) {
      if (known.has(invalid.id)) continue;
      infos.push({
        id: invalid.id,
        name: invalid.id,
        version: "0.0.0",
        kernelApi: KERNEL_API_VERSION,
        kind: "processor",
        description: "插件清单校验失败，无法加载",
        riskLevel: "high",
        capabilities: [],
        permissions: [],
        grantable: [],
        runtimeEnv: false,
        grantNeedsConfirm: false,
        enableNeedsConfirm: false,
        granted: [],
        status: "invalid",
        enabled: false,
        config: {},
        health: null,
        secrets: [],
        missingSecrets: [],
        issues: invalid.issues,
      });
    }
    return infos.sort((a, b) => a.id.localeCompare(b.id));
  }

  async enable(
    pluginId: string,
    confirmToken?: string,
    internal?: { skipConfirm?: boolean },
  ): Promise<PluginInfo> {
    const rt = this.requireRuntime(pluginId);
    if (rt.state === "running" || rt.state === "starting") return this.toInfo(pluginId);
    const manifest = rt.info.manifest;
    if (this.options.requireHighRiskConfirm && manifest.riskLevel === "high" && internal?.skipConfirm !== true) {
      this.consumeConfirm(confirmToken, "plugin.enable", pluginId);
    }

    const verdict = await this.canEnable(manifest, {
      grants: this.grants.list(pluginId),
      missingSecrets: manifest.secrets.filter((name) => !this.secrets.has(pluginId, name)),
      consent: await this.ports.consent.check(),
    });
    if (!verdict.ok) {
      // 声明闸没过只是"还没到能启用的时机"，不是用户把它关了：
      // 保留 enabled=1，等 consent.accept 之后由内核再拉一次（避免首启把默认插件永久停掉）。
      const keepEnabled = verdict.code === ERROR_CODES.ECONSENT ? 1 : 0;
      this.update(pluginId, { status: "blocked", enabled: keepEnabled, last_error: verdict.reason, health: null });
      this.event(pluginId, "warn", `启用被拒：${verdict.reason}`);
      this.emitPlugin(pluginId);
      this.emitHealth();
      throw new AnterosError(verdict.code, verdict.reason);
    }

    this.update(pluginId, { enabled: 1 });
    if (this.options.grantOnEnable) this.autoGrant(rt);
    await this.startProcess(rt);
    return this.toInfo(pluginId);
  }

  async disable(pluginId: string): Promise<PluginInfo> {
    const rt = this.requireRuntime(pluginId);
    if (rt.state === "stopped" || rt.state === "disabled") {
      this.update(pluginId, { enabled: 0, status: "disabled", health: null });
      this.emitPlugin(pluginId);
      this.emitHealth();
      return this.toInfo(pluginId);
    }
    await this.haltProcess(rt);
    return this.toInfo(pluginId);
  }

  async restart(pluginId: string): Promise<PluginInfo> {
    const rt = this.requireRuntime(pluginId);
    const wasEnabled = this.row(pluginId)?.enabled === 1;
    await this.haltProcess(rt);
    rt.crashCount = 0;
    return this.enable(pluginId, undefined, { skipConfirm: wasEnabled });
  }

  grant(pluginId: string, permissions: string[], confirmToken?: string): PluginInfo {
    this.requireRuntime(pluginId);
    if (!Array.isArray(permissions) || permissions.length === 0) {
      throw new AnterosError(ERROR_CODES.EINVALID, "授权列表不能为空");
    }
    for (const permission of permissions) {
      const known =
        CAPABILITIES.includes(permission as Capability) ||
        PLAIN_PERMISSIONS.includes(permission as (typeof PLAIN_PERMISSIONS)[number]);
      if (!known && permissionPattern(permission) === null) {
        throw new AnterosError(ERROR_CODES.EINVALID, `未知权限：${permission}`, {
          hint: "权限名见 shared/manifest.ts 的 CAPABILITIES 与参数权限前缀",
        });
      }
    }
    if (permissions.some((permission) => HIGH_RISK_PERMISSION.test(permission))) {
      this.consumeConfirm(confirmToken, "plugin.grant", pluginId);
    }
    this.grants.grant(pluginId, permissions);
    this.event(pluginId, "info", `已授权：${permissions.join("、")}`);
    this.emitPlugin(pluginId);
    return this.toInfo(pluginId);
  }

  setConfig(pluginId: string, config: Record<string, unknown>): PluginInfo {
    this.requireRuntime(pluginId);
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      throw new AnterosError(ERROR_CODES.EINVALID, "插件配置必须是对象");
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(config);
    } catch {
      throw new AnterosError(ERROR_CODES.EINVALID, "插件配置必须是可 JSON 序列化的对象");
    }
    this.update(pluginId, { config: serialized });
    this.event(pluginId, "info", "插件配置已更新");
    this.emitPlugin(pluginId);
    return this.toInfo(pluginId);
  }

  secret(pluginId: string, name: string): string | null {
    const info = this.runtimes.get(pluginId)?.info ?? this.registry.get(pluginId);
    if (info === undefined) return null;
    if (!info.manifest.secrets.includes(name)) {
      this.log.warn(`插件 ${pluginId} 未在 manifest 里声明密钥 ${name}，拒绝读取`);
      return null;
    }
    if (!this.grants.isGranted(pluginId, `secrets.read:${name}`)) {
      this.log.warn(`插件 ${pluginId} 未获 secrets.read:${name} 授权，拒绝读取`);
      return null;
    }
    return this.secrets.get(pluginId, name);
  }

  /** 录入（覆盖）插件声明要的密钥。值只进密钥库，不进日志、不回显、不落库。 */
  setSecret(pluginId: string, name: string, value: string): void {
    const info = this.runtimes.get(pluginId)?.info ?? this.registry.get(pluginId);
    if (info === undefined) throw new AnterosError(ERROR_CODES.ENOTFOUND, `找不到插件：${pluginId}`);
    if (!info.manifest.secrets.includes(name)) {
      throw new AnterosError(ERROR_CODES.EINVALID, `插件 ${pluginId} 没有声明密钥 ${name}`, {
        hint: `它声明的密钥是：${info.manifest.secrets.length === 0 ? "（无）" : info.manifest.secrets.join("、")}`,
      });
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new AnterosError(ERROR_CODES.EINVALID, "密钥不能为空；要清除请用「删除密钥」");
    }
    this.secrets.set(pluginId, name, trimmed);
    this.event(pluginId, "info", `已录入密钥 ${name}（值不显示）`);
    this.emitPlugin(pluginId);
    this.emitHealth();
  }

  /** 清除插件密钥；清掉后依赖它的插件会被判 blocked，不会假装还能用。 */
  deleteSecret(pluginId: string, name: string): void {
    const info = this.runtimes.get(pluginId)?.info ?? this.registry.get(pluginId);
    if (info === undefined) throw new AnterosError(ERROR_CODES.ENOTFOUND, `找不到插件：${pluginId}`);
    if (!info.manifest.secrets.includes(name)) {
      throw new AnterosError(ERROR_CODES.EINVALID, `插件 ${pluginId} 没有声明密钥 ${name}`);
    }
    this.secrets.delete(pluginId, name);
    this.event(pluginId, "info", `已删除密钥 ${name}`);
    this.emitPlugin(pluginId);
    this.emitHealth();
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.monitor !== null) {
      clearInterval(this.monitor);
      this.monitor = null;
    }
    const tasks: Array<Promise<void>> = [];
    for (const rt of this.runtimes.values()) {
      if (rt.state === "stopped" || rt.state === "disabled" || rt.state === "invalid") continue;
      tasks.push(
        this.stopRuntime(rt)
          .then(() => this.update(rt.info.manifest.id, { status: "disabled", health: null }))
          .catch((error: unknown) => this.log.warn(`停止插件 ${rt.info.manifest.id} 失败：${errorText(error)}`)),
      );
    }
    await Promise.all(tasks);
  }

  async panicStop(): Promise<{ stopped: string[]; restored: boolean; message: string }> {
    const stopped: string[] = [];
    let restored = true;
    for (const rt of this.runtimes.values()) {
      const manifest = rt.info.manifest;
      const isChannel = manifest.kind === "channel" || manifest.capabilities.includes("channel.write");
      if (!isChannel) continue;
      if (rt.state === "stopped" || rt.state === "disabled" || rt.state === "invalid") continue;
      try {
        const ok = await this.haltProcess(rt);
        stopped.push(manifest.id);
        if (!ok) restored = false;
      } catch (error) {
        restored = false;
        this.log.warn(`一键停用插件 ${manifest.id} 失败：${errorText(error)}`);
      }
    }
    const message =
      stopped.length === 0
        ? "没有正在运行的通道插件，无需停用"
        : `已停用 ${stopped.length} 个通道插件${restored ? "，宿主侧状态已还原" : "，但部分插件未能确认还原（请检查通道侧前台/置顶/剪贴板）"}`;
    return { stopped, restored, message };
  }

  /* ---------------------------------------------------------------- */
  /* 启动与自动恢复                                                   */
  /* ---------------------------------------------------------------- */

  /** 启动所有 enabled=1 的插件（幂等；声明闸未过时只记 blocked，不抛不崩）。 */
  async ensureStarted(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.clearStaleStatuses();
    for (const row of this.db.all<PluginRow>("SELECT * FROM plugins WHERE enabled = 1 ORDER BY id")) {
      if (this.registry.get(row.id) === undefined) {
        this.update(row.id, { status: "blocked", enabled: 0, last_error: "插件文件已不存在，无法启动" });
        continue;
      }
      try {
        await this.enable(row.id, undefined, { skipConfirm: true });
      } catch (error) {
        this.log.warn(`自动启动插件 ${row.id} 失败：${errorText(error)}`);
      }
    }
  }

  private clearStaleStatuses(): void {
    this.db.run(
      "UPDATE plugins SET status = 'disabled', health = NULL WHERE status IN ('enabled', 'running', 'degraded', 'crashed', 'starting')",
    );
  }

  /* ---------------------------------------------------------------- */
  /* 调用插件（内核 → 插件）                                          */
  /* ---------------------------------------------------------------- */

  async call<M extends PluginMethod>(
    pluginId: string,
    method: M,
    params: PluginParams<M>,
    opts?: CallOptions,
  ): Promise<PluginResult<M>>;
  async call(pluginId: string, method: string, params: unknown, opts?: CallOptions): Promise<unknown>;
  async call(pluginId: string, method: string, params: unknown, opts: CallOptions = {}): Promise<unknown> {
    const rt = this.requireRuntime(pluginId);
    const capability = METHOD_CAPABILITY[method] ?? null;
    if (capability !== null && !rt.info.manifest.capabilities.includes(capability)) {
      throw new AnterosError(ERROR_CODES.EPERM, `插件 ${pluginId} 的 manifest 未声明能力 ${capability}`);
    }
    if (capability !== null && !INTERNAL_METHODS.has(method)) this.grants.require(pluginId, capability);

    const isWrite =
      opts.kind === "write" || opts.kind === "lease" || capability === "channel.write" || capability === "channel.lease";
    if (rt.state === "degraded" && isWrite) {
      throw new AnterosError(ERROR_CODES.EDEGRADED, `插件 ${pluginId} 心跳异常（degraded），写调用已暂停，读调用不受影响`);
    }
    const timeoutMs = this.timeoutFor(rt, capability, opts);

    const execute = async (): Promise<unknown> => {
      if (!rt.acceptingCalls) {
        throw new AnterosError(ERROR_CODES.EBLOCKED, `插件 ${pluginId} 正在停用，拒绝新调用`);
      }
      const peer = rt.peer;
      if (peer === null || peer.isClosed || !rt.handshakeDone) {
        throw new AnterosError(ERROR_CODES.ECRASH, `插件 ${pluginId} 未就绪（未握手或已断开）`);
      }
      rt.inFlight += 1;
      try {
        return await peer.request(method, params, timeoutMs);
      } catch (error) {
        if (error instanceof AnterosError && error.code === ERROR_CODES.ETIMEOUT) {
          this.onCallTimeout(rt, method, timeoutMs);
        }
        throw error;
      } finally {
        rt.inFlight = Math.max(0, rt.inFlight - 1);
      }
    };

    await rt.semaphore.acquire();
    try {
      if (capability === "channel.write" || opts.kind === "write") return await rt.writeQueue.run(execute);
      if (capability === "channel.lease" || opts.kind === "lease") return await rt.leaseQueue.run(execute);
      return await execute();
    } finally {
      rt.semaphore.release();
    }
  }

  private timeoutFor(rt: PluginRuntime, capability: Capability | null, opts: CallOptions): number {
    const base = opts.timeoutMs ?? rt.info.manifest.resources.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    if (capability === "channel.write") return Math.min(Math.max(base, 1_000), CHANNEL_WRITE_TIMEOUT_MS);
    return Math.max(1_000, base);
  }

  /* ---------------------------------------------------------------- */
  /* 进程启动 / 停止                                                  */
  /* ---------------------------------------------------------------- */

  private async startProcess(rt: PluginRuntime): Promise<void> {
    const manifest = rt.info.manifest;
    const id = manifest.id;
    this.clearRestart(rt);
    this.clearStable(rt);
    this.ensureMonitor();
    rt.stopping = false;
    rt.acceptingCalls = false;
    rt.handshakeDone = false;
    rt.state = "starting";
    rt.lastHeartbeatTs = Date.now();
    rt.lastHealth = null;
    rt.token = randomHex(16);
    const pipePath = pluginPipePath(this.sessionId, id);
    rt.pipePath = pipePath;
    const deferred = new Deferred<void>();
    this.pendingHandshake.set(id, deferred);
    const pluginDataDir = path.join(this.dataDir, "plugins", id);
    fs.mkdirSync(pluginDataDir, { recursive: true });
    const secretNames = this.grantedSecretNames(id);
    const secretValues = secretNames
      .map((name) => this.secrets.get(id, name))
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const env = this.spawnEnv(rt, pipePath, secretNames);

    const proc = new PluginProcess({
      pluginId: id,
      entryPath: rt.info.entryPath,
      args: manifest.entry.args,
      cwd: rt.info.dir,
      env,
      log: this.log,
      token: rt.token,
      knownSecrets: secretValues,
      onExit: (info) => this.onProcessExit(rt, info),
      onSecret: (info) => this.onSecretLeak(rt, info.kind, info.stream),
    });
    rt.proc = proc;

    try {
      try {
        rt.server = await createPipeServer(pipePath, (socket) => this.onSocket(rt, socket));
      } catch (error) {
        rt.proc = null;
        rt.state = "stopped";
        throw new AnterosError(ERROR_CODES.EIO, `创建插件命名管道失败：${errorText(error)}`);
      }

      this.update(id, { status: "enabled", last_error: null });
      this.emitPlugin(id);
      proc.start();

      await withTimeout(
        deferred.promise,
        this.options.handshakeTimeoutMs,
        `插件 ${id} 启动握手超时（${this.options.handshakeTimeoutMs}ms）`,
      );
    } catch (error) {
      this.pendingHandshake.delete(id);
      await this.stopRuntime(rt);
      const reason = errorText(error);
      this.update(id, { status: "blocked", enabled: 0, last_error: reason, health: null });
      this.event(id, "error", `启动失败：${reason}`);
      this.emitPlugin(id);
      this.emitHealth();
      throw error instanceof AnterosError ? error : new AnterosError(ERROR_CODES.ETIMEOUT, reason);
    }
    this.pendingHandshake.delete(id);

    rt.state = "running";
    rt.acceptingCalls = true;
    const health: PluginHealth = { ok: true, status: "ok", message: "握手成功", checkedTs: Date.now() };
    const row = this.row(id);
    this.update(id, {
      enabled: 1,
      status: "running",
      health: JSON.stringify(health),
      last_error: null,
      enabled_ts: row?.enabled_ts ?? Date.now(),
    });
    rt.lastHealth = health;
    this.event(id, "info", "插件已启动并完成握手");
    this.emitPlugin(id);
    this.emitHealth();
    this.startHealthLoop(rt);
    this.scheduleStableReset(rt);
  }

  /** 停用：拒新调用 → 等在途 → 通知插件还原（写能力）→ 强杀 → 记录。返回 restored。 */
  private async haltProcess(rt: PluginRuntime): Promise<boolean> {
    const id = rt.info.manifest.id;
    rt.acceptingCalls = false;
    this.update(id, { status: "disabled", health: null });
    this.emitPlugin(id);
    await this.drain(rt, this.options.disableGraceMs);
    let restored = true;
    const peer = rt.peer;
    if (rt.info.manifest.capabilities.includes("channel.write") && peer !== null && !peer.isClosed && rt.handshakeDone) {
      try {
        const result = await peer.request<{ restored: boolean; detail: string }>(
          "plugin.channel.disable_and_restore",
          {},
          Math.max(1_000, this.options.disableGraceMs),
        );
        restored = result.restored === true;
        if (!restored) this.log.warn(`插件 ${id} 报告宿主状态还原失败：${result.detail}`);
      } catch (error) {
        restored = false;
        this.log.warn(`插件 ${id} 还原调用失败（将强杀进程）：${errorText(error)}`);
      }
    }
    await this.stopRuntime(rt);
    this.update(id, { enabled: 0, status: "disabled", last_error: null });
    this.event(id, "info", restored ? "插件已停用" : "插件已停用，但宿主侧状态还原未确认");
    this.emitPlugin(id);
    this.emitHealth();
    return restored;
  }

  private async stopRuntime(rt: PluginRuntime): Promise<void> {
    const id = rt.info.manifest.id;
    rt.stopping = true;
    rt.acceptingCalls = false;
    this.clearHealthTimer(rt);
    this.clearStable(rt);
    this.clearRestart(rt);
    const pending = this.pendingHandshake.get(id);
    if (pending !== undefined) {
      this.pendingHandshake.delete(id);
      pending.reject(new AnterosError(ERROR_CODES.ECRASH, `插件 ${id} 已停止`));
    }
    const peer = rt.peer;
    rt.peer = null;
    rt.handshakeDone = false;
    if (peer !== null) peer.close("宿主停止插件");
    if (rt.socket !== null) {
      rt.socket.destroy();
      rt.socket = null;
    }
    const server = rt.server;
    rt.server = null;
    if (server !== null) {
      await new Promise<void>((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
        const timer = setTimeout(resolve, 500);
        timer.unref?.();
      });
    }
    const proc = rt.proc;
    rt.proc = null;
    if (proc !== null) await proc.stop(2_000);
    rt.state = "stopped";
  }

  private async drain(rt: PluginRuntime, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (rt.inFlight > 0 && Date.now() < deadline) await delay(25);
    if (rt.inFlight > 0) this.log.warn(`插件 ${rt.info.manifest.id} 仍有 ${rt.inFlight} 个在途调用，超时强杀`);
  }

  private spawnEnv(rt: PluginRuntime, pipePath: string, secretNames: readonly string[]): NodeJS.ProcessEnv {
    const id = rt.info.manifest.id;
    const token = rt.token ?? "";
    const pluginDataDir = path.join(this.dataDir, "plugins", id);
    const env: NodeJS.ProcessEnv = { ...process.env };
    env.ELECTRON_RUN_AS_NODE = "1";
    env.ANTEROS_PIPE_NAME = pipePath;
    env.ANTEROS_PIPE_SERVER = pipePath;
    env.ANTEROS_TOKEN = token;
    env.ANTEROS_PLUGIN_TOKEN = token;
    env.ANTEROS_PLUGIN_ID = id;
    env.ANTEROS_DATA_DIR = pluginDataDir;
    env.ANTEROS_PLUGINS_DIR = this.registry.pluginsDir;
    env.ANTEROS_KERNEL_API = KERNEL_API_VERSION;
    Object.assign(env, this.secrets.envFor(id, secretNames));
    return env;
  }

  private grantedSecretNames(id: string): string[] {
    const info = this.runtimes.get(id)?.info ?? this.registry.get(id);
    if (info === undefined) return [];
    return info.manifest.secrets.filter((name) => this.grants.isGranted(id, `secrets.read:${name}`));
  }

  private autoGrant(rt: PluginRuntime): void {
    const id = rt.info.manifest.id;
    const manifest = rt.info.manifest;
    const wanted = [...manifest.capabilities, ...manifest.secrets.map((name) => `secrets.read:${name}`)];
    const have = new Set(this.grants.list(id));
    const missing = wanted.filter((capability) => !have.has(capability));
    if (missing.length > 0) this.grants.grant(id, missing);
  }

  /* ---------------------------------------------------------------- */
  /* 管道连接与握手                                                   */
  /* ---------------------------------------------------------------- */

  private onSocket(rt: PluginRuntime, socket: net.Socket): void {
    const id = rt.info.manifest.id;
    if (rt.socket !== null) {
      socket.destroy();
      this.log.warn(`插件 ${id} 出现重复连接，已拒绝`);
      return;
    }
    rt.socket = socket;
    const peer = new RpcPeer(socket, {
      onRequest: (method, params, extra) => this.onPluginRequest(rt, method, params, extra),
      onNotification: (method, params) => this.onPluginNotification(rt, method, params),
      onClose: (reason) => {
        if (rt.socket === socket) rt.socket = null;
        if (rt.peer === peer) rt.peer = null;
        const pending = this.pendingHandshake.get(id);
        if (pending !== undefined && !rt.handshakeDone) {
          this.pendingHandshake.delete(id);
          pending.reject(new AnterosError(ERROR_CODES.ECRASH, `插件连接在握手前断开：${reason}`));
        }
        if (!rt.stopping && rt.state === "running") this.log.warn(`插件 ${id} 连接断开：${reason}`);
      },
      onProtocolError: (message) => this.log.warn(`插件 ${id} 协议错误：${message}`),
    });
    rt.peer = peer;
  }

  private async onPluginRequest(
    rt: PluginRuntime,
    method: string,
    params: unknown,
    extra: RpcHandshakeExtra | undefined,
  ): Promise<unknown> {
    const p = asRecord(params);
    if (method === "plugin.handshake") return this.onHandshake(rt, p, extra);
    if (!rt.handshakeDone) {
      throw new AnterosError(ERROR_CODES.EPERM, "握手完成前不允许调用内核方法");
    }
    if (method === "plugin.heartbeat") return this.onHeartbeat(rt, p);
    if (method === "plugin.describe") {
      return { id: rt.info.manifest.id, capabilities: rt.info.manifest.capabilities };
    }
    return this.routeKernelCall(rt, method, p);
  }

  private onHandshake(rt: PluginRuntime, params: Record<string, unknown>, extra?: RpcHandshakeExtra): unknown {
    const id = rt.info.manifest.id;
    const fail = (error: AnterosError): never => {
      this.log.warn(`插件 ${id} 握手被拒：${error.message}`);
      this.event(id, "warn", `握手被拒：${error.message}`);
      void this.stopRuntime(rt);
      throw error;
    };

    const token =
      asString(params.auth) ?? asString(params.token) ?? asString(extra?.auth) ?? asString(extra?.token);
    if (token === undefined || rt.token === null || token !== rt.token) {
      return fail(
        new AnterosError(ERROR_CODES.EPERM, "握手 token 不匹配（一次性 token 只经环境变量注入）", {
          hint: "插件应读取 ANTEROS_TOKEN / ANTEROS_PLUGIN_TOKEN 并原样回传",
        }),
      );
    }
    if (asString(params.pluginId) !== id) {
      return fail(new AnterosError(ERROR_CODES.EPERM, `握手 pluginId 不匹配：期望 ${id}`));
    }
    const kernelApi = asString(params.kernelApi) ?? "";
    if (kernelApiMajor(kernelApi) !== kernelApiMajor(KERNEL_API_VERSION)) {
      return fail(
        new AnterosError(
          ERROR_CODES.EVERSION,
          `插件声明的 kernel_api 与内核不兼容：${kernelApi} vs ${KERNEL_API_VERSION}`,
        ),
      );
    }
    const claimed = Array.isArray(params.capabilities) ? params.capabilities.map(String) : [];
    const declared = new Set<string>(rt.info.manifest.capabilities);
    const extraCapabilities = claimed.filter((capability) => !declared.has(capability));
    if (extraCapabilities.length > 0) {
      return fail(
        new AnterosError(ERROR_CODES.EPERM, `插件握手声明了 manifest 之外的能​​力：${extraCapabilities.join("、")}`),
      );
    }

    rt.handshakeDone = true;
    rt.lastHeartbeatTs = Date.now();
    this.log.info(`插件 ${id} 握手成功（kernel_api=${kernelApi}）`);
    const deferred = this.pendingHandshake.get(id);
    if (deferred !== undefined) {
      this.pendingHandshake.delete(id);
      setImmediate(() => deferred.resolve());
    }
    return { kernelApi: KERNEL_API_VERSION, sessionId: this.sessionId, grants: this.grants.list(id) };
  }

  private onHeartbeat(rt: PluginRuntime, params: Record<string, unknown>): unknown {
    rt.lastHeartbeatTs = Date.now();
    void params;
    if (rt.state === "degraded" && rt.acceptingCalls) {
      rt.state = "running";
      const health: PluginHealth = { ok: true, status: "ok", message: "心跳恢复", checkedTs: Date.now() };
      rt.lastHealth = health;
      this.update(rt.info.manifest.id, { status: "running", last_error: null, health: JSON.stringify(health) });
      this.event(rt.info.manifest.id, "info", "心跳恢复，写调用已放行");
      this.emitPlugin(rt.info.manifest.id);
      this.emitHealth();
    }
    return { ack: true };
  }

  private onPluginNotification(rt: PluginRuntime, method: string, params: unknown): void {
    if (method === "plugin.heartbeat") {
      this.onHeartbeat(rt, asRecord(params));
      return;
    }
    this.log.debug(`插件 ${rt.info.manifest.id} 通知 ${method}（宿主未处理）`);
  }

  /* ---------------------------------------------------------------- */
  /* 插件 → 内核：kernel.* 路由                                       */
  /* ---------------------------------------------------------------- */

  private async routeKernelCall(rt: PluginRuntime, method: string, p: Record<string, unknown>): Promise<unknown> {
    const id = rt.info.manifest.id;
    switch (method) {
      case "kernel.config.get": {
        const keys = Array.isArray(p.keys) ? p.keys.map(String) : undefined;
        return { config: this.pluginConfig(id, keys) };
      }
      case "kernel.memory.search": {
        const topK = asNumber(p.topK);
        const result: MemorySearchResult = await this.ports.memory.search({
          query: asString(p.query) ?? "",
          ...(topK === undefined ? {} : { topK }),
          pluginId: id,
        });
        return result;
      }
      case "kernel.memory.remember": {
        const importance = asImportance(p.importance);
        const slotKey = asString(p.slotKey);
        const extractionId = await this.ports.memory.remember({
          kind: asMemoryKind(p.kind),
          content: asString(p.content) ?? "",
          ...(importance === undefined ? {} : { importance }),
          ...(slotKey === undefined ? {} : { slotKey }),
          pluginId: id,
        });
        return { extractionId };
      }
      case "kernel.context.assemble": {
        const contextBlock = await this.ports.context.assemble({ intent: asString(p.intent) ?? "", pluginId: id });
        return { contextBlock };
      }
      case "kernel.outbox.send": {
        this.grants.require(id, "channel.write");
        return await this.ports.outbox.send({
          channelId: asString(p.channelId) ?? id,
          target: asString(p.target) ?? "",
          parts: Array.isArray(p.parts) ? p.parts.map(String) : [],
          deadlineTs: asNumber(p.deadlineTs) ?? Date.now() + 60_000,
          pluginId: id,
        });
      }
      case "kernel.inbox.next": {
        this.grants.require(id, "channel.read");
        const messages: ChatMessage[] = await this.ports.inbox.next({
          channelId: asString(p.channelId) ?? id,
          limit: Math.min(Math.max(asNumber(p.limit) ?? 10, 1), 100),
          pluginId: id,
        });
        return { messages };
      }
      case "kernel.audit.log": {
        await this.ports.audit.log({
          action: asString(p.action) ?? "plugin.unknown",
          detail: asRecord(p.detail),
          pluginId: id,
        });
        return { ack: true };
      }
      case "kernel.metrics.emit": {
        const tags = toStringRecord(asRecord(p.tags));
        await this.ports.metrics.emit({
          name: asString(p.name) ?? "unknown",
          value: asNumber(p.value) ?? 0,
          ...(Object.keys(tags).length === 0 ? {} : { tags }),
          pluginId: id,
        });
        return { ack: true };
      }
      case "kernel.consent.check": {
        const consent = await this.ports.consent.check();
        return { ok: consent.ok, consentVersion: consent.consentVersion };
      }
      default:
        throw new AnterosError(ERROR_CODES.EINVALID, `插件调用了未知的内核方法：${method}`);
    }
  }

  private pluginConfig(id: string, keys?: readonly string[]): Record<string, unknown> {
    const row = this.row(id);
    const own = parseJson<Record<string, unknown>>(row?.config, {});
    const defaults = extractSchemaDefaults(this.registry.get(id)?.manifest.configSchema);
    const merged: Record<string, unknown> = { ...defaults, ...own };
    if (keys === undefined || keys.length === 0) return merged;
    const selected: Record<string, unknown> = {};
    for (const key of keys) if (key in merged) selected[key] = merged[key];
    return selected;
  }

  /* ---------------------------------------------------------------- */
  /* 崩溃、超时、泄漏、健康                                           */
  /* ---------------------------------------------------------------- */

  private onProcessExit(rt: PluginRuntime, info: PluginExitInfo): void {
    const id = rt.info.manifest.id;
    rt.proc = null;
    const pending = this.pendingHandshake.get(id);
    if (pending !== undefined) {
      this.pendingHandshake.delete(id);
      pending.reject(new AnterosError(ERROR_CODES.ECRASH, `插件 ${id} 进程在握手前退出`));
    }
    rt.peer?.close("进程退出");
    rt.peer = null;
    rt.handshakeDone = false;
    if (rt.socket !== null) {
      rt.socket.destroy();
      rt.socket = null;
    }
    const server = rt.server;
    rt.server = null;
    server?.close();
    this.clearHealthTimer(rt);
    if (rt.stopping || info.expected) return;

    const tail = (info.stderrTail || info.stdoutTail).trim().split("\n").slice(-3).join(" | ").slice(0, 300);
    const reason =
      info.code !== null
        ? `插件进程退出（code=${info.code}）${tail ? `：${tail}` : ""}`
        : info.signal !== null
          ? `插件进程被信号终止（${info.signal}）`
          : "插件进程异常退出";
    this.noteCrash(rt, reason);
  }

  private noteCrash(rt: PluginRuntime, reason: string): void {
    const id = rt.info.manifest.id;
    rt.crashCount += 1;
    rt.state = "crashed";
    this.update(id, { status: "crashed", last_error: reason, health: null });
    this.event(id, "error", `崩溃第 ${rt.crashCount} 次：${reason}`);
    this.emitPlugin(id);
    this.emitHealth();
    this.emit("event.log", { level: "error", source: `plugin:${id}`, message: reason, ts: Date.now() });

    if (rt.crashCount >= 3 || !this.options.autoRestart) {
      rt.state = "disabled";
      this.update(id, {
        enabled: 0,
        status: "disabled",
        last_error: `连续启动失败 ${rt.crashCount} 次，已自动停用：${reason}`,
      });
      this.event(id, "error", "连续失败已达上限，插件已停用，等待用户手动启用");
      this.emitPlugin(id);
      this.emitHealth();
      return;
    }
    const backoff = this.options.crashBackoffMs;
    const delayMs = backoff[Math.min(rt.crashCount - 1, backoff.length - 1)] ?? 1_000;
    this.clearRestart(rt);
    const timer = setTimeout(() => {
      rt.restartTimer = null;
      if (rt.stopping || this.closed) return;
      this.event(id, "info", `退避 ${delayMs}ms 后尝试重启（第 ${rt.crashCount} 次）`);
      void this.startProcess(rt).catch((error: unknown) => this.noteCrash(rt, `重启失败：${errorText(error)}`));
    }, delayMs);
    timer.unref?.();
    rt.restartTimer = timer;
  }

  private onCallTimeout(rt: PluginRuntime, method: string, timeoutMs: number): void {
    const id = rt.info.manifest.id;
    const reason = `调用 ${method} 超时（${timeoutMs}ms），已标记降级`;
    const health: PluginHealth = { ok: false, status: "degraded", message: reason, checkedTs: Date.now() };
    rt.lastHealth = health;
    if (rt.state === "running") rt.state = "degraded";
    this.update(id, { status: "degraded", last_error: reason, health: JSON.stringify(health) });
    this.event(id, "warn", reason);
    this.emitPlugin(id);
    this.emitHealth();
  }

  private onSecretLeak(rt: PluginRuntime, kind: string, stream: "stdout" | "stderr"): void {
    const id = rt.info.manifest.id;
    const message = `插件输出疑似泄漏密钥（${kind}，${stream}），已脱敏并记录告警`;
    if (rt.leakNoted) return;
    rt.leakNoted = true;
    this.event(id, "warn", message);
    this.update(id, { last_error: message });
    this.emit("event.log", { level: "warn", source: `plugin:${id}`, message, ts: Date.now() });
    this.emitPlugin(id);
  }

  private startHealthLoop(rt: PluginRuntime): void {
    this.clearHealthTimer(rt);
    const interval = rt.info.manifest.healthcheck?.intervalMs ?? this.options.healthIntervalMs;
    if (interval <= 0) return;
    const timer = setInterval(() => {
      void this.runHealthCheck(rt).catch((error: unknown) =>
        this.log.warn(`插件 ${rt.info.manifest.id} 体检失败：${errorText(error)}`),
      );
    }, interval);
    timer.unref?.();
    rt.healthTimer = timer;
  }

  private async runHealthCheck(rt: PluginRuntime): Promise<void> {
    if (rt.state !== "running" && rt.state !== "degraded") return;
    const id = rt.info.manifest.id;
    const timeoutMs = rt.info.manifest.healthcheck?.timeoutMs ?? 5_000;
    try {
      const result = await this.call<"plugin.health.check">(id, "plugin.health.check", {}, { timeoutMs, kind: "read" });
      const health: PluginHealth = {
        ok: result.ok,
        status: result.status,
        message: result.message,
        checkedTs: Date.now(),
      };
      rt.lastHealth = health;
      this.update(id, { health: JSON.stringify(health) });
      if (result.status === "blocked") this.setState(rt, "blocked", `体检报告 blocked：${result.message}`);
      else if (result.status === "degraded") this.setState(rt, "degraded", `体检报告 degraded：${result.message}`);
      else if (rt.state === "degraded" && this.heartbeatFresh(rt)) this.setState(rt, "running", null);
      else this.emitPlugin(id);
    } catch (error) {
      const health: PluginHealth = {
        ok: false,
        status: "degraded",
        message: errorText(error),
        checkedTs: Date.now(),
      };
      rt.lastHealth = health;
      this.update(id, { health: JSON.stringify(health) });
      if (rt.state === "running") this.setState(rt, "degraded", `体检失败：${health.message}`);
    }
  }

  private heartbeatFresh(rt: PluginRuntime): boolean {
    return rt.lastHeartbeatTs > 0 && Date.now() - rt.lastHeartbeatTs <= this.options.heartbeatMs * 2;
  }

  private setState(rt: PluginRuntime, state: RuntimeState, reason: string | null): void {
    const id = rt.info.manifest.id;
    rt.state = state;
    const fields: Partial<Record<PluginColumn, SqlValue>> = { status: this.stateToStatus(state) };
    if (reason !== null) fields.last_error = reason;
    this.update(id, fields);
    this.event(id, "info", `状态变为 ${state}${reason === null ? "" : `：${reason}`}`);
    this.emitPlugin(id);
    this.emitHealth();
  }

  private stateToStatus(state: RuntimeState): PluginStatus {
    if (state === "starting") return "enabled";
    if (state === "stopped") return "disabled";
    return state;
  }

  private ensureMonitor(): void {
    if (this.monitor !== null) return;
    this.monitor = setInterval(() => this.checkHeartbeats(), Math.min(5_000, this.options.heartbeatMs));
    this.monitor.unref?.();
  }

  private checkHeartbeats(): void {
    const now = Date.now();
    for (const rt of this.runtimes.values()) {
      if (rt.state !== "running") continue;
      if (rt.lastHeartbeatTs > 0 && now - rt.lastHeartbeatTs > this.options.heartbeatMs * 2) {
        const id = rt.info.manifest.id;
        const reason = `心跳超时（>${Math.round((this.options.heartbeatMs * 2) / 1000)}s），只丢写调用、读调用照常`;
        rt.state = "degraded";
        this.update(id, { status: "degraded", last_error: reason });
        this.event(id, "warn", reason);
        this.emitPlugin(id);
        this.emitHealth();
      }
    }
  }

  private scheduleStableReset(rt: PluginRuntime): void {
    this.clearStable(rt);
    const timer = setTimeout(() => {
      rt.stableTimer = null;
      rt.crashCount = 0;
    }, 60_000);
    timer.unref?.();
    rt.stableTimer = timer;
  }

  private clearHealthTimer(rt: PluginRuntime): void {
    if (rt.healthTimer !== null) {
      clearInterval(rt.healthTimer);
      rt.healthTimer = null;
    }
  }

  private clearStable(rt: PluginRuntime): void {
    if (rt.stableTimer !== null) {
      clearTimeout(rt.stableTimer);
      rt.stableTimer = null;
    }
  }

  private clearRestart(rt: PluginRuntime): void {
    if (rt.restartTimer !== null) {
      clearTimeout(rt.restartTimer);
      rt.restartTimer = null;
    }
  }

  /* ---------------------------------------------------------------- */
  /* 运行时登记 / 数据库 / 事件                                       */
  /* ---------------------------------------------------------------- */

  private createRuntime(info: PluginDirInfo): PluginRuntime {
    return {
      info,
      state: "stopped",
      proc: null,
      peer: null,
      socket: null,
      server: null,
      pipePath: null,
      token: null,
      handshakeDone: false,
      acceptingCalls: false,
      inFlight: 0,
      semaphore: new Semaphore(MAX_INFLIGHT_PER_PLUGIN),
      writeQueue: new SerialQueue(),
      leaseQueue: new SerialQueue(),
      healthTimer: null,
      stableTimer: null,
      restartTimer: null,
      lastHeartbeatTs: 0,
      lastHealth: null,
      crashCount: 0,
      stopping: true,
      leakNoted: false,
    };
  }

  private requireRuntime(pluginId: string): PluginRuntime {
    const existing = this.runtimes.get(pluginId);
    if (existing !== undefined) return existing;
    const info = this.registry.get(pluginId);
    if (info !== undefined) {
      const created = this.createRuntime(info);
      this.runtimes.set(pluginId, created);
      return created;
    }
    if (this.row(pluginId) !== undefined) {
      throw new AnterosError(ERROR_CODES.EINVALID, `插件 ${pluginId} 的文件已不存在`, {
        hint: "插件目录被移动或删除，请重新安装或移除该记录",
      });
    }
    throw new AnterosError(ERROR_CODES.ENOTFOUND, `找不到插件：${pluginId}`);
  }

  private row(id: string): PluginRow | undefined {
    return this.db.get<PluginRow>("SELECT * FROM plugins WHERE id = ?", [id]);
  }

  private update(id: string, fields: Partial<Record<PluginColumn, SqlValue>>): void {
    const keys = Object.keys(fields) as PluginColumn[];
    if (keys.length === 0) return;
    const assignments = keys.map((key) => `${key} = ?`).join(", ");
    const values = keys.map((key) => fields[key] ?? null);
    this.db.run(`UPDATE plugins SET ${assignments} WHERE id = ?`, [...values, id]);
  }

  private event(id: string, level: "debug" | "info" | "warn" | "error", message: string): void {
    try {
      this.db.run("INSERT INTO plugin_events(plugin_id, ts, level, message) VALUES (?, ?, ?, ?)", [
        id,
        Date.now(),
        level,
        message.slice(0, 2_000),
      ]);
    } catch {
      /* 事件表写失败不影响主流程 */
    }
  }

  private toInfo(pluginId: string): PluginInfo {
    const row = this.row(pluginId);
    if (row === undefined) throw new AnterosError(ERROR_CODES.ENOTFOUND, `找不到插件：${pluginId}`);
    return this.toInfoFromRow(row);
  }

  private toInfoFromRow(row: PluginRow): PluginInfo {
    const info = this.runtimes.get(row.id)?.info ?? this.registry.get(row.id);
    const manifest = info?.manifest;
    const issued = info?.issues ?? [];
    // 密钥问题是"现在就能改"的活状态：每次读都按密钥库重算，别把注册时那句过期的提示一直挂着。
    const missingSecrets = (manifest?.secrets ?? []).filter((name) => !this.secrets.has(row.id, name));
    const stale = parseJson<string[]>(row.issues, []).filter((issue) => !issue.includes("项密钥"));
    if (missingSecrets.length > 0) {
      stale.push(`需要 ${missingSecrets.length} 项密钥（未录入会导致 blocked）：${missingSecrets.join("、")}`);
    }
    const issues = unique([
      ...stale,
      ...issued.filter((issue) => !issue.includes("项密钥")),
    ]);
    if (info === undefined) issues.push("插件目录或文件已不存在，请重新安装或移除该插件");
    const grantable = unique([...parseJson<string[]>(row.capabilities, []), ...parseJson<string[]>(row.permissions, [])]);
    const status = this.effectiveStatus(row);
    return {
      id: row.id,
      name: manifest?.name ?? row.id,
      version: manifest?.version ?? row.version,
      kernelApi: manifest?.kernelApi ?? row.kernel_api,
      kind: (manifest?.kind ?? row.kind) as PluginKind,
      description: manifest?.description ?? "",
      riskLevel: (manifest?.riskLevel ?? row.risk_level) as PluginRisk,
      capabilities: parseJson<string[]>(row.capabilities, []),
      permissions: parseJson<string[]>(row.permissions, []),
      grantable,
      // 授权闸只看「勾选的权限里有没有高危项」，与插件整体 riskLevel 是两回事：
      // 中风险的 core.llm-router 因为声明 secrets.read:llm.api_key 同样要二次确认。
      grantNeedsConfirm: grantable.some((permission) => HIGH_RISK_PERMISSION.test(permission)),
      // 启用闸只认 riskLevel === "high"（见 enable()），两边规则必须一致地暴露给界面。
      enableNeedsConfirm: (manifest?.riskLevel ?? row.risk_level) === "high",
      granted: this.grants.list(row.id),
      status,
      enabled: row.enabled === 1,
      config: parseJson<Record<string, unknown>>(row.config, {}),
      health: parseJson<PluginHealth | null>(row.health, null),
      secrets: [...(manifest?.secrets ?? [])],
      missingSecrets,
      runtimeEnv: manifest?.runtimeEnv === true,
      issues,
      ...(row.last_error === null ? {} : { lastError: row.last_error }),
      ...(row.enabled_ts === null ? {} : { enabledTs: row.enabled_ts }),
    };
  }

  private effectiveStatus(row: PluginRow): PluginStatus {
    const runtime = this.runtimes.get(row.id);
    if (runtime === undefined) {
      return this.registry.get(row.id) === undefined ? "invalid" : (row.status as PluginStatus);
    }
    if (runtime.state === "starting") return "enabled";
    if (runtime.state === "stopped") {
      if (this.registry.get(row.id) === undefined) return "invalid";
      return row.status as PluginStatus;
    }
    return runtime.state;
  }

  private emitPlugin(id: string): void {
    const row = this.row(id);
    if (row === undefined) return;
    this.emit("event.plugin", this.toInfoFromRow(row));
  }

  private emitHealth(): void {
    const degraded: Array<{ pluginId: string; reason: string }> = [];
    for (const row of this.db.all<PluginRow>("SELECT * FROM plugins ORDER BY id")) {
      const status = this.effectiveStatus(row);
      if (status === "degraded" || status === "blocked" || status === "crashed") {
        degraded.push({ pluginId: row.id, reason: row.last_error ?? status });
      }
    }
    this.emit("event.health", { degraded });
  }

  private async audit(action: string, detail: Record<string, unknown>, pluginId: string): Promise<void> {
    await this.ports.audit.log({ action, detail, pluginId });
  }

  private consumeConfirm(token: string | undefined, action: string, target: string): void {
    if (this.confirm !== null) {
      this.confirm.consume(token, action, target);
      return;
    }
    if (token === undefined || token.length === 0) {
      throw new AnterosError(ERROR_CODES.ECONFIRM, "该操作需要 owner 二次确认（confirmToken）", {
        hint: "先在客户端调用 confirm.token 获取一次性 token",
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* 模块级工具                                                          */
/* ------------------------------------------------------------------ */

function toStringRecord(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
    else if (typeof item === "number" || typeof item === "boolean") out[key] = String(item);
  }
  return out;
}

function extractSchemaDefaults(schema: unknown): Record<string, unknown> {
  const properties = asRecord(asRecord(schema).properties);
  const defaults: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(properties)) {
    const property = asRecord(raw);
    if ("default" in property) defaults[key] = property.default;
  }
  return defaults;
}

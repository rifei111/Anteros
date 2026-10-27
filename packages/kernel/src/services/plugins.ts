/**
 * 插件服务装配层（宿主侧的对外门面）。
 *
 * 职责：
 *  - 扫描插件目录（PluginRegistry）并落 plugins 表；
 *  - 管理一次性密钥（SecretStore）与能力授权（GrantStore）；
 *  - 组装并持有 PluginHost（命名管道宿主），向 app / IPC 暴露 PluginHostPort；
 *  - 把宿主产生的事件转发给客户端（可附带 event.channels 快照）；
 *  - 提供 attachPorts()：由 chat / memory / channels 等服务在装配阶段接线内核侧端口。
 *
 * 内核不在此处实现任何具体通道逻辑，只按 manifest capabilities 分支。
 */
import path from "node:path";
import { AnterosError, ERROR_CODES } from "@anteros/shared";
import type { PluginInfo, PluginRuntimeStatus } from "@anteros/shared";
import type { KernelDeps, PluginHostPort } from "../contracts.js";
import { PluginHost, defaultCanEnable } from "../plugins/host.js";
import type { CallOptions } from "../plugins/host.js";
import { GrantStore } from "../plugins/grants.js";
import { PluginRegistry } from "../plugins/registry.js";
import { PluginRuntimeManager } from "../plugins/runtime.js";
import { SecretStore } from "../plugins/secrets.js";
import type {
  CanEnableFn,
  CanEnableResult,
  EmitFn,
  HostPorts,
  PluginDirInfo,
  PluginHostOptions,
} from "../plugins/types.js";
import { loadOrCreateMasterKey } from "../util/crypto.js";
import type { LogSink } from "../util/log.js";
import type { AuditService } from "./audit.js";
import type { ConsentService } from "./consent.js";
import { SettingsService } from "../settings.js";
import type { PermissionsService } from "./permissions.js";

/** PluginService 的构造选项。pluginsDir 由 app 传入（开发态默认 <repo>/plugins）。 */
export interface PluginServiceOptions {
  pluginsDir: string;
  /** 数据目录；缺省用 db 所在目录（内存库用 cwd）。 */
  dataDir?: string;
  /** 生产模式（拒绝 dev 插件）。缺省按 NODE_ENV 判断。 */
  production?: boolean;
  /** 仅供测试：覆盖宿主参数。 */
  hostOptions?: Partial<PluginHostOptions>;
}

/** 客户端事件推送函数：app 把 emit 挂到 IPC 广播上。 */
export type PluginEventListener = (method: string, params: unknown) => void;

function blocked(feature: string): AnterosError {
  return new AnterosError(ERROR_CODES.EBLOCKED, `内核尚未接线：${feature}`);
}

/** 给共享 LogSink 加前缀（KernelDeps.log 是进程级 sink，没有 child()）。 */
function prefixed(parent: LogSink, prefix: string): LogSink {
  return {
    debug: (message) => parent.debug(`${prefix}${message}`),
    info: (message) => parent.info(`${prefix}${message}`),
    warn: (message) => parent.warn(`${prefix}${message}`),
    error: (message) => parent.error(`${prefix}${message}`),
  };
}

function isChannelLike(capabilities: readonly string[]): boolean {
  return capabilities.some((capability) => capability.startsWith("channel."));
}

export class PluginService implements PluginHostPort {
  private readonly deps: KernelDeps;
  private readonly permissions: PermissionsService;
  private readonly audit: AuditService;
  private readonly consent: ConsentService;
  private readonly log: LogSink;

  private readonly registry: PluginRegistry;
  private readonly secrets: SecretStore;
  private readonly grants: GrantStore;
  private readonly host: PluginHost;
  /** 插件运行环境（下载/增量升级/卸载），见 plugins/runtime.ts */
  private readonly runtime: PluginRuntimeManager;
  private readonly ports: HostPorts;
  private readonly dataDirectory: string;
  private readonly options: PluginServiceOptions;

  private emitter: PluginEventListener | null = null;
  private channelsProvider: (() => unknown) | null = null;
  private overrides: Partial<HostPorts> = {};

  /** 宿主事件出口：转给客户端，并在插件状态变化时补一份通道快照。 */
  private readonly emit: EmitFn = (method, params) => {
    try {
      this.emitter?.(method, params);
    } catch (error) {
      this.log.warn(`转发插件事件失败（${method}）：${String(error)}`);
    }
    if ((method === "event.plugin" || method === "event.health") && this.channelsProvider) {
      try {
        this.emitter?.("event.channels", this.channelsProvider());
      } catch (error) {
        this.log.warn(`刷新通道快照失败：${String(error)}`);
      }
    }
  };

  constructor(
    deps: KernelDeps,
    permissions: PermissionsService,
    audit: AuditService,
    consent: ConsentService,
    options: PluginServiceOptions,
  ) {
    this.deps = deps;
    this.permissions = permissions;
    this.audit = audit;
    this.consent = consent;
    this.options = options;
    this.log = prefixed(deps.log, "[plugins] ");
    this.dataDirectory = options.dataDir ?? defaultDataDir(deps);

    this.registry = new PluginRegistry(deps.db, prefixed(deps.log, "[registry] "), {
      pluginsDir: options.pluginsDir,
      production: options.production ?? process.env.NODE_ENV === "production",
    });

    let masterKey: Buffer | null = null;
    try {
      masterKey = loadOrCreateMasterKey(this.dataDirectory);
    } catch (error) {
      this.log.warn(`主密钥不可用，插件密钥将无法读取：${String(error)}`);
    }
    this.secrets = new SecretStore(this.dataDirectory, {
      masterKey,
      log: prefixed(deps.log, "[secrets] "),
    });

    this.grants = new GrantStore(deps.db, (action, detail) => {
      this.audit.log(action, { actorRole: "owner", after: detail });
    });

    this.runtime = new PluginRuntimeManager({
      rootDir: path.join(this.dataDirectory, "plugin-runtime"),
      log: prefixed(deps.log, "[runtime] "),
      emit: (status) => this.emit("event.runtime", status),
      feedUrl:
        (typeof process.env.ANTEROS_PLUGIN_FEED === "string" && process.env.ANTEROS_PLUGIN_FEED.trim().length > 0
          ? process.env.ANTEROS_PLUGIN_FEED.trim()
          : new SettingsService(deps.db).getJson<string>("plugins.feedUrl", "")),
    });

    // 首次装配即扫描插件目录：把 manifest 结果落库（幂等，不覆盖用户配置）。
    try {
      const scan = this.registry.scan();
      if (scan.invalid.length > 0) {
        this.log.warn(`发现 ${scan.invalid.length} 个无效插件：${scan.invalid.map((item) => item.id).join(", ")}`);
      }
      if (scan.missing.length > 0) {
        this.log.warn(`磁盘上已不存在的插件记录：${scan.missing.join(", ")}`);
      }
    } catch (error) {
      this.log.error(`扫描插件目录失败：${String(error)}`);
    }

    this.ports = {
      memory: {
        search: (input) => {
          const port = this.overrides.memory;
          if (!port) throw blocked("记忆检索");
          return port.search(input);
        },
        remember: (input) => {
          const port = this.overrides.memory;
          if (!port) throw blocked("记忆写入");
          return port.remember(input);
        },
      },
      context: {
        assemble: (input) => {
          const port = this.overrides.context;
          if (!port) throw blocked("上下文装配");
          return port.assemble(input);
        },
      },
      outbox: {
        send: (input) => {
          const port = this.overrides.outbox;
          if (!port) throw blocked("出站发送");
          return port.send(input);
        },
      },
      inbox: {
        next: (input) => {
          const port = this.overrides.inbox;
          if (!port) throw blocked("收件箱读取");
          return port.next(input);
        },
      },
      consent: {
        check: () => {
          const status = this.consent.status("app");
          return { ok: status.accepted, consentVersion: status.docVersion };
        },
      },
      audit: {
        log: (input) => {
          this.audit.log(input.action, {
            actorRole: "system",
            targetAgentId: this.deps.agentId,
            after: { pluginId: input.pluginId, detail: input.detail },
          });
        },
      },
      metrics: {
        emit: (input) => {
          const tags = input.tags ? ` tags=${JSON.stringify(input.tags)}` : "";
          prefixed(this.deps.log, "[plugin-metrics] ").debug(
            `${input.pluginId} ${input.name}=${input.value}${tags}`,
          );
        },
      },
    };

    this.host = new PluginHost({
      deps,
      registry: this.registry,
      secrets: this.secrets,
      grants: this.grants,
      ports: this.ports,
      emit: this.emit,
      log: prefixed(deps.log, "[plugin-host] "),
      canEnable: this.canEnable,
      confirm: {
        consume: (token, action, target) => {
          this.permissions.consumeConfirm(token, action, target);
        },
      },
      options: {
        pluginsDir: options.pluginsDir,
        dataDir: this.dataDirectory,
        production: options.production ?? process.env.NODE_ENV === "production",
        grantOnEnable: true,
        requireHighRiskConfirm: true,
        crashBackoffMs: [1000, 5000, 30000],
        ...options.hostOptions,
      },
    });
  }

  // ── PluginHostPort ───────────────────────────────────────────────

  list(): PluginInfo[] {
    return this.host.list();
  }

  async enable(pluginId: string, confirmToken?: string): Promise<PluginInfo> {
    this.permissions.assertOwner("plugin.enable");
    this.consent.requireConsent();
    return this.host.enable(pluginId, confirmToken);
  }

  async disable(pluginId: string): Promise<PluginInfo> {
    this.permissions.assertOwner("plugin.disable");
    return this.host.disable(pluginId);
  }

  async restart(pluginId: string): Promise<PluginInfo> {
    this.permissions.assertOwner("plugin.restart");
    return this.host.restart(pluginId);
  }

  grant(pluginId: string, permissions: string[], confirmToken?: string): PluginInfo {
    this.permissions.assertOwner("plugin.grant");
    return this.host.grant(pluginId, permissions, confirmToken);
  }

  setConfig(pluginId: string, config: Record<string, unknown>): PluginInfo {
    this.permissions.assertOwner("plugin.config");
    return this.host.setConfig(pluginId, config);
  }

  secret(pluginId: string, name: string): string | null {
    return this.host.secret(pluginId, name);
  }

  setSecret(pluginId: string, name: string, value: string): PluginInfo {
    this.permissions.assertOwner("plugin.secret");
    this.host.setSecret(pluginId, name, value);
    this.audit.log("plugin.secret.put", {
      actorRole: "owner",
      after: { pluginId, name, length: value.trim().length },
    });
    return this.requireInfo(pluginId);
  }

  deleteSecret(pluginId: string, name: string): PluginInfo {
    this.permissions.assertOwner("plugin.secret");
    this.host.deleteSecret(pluginId, name);
    this.audit.log("plugin.secret.delete", {
      actorRole: "owner",
      after: { pluginId, name },
    });
    return this.requireInfo(pluginId);
  }

  /* --------------------------- 插件运行环境 --------------------------- */

  /** 读 / 写更新源（写要 owner + 审计；只记 URL，不记内容）。 */
  runtimeFeed(url?: string): { url: string } {
    if (typeof url !== "string") return { url: this.runtime.getFeedUrl() };
    this.permissions.assertOwner("plugin.runtime.feed");
    const next = this.runtime.setFeedUrl(url);
    new SettingsService(this.deps.db).setJson("plugins.feedUrl", next);
    this.audit.log("plugin.runtime.feed", { actorRole: "owner", after: { url: next } });
    return { url: next };
  }

  runtimeStatus(pluginId: string): PluginRuntimeStatus {
    this.requireInfo(pluginId);
    return this.runtime.status(pluginId);
  }

  async runtimeCheck(pluginId: string): Promise<PluginRuntimeStatus> {
    this.requireInfo(pluginId);
    this.permissions.assertOwner("plugin.runtime.check");
    const status = await this.runtime.check(pluginId);
    this.audit.log("plugin.runtime.check", {
      actorRole: "owner",
      after: { pluginId, available: status.available?.version ?? null },
    });
    return status;
  }

  /** 下载并安装/升级运行环境；装完把路径写进插件配置（插件自己决定怎么用）。 */
  async runtimeInstall(pluginId: string): Promise<PluginRuntimeStatus> {
    this.requireInfo(pluginId);
    this.permissions.assertOwner("plugin.runtime.install");
    await this.consent.requireConsent();
    const status = await this.runtime.install(pluginId);
    this.audit.log("plugin.runtime.install", {
      actorRole: "owner",
      after: {
        pluginId,
        version: status.installed?.version ?? null,
        mode: status.installed?.mode ?? null,
        fileCount: status.installed?.fileCount ?? 0,
      },
    });
    this.syncRuntimeIntoConfig(pluginId, status);
    return status;
  }

  async runtimeUninstall(pluginId: string): Promise<PluginRuntimeStatus> {
    this.requireInfo(pluginId);
    this.permissions.assertOwner("plugin.runtime.uninstall");
    const status = await this.runtime.uninstall(pluginId);
    this.audit.log("plugin.runtime.uninstall", { actorRole: "owner", after: { pluginId } });
    this.syncRuntimeIntoConfig(pluginId, status);
    return status;
  }

  /** 把「有没有装运行环境、装在哪、什么版本」写进插件配置，插件通过 kernel.config.get 就能读到。 */
  private syncRuntimeIntoConfig(pluginId: string, status: PluginRuntimeStatus): void {
    try {
      const info = this.requireInfo(pluginId);
      const config: Record<string, unknown> = { ...info.config };
      if (status.installed === null) {
        delete config.runtimePath;
        delete config.runtimeVersion;
      } else {
        config.runtimePath = status.installed.path;
        config.runtimeVersion = status.installed.version;
        config.runtimeMode = status.installed.mode;
      }
      this.host.setConfig(pluginId, config);
    } catch (error) {
      this.log.warn(`把运行环境写进插件配置失败：${pluginId}：${String(error)}`);
    }
  }

  private requireInfo(pluginId: string): PluginInfo {
    const found = this.list().find((item) => item.id === pluginId);
    if (found === undefined) throw new AnterosError(ERROR_CODES.ENOTFOUND, `找不到插件：${pluginId}`);
    return found;
  }

  async shutdown(): Promise<void> {
    await this.host.shutdown();
  }

  async panicStop(): Promise<{ stopped: string[]; restored: boolean; message: string }> {
    return this.host.panicStop();
  }

  // ── 装配与内部接线 ───────────────────────────────────────────────

  /** 启动所有 enabled=1 的插件（应在 app 初始化最后调用）。 */
  async start(): Promise<void> {
    await this.host.ensureStarted();
  }

  /** 重新扫描插件目录（安装/卸载插件后调用）。 */
  rescan(): PluginInfo[] {
    this.registry.scan();
    return this.list();
  }

  /** 转发内核→插件调用（通道服务用它发消息、读水位）。 */
  call(pluginId: string, method: string, params: unknown, opts?: CallOptions): Promise<unknown> {
    return this.host.call(pluginId, method, params, opts);
  }

  /** app 在 attachEmitter 阶段挂上客户端推送。 */
  attachEvents(handler: PluginEventListener): void {
    this.emitter = handler;
  }

  /** 把客户端事件直接推出去（通道服务上报 event.message / event.notify 用）。 */
  emitEvent(method: string, params: unknown): void {
    this.emit(method, params);
  }

  /**
   * 接线内核侧端口：memory/context 由 chat 层提供，outbox/inbox 由 ChannelService 提供。
   * 未接线的端口会抛 EBLOCKED，而不是静默成功（避免插件误以为一切正常）。
   */
  attachPorts(partial: Partial<HostPorts>): void {
    this.overrides = { ...this.overrides, ...partial };
  }

  /** ChannelService 构造时注册，用于在插件状态变化时推送 event.channels。 */
  attachChannelsProvider(provider: () => unknown): void {
    this.channelsProvider = provider;
  }

  get pluginsDir(): string {
    return this.options.pluginsDir;
  }

  get dataDir(): string {
    return this.dataDirectory;
  }

  get registryView(): PluginRegistry {
    return this.registry;
  }

  /** 当前磁盘上的有效插件（含 manifest 与 issues），供调试/客户端展示。 */
  pluginDirs(): PluginDirInfo[] {
    return this.registry.list();
  }

  // ── 启停闸门 ─────────────────────────────────────────────────────

  private readonly canEnable: CanEnableFn = (
    manifest,
    context,
  ): CanEnableResult => {
    // 通道类插件涉及对外发送：必须已过声明闸。
    if (manifest.kind === "channel" || isChannelLike(manifest.capabilities)) {
      if (!context.consent.ok) {
        return {
          ok: false,
          code: ERROR_CODES.ECONSENT,
          reason: "需要先阅读并逐条同意《用户声明与风险告知》后才能启用通道插件",
        };
      }
    }
    return defaultCanEnable(manifest, context);
  };
}

function defaultDataDir(deps: KernelDeps): string {
  const dbPath = deps.db.path;
  if (!dbPath || dbPath === ":memory:") return process.cwd();
  return path.dirname(path.resolve(dbPath));
}

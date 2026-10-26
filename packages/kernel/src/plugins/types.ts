/**
 * 插件宿主内部类型：宿主所需端口（ports）、启用闸、运行时状态。
 *
 * 设计原则：宿主不直接依赖 memory / expression / chat 等"脑子"模块，
 * 只通过 HostPorts 注入回调；这样 SDK 契约测试可以在没有 LLM 的临时目录里跑。
 */
import type {
  ChatMessage,
  ErrorCode,
  Importance,
  MemorySearchResult,
  ParsedPluginManifest,
} from "@anteros/shared";
import type { LogSink } from "../util/log.js";

/** 内核 → 客户端事件推送（event.plugin / event.health / event.channels / event.notify / event.log...）。 */
export type EmitFn = (method: string, params: unknown) => void;

/** 审计落账（默认由 AuditService 实现；测试注入 spy）。 */
export type AuditFn = (action: string, detail: Record<string, unknown>) => void;

/** 插件 → 内核：记忆检索。 */
export interface MemoryHostPort {
  search(input: { query: string; topK?: number; pluginId: string }): MemorySearchResult | Promise<MemorySearchResult>;
  remember(input: {
    kind: "episodic" | "semantic" | "open_loop";
    content: string;
    importance?: Importance;
    slotKey?: string;
    pluginId: string;
  }): number | Promise<number>;
}

/** 插件 → 内核：按意图装配上下文（插件拿不到原始记忆全文，只拿装配块）。 */
export interface ContextHostPort {
  assemble(input: { intent: string; pluginId: string }): string | Promise<string>;
}

/** 插件 → 内核：把发送请求交给内核 outbox（插件不拥有通道状态）。 */
export interface OutboxHostPort {
  send(input: {
    channelId: string;
    target: string;
    parts: string[];
    deadlineTs: number;
    pluginId: string;
  }): { outboxId: number; status: "queued" | "blocked" } | Promise<{ outboxId: number; status: "queued" | "blocked" }>;
}

/** 插件 → 内核：读 App 内入站（只读，写仍回 outbox）。 */
export interface InboxHostPort {
  next(input: { channelId: string; limit: number; pluginId: string }): ChatMessage[] | Promise<ChatMessage[]>;
}

export interface ConsentHostPort {
  check(): { ok: boolean; consentVersion: string | null } | Promise<{ ok: boolean; consentVersion: string | null }>;
}

export interface AuditHostPort {
  log(input: { action: string; detail: Record<string, unknown>; pluginId: string }): void | Promise<void>;
}

export interface MetricsHostPort {
  emit(input: { name: string; value: number; tags?: Record<string, string>; pluginId: string }): void | Promise<void>;
}

/** 宿主需要的全部回调。未接线的端口会以 EBLOCKED 返回，而不是静默成功。 */
export interface HostPorts {
  memory: MemoryHostPort;
  context: ContextHostPort;
  outbox: OutboxHostPort;
  inbox: InboxHostPort;
  consent: ConsentHostPort;
  audit: AuditHostPort;
  metrics: MetricsHostPort;
}

/** 启用闸的输入：宿主已经算好授权/密钥/声明闸状态，策略由上层注入。 */
export interface CanEnableContext {
  grants: string[];
  missingSecrets: string[];
  consent: { ok: boolean; consentVersion: string | null };
}

export type CanEnableResult = { ok: true } | { ok: false; code: ErrorCode; reason: string };

export type CanEnableFn = (
  manifest: ParsedPluginManifest,
  context: CanEnableContext,
) => CanEnableResult | Promise<CanEnableResult>;

/** 注册表扫描出来的一条可用插件。 */
export interface PluginDirInfo {
  manifest: ParsedPluginManifest;
  /** 插件根目录绝对路径 */
  dir: string;
  /** 入口脚本绝对路径（entry.command 是相对路径或绝对路径） */
  entryPath: string;
  /** 非致命问题（warnings + 运行期补充），人类可读 */
  issues: string[];
}

/** 扫描失败但需要展示给用户的一类问题（manifest 坏了也要能看见）。 */
export interface InvalidPluginInfo {
  id: string;
  dir: string;
  issues: string[];
}

/** owner-only 二次确认（默认接 PermissionsService.consumeConfirm）。 */
export interface ConfirmPort {
  consume(token: string | undefined, action: string, target?: string): void;
}

export interface PluginHostOptions {
  pluginsDir: string;
  /** 用户数据目录（插件私有数据目录在 dataDir/plugins/<id>）；缺省取数据库所在目录。 */
  dataDir?: string;
  /** 生产构建拒绝 dev 插件 */
  production?: boolean;
  /** 握手超时（默认 10s） */
  handshakeTimeoutMs?: number;
  /** 停用等待在途调用的上限（默认 5s） */
  disableGraceMs?: number;
  /** 心跳超时（默认 30s，超时 ×2 判 degraded） */
  heartbeatMs?: number;
  /** 体检轮询默认间隔（manifest 未声明 healthcheck 时） */
  healthIntervalMs?: number;
  /** 崩溃后是否自动重启（默认 true） */
  autoRestart?: boolean;
  /** 崩溃退避序列（默认 [1000, 5000, 30000]），连续 3 次重启失败后 disabled。 */
  crashBackoffMs?: readonly number[];
  /** 启用时自动授予 manifest 声明的能力（用户点「启用」= 同意其声明能力；默认 false，装配层开 true）。 */
  grantOnEnable?: boolean;
  /** high 风险插件启用必须带 confirm token（默认 true）。 */
  requireHighRiskConfirm?: boolean;
  /** 会话 id（命名管道的一部分），缺省随机。 */
  sessionId?: string;
}

export interface HostDepsBundle {
  deps: import("../contracts.js").KernelDeps;
  registry: import("./registry.js").PluginRegistry;
  secrets: import("./secrets.js").SecretStore;
  grants?: import("./grants.js").GrantStore;
  ports: HostPorts;
  emit: EmitFn;
  log: LogSink;
  /** 启用闸策略（缺省：声明闸 + 密钥齐全 + 写能力需租约授权）。 */
  canEnable?: CanEnableFn;
  /** owner 二次确认；缺省时 high 风险启用若带 token 则直接信任（由上层 IPC 校验）。 */
  confirm?: ConfirmPort;
  options?: Partial<PluginHostOptions>;
}

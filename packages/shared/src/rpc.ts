/**
 * JSON-RPC 2.0 协议定义（规范 6 §5）。
 *
 * 三条链路共用同一套信封，区别只在身份与授权：
 * 1. Windows 客户端 → 内核：`KernelApi`（本机 UI 的读写入口）
 * 2. 内核 → 插件：`PluginApi`（内核调用插件能力，受超时与权限约束）
 * 3. 插件 → 内核：`PluginHostApi`（插件申请状态变更，默认拒绝）
 *
 * 所有方法都带类型化的 params/result，避免内核、客户端、插件三处各写一份字符串。
 */
import type { RpcErrorObject } from "./errors.js";
import type {
  ActionItem,
  ActionState,
  AgentMode,
  AppSnapshot,
  AuditEntry,
  ChannelInfo,
  ChatMessage,
  ConsentStatus,
  CostSummary,
  DriveState,
  HandshakeResult,
  Importance,
  LlmProbeResult,
  LlmStatus,
  MemoryItem,
  MemoryKind,
  MemorySearchResult,
  OwnerStatus,
  Persona,
  PersonaBlueprint,
  PersonaCompileResult,
  PluginInfo,
  PluginStatus,
  RelationState,
  SystemHealth,
  TurnReplay,
  WorldState,
} from "./domain.js";

export interface RpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface RpcSuccess {
  jsonrpc: "2.0";
  id: string | number;
  result: unknown;
}

export interface RpcFailure {
  jsonrpc: "2.0";
  id: string | number;
  error: RpcErrorObject;
}

export type RpcResponse = RpcSuccess | RpcFailure;
export type RpcIncoming = RpcRequest | RpcNotification;

export interface MethodSpec<P = unknown, R = unknown> {
  params: P;
  result: R;
}

export type Ack = { ack: true };

/* ------------------------------------------------------------------ */
/* 1. Windows 客户端 → 内核                                             */
/* ------------------------------------------------------------------ */

export interface KernelApi {
  "client.handshake": MethodSpec<
    { appVersion: string; platform?: string },
    HandshakeResult & { needsConsent: boolean }
  >;
  "state.snapshot": MethodSpec<Record<string, never>, AppSnapshot>;

  "chat.history": MethodSpec<
    { limit?: number; beforeTs?: number },
    { messages: ChatMessage[]; hasMore: boolean }
  >;
  /** 上行只带 is_typing 布尔值，禁止上报草稿文本（规范 1 §4.1 隐私约束）。 */
  "chat.send": MethodSpec<
    {
      text: string;
      /** 幂等键，内核 7 天内去重（规范 1 §5.1） */
      eventId: string;
      clientTs: number;
      presence?: { isTyping?: boolean; appFocused?: boolean; lastInteractionMs?: number };
    },
    { turnId: number; userMessage: ChatMessage; accepted: boolean }
  >;
  "chat.typing": MethodSpec<{ isTyping: boolean }, Ack>;
  "chat.markRead": MethodSpec<{ lastTs: number }, Ack>;

  "memory.search": MethodSpec<{ query: string; topK?: number }, MemorySearchResult>;
  "memory.list": MethodSpec<
    { kind?: MemoryKind; importance?: Importance; limit?: number; offset?: number },
    { items: MemoryItem[]; total: number }
  >;
  "memory.get": MethodSpec<{ id: number }, { item: MemoryItem | null }>;
  "memory.delete": MethodSpec<{ id: number }, { deleted: boolean }>;
  "memory.deleteAll": MethodSpec<{ confirmToken: string }, { deleted: number }>;
  "memory.stats": MethodSpec<
    Record<string, never>,
    { episodic: number; semantic: number; openLoops: number; persona: number; pinned: number; total: number }
  >;
  "memory.export": MethodSpec<Record<string, never>, { path: string; bytes: number }>;

  "consent.status": MethodSpec<Record<string, never>, ConsentStatus>;
  "consent.accept": MethodSpec<
    { docVersion: string; checkedIds: string[]; channel?: string },
    ConsentStatus
  >;
  "consent.revoke": MethodSpec<Record<string, never>, ConsentStatus>;

  "persona.get": MethodSpec<Record<string, never>, Persona>;
  "persona.update": MethodSpec<{ patch: Partial<Persona> }, Persona>;
  "persona.presets": MethodSpec<Record<string, never>, { presets: PersonaPreset[] }>;
  "persona.applyPreset": MethodSpec<{ presetId: string }, Persona>;
  /** 用一段人设文本编译人格内核（规则引擎优先，配了模型就让模型推导）。 */
  "persona.compile": MethodSpec<{ text: string }, PersonaCompileResult>;
  /** 把编译结果（用户可微调过）落库；等价于一次 owner 显式编辑人格。 */
  "persona.applyBlueprint": MethodSpec<{ blueprint: PersonaBlueprint }, Persona>;

  "relation.get": MethodSpec<Record<string, never>, RelationState>;
  /** 完全体模式：owner 专属 + 二次确认 token（草案 2.8）。 */
  "relation.setMode": MethodSpec<{ mode: AgentMode; confirmToken: string }, RelationState>;
  "relation.ledger": MethodSpec<
    { limit?: number },
    { entries: Array<{ id: number; ts: number; situation: string; chosen: string; givenUp: string; userReaction: string | null }> }
  >;

  "owner.status": MethodSpec<Record<string, never>, OwnerStatus>;
  /** 危险操作二次确认：60 秒有效、一次性（规范 1 §2.9）。 */
  "confirm.token": MethodSpec<{ action: string; target?: string }, { token: string; expiresTs: number }>;

  "plugins.list": MethodSpec<Record<string, never>, PluginInfo[]>;
  "plugins.enable": MethodSpec<{ id: string; confirmToken?: string }, PluginInfo>;
  "plugins.disable": MethodSpec<{ id: string }, PluginInfo>;
  "plugins.grant": MethodSpec<{ id: string; permissions: string[]; confirmToken?: string }, PluginInfo>;
  "plugins.config.put": MethodSpec<{ id: string; config: Record<string, unknown> }, PluginInfo>;
  /** 录入或清除插件声明要的密钥（值只进 DPAPI/AES 落盘的密钥库，不回显）。 */
  "plugins.secret.put": MethodSpec<{ id: string; name: string; value: string }, PluginInfo>;
  "plugins.secret.delete": MethodSpec<{ id: string; name: string }, PluginInfo>;
  "plugins.restart": MethodSpec<{ id: string }, PluginInfo>;

  "channels.list": MethodSpec<Record<string, never>, ChannelInfo[]>;
  /** 一键停用：停掉所有通道并还原宿主状态（草案 14.6 ⑦）。 */
  "channels.panicStop": MethodSpec<{ confirmToken?: string }, { stopped: string[]; restored: boolean; message: string }>;

  "world.state": MethodSpec<Record<string, never>, WorldState>;
  "drives.state": MethodSpec<Record<string, never>, DriveState>;
  "proactive.list": MethodSpec<Record<string, never>, { pending: ActionItem[]; recent: ActionItem[] }>;
  "proactive.setFrequency": MethodSpec<{ level: "off" | "low" | "normal" | "high" }, { level: string }>;

  "turns.list": MethodSpec<
    { limit?: number },
    { turns: Array<{ id: number; ts: number; trigger: string; outcome: string | null }> }
  >;
  /** "它为什么这么说"：还原当时的装配输入（规范 1 §5.3 验收）。 */
  "turn.replay": MethodSpec<{ turnId: number }, TurnReplay>;

  "cost.summary": MethodSpec<Record<string, never>, CostSummary>;
  "cost.setBudget": MethodSpec<{ monthlyCny: number }, CostSummary>;
  "llm.status": MethodSpec<Record<string, never>, LlmStatus>;
  /** 真的发一次请求量延迟：先 GET /models，不通再发一次 1 token 的对话。不写任何配置。 */
  "llm.test": MethodSpec<
    {
      baseUrl?: string;
      /** 留空则用已保存的密钥 */
      apiKey?: string;
      model?: string;
    },
    LlmProbeResult
  >;
  "llm.configure": MethodSpec<
    {
      providerId?: string;
      baseUrl: string;
      model: string;
      /** 只写不读：回传时永远是 null（密钥不出内核） */
      apiKey?: string;
      temperature?: number;
      maxTokens?: number;
      /** 是否顺手把同一份配置写进 core.llm-router 的插件配置（默认 true） */
      syncPlugin?: boolean;
    },
    { status: LlmStatus }
  >;

  "audit.list": MethodSpec<{ limit?: number; beforeId?: number }, AuditEntry[]>;
  "narrative.get": MethodSpec<
    Record<string, never>,
    { slots: Array<{ slotKey: string; value: unknown; prose: string | null; updatedTs: number }> }
  >;

  "system.health": MethodSpec<Record<string, never>, SystemHealth>;
  /** 全局停止：停通道、暂停主动、保留只读 UI（一键停用）。 */
  "system.panic": MethodSpec<Record<string, never>, { ok: boolean; message: string; disabledPlugins: string[] }>;
  "system.dataDir": MethodSpec<Record<string, never>, { path: string; dbPath: string }>;
  "system.shutdown": MethodSpec<Record<string, never>, { ok: true }>;
  "export.bundle": MethodSpec<Record<string, never>, { path: string; bytes: number }>;
  "import.bundle": MethodSpec<{ path: string }, { imported: number; message: string }>;
}

export interface PersonaPreset {
  id: string;
  name: string;
  summary: string;
  persona: Omit<Persona, "id" | "birthTs">;
}

/* ------------------------------------------------------------------ */
/* 2. 内核 → 插件                                                      */
/* ------------------------------------------------------------------ */

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmGenerateParams {
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 要求返回 JSON（抽取/分类用） */
  json?: boolean;
  purpose?: "reply" | "proactive" | "extract" | "world" | "narrative";
}

export interface LlmGenerateResult {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ExtractedMemoryCandidate {
  text: string;
  kind: "episodic" | "semantic" | "open_loop";
  slotKey?: string;
  value?: unknown;
  importance: Importance;
  entities: string[];
  emotion?: { v: number; a: number };
  confidence: number;
}

export interface WorldInfoItem {
  title: string;
  summary: string;
  sourceUrl?: string;
  fetchedTs: number;
}

export interface ChannelInboundMessage {
  msgId: string;
  /** 通道侧的会话标识（关系绑定由内核完成，插件不认自己是谁） */
  target: string;
  senderName: string;
  text: string;
  ts: number;
  direction: "in" | "out";
  /** 群消息才有 */
  senderNameInGroup?: string;
}

export interface PluginApi {
  "plugin.describe": MethodSpec<Record<string, never>, { id: string; capabilities: string[] }>;
  "plugin.health.check": MethodSpec<Record<string, never>, { ok: boolean; status: "ok" | "degraded" | "blocked"; message: string }>;
  "plugin.llm.generate": MethodSpec<LlmGenerateParams, LlmGenerateResult>;
  "plugin.extract.memory": MethodSpec<
    { texts: Array<{ id: number; text: string; ts: number }> },
    { candidates: ExtractedMemoryCandidate[] }
  >;
  "plugin.world.info": MethodSpec<
    { kind: "time" | "weather" | "news"; query?: string },
    { items: WorldInfoItem[]; degraded?: boolean; detail?: string }
  >;
  "plugin.channel.read_since": MethodSpec<
    { sinceTs: number; limit: number },
    { messages: ChannelInboundMessage[]; hasMore: boolean; waterline: number }
  >;
  "plugin.channel.send": MethodSpec<
    { outboxId: number; target: string; text: string; deadlineTs: number },
    { status: "sent" | "unknown" | "failed"; remoteMsgId?: string; detail?: string }
  >;
  "plugin.channel.download_media": MethodSpec<
    { msgId: string; outDir: string },
    { path: string; mimeType: string }
  >;
  "plugin.channel.lease.begin": MethodSpec<
    { reason: string; timeoutMs: number },
    { granted: boolean; leaseId?: string; untilTs?: number }
  >;
  "plugin.channel.lease.end": MethodSpec<{ leaseId: string }, { released: boolean }>;
  "plugin.channel.disable_and_restore": MethodSpec<Record<string, never>, { restored: boolean; detail: string }>;
  "plugin.ui.panel.render": MethodSpec<{ panelId: string }, { title: string; blocks: Array<Record<string, unknown>> }>;
  "plugin.notify.send": MethodSpec<{ title: string; body: string }, { delivered: boolean }>;
}

/* ------------------------------------------------------------------ */
/* 3. 插件 → 内核                                                      */
/* ------------------------------------------------------------------ */

export interface PluginHostApi {
  "plugin.handshake": MethodSpec<
    { pluginId: string; kernelApi: string; capabilities: string[] },
    { kernelApi: string; sessionId: string; grants: string[] }
  >;
  "plugin.heartbeat": MethodSpec<{ status: PluginStatus; metrics?: Record<string, number> }, Ack>;
  "kernel.config.get": MethodSpec<{ keys?: string[] }, { config: Record<string, unknown> }>;
  "kernel.memory.search": MethodSpec<{ query: string; topK?: number }, MemorySearchResult>;
  "kernel.memory.remember": MethodSpec<
    { kind: "episodic" | "semantic" | "open_loop"; content: string; importance?: Importance; slotKey?: string },
    { extractionId: number }
  >;
  "kernel.context.assemble": MethodSpec<{ intent: string }, { contextBlock: string }>;
  "kernel.outbox.send": MethodSpec<
    { channelId: string; target: string; parts: string[]; deadlineTs: number },
    { outboxId: number; status: "queued" | "blocked" }
  >;
  "kernel.inbox.next": MethodSpec<{ channelId: string; limit: number }, { messages: ChatMessage[] }>;
  "kernel.audit.log": MethodSpec<{ action: string; detail: Record<string, unknown> }, Ack>;
  "kernel.metrics.emit": MethodSpec<{ name: string; value: number; tags?: Record<string, string> }, Ack>;
  "kernel.consent.check": MethodSpec<Record<string, never>, { ok: boolean; consentVersion: string | null }>;
}

/* ------------------------------------------------------------------ */
/* 4. 内核 → 客户端事件                                                */
/* ------------------------------------------------------------------ */

export interface KernelEvents {
  "event.message": ChatMessage;
  "event.part": { turnId: number; index: number; total: number; text: string; delayAfterMs: number; typingMs: number };
  "event.typing": { state: "start" | "stop"; plannedMs?: number; plannedChars?: number };
  "event.recall": { messageId: number; replacement: string };
  "event.presence": WorldState;
  "event.drives": DriveState;
  "event.relation": RelationState;
  "event.plugin": PluginInfo;
  "event.channels": ChannelInfo[];
  "event.consent": ConsentStatus;
  "event.cost": CostSummary;
  "event.health": { degraded: Array<{ pluginId: string; reason: string }> };
  "event.proactive": { actionId: number; state: ActionState; reason: string };
  "event.turn": { turnId: number; outcome: string };
  "event.notify": { channelId: string; title: string; body: string };
  "event.log": { level: "debug" | "info" | "warn" | "error"; source: string; message: string; ts: number };
}

/** 类型化调用辅助：客户端 IPC 层用它把方法名与参数绑在一起。 */
export type KernelMethod = keyof KernelApi;
export type KernelParams<M extends KernelMethod> = KernelApi[M]["params"];
export type KernelResult<M extends KernelMethod> = KernelApi[M]["result"];

export type PluginMethod = keyof PluginApi;
export type PluginParams<M extends PluginMethod> = PluginApi[M]["params"];
export type PluginResult<M extends PluginMethod> = PluginApi[M]["result"];

export type PluginHostMethod = keyof PluginHostApi;
export type PluginHostParams<M extends PluginHostMethod> = PluginHostApi[M]["params"];
export type PluginHostResult<M extends PluginHostMethod> = PluginHostApi[M]["result"];

export type KernelEventName = keyof KernelEvents;

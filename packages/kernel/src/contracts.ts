/**
 * 内核内部端口（port）：把"脑子"和"服务"解耦，便于并行实现与单元测试。
 *
 * 依赖方向固定为：
 *   services（写得进库、发得出消息） → ports（脑子的行为）
 * 反向依赖被禁止：memory/mind/expression 不得直接 import services。
 */
import type {
  ActionItem,
  AgentMode,
  ChatMessage,
  DriveState,
  Importance,
  MemoryItem,
  MemoryKind,
  MemorySearchResult,
  MessageAttachment,
  Persona,
  PersonaBlueprint,
  PresenceState,
  RelationStage,
  RelationState,
  VoiceOption,
  WorldState,
} from "@anteros/shared";
import type { Db } from "./db/database.js";
import type { LogSink } from "./util/log.js";

export interface KernelDeps {
  db: Db;
  log: LogSink;
  /** 本机用户/agent 固定单实例（单机闭环：一个用户一个 agent） */
  userId: number;
  agentId: number;
  tz: string;
}

/** 抽取候选：规则管线 / 小模型 / LLM 三条路统一产出这个结构。 */
export interface MemoryCandidate {
  text: string;
  kind: "episodic" | "semantic" | "open_loop";
  slotKey?: string;
  value?: unknown;
  importance: Importance;
  entities: string[];
  emotion?: { v: number; a: number };
  confidence: number;
}

export interface RecallQuery {
  agentId: number;
  text: string;
  now: number;
  /** 情绪一致性加权用的当前情绪 */
  mood?: { v: number; a: number };
  topK?: number;
  /** 只召回这条对话线上的记忆；不传等于 app 主会话 */
  channelId?: string;
}

export interface MindPort {
  getPersona(): Persona;
  updatePersona(patch: Partial<Persona>): Persona;
  listPresets(): Array<{ id: string; name: string; summary: string; persona: Omit<Persona, "id" | "birthTs"> }>;
  applyPreset(presetId: string): Persona;
  /** 人设文本 → 人格内核草稿：规则引擎或模型推导，结果按草案区间钳住。 */
  compileBlueprint(text: string): Promise<{
    blueprint: PersonaBlueprint;
    usage: { model: string; inputTokens: number; outputTokens: number } | null;
  }>;
  /** 把用户确认过（可能微调过）的草稿落库。 */
  applyBlueprint(blueprint: PersonaBlueprint): Persona;

  /** 关系：intimacy 只允许由事件累加（规范 1 §3.3） */
  getRelation(): RelationState;
  observeUserTurn(text: string, now: number): RelationState;
  observeAgentTurn(text: string, now: number): RelationState;
  setMode(mode: AgentMode): RelationState;
  /** 阶段真的迁移时回调（用于把新阶段推给界面；不注册就只在下次拉快照时才更新）。 */
  setRelationChangeHandler(handler: ((relation: RelationState) => void) | null): void;

  /** 世界时钟 */
  getWorld(now: number): WorldState;
  tickWorld(now: number): WorldState;
  getPresence(now: number): PresenceState;
  touchPresence(state: PresenceState, source: "behavior" | "calendar" | "default"): void;

  /** 动机层 */
  getDrives(): DriveState;
  tickDrives(now: number): DriveState;

  /** 叙事层：结构化槽位（确定性投影）+ prose（LLM 只写这个） */
  getNarrative(): Array<{ slotKey: string; value: unknown; prose: string | null; updatedTs: number }>;
  refreshNarrative(now: number): void;

  /** 主动动作候补：四类理由 + 无理由冲动（草案 5.4） */
  candidateActions(now: number): ActionItem[];
}

export interface MemoryPort {
  recall(query: RecallQuery): MemorySearchResult;
  rememberEpisode(input: {
    agentId: number;
    /** 记忆挂在哪条对话线上（默认 app 主会话）：不同的人/群分开记 */
    channelId?: string;
    text: string;
    now: number;
    importance?: Importance;
    entities?: string[];
    emotion?: { v: number; a: number };
    source?: "user_said" | "it_did" | "world" | "inference";
    sourceRef?: unknown;
    layer?: "detail" | "fact";
    confidence?: number;
  }): number;
  upsertSemantic(input: {
    agentId: number;
    slotKey: string;
    value: unknown;
    confidence: number;
    importance?: Importance;
    evidence?: unknown;
    now: number;
  }): number;
  openLoop(input: { agentId: number; topic: string; now: number; urgency?: number; sourceRef?: number }): number;
  closeLoop(agentId: number, loopId: number, now: number): void;
  touchOpenLoops(agentId: number, now: number): number;

  /** 抽取管线：规则 → （可选插件）→ 内联 LLM；返回落库条数 */
  extract(
    agentId: number,
    texts: Array<{ id: number; text: string; ts: number }>,
    now: number,
    channelId?: string,
  ): Promise<number>;

  list(input: { agentId: number; kind?: MemoryKind; importance?: Importance; limit: number; offset: number }): { items: MemoryItem[]; total: number };
  get(agentId: number, id: number): MemoryItem | null;
  softDelete(agentId: number, id: number, now: number): boolean;
  deleteAll(agentId: number, now: number): number;
  stats(agentId: number): { episodic: number; semantic: number; openLoops: number; persona: number; pinned: number; total: number };
  pinnedEvidence(agentId: number, now: number): MemoryItem[];
  /** 召回后按当前 mood 重构再编码（草案 1.4，ρ 由 traits 决定） */
  reencode(agentId: number, itemId: number, mood: { v: number; a: number }, now: number): void;
}

/** LLM 出站：内核内置 OpenAI 兼容客户端，插件可由 core.llm-router 接管。 */
export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
export interface LlmResult {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  /**
   * 上游给的 finish_reason（`stop`/`length`/`content_filter`…）。
   * `length` 表示输出被 max_tokens 截断——JSON 类调用靠它判断"是不是没写完"，别把截断当成格式错。
   */
  finishReason?: string;
}
export interface LlmPort {
  generate(input: {
    messages: LlmMessage[];
    temperature?: number;
    maxTokens?: number;
    json?: boolean;
    purpose?: "reply" | "proactive" | "extract" | "world" | "narrative" | "persona" | "speech";
    /** 多模型：本次指定用的模型（地址/模型名/密钥）；不传就走主模型 */
    override?: { baseUrl: string; model: string; apiKey: string };
  }): Promise<LlmResult>;
  isConfigured(): boolean;
  status(): { configured: boolean; providerId: string | null; baseUrl: string | null; model: string | null; lastError: string | null };
}

export interface PromptBundle {
  system: string;
  messages: LlmMessage[];
  /** 证据层与召回结果，写进 turns.ctx_snapshot 以便回放 */
  evidence: MemoryItem[];
  slots: Record<string, unknown>;
  relation: RelationState;
  world: WorldState;
  drives: DriveState;
  pinned: MemoryItem[];
}

export interface PlannedPart {
  text: string;
  /** 这一条发出去之后等多久再发下一条（毫秒） */
  delayAfterMs: number;
  /** 这一条"打字"用多久（毫秒）：字数 / (4~6 字每秒) */
  typingMs: number;
  /**
   * 这一条它想用声音说出来（模型在原文里用 `<voice>…</voice>` 标出来的，v1.0.29）。
   * 它自己决定哪句话值得出声——而不是由档位替它决定整条回复。
   */
  voice?: boolean;
  /**
   * 这一句它想用声音说、但觉得现在不是时候：`<voice wait>…</voice>`（v1.0.34）。
   * 这一轮不打字也不出声，存进"待发语音槽"，等对方回了再摆到它面前。
   */
  hold?: boolean;
}

export interface ReplyPlan {
  parts: PlannedPart[];
  /** 完整回复文本（落库用） */
  fullText: string;
  prompt: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  ctxSnapshot: unknown;
}

export interface ExpressionPort {
  /** 生成一次回复（用户消息或主动消息共用） */
  planReply(input: {
    agentId: number;
    userText: string;
    trigger: "reply" | "proactive" | "impulse";
    now: number;
    reason?: string;
    /** 主动消息时由 hazard 提供的候选上下文 */
    actionId?: number;
    /** 会话键：不同的人/群各自一条对话线（默认应用内主会话） */
    conversation?: string;
    /** 允许它自己决定「这次不回」：群聊里不想接就不接 */
    silenceAllowed?: boolean;
    /**
     * 上一轮它留着没说出口的那句话（`<voice wait>` 标的）。
     * 只递到它面前，发不发仍由它自己决定（v1.0.34）。
     */
    heldVoice?: string;
  }): Promise<ReplyPlan>;
  /** 只装配上下文，不调用模型（回放与调试用） */
  assemble(input: {
    agentId: number;
    userText: string;
    trigger: string;
    now: number;
    conversation?: string;
  }): Promise<PromptBundle>;
}

export interface PluginHostPort {
  list(): unknown[];
  enable(pluginId: string, confirmToken?: string): Promise<unknown>;
  disable(pluginId: string): Promise<unknown>;
  grant(pluginId: string, permissions: string[], confirmToken?: string): unknown;
  setConfig(pluginId: string, config: Record<string, unknown>): unknown;
  restart(pluginId: string): Promise<unknown>;
  /** 注入插件进程的密钥（DPAPI 保护，不出内核） */
  secret(pluginId: string, name: string): string | null;
  shutdown(): Promise<void>;
  panicStop(): Promise<{ stopped: string[]; restored: boolean; message: string }>;
  /** 调插件方法（语音合成/识别走这里；权限与超时由插件宿主统一管） */
  call(pluginId: string, method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
}

export interface ChatDeps {
  deps: KernelDeps;
  memory: MemoryPort;
  mind: MindPort;
  expression: ExpressionPort;
  llm: LlmPort;
  pluginHost: PluginHostPort;
  /** 语音条（docs/语音条.md）：收/转写/合成/attachment 读写都在它里面 */
  media: MediaPort;
  /** 事件推送（内核 → 客户端） */
  emit: (method: string, params: unknown) => void;
  /** 成本记账 */
  recordCost: (input: { agentId: number; kind: string; model: string; usage: { inputTokens: number; outputTokens: number } }) => void;
}

/** 合成时一起交给插件的情绪快照：BreezeBlue 这类支持"语气指令"的供应商靠它出声。 */
export interface SpeechMood {
  arousal: number;
  valence: number;
  energy: number;
  warmth: number;
}

/** 语音条端口：ChatService 只依赖这几个方法，实现见 services/media.ts。 */
export interface MediaPort {
  /** 把客户端刚上传的录音转正，返回可落库的 attachment */
  bindUpload(uploadId: string): MessageAttachment;
  /** 临时气泡正文（`[语音 12″]`），模板在 shared 里只有一份 */
  placeholderFor(att: MessageAttachment): string;
  /** 转写一条语音消息；成功时消息正文由调用方改写 */
  transcribe(messageId: number): Promise<{ ok: true; text: string; silent: boolean } | { ok: false; reason: string }>;
  /** 合成一段语音；失败抛错，调用方要把它变成 skipped 而不是让整轮失败 */
  synthesize(input: {
    text: string;
    rate?: number;
    volume?: number;
    cacheKey?: string;
    mood?: SpeechMood;
    /** mp3 给应用内播放器；wav 给外部通道（旁路进程要直接喂 waveOut） */
    format?: "mp3" | "wav";
  }): Promise<{ attachment: MessageAttachment; costCny: number }>;
  status(): { listenReady: boolean; speakReady: boolean; message: string; asrAffordable: boolean; voiceOutbound: "off" | "auto" | "always" };
  readAttachment(messageId: number): MessageAttachment | null;
  /** attachment 的相对路径 → 绝对路径（外部通道要把文件交给旁路进程播放） */
  absPathFor(attachment: MessageAttachment): string;
  writeAttachment(messageId: number, att: MessageAttachment): void;
  patchAttachment(messageId: number, patch: Partial<MessageAttachment>): MessageAttachment | null;
  /** 语音单价（元/秒），预检用；插件没配就是 0 */
  speakPricePerSecond(): number;
  /** 语音单价（元/百万字符），按字计价的供应商用；插件没配就是 0 */
  speakPricePerMillionChars(): number;
  /** 出站预检上限：两种计价口径取大者（文档 10.6，预检必须排在朗读稿改写之前） */
  speakCeilingCny(text: string, rate: number): number;
  /** 这笔钱花下去会不会越过本月预算 */
  affordable(costCny: number): boolean;
  /** 列可用音色（管理面板「声音」）；只读、不计费 */
  voices(): Promise<{ ok: boolean; provider: string; voices: VoiceOption[]; message?: string }>;
  /** 试听一句：不进对话、不落消息表，成本照实记账 */
  preview(text: string): Promise<{
    ok: boolean;
    audioBase64?: string;
    mime?: string;
    durMs?: number;
    costCny?: number;
    reason?: string;
  }>;
}

export interface ChatReplyResult {
  turnId: number;
  userMessage: ChatMessage;
  accepted: boolean;
  /**
   * 外部通道要发出去的语音条：一句一条（用户 2026-11-04：长话不要拼成一条，拆成一句一句直接发）。
   * 合成失败/没合成的那句由调用方退回发文字——绝不因为语音坏了把话弄丢。
   */
  voices?: Array<{ index: number; messageId: number; path: string; durMs: number }>;
}

export { RelationStage };
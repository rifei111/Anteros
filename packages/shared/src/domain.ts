/**
 * Anteros 领域模型 —— 与《工程规范 1：数据契约》对齐的类型定义。
 *
 * 约束来源：
 * - 设计草案 v0.9.5 §14.14 / §14.15：内核 + Windows 主客户端 + 插件，单机闭环。
 * - 工程规范 1 §2：表结构与字段名；本包是内核、客户端、插件共用的唯一真源。
 * - 时间一律为 UTC 毫秒整数，字段后缀 `_ts`（规范 1 §0）。
 */

/** 记忆重要性三级（草案 1.6/2.6）：决定是否钉进证据层、衰减速度、忘了能否承认。 */
export type Importance = "redline" | "important" | "detail";

/** 四类记忆分治（规范 1 §2.3），前端列表用统一视图。 */
export type MemoryKind = "episodic" | "semantic" | "open_loop" | "persona";

/** 关系状态机（规范 1 §3.2）。 */
export type RelationStage =
  | "stranger"
  | "acquainted"
  | "familiar"
  | "close"
  | "strained"
  | "repairing";

/** 完全体模式是关系级的（草案 2.8）：默认 standard。 */
export type AgentMode = "standard" | "full_human";

/** 在场状态机（规范 1 §3.4）。 */
export type PresenceState = "phone_in_hand" | "idle" | "busy" | "sleep" | "away";

/** 世界时钟驱动的慢变量（草案 3.1）。 */
export interface WorldState {
  /** UTC ms */
  nowTs: number;
  /** 本地时区的 ISO 字符串（人类可读，仅展示用） */
  localIso: string;
  /** IANA 时区 */
  tz: string;
  /** 一天中的时段标签，由本地时间推导（禁止用 UTC 小时直接判断） */
  daypart: "late_night" | "morning" | "noon" | "afternoon" | "evening" | "night";
  /** 节气/节日等真实时间锚点，可为空 */
  timeAnchor?: string;
  presence: PresenceState;
  presenceSinceTs: number;
  /** 能量 0–1 慢变量 */
  energy: number;
  /** 情绪效价 -1–1 */
  moodValence: number;
  /** 情绪唤醒 0–1 */
  moodArousal: number;
  /** 昼夜与作息得到的"应该在做什么"，默认不对外叙述（草案 3.7） */
  schedule?: ScheduleSlot[];
  /** 生活模拟是否开启（默认关闭，草案 3.7） */
  lifeSimulationEnabled: boolean;
}

export interface ScheduleSlot {
  startTs: number;
  endTs: number;
  activity: string;
  presence: PresenceState;
  publicNarratable: boolean;
  source: "synced" | "generated" | "persona";
}

/** 动机层（草案 12.2）：空转期纯数学演化，越阈才唤醒 LLM。 */
export interface DriveState {
  loneliness: number;
  boredom: number;
  longing: number;
  tension: number;
  fatigue: number;
  urgeToShare: number;
  anxiety: number;
  /** 每个 drive 的 rate/decay/coupling/threshold，见内核配置 */
  params: Record<string, DriveParams>;
  updatedTs: number;
}

export interface DriveParams {
  rate: number;
  decay: number;
  threshold: number;
  coupling?: Record<string, number>;
}

/** 差异参数（规范 1 §2.2 `personas.traits`），是"参数→行为"翻译函数的输入。 */
export interface PersonaTraits {
  detailPref: number;
  warmth: number;
  initiative: number;
  humor: number;
  /** ACT-R 衰减指数 d，0.3 记性好 ↔ 0.7 健忘 */
  memoryD: number;
  /** 提取阈值 τ，-6.5 ~ -5.0 */
  memoryTau: number;
  /** 回忆噪声 s，0.15 ~ 0.4 */
  memoryS: number;
  /** 重构漂移 ρ，0.1 ~ 0.2 */
  reconstructRho: number;
  /** 情绪增益 γ，1.0 ~ 2.5 */
  emotionGain: number;
  delayMedianMs: number;
  delaySigma: number;
  burstMin: number;
  burstMax: number;
  typoRate: number;
  /** 只当人设标签先验，禁进 prompt（草案 2.7） */
  mbti: string | null;
}

export interface Persona {
  id: number;
  name: string;
  /** 它的城市（异地设定，草案 3.3） */
  city: string;
  birthTs: number;
  traits: PersonaTraits;
  interests: string[];
  /** 不可变设定：经历、观点、价值观、禁用词（草案 3.7） */
  immutable: {
    background: string;
    values: string[];
    taboo: string[];
  };
  speechStyle: {
    /** 口癖只能来自真实说过的话（草案 4.6） */
    habits: string[];
    punctuation: "minimal" | "normal" | "expressive";
    sentenceLength: "short" | "medium" | "long";
  };
}

/** 关系层（规范 1 §2.4）：intimacy 只由 transition_log 累加，禁止自由漂移。 */
export interface RelationState {
  stage: RelationStage;
  intimacy: number;
  trust: number;
  mode: AgentMode;
  sinceTs: number;
  lastTransitionTs: number | null;
  transitionLog: RelationTransition[];
}

export interface RelationTransition {
  from: RelationStage;
  to: RelationStage;
  trigger: string;
  ts: number;
}

/** 记忆统一视图：内核向 UI / 插件暴露的脱敏形态。 */
export interface MemoryItem {
  id: number;
  kind: MemoryKind;
  /** episodic 的自然语言文本 */
  text?: string;
  /** semantic / persona 的槽位 */
  slotKey?: string;
  /** open_loop 的话题 */
  topic?: string;
  value?: unknown;
  importance: Importance;
  confidence: number;
  salience: number;
  entities: string[];
  source: string;
  createdAt: number;
  lastAccessTs: number | null;
  accessCount: number;
  /** ACT-R 当前激活值（仅检索结果填充） */
  activation?: number;
  /** 想起概率（仅检索结果填充） */
  recallProbability?: number;
  /** open_loop: 是否仍开放 */
  open?: boolean;
  urgency?: number;
  deletedTs?: number | null;
}

export interface MemorySearchResult {
  items: MemoryItem[];
  /** 被钉住的证据层（系统兜底注入，不强迫模型开口，草案 1.6） */
  pinned: MemoryItem[];
}

export type ChatRole = "user" | "agent" | "system";

export type MessageDelivery = "pending" | "sent" | "failed" | "unknown" | "cancelled";

export interface ChatMessage {
  id: number;
  role: ChatRole;
  text: string;
  ts: number;
  turnId?: number | null;
  partIndex?: number | null;
  /** 撤回：只删正文留占位，不恢复原文（规范 1 §4.4） */
  recalled: boolean;
  channelId: string;
  delivery: MessageDelivery;
}

/** 分条发送计划（规范 1 §4.3）：服务端决定 parts 与间隔，客户端不得自行改。 */
export interface TurnPlan {
  parts: Array<{
    text: string;
    /** 显示下一条前的延迟 ms */
    delayAfterMs: number;
    /** 打字时长 ms，客户端只按它自走 */
    typingMs: number;
  }>;
  totalChars: number;
  sampledAt: number;
}

export interface TurnReplay {
  turnId: number;
  trigger: "reply" | "proactive" | "impulse";
  plan: TurnPlan | null;
  /** 装配输入：记忆 id、pinned id、槽位快照（不存全文） */
  ctxSnapshot: {
    memoryIds: number[];
    pinnedIds: number[];
    slots: Record<string, unknown>;
    relation: RelationState;
    presence: PresenceState;
    /** 装配后的 prompt（本地可回收，便于"它为什么这么说"） */
    prompt?: string;
  } | null;
  model: string | null;
  output: string | null;
  timeline: Array<{ ts: number; event: string }>;
  outcome: string | null;
}

/** 声明闸（草案 14.14.5）：九条最小集，逐条勾选，版本化。 */
export interface ConsentStatus {
  docVersion: string;
  accepted: boolean;
  acceptedTs: number | null;
  revokedTs: number | null;
  /** 版本升级必须重勾 */
  needsAccept: boolean;
  items: ConsentItem[];
  checkedIds: string[];
}

export interface ConsentItem {
  id: string;
  title: string;
  body: string;
  required: true;
}

export type PluginKind = "channel" | "provider" | "processor" | "media" | "world" | "ui" | "ops";

export type PluginRisk = "low" | "medium" | "high";

export type PluginStatus =
  | "invalid"
  | "disabled"
  | "blocked"
  | "enabled"
  | "running"
  | "degraded"
  | "crashed";

export interface PluginHealth {
  ok: boolean;
  status: "ok" | "degraded" | "blocked";
  message: string;
  checkedTs: number;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  kernelApi: string;
  kind: PluginKind;
  description: string;
  riskLevel: PluginRisk;
  capabilities: string[];
  /** 声明申请的能力（默认全拒） */
  permissions: string[];
  /** 已授予的能力 */
  granted: string[];
  status: PluginStatus;
  enabled: boolean;
  config: Record<string, unknown>;
  health: PluginHealth | null;
  /** manifest 校验/运行期问题，人话 */
  issues: string[];
  lastError?: string | null;
  enabledTs?: number | null;
}

/** 通道能力（规范 5 / 草案 14.3）：业务代码只许读能力，不许认通道名。 */
export interface ChannelCapabilities {
  readCanBackfill: boolean;
  writeIsDeterministic: boolean;
  typingIsReal: boolean;
  canRecall: boolean;
  hostOccupancyMs: number;
  riskLevel: "none" | "gray" | "red";
}

export interface ChannelInfo {
  pluginId: string;
  displayName: string;
  kind: "app" | "external";
  capabilities: ChannelCapabilities;
  enabled: boolean;
  status: PluginStatus;
  /** 写路径是否就绪（租约 + 体检） */
  writeReady: boolean;
  health: PluginHealth | null;
}

export type ActionState = "queued" | "quarantined" | "dispatched" | "cancelled" | "expired";

export interface ActionItem {
  id: number;
  kind: "proactive" | "impulse" | "typing" | "delay";
  payload: unknown;
  createdTs: number;
  deadlineTs: number;
  ttlMs: number;
  state: ActionState;
  /** 四类主动理由 + 第五类冲动（草案 5.7）；人类可读，落库为文本 */
  reason: string;
}

export interface AuditEntry {
  id: number;
  actorRole: "owner" | "member" | "operator" | "system";
  action: string;
  targetAgentId: number | null;
  before: unknown;
  after: unknown;
  ts: number;
}

export interface CostEntry {
  id: number;
  ts: number;
  kind: "reply" | "proactive" | "impulse" | "extract" | "world" | "embedding";
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCny: number;
}

export interface CostSummary {
  currency: "CNY";
  todayCny: number;
  monthCny: number;
  totalCny: number;
  /** 月度预算上限（成本上限是 owner 也不可越过的硬项） */
  monthlyBudgetCny: number;
  turnCount: number;
  byModel: Array<{ model: string; calls: number; inputTokens: number; outputTokens: number; costCny: number }>;
  /** 每条用户消息边际成本 ≤ 普通聊天 2 倍（草案 8 章） */
  avgCostPerTurnCny: number;
  recent: CostEntry[];
}

export interface OwnerStatus {
  isOwner: boolean;
  /** 构建期配置的 OWNER_WECHAT_ID 是否已填 */
  ownerWechatConfigured: boolean;
  role: "owner" | "member" | "operator";
}

export interface LlmStatus {
  providerId: string;
  providerName: string;
  model: string;
  online: boolean;
  lastError: string | null;
  /** 无密钥时是否退化为本地回声（可演示、不产生云端调用） */
  degradedLocalEcho: boolean;
}

export interface SystemHealth {
  ok: boolean;
  kernelVersion: string;
  kernelApi: string;
  startedTs: number;
  uptimeMs: number;
  dataDir: string;
  dbPath: string;
  memoryCount: number;
  pluginCount: number;
  externalChannelCount: number;
  degraded: Array<{ pluginId: string; reason: string }>;
  singlePointRisks: string[];
}

/** 首次握手返回：客户端据此渲染，不额外请求。 */
export interface HandshakeResult {
  kernelVersion: string;
  kernelApi: string;
  sessionId: string;
  dataDir: string;
  startedTs: number;
  platform: string;
  nodeVersion: string;
}

/** 客户端启动时的整包快照。 */
export interface AppSnapshot {
  handshake: HandshakeResult;
  consent: ConsentStatus;
  owner: OwnerStatus;
  persona: Persona;
  relation: RelationState;
  world: WorldState;
  drives: DriveState;
  plugins: PluginInfo[];
  channels: ChannelInfo[];
  cost: CostSummary;
  health: SystemHealth;
  llm: LlmStatus;
  /** 未闭合话题（主动燃料） */
  openLoops: MemoryItem[];
  pendingActions: ActionItem[];
}

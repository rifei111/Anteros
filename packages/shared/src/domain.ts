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

/**
 * 一条参数的解释：用户写完人设、系统算出内核之后，得能说清"为什么是这个值"。
 * 没有解释的自动参数没人敢用，也没法改。
 */
export interface PersonaRationale {
  key: string;
  label: string;
  value: string;
  why: string;
}

/**
 * 人设文本 → 人格内核的编译产物（草案 2 参数投影、2.7 MBTI 只作投影）。
 *
 * 它是"草稿"：用户可以在界面上微调每个数值，再决定要不要落库。
 * traits 的取值一律钳在草案给的区间里，越界会被记进 clamped 而不是静默截断。
 */
export interface PersonaBlueprint {
  /** 编译来源文本，保存下来便于"这句话是怎么变成这个人"的回看 */
  sourceText: string;
  /** rules = 本地规则引擎（没配模型也能用）；llm = 模型推导 */
  engine: "rules" | "llm";
  name: string;
  city: string;
  ageYears: number | null;
  interests: string[];
  background: string;
  values: string[];
  /** 口头禅只从用户原话里摘，不生成（草案 4.6） */
  habits: string[];
  speechStyle: Persona["speechStyle"];
  traits: PersonaTraits;
  rationale: PersonaRationale[];
  clamped: string[];
  warnings: string[];
}

/** persona.compile 的结果：草稿 + 这次编译的模型开销（规则引擎为 null）。 */
export interface PersonaCompileResult {
  blueprint: PersonaBlueprint;
  usage: { model: string; inputTokens: number; outputTokens: number } | null;
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
  /**
   * 通道类插件的「真的接上了吗」：能力声明是"它被允许做什么"，
   * 这里是"它现在实际能做什么"。骨架能跑但还没接上第三方通道本体时，write 必须是 false。
   */
  attachments?: { read?: boolean; write?: boolean; typing?: boolean; recall?: boolean };
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
  /** 这一份插件里"能被授权"的全部条目 = capabilities + permissions（界面按它逐项勾选） */
  grantable: string[];
  /** 授权时必须先拿一次性确认 token 吗（勾选里含 proc./secrets.read:/fs.write:/ui.foreground 就是 true，与 riskLevel 无关） */
  grantNeedsConfirm: boolean;
  /** 启用时必须先拿一次性确认 token 吗（只有 riskLevel === "high" 才是 true） */
  enableNeedsConfirm: boolean;
  /** 已授予的能力 */
  granted: string[];
  status: PluginStatus;
  enabled: boolean;
  config: Record<string, unknown>;
  health: PluginHealth | null;
  /** manifest 里声明要的密钥名（只给名字，永远不含值） */
  secrets: string[];
  /** 上面这些密钥里还没录入的（缺了就启用不了） */
  missingSecrets: string[];
  /** 这个插件要不要一份外部运行环境（v0.5：界面按它显示「下载运行环境」） */
  runtimeEnv: boolean;
  /** manifest 校验/运行期问题，人话 */
  issues: string[];
  lastError?: string | null;
  enabledTs?: number | null;
}

/** 运行环境包里的一个文件（增量更新按 sha256 比对，只下变了的那几个）。 */
export interface PluginRuntimeFile {
  path: string;
  sha256: string;
  size: number;
}

/** 整包下载信息（二进制包，先落地再校验再解，校验不过一律不落地）。 */
export interface PluginRuntimeArchive {
  url: string;
  sha256: string;
  size: number;
  format: "tar.gz" | "zip";
}

/** 更新源里的一个运行环境包。 */
export interface PluginRuntimePackage {
  pluginId: string;
  version: string;
  /** 发布说明（人话，界面上直接显示） */
  notes?: string;
  releasedTs?: number;
  /** 装好之后要执行的入口文件（相对包根） */
  entry?: string;
  /** 整包（没有 files 或增量失败时用） */
  archive?: PluginRuntimeArchive;
  /** 文件清单；配合 filesBaseUrl 做按文件增量 */
  files?: PluginRuntimeFile[];
  /** 内容寻址的按文件下载地址：`${filesBaseUrl}/${sha256}` 返回该文件字节 */
  filesBaseUrl?: string;
}

/** 本机已安装的运行环境。 */
export interface PluginRuntimeInstall {
  version: string;
  /** 绝对路径：<dataDir>/plugin-runtime/<pluginId>/<version> */
  path: string;
  size: number;
  fileCount: number;
  installedTs: number;
  /** 这次是怎么装上的：整包 or 按文件增量 */
  mode: "archive" | "delta";
  source: string;
}

/** 插件运行环境状态：界面一次拿全（装了没、能升到哪版、在干什么、错在哪）。 */
export interface PluginRuntimeStatus {
  pluginId: string;
  feedUrl: string;
  installed: PluginRuntimeInstall | null;
  available: { version: string; size: number; notes?: string; releasedTs?: number } | null;
  updateAvailable: boolean;
  lastCheckTs: number | null;
  busy: "idle" | "checking" | "downloading" | "applying";
  progress: { phase: "download" | "verify" | "extract" | "apply"; percent: number; bytes: number; totalBytes: number } | null;
  error: string | null;
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

/** 内置微信通道的一项环境体检（内核自己探 Python / 微信 / sidecar，不靠插件自吹）。 */
export interface WechatCheck {
  id: string;
  label: string;
  state: "ok" | "warn" | "fail";
  message: string;
  hint?: string;
}

/**
 * 内置微信通道的状态快照。
 *
 * 这条通道是软件本体的一部分（不是插件）：默认关闭，用户在管理面板里点了风险确认才开。
 * sidecar 是一个 Python 子进程，负责读本机微信数据库、驱动微信界面发消息。
 */
export interface WechatChannelStatus {
  enabled: boolean;
  running: boolean;
  state: "off" | "starting" | "ready" | "degraded" | "blocked" | "error";
  checks: WechatCheck[];
  account: { wxid: string; nickname: string | null } | null;
  /** 只跟这一个会话说话（白名单），默认 filehelper（文件传输助手） */
  chatUsername: string;
  chatTitle: string | null;
  canRead: boolean;
  canSend: boolean;
  pythonPath: string | null;
  sidecarVersion: string | null;
  wechatautoVersion: string | null;
  lastError: string | null;
  lastInboundTs: number | null;
  lastOutboundTs: number | null;
  inboundCount: number;
  outboundCount: number;
  installing: boolean;
  installLog: string[];
  /** 上次体检完成的时间（0 = 还没体检过） */
  lastCheckTs: number;
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

/** 记账口径：persona = 人设文本编译（一次性开销，不算进"每条消息边际成本"）。 */
export type CostKind = "reply" | "proactive" | "impulse" | "extract" | "world" | "embedding" | "persona";

export interface CostEntry {
  id: number;
  ts: number;
  kind: CostKind;
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
  /** 当前生效的根地址（不含密钥，可以显示） */
  baseUrl?: string;
  /** 是否已经存过密钥（只给布尔，永不回显值） */
  hasKey?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** 路由插件（core.llm-router）的状态：模型页把它的配置也管起来 */
  router?: LlmRouterStatus | null;
}

/** 模型页里「插件里的模型服务」一节要显示的东西 */
export interface LlmRouterStatus {
  id: string;
  enabled: boolean;
  status: string;
  /** 授权是否齐了（缺哪几项见 missingGrants） */
  grantedAll: boolean;
  missingGrants: string[];
  missingSecrets: string[];
  issues: string[];
  config: Record<string, unknown>;
}

/** 一次真实连通性探测的结果（llm.test） */
export interface LlmProbeResult {
  ok: boolean;
  baseUrl: string;
  model: string | null;
  latencyMs: number;
  /** 服务端 /models 返回的模型名（拿不到就是空数组） */
  models: string[];
  /** 靠哪条路径确认的：models 列表 / 一次 1 token 的对话 / 都没通 */
  via: "models" | "chat" | "none";
  httpStatus: number | null;
  /** 人话结论，成功失败都用它 */
  message: string;
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

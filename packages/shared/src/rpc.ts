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
  WechatChannelStatus,
  ChatMessage,
  ConsentStatus,
  ConversationSummary,
  CostSummary,
  DriveState,
  HandshakeResult,
  Importance,
  LlmProbeResult,
  LlmStatus,
  ModelCatalog,
  ModelEntry,
  ModelTaskKind,
  MemoryItem,
  MemoryKind,
  MemorySearchResult,
  MessageAttachment,
  OwnerStatus,
  Persona,
  PersonaBlueprint,
  PersonaCompileResult,
  PluginInfo,
  PluginRuntimeStatus,
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

/**
 * 一个可选音色（管理面板「声音」里的下拉项）。
 *
 * 字段一律可选，供应商能给多少给多少：BreezeBlue 会带 name/language/gender/preview_url，
 * 别家可能只给一个 id。界面只依赖 id 与显示名。
 */
export interface VoiceOption {
  id: string;
  name: string;
  language?: string;
  gender?: string;
  previewUrl?: string;
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
    { limit?: number; beforeTs?: number; conversation?: string },
    { messages: ChatMessage[]; hasMore: boolean }
  >;
  /** 每条会话线的最后一句与条数：左侧列表用它显示摘要（重启也不归零）。 */
  "chat.summaries": MethodSpec<Record<string, never>, { summaries: ConversationSummary[] }>;
  /** 上行只带 is_typing 布尔值，禁止上报草稿文本（规范 1 §4.1 隐私约束）。 */
  "chat.send": MethodSpec<
    {
      text: string;
      /** 幂等键，内核 7 天内去重（规范 1 §5.1） */
      eventId: string;
      clientTs: number;
      /** 会话键：不同的人（或群）各自一条对话线，互不污染上下文 */
      conversation?: string;
      presence?: { isTyping?: boolean; appFocused?: boolean; lastInteractionMs?: number };
      /**
       * 语音条：先 media.upload 拿到的 uploadId（**不是路径**，路径由内核生成）。
       * 内核在这一步把它绑到消息上，uploadId 立刻作废（语言条 5.2）。
       */
      uploadId?: string;
    },
    { turnId: number; userMessage: ChatMessage; accepted: boolean; /** 入站预算预检拒绝时的人话原因（11.2） */ reason?: string }
  >;
  "chat.typing": MethodSpec<{ isTyping: boolean }, Ack>;
  "chat.markRead": MethodSpec<{ lastTs: number }, Ack>;

  /* ---------------- 语音条：五个媒体原语（内核只做这五件事，供应商全在插件里） ---------------- */
  /** 第一段握手：字节进内核、校验、落盘，返回 uploadId 与内核生成的附件描述。 */
  "media.upload": MethodSpec<
    {
      /** 幂等键：同一次上传重试不该落两个文件 */
      eventId?: string;
      dataBase64: string;
      mime: string;
      /** 客户端 performance.now() 计时；内核只做范围检查，不做独立校验（7.5） */
      durMs: number;
      peaks: number[];
    },
    { uploadId: string; attachment: MessageAttachment }
  >;
  /** 取字节：只接受 uploadId 或 messageId，**不接受裸路径**（9.3 的 LRU 与重试都走它）。 */
  "media.load": MethodSpec<
    { uploadId?: string; messageId?: number },
    { dataBase64: string; mime: string; durMs: number; transcript?: string }
  >;
  /** 只读缓存里的插件健康与预算可负担性，客户端一样都不自己算（9.5 / 10.6）。 */
  "media.status": MethodSpec<
    Record<string, never>,
    {
      listenReady: boolean;
      speakReady: boolean;
      message: string;
      /** 本月还花得起最坏一笔 ASR 吗（内核用 monthCny() 与预算算） */
      asrAffordable: boolean;
      voiceOutbound: "off" | "auto" | "always";
      /** 没装/没启用/没授权时给"去配置"用的原因 */
      reason?: string;
    }
  >;
  /** 出站时长的唯一实测来源：渲染层解码后回填（幂等 UPDATE，9.3）。 */
  "media.meta.set": MethodSpec<{ messageId: number; durMs: number; peaks: number[] }, { attachment: MessageAttachment }>;
  /** 对没转写成功、或转写成功但没形成回复的语音重跑一次（11.2）。 */
  "media.retry": MethodSpec<{ messageId: number }, { ok: boolean; text?: string; reason?: string }>;
  /** 对合成失败（skipped / error / missing）的语音条重新合成一次，成功后直接刷新 attachment。 */
  "media.respeak": MethodSpec<{ messageId: number }, { ok: boolean; attachment?: MessageAttachment; reason?: string }>;
  /**
   * 列出可用音色（管理面板「声音」用）。只读、不计费。
   *
   * 供应商把音色藏在账户后面（BreezeBlue 走 GET /v1/voices），所以"选音色"只能是内核去问插件，
   * 不能让客户端自己拼请求——密钥不出内核。
   */
  "media.voices": MethodSpec<Record<string, never>, { ok: boolean; provider: string; voices: VoiceOption[]; message?: string }>;
  /**
   * 试听一句：不进对话、不占语音档位、不入消息表，成本照实记账。
   * 音频直接以 base64 回给客户端播放，省掉一条"预览文件"的落盘与清理路径。
   */
  "media.preview": MethodSpec<
    { text?: string },
    { ok: boolean; audioBase64?: string; mime?: string; durMs?: number; costCny?: number; reason?: string }
  >;
  /** 撤回/GC 之后客户端刷新一条消息的附件状态。 */
  "media.attachment": MethodSpec<{ messageId: number }, { attachment: MessageAttachment | null }>;
  /**
   * 它什么时候用语音回你（10.1）。三档只影响"出站要不要开口"，
   * 识别/合成的可用性看 media.status 的 listenReady / speakReady。
   */
  "media.setVoiceOutbound": MethodSpec<
    { mode: "off" | "auto" | "always" },
    { voiceOutbound: "off" | "auto" | "always" }
  >;

  "memory.search": MethodSpec<{ query: string; topK?: number }, MemorySearchResult>;
  "memory.list": MethodSpec<
    { kind?: MemoryKind; importance?: Importance; limit?: number; offset?: number; conversation?: string },
    { items: MemoryItem[]; total: number }
  >;
  "memory.get": MethodSpec<{ id: number }, { item: MemoryItem | null }>;
  "memory.delete": MethodSpec<{ id: number }, { deleted: boolean }>;
  "memory.deleteAll": MethodSpec<{ confirmToken: string }, { deleted: number }>;
  /**
   * 重置记忆：真的"忘掉"一个人需要同时清掉长期记忆、未闭合话题、叙事槽位与聊天历史
   * （只删记忆行、聊天记录还在上下文里，模型还是会"记得"）。
   */
  "memory.reset": MethodSpec<
    { confirmToken: string; keepChat?: boolean },
    { memories: number; openLoops: number; narrative: number; messages: number; turns: number }
  >;
  "memory.stats": MethodSpec<
    Record<string, never>,
    { episodic: number; semantic: number; openLoops: number; persona: number; pinned: number; total: number }
  >;
  "memory.export": MethodSpec<Record<string, never>, { path: string; bytes: number }>;
  /**
   * 它留着没说出口的那句话（`<voice wait>`，v1.0.34）：这一轮没说、等对方回了再决定。
   * 只给 owner 看，可以手动清掉。
   */
  "voice.held": MethodSpec<Record<string, never>, { items: Array<{ conversation: string; text: string; ts: number; seen: number }> }>;
  "voice.held.clear": MethodSpec<{ conversation: string }, { cleared: boolean }>;

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
  /** 把当前人格渲染成一份可读、可改、可再导入的 Markdown 文档。 */
  "persona.exportDoc": MethodSpec<Record<string, never>, { text: string; filename: string }>;
  /** 从文档导入人设：只改文档里写到的字段，没写到的保持不动。 */
  "persona.importDoc": MethodSpec<{ text: string }, { persona: Persona; applied: string[]; warnings: string[] }>;
  /** 聊天对象头像：data URL（空=回退到名字首字）。客户端在渲染层选图后转 data URL 传进来。 */
  "ui.avatar.get": MethodSpec<Record<string, never>, { dataUrl: string | null }>;
  "ui.avatar.set": MethodSpec<{ dataUrl: string | null }, { dataUrl: string | null }>;

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
  /** 插件运行环境（v0.1 是"用户点下载、内核去装"的通道适配器环境）。 */
  "plugins.runtime.status": MethodSpec<{ id: string }, PluginRuntimeStatus>;
  "plugins.runtime.check": MethodSpec<{ id: string }, PluginRuntimeStatus>;
  /** 下载并安装；已装旧版时装上新版（能按文件增量就只下变了的文件）。 */
  "plugins.runtime.install": MethodSpec<{ id: string }, PluginRuntimeStatus>;
  "plugins.runtime.uninstall": MethodSpec<{ id: string }, PluginRuntimeStatus>;
  /** 更新源：不传 url 就是读，传了就写（只接受 https / file，写盘前先校验）。 */
  "plugins.runtime.feed": MethodSpec<{ url?: string }, { url: string }>;

  "channels.list": MethodSpec<Record<string, never>, ChannelInfo[]>;
  /** 一键停用：停掉所有通道并还原宿主状态（草案 14.6 ⑦）。 */
  "channels.panicStop": MethodSpec<{ confirmToken?: string }, { stopped: string[]; restored: boolean; message: string }>;
  "channels.wechat.status": MethodSpec<Record<string, never>, WechatChannelStatus>;
  "channels.wechat.installDeps": MethodSpec<Record<string, never>, WechatChannelStatus>;
  /** 一键下载运行环境：便携版 Python + pip + wechatauto-replica（全在数据目录里，不动系统） */
  "channels.wechat.installRuntime": MethodSpec<Record<string, never>, WechatChannelStatus>;
  "channels.wechat.enable": MethodSpec<
    { ackRisk: boolean; chatUsername?: string },
    WechatChannelStatus
  >;
  "channels.wechat.disable": MethodSpec<Record<string, never>, WechatChannelStatus>;
  "channels.wechat.setChat": MethodSpec<{ chatUsername: string }, WechatChannelStatus>;
  /** 列出本机微信里最近的会话与群，供「添加可对话对象」挑选（只读，不发消息） */
  /** 发一条测试消息：真正走一次 GUI 发送，把成败如实回给界面 */
  "channels.wechat.sendTest": MethodSpec<
    { text?: string; chatUsername?: string },
    {
      ok: boolean;
      error?: string;
      recent: Array<{
        ts: number;
        direction: "in" | "out";
        chat: string;
        title: string;
        text: string;
        ok: boolean;
        error: string | null;
      }>;
    }
  >;
  /** 最近收发记录：用来验证"它真的读到了/发出去了"，不是只看体检绿灯 */
  "channels.wechat.recent": MethodSpec<
    { limit?: number },
    {
      items: Array<{
        ts: number;
        direction: "in" | "out";
        chat: string;
        title: string;
        text: string;
        ok: boolean;
        error: string | null;
      }>;
    }
  >;
  "channels.wechat.listChats": MethodSpec<
    { limit?: number },
    { chats: Array<{ username: string; title: string; kind: "direct" | "group"; added: boolean }> }
  >;
  "channels.wechat.addChat": MethodSpec<
    { username: string; mode?: "all" | "mention" | "off" | "auto" },
    WechatChannelStatus
  >;
  "channels.wechat.removeChat": MethodSpec<{ username: string }, WechatChannelStatus>;
  "channels.wechat.setChatMode": MethodSpec<
    { username: string; mode: "all" | "mention" | "off" | "auto" },
    WechatChannelStatus
  >;
  "channels.wechat.setMaxChats": MethodSpec<{ max: number }, WechatChannelStatus>;
  "channels.wechat.doctor": MethodSpec<{ action: "dump-account" | "diagnose-keys" }, { ok: boolean; output: string }>;
  /** 主动消息要不要同时同步到这个微信会话（默认关） */
  "channels.wechat.setRelay": MethodSpec<{ enabled: boolean }, WechatChannelStatus>;
  /** 微信里回话要不要发真语音条（虚拟声卡路线，默认关） */
  "channels.wechat.setVoiceOutbound": MethodSpec<{ enabled: boolean }, WechatChannelStatus>;
  /** 虚拟声卡自检：把一段声音送进微信的麦克风，看录回来的电平 */
  "channels.wechat.voiceStatus": MethodSpec<
    { force?: boolean },
    { ok: boolean; playbackDevice?: string; rms?: number; message?: string }
  >;
  /** 本机有没有虚拟声卡（VB-CABLE）：只读检测，不弹任何窗口 */
  "channels.wechat.soundcardStatus": MethodSpec<
    Record<string, never>,
    {
      installed: boolean;
      /** 回放端名字，例如 CABLE Input (VB-Audio Virtual Cable) */
      playbackDevice?: string;
      /** 录音端名字，例如 CABLE Output (VB-Audio Virtual Cable) */
      captureDevice?: string;
      /** 驱动包是否随应用一起打包（可以一键装）；为 false 时只能给下载地址 */
      bundled: boolean;
      message: string;
    }
  >;
  /**
   * 一键安装虚拟声卡。会弹一次 UAC（装驱动必须提权），装着的时候要先关掉微信，
   * 装完需要重启微信与 Anteros 才会认到设备。
   */
  "channels.wechat.installSoundcard": MethodSpec<
    Record<string, never>,
    { ok: boolean; needsAdmin?: boolean; needsRestart?: boolean; message: string }
  >;

  "world.state": MethodSpec<Record<string, never>, WorldState>;
  "drives.state": MethodSpec<Record<string, never>, DriveState>;
  "proactive.list": MethodSpec<Record<string, never>, { pending: ActionItem[]; recent: ActionItem[] }>;
  "proactive.setFrequency": MethodSpec<{ level: "off" | "low" | "normal" | "high" }, { level: string }>;
  /**
   * 立刻跑一次主动判定（owner 自检用）：force=true 时跳过"距上条的时间间隔/当日上限/关系阶段"，
   * 但仍然守静默时段、pause、panic、档位 off。返回这次有没有排进队列。
   */
  "proactive.tick": MethodSpec<
    { force?: boolean },
    { queued: boolean; actionId: number | null; reason: string | null; blockedBy: string | null }
  >;
  /** 验证「主动消息 → 微信」通路：真发一条带标记的自检消息，如实回报成败 */
  "proactive.verifyRelay": MethodSpec<{ text?: string }, { ok: boolean; message: string }>;

  "turns.list": MethodSpec<
    { limit?: number },
    { turns: Array<{ id: number; ts: number; trigger: string; outcome: string | null }> }
  >;
  /** "它为什么这么说"：还原当时的装配输入（规范 1 §5.3 验收）。 */
  "turn.replay": MethodSpec<{ turnId: number }, TurnReplay>;

  "cost.summary": MethodSpec<Record<string, never>, CostSummary>;
  /* ---------------- 多模型 ---------------- */
  "models.list": MethodSpec<Record<string, never>, ModelCatalog>;
  "models.upsert": MethodSpec<
    {
      id?: string | null;
      label: string;
      baseUrl: string;
      model: string;
      provider?: string;
      apiKey?: string;
      kinds?: ModelTaskKind[];
      enabled?: boolean;
    },
    { entry: ModelEntry; catalog: ModelCatalog }
  >;
  "models.remove": MethodSpec<{ id: string }, { removed: boolean; catalog: ModelCatalog }>;
  "models.setRoute": MethodSpec<{ kind: ModelTaskKind; modelId: string | null }, { catalog: ModelCatalog }>;
  "models.setActiveChat": MethodSpec<{ modelId: string | null }, { catalog: ModelCatalog }>;
  "models.probe": MethodSpec<{ id: string }, { ok: boolean; message: string; latencyMs: number }>;  "cost.setBudget": MethodSpec<{ monthlyCny: number }, CostSummary>;
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
  /**
   * 整体重置：清空本机数据。三个 keep 开关对应界面上的三个复选框；
   * 不管怎么选，人格/关系/驱动/日程都会回到初始态，只是"要不要留下密钥、运行环境、插件配置"由你决定。
   */
  "system.resetData": MethodSpec<
    { confirmToken: string; keepApiKey?: boolean; keepRuntime?: boolean; keepPlugins?: boolean },
    {
      tables: Record<string, number>;
      removedDirs: string[];
      kept: string[];
      resetSettings: number;
    }
  >;
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
  "plugin.health.check": MethodSpec<
    Record<string, never>,
    {
      ok: boolean;
      status: "ok" | "degraded" | "blocked";
      message: string;
      /** 这个插件现在真的能做什么（语音条 8.3：listen/speak 两个布尔是能力的唯一真话） */
      attachments?: Record<string, boolean>;
    }
  >;
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

  /* ---- 媒体：三个只有插件会做的事（语音条 8.1：TTS/ASR 全部在插件里，内核只做编排） ---- */
  /** 文字 → 音频字节。内核出站时先预检预算、再调它，返回的 costCny 直接进 cost_ledger。 */
  "plugin.media.speak": MethodSpec<
    {
      text: string;
      /** 语速倍率（0.5–2.0）：同一个 text 不同 rate 就是不同时长，缓存键必须带上它 */
      rate?: number;
      /** 音色 id，空则用插件默认 */
      voice?: string;
      /** 缓存键：内核按 (text, rate, voice) 的摘要算好传进来，插件不自己算 */
      cacheKey?: string;
    },
    {
      dataBase64: string;
      mime: string;
      /** 供应商回报的时长；给不出就 0，由渲染层实测回填（9.3） */
      durMs: number;
      costCny?: number;
      model?: string;
      /** 缓存命中：内核据此跳过记账 */
      cached?: boolean;
    }
  >;
  /** 音频字节 → 文字。只接受内核递来的本地路径，插件不得自己去找文件。 */
  "plugin.media.listen": MethodSpec<
    { path: string; mime: string; durMs: number },
    {
      text: string;
      /** assistant: 转写成功；none: 没人声/无法识别（此时 text 为空，内核用"没听清"）；error: 失败 */
      kind: "assistant" | "none" | "error";
      costCny?: number;
      model?: string;
      reason?: string;
    }
  >;
  /** 列出这家供应商能给到的音色（管理面板「声音」用）。只读、不计费。 */
  "plugin.media.voices": MethodSpec<
    { language?: string },
    {
      provider: string;
      voices: VoiceOption[];
      /** 列不出来时说清原因（没密钥 / 网络 / 供应商没有这个接口） */
      message?: string;
    }
  >;
  /** 图片：本期只留签名，未实现（语音条 8.1 明确"顺手做了"以外的都别加） */
  "plugin.media.image": MethodSpec<
    { prompt: string; size?: string },
    { dataBase64: string; mime: string; costCny?: number }
  >;
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
  "event.typing": {
    /**
     * start/stop 是"正在写"；transcribe 是"正在听你那条语音"——
     * ASR 那几秒不能是空窗，否则用户以为消息没发出去（语音条 10.5）。
     */
    state: "start" | "stop" | "transcribe";
    plannedMs?: number;
    plannedChars?: number;
  };
  "event.recall": { messageId: number; replacement: string };
  "event.presence": WorldState;
  "event.drives": DriveState;
  "event.relation": RelationState;
  "event.plugin": PluginInfo;
  /** 插件运行环境的下载/安装/更新进度（界面拿它画进度条）。 */
  "event.runtime": PluginRuntimeStatus;
  "event.channels": ChannelInfo[];
  "event.wechat": WechatChannelStatus;
  "event.wechat.log": { line: string };
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

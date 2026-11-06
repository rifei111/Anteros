/**
 * 应用编排层：启动握手、快照、事件接线、发送/重发、分页历史、声明闸与引导的流转。
 *
 * 分层的原则：组件只调用这里的函数 + 读 store；这里只调用 `lib/kernel.ts`。
 */

import type { ChatMessage, KernelEvents, MemoryItem, SystemHealth } from "@anteros/shared";
import { voicePlaceholder } from "@anteros/shared";
import { humanizeError } from "./errors";
import { invoke, newEventId, pollConnection, subscribe, appInfo, quitApp } from "./kernel";
import {
  appendLog,
  applyModelCatalog,
  applyPluginRuntime,
  applyUpdateStatus,
  applyConversationSummaries,
  applyDegraded,
  applyWechatChats,
  bumpConversationUnread,
  clearConversationUnread,
  getState,
  pushToast,
  setState,
  type AdminTab,
  type DegradedNotice,
} from "./store";
import { truncate } from "./format";
import { uploadClip, type RecordedClip } from "./voice";

const ONBOARDED_KEY = "anteros.onboarded.v1";
const HISTORY_PAGE = 40;
const OLDER_PAGE = 30;

let booted = false;
let booting = false;
let started = false;
let stopPolling: (() => void) | null = null;
let stopEvents: (() => void) | null = null;
let tempSequence = 0;
let markReadTimer: number | null = null;

function nextTempId(): number {
  tempSequence += 1;
  return -tempSequence;
}

function needsOnboarding(): boolean {
  try {
    return globalThis.localStorage.getItem(ONBOARDED_KEY) !== "1";
  } catch {
    return true;
  }
}

function markOnboarded(): void {
  try {
    globalThis.localStorage.setItem(ONBOARDED_KEY, "1");
  } catch {
    // localStorage 不可用就每次启动都引导一次，不影响正确性
  }
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

export function startApp(): () => void {
  if (started) return () => undefined;
  started = true;

  stopEvents = wireEvents();
  let wasConnected = false;

  stopPolling = pollConnection((info) => {
    const previous = getState().connection;
    setState({ connection: info });

    if (!info.connected && previous.connected) {
      setState({ stream: null });
    }
    if (!info.connected) wasConnected = false;

    if (info.connected && !booted && !booting) {
      void boot();
    } else if (info.connected && booted && !wasConnected && previous.connected === false) {
      void resync();
    }
    if (info.connected) wasConnected = true;
  });

  const onVisibility = (): void => {
    if (!document.hidden) void markReadNow();
  };
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    started = false;
    document.removeEventListener("visibilitychange", onVisibility);
    stopPolling?.();
    stopPolling = null;
    stopEvents?.();
    stopEvents = null;
    booted = false;
  };
}

async function boot(): Promise<void> {
  if (booting || booted) return;
  booting = true;
  setState({ booting: true, bootError: null });
  try {
    const info = await appInfo().catch(() => null);
    const appVersion = info?.version && info.version.length > 0 ? info.version : getState().appVersion;
    setState({ appVersion });

    const handshake = await invoke("client.handshake", { appVersion, platform: info?.platform ?? "win32" });
    setState({ kernelVersion: handshake.kernelVersion, dataDir: handshake.dataDir });

    await loadSnapshot();
    booted = true;

    const consent = getState().consent;
    if (!consent || consent.needsAccept) {
      setState({ phase: "consent" });
      return;
    }
    if (needsOnboarding()) {
      await loadPresets();
      setState({ phase: "onboarding" });
      return;
    }
    await enterChat();
  } catch (error) {
    const human = humanizeError(error);
    setState({
      bootError: human.hint ? `${human.title}（${human.hint}）` : human.title,
    });
  } finally {
    booting = false;
    setState({ booting: false });
  }
}

async function resync(): Promise<void> {
  appendLog({ ts: Date.now(), level: "info", source: "kernel", message: "内核连接恢复，开始重新同步状态" });
  try {
    await loadSnapshot();
    await loadHistory();
    setState({ stream: null });
  } catch (error) {
    const human = humanizeError(error);
    appendLog({ ts: Date.now(), level: "warn", source: "kernel", message: `重新同步失败：${human.title}` });
  }
}

/**
 * 健康状态里哪些算用户看得见的降级：「还没勾声明」是第一跑的预期状态，不当故障。
 */
function realDegraded(list: SystemHealth["degraded"]): DegradedNotice[] {
  return list
    .filter((item) => !item.reason.includes("同意《用户声明与风险告知》"))
    .map((item) => ({ pluginId: item.pluginId, reason: item.reason }));
}

async function loadSnapshot(): Promise<void> {
  const snapshot = await invoke("state.snapshot", {});
  setState({
    consent: snapshot.consent,
    owner: snapshot.owner,
    persona: snapshot.persona,
    relation: snapshot.relation,
    world: snapshot.world,
    drives: snapshot.drives,
    plugins: snapshot.plugins,
    channels: snapshot.channels,
    cost: snapshot.cost,
    health: snapshot.health,
    llm: snapshot.llm,
    kernelVersion: snapshot.handshake.kernelVersion,
    dataDir: snapshot.handshake.dataDir,
    agentAvatar: snapshot.agentAvatar ?? null,
    proactive: snapshot.proactive ?? null,
  });
  // 快照里的健康状态与 event.health 是同一份事实：启动时就该显示能力条，
  // 不能等下一次巡检推送，否则刚进主界面那几十秒像是「一切正常」。
  applyDegraded(realDegraded(snapshot.health?.degraded ?? []));
  void loadModelCatalog();
}

/** 拉一次多模型清单（模型页改完、聊天框切模型后都调它）。 */
export async function loadModelCatalog(): Promise<void> {
  try {
    const catalog = await invoke("models.list", {});
    applyModelCatalog(catalog);
  } catch {
    // 清单拉不到不影响聊天：只是选择器空着
  }
}

/** 重新拉一次快照：改完频率、重置完数据之后用它把界面上的数字对齐。 */
export async function refreshSnapshot(): Promise<void> {
  try {
    await loadSnapshot();
  } catch {
    // 快照拉不到不影响当前界面，下一次事件会补上
  }
}

async function enterChat(): Promise<void> {
  await Promise.all([loadHistory(), loadPresets(), loadWechatChats(), loadConversationSummaries()]);

  setState({ phase: "ready", unread: 0 });
  void markReadNow();
}

/**
 * 每条对话线各自缓存一份界面消息。
 * 之前切换会话只留一份 messages，切走再切回来等于从内核重拉一遍；内核慢或者
 * 刚好在回消息时，界面就先空着，看起来就是「聊天记录会消失」。现在先上缓存、
 * 后台再对齐，网络/内核抖动也不会把正在看的记录抹掉。
 */
const historyCache = new Map<string, ChatMessage[]>();

async function loadHistory(): Promise<void> {
  const conversation = getState().activeConversation;
  try {
    const result = await invoke("chat.history", {
      limit: HISTORY_PAGE,
      conversation,
    });
    const messages = [...result.messages].sort((left, right) => left.ts - right.ts || left.id - right.id);
    historyCache.set(conversation, messages);
    // 拉回来的时候用户可能已经切走了：别把 A 的历史盖到 B 的画面上
    if (getState().activeConversation !== conversation) return;
    setState({ messages, hasMoreHistory: result.hasMore });
  } catch (error) {
    const human = humanizeError(error);
    appendLog({ ts: Date.now(), level: "warn", source: "chat", message: `加载历史失败：${human.title}` });
    // 失败也不清屏：有缓存就继续显示缓存，别让用户以为记录没了
    if (getState().activeConversation === conversation && getState().messages.length === 0) {
      const cached = historyCache.get(conversation);
      if (cached && cached.length > 0) setState({ messages: cached });
    }
  }
}

/**
 * 内核里的对话被清掉之后，把界面上的那一段也清掉再重新拉。
 * 只删库不清界面，画面里还会挂着旧消息，看起来就像"重置没生效"。
 */
/** 切换会话（应用内 / 某个微信的人或群）：换一条对话线看历史。 */
export async function switchConversation(key: string): Promise<void> {
  const current = getState().activeConversation;
  if (current === key) {
    clearConversationUnread(key);
    return;
  }
  clearConversationUnread(key);
  // 先把当前这条线的消息存起来，切回去时不必等内核
  if (getState().messages.length > 0) historyCache.set(current, getState().messages);
  const cached = historyCache.get(key) ?? [];
  setState({ activeConversation: key, messages: cached, stream: null, hasMoreHistory: false, unread: 0 });
  await loadHistory();
}

/** 拉一次「可对话对象」，聊天页顶部的会话切换器用。 */
/** 拉每条会话线的摘要（最后一句 + 时间）：左侧列表用它，不受重启影响。 */
export async function loadConversationSummaries(): Promise<void> {
  try {
    const result = await invoke("chat.summaries", {});
    if (Array.isArray(result.summaries)) applyConversationSummaries(result.summaries);
  } catch {
    // 摘要只是列表装饰，失败不影响聊天
  }
}

export async function loadWechatChats(): Promise<void> {
  try {
    const status = await invoke("channels.wechat.status", {});
    if (Array.isArray(status.chats)) applyWechatChats(status.chats);
  } catch {
    // 通道没开就没有会话可切，这里静默
  }
}

export async function reloadChatView(): Promise<void> {
  historyCache.clear();
  setState({ messages: [], stream: null, hasMoreHistory: false, unread: 0 });
  await loadHistory();
}

async function loadPresets(): Promise<void> {
  setState({ presetsLoading: true });
  try {
    const result = await invoke("persona.presets", {});
    setState({ presets: result.presets });
  } catch (error) {
    const human = humanizeError(error);
    appendLog({ ts: Date.now(), level: "warn", source: "persona", message: `读取预设人格失败：${human.title}` });
  } finally {
    setState({ presetsLoading: false });
  }
}

/* ------------------------------------------------------------------ */
/* 声明闸与首次引导                                                    */
/* ------------------------------------------------------------------ */

export async function acceptConsent(checkedIds: string[]): Promise<void> {
  const consent = getState().consent;
  if (!consent) return;
  setState({ consentError: null });
  try {
    const updated = await invoke("consent.accept", { docVersion: consent.docVersion, checkedIds });
    setState({ consent: updated });
    if (updated.needsAccept) {
      setState({ consentError: "九条声明需要逐条勾选后才能进入。" });
      return;
    }
    booted = true;
    if (needsOnboarding()) {
      await loadPresets();
      setState({ phase: "onboarding" });
    } else {
      await enterChat();
    }
  } catch (error) {
    const human = humanizeError(error);
    setState({ consentError: human.hint ? `${human.title}（${human.hint}）` : human.title });
  }
}

export async function finishOnboarding(input: {
  presetId: string | null;
  name: string;
  city: string;
}): Promise<void> {
  if (getState().onboardingSaving) return;
  setState({ onboardingSaving: true });
  try {
    let persona = getState().persona;
    if (input.presetId) {
      persona = await invoke("persona.applyPreset", { presetId: input.presetId });
    } else if (!persona) {
      persona = await invoke("persona.get", {});
    }
    const name = input.name.trim();
    const city = input.city.trim();
    if (persona && name.length > 0 && (persona.name !== name || persona.city !== city)) {
      persona = await invoke("persona.update", { patch: { name, city: city.length > 0 ? city : persona.city } });
    }
    setState({ persona });
    markOnboarded();
    await enterChat();
  } catch (error) {
    const human = humanizeError(error);
    pushToast("error", human.title, human.hint);
  } finally {
    setState({ onboardingSaving: false });
  }
}

export async function quitApplication(): Promise<void> {
  try {
    await quitApp();
  } catch {
    globalThis.close();
  }
}

/* ------------------------------------------------------------------ */
/* 事件接线                                                            */
/* ------------------------------------------------------------------ */

/** 输入框里有没有正在打的字：决定要不要自动切会话。 */
function isTypingInComposer(): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (!active) return false;
  const tag = active.tagName;
  if (tag !== "TEXTAREA" && tag !== "INPUT") return false;
  const value = (active as HTMLTextAreaElement | HTMLInputElement).value ?? "";
  return value.trim().length > 0;
}

function wireEvents(): () => void {
  const cleanups: Array<() => void> = [];

  cleanups.push(
    subscribe("event.wechat", (payload) => {
      // 通道开/关、加/删对话对象都推全量状态：左侧会话列表跟着刷新
      if (Array.isArray(payload?.chats)) applyWechatChats(payload.chats);
    }),
  );

  cleanups.push(
    subscribe("event.message", (payload) => {
      // 会话隔离：别的会话线（别的微信对象、某个群）的消息不往当前列表里塞，
      // 否则"群里说的话会出现在私聊里"。切过去时 switchConversation 会重新拉历史。
      const channelId = typeof payload?.channelId === "string" ? payload.channelId.trim() : "";
      const key = channelId.length > 0 ? channelId : "app";
      if (key !== getState().activeConversation) {
        // 未读按会话线记：左侧列表上只有那条线冒红点，不混到当前对话里。
        bumpConversationUnread(key);
        // 正在打字时不抢走用户的对话框（"切到别的对话去"比漏看一条更烦）；
        // 输入框空着（手停了）才自动切过去，并补上这条消息。
        if (!isTypingInComposer()) {
          void switchConversation(key).then(() => {
            if (getState().activeConversation === key) upsertMessage(payload);
          });
        }
        return;
      }
      upsertMessage(payload);
      void loadConversationSummaries();
    }),
  );

  cleanups.push(
    subscribe("event.part", (payload) => {
      // 分条文本只走 event.message（气泡唯一真源）；这里只维持「正在输入」，
      // 不累积任何文本，否则同一句话会被 stream.parts 与 messages 各画一遍。
      setState((previous) => ({
        stream: {
          turnId: payload.turnId,
          typing: true,
          plannedMs: previous.stream?.plannedMs ?? null,
        },
      }));
    }),
  );

  cleanups.push(
    subscribe("event.typing", (payload) => {
      if (payload.state === "transcribe") {
        setState((previous) => ({
          stream: {
            turnId: previous.stream?.turnId ?? null,
            typing: true,
            plannedMs: null,
            transcribing: true,
          },
        }));
        return;
      }
      if (payload.state === "start") {
        setState((previous) => ({
          stream: {
            turnId: previous.stream?.turnId ?? null,
            typing: true,
            plannedMs: typeof payload.plannedMs === "number" ? payload.plannedMs : null,
          },
        }));
        return;
      }
      setState((previous) => ({
        stream: previous.stream ? { ...previous.stream, typing: false, plannedMs: null, transcribing: false } : null,
      }));
    }),
  );

  cleanups.push(
    subscribe("event.recall", (payload) => {
      setState((previous) => ({
        messages: previous.messages.map((message) =>
          message.id === payload.messageId
            ? { ...message, text: payload.replacement, recalled: true }
            : message,
        ),
      }));
    }),
  );

  cleanups.push(
    subscribe("event.presence", (payload) => {
      setState({ world: payload });
    }),
  );

  cleanups.push(
    subscribe("event.drives", (payload) => {
      setState({ drives: payload });
    }),
  );

  cleanups.push(
    subscribe("event.relation", (payload) => {
      setState({ relation: payload });
    }),
  );

  cleanups.push(
    subscribe("event.plugin", (payload) => {
      setState((previous) => {
        const exists = previous.plugins.some((plugin) => plugin.id === payload.id);
        const plugins = exists
          ? previous.plugins.map((plugin) => (plugin.id === payload.id ? payload : plugin))
          : [...previous.plugins, payload];
        return { plugins };
      });
    }),
  );

  // 运行环境（下载/校验/解包/切换）是内核侧的长任务：进度与结果都靠这条事件推进，
  // 面板只读 store，不再自己轮询。
  cleanups.push(
    subscribe("event.runtime", (payload) => {
      applyPluginRuntime(payload);
    }),
  );

  // 应用自身更新（软件整体）由主进程算状态：这里只订阅、只落 store，不自己轮询。
  // 桌面端才有 updates 能力（浏览器里跑 dev 时会缺失），所以要做存在性判断。
  if (window.anteros?.updates) {
    cleanups.push(window.anteros.updates.onEvent((status) => applyUpdateStatus(status)));
    void window.anteros.updates.status().then((status) => {
      if (status) applyUpdateStatus(status);
    });
  }

  cleanups.push(
    subscribe("event.channels", (payload) => {
      setState({ channels: payload });
    }),
  );

  cleanups.push(
    subscribe("event.consent", (payload) => {
      setState({ consent: payload });
      if (payload.needsAccept && getState().phase !== "connecting") {
        setState({ phase: "consent" });
      }
    }),
  );

  cleanups.push(
    subscribe("event.cost", (payload) => {
      setState({ cost: payload });
    }),
  );

  /**
   * 插件降级不是一次性错误，而是当前的能力状态：写进 store，由聊天页顶部的
   * 能力条常驻显示。界面只说「哪件事用不了」，`pluginId` 与原始原因留在
   * 管理面板 · 插件里给需要看的人看。
   * 「还没勾声明」是第一跑的预期状态，不当降级。
   */
  cleanups.push(
    subscribe("event.health", (payload) => {
      applyDegraded(realDegraded(payload.degraded));
    }),
  );

  cleanups.push(
    subscribe("event.notify", (payload) => {
      pushToast("info", payload.title, payload.body);
    }),
  );

  cleanups.push(
    subscribe("event.log", (payload) => {
      appendLog({ ts: payload.ts, level: payload.level, source: payload.source, message: payload.message });
    }),
  );

  cleanups.push(
    subscribe("event.proactive", (payload) => {
      appendLog({
        ts: Date.now(),
        level: "info",
        source: "proactive",
        message: `动作 #${payload.actionId} → ${payload.state}（${payload.reason}）`,
      });
    }),
  );

  cleanups.push(
    subscribe("event.turn", (payload) => {
      appendLog({ ts: Date.now(), level: "info", source: "turn", message: `回合 #${payload.turnId} 结束：${payload.outcome}` });
    }),
  );

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

function upsertMessage(message: ChatMessage): void {
  const isAgent = message.role === "agent";
  if (isAgent && document.hidden) {
    setState((previous) => ({ unread: previous.unread + 1 }));
  }
  setState((previous) => {
    const exists = previous.messages.some((item) => item.id === message.id);
    if (exists) {
      return {
        messages: previous.messages.map((item) => (item.id === message.id ? { ...item, ...message } : item)),
      };
    }
    // 自己发的消息：内核回声到达时把还在「发送中」的临时气泡摘掉，
    // 否则同一条话会在列表里躺两条（一条 pending、一条权威）。
    const withoutTemp =
      message.role === "user"
        ? previous.messages.filter(
            (item) =>
              !(item.id < 0 && item.delivery === "pending" && item.text === message.text && item.role === "user"),
          )
        : previous.messages;
    const messages = [...withoutTemp, message].sort(
      (left, right) => left.ts - right.ts || left.id - right.id,
    );
    return { messages };
  });
}

/* ------------------------------------------------------------------ */
/* 聊天动作                                                            */
/* ------------------------------------------------------------------ */

export async function sendMessage(rawText: string, quote: ChatMessage | null): Promise<boolean> {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) return false;
  const { connection, phase } = getState();
  if (!connection.connected || phase !== "ready") {
    pushToast("warn", "内核未连接，暂时无法发送", connection.message);
    return false;
  }

  const quoted = quote ? `> ${truncate(quote.text, 60)}\n` : "";
  const text = `${quoted}${trimmed}`;
  const eventId = newEventId();
  const tempId = nextTempId();
  const temp: ChatMessage = {
    id: tempId,
    role: "user",
    text,
    ts: Date.now(),
    turnId: null,
    partIndex: null,
    recalled: false,
    channelId: "app",
    delivery: "pending",
  };

  setState((previous) => ({ messages: [...previous.messages, temp], stream: null }));

  try {
    const result = await invoke("chat.send", {
      text,
      eventId,
      clientTs: temp.ts,
      presence: { isTyping: true, appFocused: document.hasFocus() },
      // 带上当前会话线：不然在别人的对话里打的字会落进应用内那条主线，
      // 看起来就是「这个对话框里出现了别的对话」。
      conversation: getState().activeConversation,
    });
    // 临时消息可能已被 event.message 的权威消息「顶替」进列表：先把 tempId 和
    // 真实 id 都摘掉，再补回内核返回的那条，保证任何时刻列表里 id 唯一（否则同一句话两条气泡）。
    setState((previous) => {
      const rest = previous.messages.filter(
        (item) => item.id !== tempId && item.id !== result.userMessage.id,
      );
      const messages = [...rest, result.userMessage].sort(
        (left, right) => left.ts - right.ts || left.id - right.id,
      );
      return { messages };
    });
    void markReadNow();
    return true;
  } catch (error) {
    setState((previous) => ({
      messages: previous.messages.map((item) =>
        item.id === tempId ? { ...item, delivery: "failed" } : item,
      ),
    }));
    const human = humanizeError(error);
    pushToast("error", human.title, human.hint);
    return false;
  }
}

/**
 * 发一条语音（文档 7.2）：先上传拿到 uploadId，再让内核把「音频 + 转写」当成一次正常输入。
 * 临时气泡先按本地时长画出来——录音那一刻就有峰值，不必等内核回声。
 */
export async function sendVoice(clip: RecordedClip): Promise<boolean> {
  const { connection, phase } = getState();
  if (!connection.connected || phase !== "ready") {
    pushToast("warn", "内核未连接，暂时无法发送", connection.message);
    return false;
  }
  let uploadId: string;
  try {
    uploadId = await uploadClip(clip);
  } catch (error) {
    const human = humanizeError(error);
    pushToast("error", "录音没能送进内核", human.hint ?? human.title);
    return false;
  }

  const eventId = newEventId();
  const tempId = nextTempId();
  const placeholder = voicePlaceholder({ durMs: clip.durMs });
  const temp: ChatMessage = {
    id: tempId,
    role: "user",
    text: placeholder,
    ts: Date.now(),
    turnId: null,
    partIndex: null,
    recalled: false,
    channelId: "app",
    delivery: "pending",
    attachment: {
      kind: "audio",
      path: "",
      mime: clip.mime,
      bytes: clip.blob.size,
      durMs: clip.durMs,
      peaks: clip.peaks,
      state: "ready",
    },
  };
  setState((previous) => ({ messages: [...previous.messages, temp], stream: null }));

  try {
    const result = await invoke("chat.send", {
      text: "",
      uploadId,
      eventId,
      clientTs: temp.ts,
      presence: { isTyping: false, appFocused: document.hasFocus() },
      conversation: getState().activeConversation,
    });
    setState((previous) => {
      const rest = previous.messages.filter((item) => item.id !== tempId && item.id !== result.userMessage.id);
      const messages = [...rest, result.userMessage].sort((left, right) => left.ts - right.ts || left.id - right.id);
      return { messages };
    });
    void markReadNow();
    return true;
  } catch (error) {
    setState((previous) => ({
      messages: previous.messages.map((item) => (item.id === tempId ? { ...item, delivery: "failed" } : item)),
    }));
    const human = humanizeError(error);
    pushToast("error", human.title, human.hint);
    return false;
  }
}

export async function resendMessage(message: ChatMessage): Promise<void> {
  setState((previous) => ({ messages: previous.messages.filter((item) => item.id !== message.id) }));
  await sendMessage(message.text, null);
}

export function deleteLocalMessage(message: ChatMessage): void {
  setState((previous) => ({ messages: previous.messages.filter((item) => item.id !== message.id) }));
}

/** 语音条重新合成成功后，把这一条气泡的 attachment 换成内核给的新值（不重拉整段历史）。 */
export function applyMessageAttachment(messageId: number, attachment: ChatMessage["attachment"]): void {
  setState((previous) => ({
    messages: previous.messages.map((item) => (item.id === messageId ? { ...item, attachment } : item)),
  }));
}

export async function loadOlderMessages(): Promise<void> {
  const snapshot = getState();
  if (snapshot.historyLoading || !snapshot.hasMoreHistory) return;
  const oldest = snapshot.messages.find((item) => item.id > 0);
  if (!oldest) return;

  setState({ historyLoading: true });
  try {
    const result = await invoke("chat.history", { limit: OLDER_PAGE, beforeTs: oldest.ts });
    const seen = new Set<number>();
    const merged = [...result.messages, ...getState().messages]
      .filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      })
      .sort((left, right) => left.ts - right.ts || left.id - right.id);
    setState({ messages: merged, hasMoreHistory: result.hasMore });
  } catch (error) {
    const human = humanizeError(error);
    pushToast("error", human.title, human.hint);
  } finally {
    setState({ historyLoading: false });
  }
}

export function markReadSoon(): void {
  if (markReadTimer !== null) return;
  markReadTimer = globalThis.setTimeout(() => {
    markReadTimer = null;
    void markReadNow();
  }, 600);
}

async function markReadNow(): Promise<void> {
  const { messages, unread } = getState();
  let latestTs = 0;
  for (const message of messages) {
    if (message.role !== "agent") continue;
    if (message.ts > latestTs) latestTs = message.ts;
  }
  if (latestTs > 0) {
    try {
      await invoke("chat.markRead", { lastTs: latestTs });
    } catch {
      // 已读回执不是关键路径：失败只说明内核暂时不可用，不打扰用户
    }
  }
  if (unread > 0) setState({ unread: 0 });
}

/* ------------------------------------------------------------------ */
/* 界面开关                                                            */
/* ------------------------------------------------------------------ */

export function openAdmin(tab: AdminTab = "owner"): void {
  setState({ adminOpen: true, adminTab: tab, searchOpen: false });
}

export function closeAdmin(): void {
  setState({ adminOpen: false });
}

export function setAdminTab(tab: AdminTab): void {
  setState({ adminTab: tab });
}

export function openSearch(): void {
  setState({ searchOpen: true, adminOpen: false });
}

export function closeSearch(): void {
  setState({ searchOpen: false });
}

export function focusMemory(item: MemoryItem | null): void {
  setState({ memoryFocus: item });
}

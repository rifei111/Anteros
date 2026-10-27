/**
 * 应用编排层：启动握手、快照、事件接线、发送/重发、分页历史、声明闸与引导的流转。
 *
 * 分层的原则：组件只调用这里的函数 + 读 store；这里只调用 `lib/kernel.ts`。
 */

import type { ChatMessage, KernelEvents, MemoryItem } from "@anteros/shared";
import { humanizeError } from "./errors";
import { invoke, newEventId, pollConnection, subscribe, appInfo, quitApp } from "./kernel";
import { appendLog, applyPluginRuntime, getState, pushToast, setState, type AdminTab } from "./store";
import { truncate } from "./format";

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
  });
}

async function enterChat(): Promise<void> {
  await Promise.all([loadHistory(), loadPresets()]);
  setState({ phase: "ready", unread: 0 });
  void markReadNow();
}

async function loadHistory(): Promise<void> {
  try {
    const result = await invoke("chat.history", { limit: HISTORY_PAGE });
    const messages = [...result.messages].sort((left, right) => left.ts - right.ts || left.id - right.id);
    setState({ messages, hasMoreHistory: result.hasMore });
  } catch (error) {
    const human = humanizeError(error);
    appendLog({ ts: Date.now(), level: "warn", source: "chat", message: `加载历史失败：${human.title}` });
  }
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

function wireEvents(): () => void {
  const cleanups: Array<() => void> = [];

  cleanups.push(
    subscribe("event.message", (payload) => {
      upsertMessage(payload);
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
        stream: previous.stream ? { ...previous.stream, typing: false, plannedMs: null } : null,
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
   * 插件降级提示：内核在启动/健康检查里会连着发几次 event.health，同一条降级会重复很多遍。
   * 这里做两件事：①「还没勾声明」是第一跑的预期状态，不当告警；②把 1.5 秒内的多次变化
   * 合并成一条，并且和上次报过的内容相同就不再弹。
   */
  let degradeTimer: number | null = null;
  let degradeShown = "";
  let degradePending: string[] = [];
  cleanups.push(
    subscribe("event.health", (payload) => {
      const real = payload.degraded.filter((item) => !item.reason.includes("同意《用户声明与风险告知》"));
      if (real.length === 0) return;
      degradePending = real.slice(0, 3).map((item) => `${item.pluginId}：${item.reason}`);
      if (degradeTimer !== null) window.clearTimeout(degradeTimer);
      degradeTimer = window.setTimeout(() => {
        degradeTimer = null;
        const text = degradePending.join("\n");
        if (text.length === 0 || text === degradeShown) return;
        degradeShown = text;
        const extra = real.length > 3 ? `\n…另有 ${real.length - 3} 个` : "";
        pushToast("warn", "有插件降级", text + extra);
      }, 1_500);
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

export async function resendMessage(message: ChatMessage): Promise<void> {
  setState((previous) => ({ messages: previous.messages.filter((item) => item.id !== message.id) }));
  await sendMessage(message.text, null);
}

export function deleteLocalMessage(message: ChatMessage): void {
  setState((previous) => ({ messages: previous.messages.filter((item) => item.id !== message.id) }));
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

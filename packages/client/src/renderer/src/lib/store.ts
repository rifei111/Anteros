/**
 * 轻量全局 store：一个不可变 state 对象 + `useSyncExternalStore`。
 *
 * - 不做 redux；所有写入都走 `setState`，保证引用变化可被 React 观察到
 * - 组件用 `useAppState()` 读整块状态（这个体量够用，不需要选择器缓存）
 * - toast / 滚动日志也在这里，避免每个面板自己造一套浮层
 */

import { useSyncExternalStore } from "react";
import type {
  ModelCatalog,
  ChatMessage,
  ConsentStatus,
  CostSummary,
  DriveState,
  LlmStatus,
  MemoryItem,
  OwnerStatus,
  Persona,
  PersonaPreset,
  PluginInfo,
  PluginRuntimeStatus,
  ProactiveSummary,
  ChannelInfo,
  RelationState,
  SystemHealth,
  WorldState,
} from "@anteros/shared";
import type { ConnectionInfo } from "./kernel";
import type { WechatChatTarget } from "@anteros/shared";
import type { UpdateStatusView } from "../../../common/protocol";

export type Phase = "connecting" | "consent" | "onboarding" | "ready";

export type AdminTab =
  | "owner"
  | "persona"
  | "plugins"
  | "channels"
  | "memory"
  | "expression"
  | "proactive"
  | "cost"
  | "model"
  | "models"
  | "advanced"
  | "update"
  | "data";

/**
 * 只记录「正在输入」的临时状态。
 *
 * 气泡的唯一真源是 `messages`（`event.message` → upsertMessage）；分条文本不在
 * 客户端累积，否则同一句话会被画两遍（stream.parts + messages 各一次）。
 */
export interface StreamView {
  turnId: number | null;
  /** 是否在「正在输入…」（只来自 event.typing / event.part，不自己造计时器） */
  typing: boolean;
  /** 内核给的预计打字时长（仅用于展示，不参与本地计时） */
  plannedMs: number | null;
}

export type ToastLevel = "info" | "success" | "warn" | "error";

export interface ToastItem {
  id: number;
  level: ToastLevel;
  title: string;
  detail: string | null;
}

export interface LogLine {
  ts: number;
  level: "debug" | "info" | "warn" | "error";
  source: string;
  message: string;
}

export interface AppState {
  phase: Phase;
  connection: ConnectionInfo;
  appVersion: string;
  kernelVersion: string | null;
  dataDir: string;
  bootError: string | null;
  booting: boolean;
  consent: ConsentStatus | null;
  consentError: string | null;
  persona: Persona | null;
  presets: PersonaPreset[];
  presetsLoading: boolean;
  relation: RelationState | null;
  world: WorldState | null;
  drives: DriveState | null;
  owner: OwnerStatus | null;
  llm: LlmStatus | null;
  /** 多模型清单（模型 + 任务类别路由 + 聊天框选择） */
  modelsCatalog: ModelCatalog | null;
  health: SystemHealth | null;
  cost: CostSummary | null;
  plugins: PluginInfo[];
  /** 插件运行环境状态：key 是 pluginId（`event.runtime` 与 `plugins.runtime.*` 都写这里） */
  pluginRuntime: Record<string, PluginRuntimeStatus>;
  /** 聊天对象头像（data URL）；null = 用名字首字 */
  agentAvatar: string | null;
  /** 主动消息档位摘要（常驻显示；管理面板关了也要看得见） */
  proactive: ProactiveSummary | null;
  /** 应用内更新状态（主进程推、界面只读）。 */
  updateStatus: UpdateStatusView | null;
  channels: ChannelInfo[];
  messages: ChatMessage[];
  /** 当前正在看的会话键：app 或 wechat:<username> */
  activeConversation: string;
  /** 微信通道里被设为可对话的对象（切换会话用） */
  wechatChats: WechatChatTarget[];
  hasMoreHistory: boolean;
  historyLoading: boolean;
  stream: StreamView | null;
  unread: number;
  adminOpen: boolean;
  adminTab: AdminTab;
  searchOpen: boolean;
  memoryFocus: MemoryItem | null;
  toasts: ToastItem[];
  logs: LogLine[];
  onboardingSaving: boolean;
}

const MAX_LOGS = 400;

const initialState: AppState = {
  phase: "connecting",
  connection: { connected: false, pipeName: "", kernelVersion: null, message: "正在启动内核…" },
  appVersion: "0.1.0",
  kernelVersion: null,
  dataDir: "",
  bootError: null,
  booting: false,
  consent: null,
  consentError: null,
  persona: null,
  presets: [],
  presetsLoading: false,
  relation: null,
  world: null,
  drives: null,
  owner: null,
  llm: null,
  modelsCatalog: null,
  health: null,
  cost: null,
  plugins: [],
  pluginRuntime: {},
  agentAvatar: null,
  proactive: null,
  updateStatus: null,
  channels: [],
  messages: [],
  activeConversation: "app",
  wechatChats: [],
  hasMoreHistory: false,
  historyLoading: false,
  stream: null,
  unread: 0,
  adminOpen: false,
  adminTab: "owner",
  searchOpen: false,
  memoryFocus: null,
  toasts: [],
  logs: [],
  onboardingSaving: false,
};

let state: AppState = initialState;
const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

type Patch = Partial<AppState> | ((previous: AppState) => Partial<AppState>);

export function setState(patch: Patch): void {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, getState, getState);
}

/* ------------------------------------------------------------------ */
/* 插件运行环境                                                        */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 应用内更新（软件整体）                                              */
/* ------------------------------------------------------------------ */

/** 主进程推来的更新状态：原样落到 store，界面只读；不做乐观更新。 */
export function applyUpdateStatus(status: UpdateStatusView): void {
  setState({ updateStatus: status });
}

/** 聊天对象头像：内核快照 / `ui.avatar.set` 返回值都走这里。 */
export function applyWechatChats(chats: WechatChatTarget[]): void {
  setState({ wechatChats: chats });
}

export function applyAgentAvatar(dataUrl: string | null): void {
  setState({ agentAvatar: dataUrl });
}

/** 主动消息档位摘要：快照与 `event.proactive` 之后的重拉都写这里。 */
export function applyProactiveSummary(summary: ProactiveSummary | null): void {
  setState({ proactive: summary });
}
/** 写入一条运行环境状态：`event.runtime` 推送与 RPC 返回值共走这一条路。 */
export function applyPluginRuntime(status: PluginRuntimeStatus): void {
  setState((previous) => ({
    pluginRuntime: { ...previous.pluginRuntime, [status.pluginId]: status },
  }));
}

/**
 * 更新源是全局配置（`plugins.runtime.feed` 不带插件 id）：保存成功后把所有已缓存的
 * 状态一起改掉，否则同一份更新源在两个插件卡片里会显示成两个地址。
 */
export function setRuntimeFeedUrl(url: string): void {
  setState((previous) => {
    const next: Record<string, PluginRuntimeStatus> = {};
    for (const [pluginId, status] of Object.entries(previous.pluginRuntime)) {
      next[pluginId] = { ...status, feedUrl: url };
    }
    return { pluginRuntime: next };
  });
}

/* ------------------------------------------------------------------ */
/* toast                                                               */
/* ------------------------------------------------------------------ */

let toastSeq = 0;

export function pushToast(level: ToastLevel, title: string, detail: string | null = null): void {
  // 同样的提示已经在栈里就不再叠一条：健康巡检会反复上报同一批降级插件，
  // 叠成四条只会把界面盖住，对用户没有新信息。
  const duplicate = getState().toasts.some(
    (toast) => toast.level === level && toast.title === title && (toast.detail ?? null) === detail,
  );
  if (duplicate) return;

  const id = ++toastSeq;
  setState((previous) => ({ toasts: [...previous.toasts, { id, level, title, detail }] }));
  const ttl = level === "error" ? 9_000 : level === "warn" ? 6_000 : 4_000;
  globalThis.setTimeout(() => {
    dismissToast(id);
  }, ttl);
}

export function dismissToast(id: number): void {
  setState((previous) => ({ toasts: previous.toasts.filter((toast) => toast.id !== id) }));
}

/* ------------------------------------------------------------------ */
/* 滚动日志（高级面板用，绝不进聊天气泡）                              */
/* ------------------------------------------------------------------ */

export function appendLog(line: LogLine): void {
  setState((previous) => {
    const next = [...previous.logs, line];
    return { logs: next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next };
  });
}

export function clearLogs(): void {
  setState({ logs: [] });
}

/* ------------------------------------------------------------------ */
/* 多模型                                                              */
/* ------------------------------------------------------------------ */

/** 内核推来的模型清单：整块替换（清单很小，不值得做 diff）。 */
export function applyModelCatalog(catalog: ModelCatalog | null): void {
  setState({ modelsCatalog: catalog });
}
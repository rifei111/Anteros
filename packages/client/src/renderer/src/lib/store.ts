/**
 * 轻量全局 store：一个不可变 state 对象 + `useSyncExternalStore`。
 *
 * - 不做 redux；所有写入都走 `setState`，保证引用变化可被 React 观察到
 * - 组件用 `useAppState()` 读整块状态（这个体量够用，不需要选择器缓存）
 * - toast / 滚动日志也在这里，避免每个面板自己造一套浮层
 */

import { useSyncExternalStore } from "react";
import type {
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
  ChannelInfo,
  RelationState,
  SystemHealth,
  WorldState,
} from "@anteros/shared";
import type { ConnectionInfo } from "./kernel";

export type Phase = "connecting" | "consent" | "onboarding" | "ready";

export type AdminTab =
  | "owner"
  | "plugins"
  | "channels"
  | "memory"
  | "expression"
  | "proactive"
  | "cost"
  | "model"
  | "advanced"
  | "data";

export interface StreamView {
  turnId: number | null;
  /** 已到达的分条文本（临时气泡，收到 event.message 后替换为权威消息） */
  parts: string[];
  /** 是否在「正在输入…」（只来自 event.typing，不自己造计时器） */
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
  health: SystemHealth | null;
  cost: CostSummary | null;
  plugins: PluginInfo[];
  channels: ChannelInfo[];
  messages: ChatMessage[];
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
  health: null,
  cost: null,
  plugins: [],
  channels: [],
  messages: [],
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
/* toast                                                               */
/* ------------------------------------------------------------------ */

let toastSeq = 0;

export function pushToast(level: ToastLevel, title: string, detail: string | null = null): void {
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

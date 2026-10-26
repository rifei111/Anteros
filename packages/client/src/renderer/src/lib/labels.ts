/** 领域枚举 → 中文标签（界面文案集中在这里，避免各面板各写一套）。 */

import type {
  ActionState,
  Importance,
  MemoryKind,
  PluginRisk,
  PluginStatus,
  PresenceState,
  RelationStage,
} from "@anteros/shared";

export const RELATION_STAGE_LABEL: Record<RelationStage, string> = {
  stranger: "陌生",
  acquainted: "认识",
  familiar: "熟悉",
  close: "亲密",
  strained: "疏远",
  repairing: "修复中",
};

export const PRESENCE_LABEL: Record<PresenceState, string> = {
  phone_in_hand: "在手机旁",
  idle: "空闲",
  busy: "忙",
  sleep: "睡了",
  away: "不在",
};

export const PRESENCE_TONE: Record<PresenceState, string> = {
  phone_in_hand: "ok",
  idle: "ok",
  busy: "warn",
  sleep: "muted",
  away: "muted",
};

export const PLUGIN_STATUS_LABEL: Record<PluginStatus, string> = {
  invalid: "声明无效",
  disabled: "已停用",
  blocked: "被阻断",
  enabled: "已启用",
  running: "运行中",
  degraded: "降级",
  crashed: "已崩溃",
};

export const RISK_LABEL: Record<PluginRisk, string> = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
};

export const KIND_LABEL: Record<MemoryKind, string> = {
  episodic: "情节记忆",
  semantic: "结构事实",
  open_loop: "未闭合话题",
  persona: "人格设定",
};

export const IMPORTANCE_LABEL: Record<Importance, string> = {
  redline: "红线",
  important: "重要",
  detail: "细节",
};

export const ACTION_STATE_LABEL: Record<ActionState, string> = {
  queued: "排队中",
  quarantined: "已隔离",
  dispatched: "已发出",
  cancelled: "已取消",
  expired: "已过期",
};

export const ACTION_REASON_LABEL: Record<string, string> = {
  share: "想分享",
  open_loop: "旧话题",
  time_anchor: "时间点",
  state_change: "状态变化",
  impulse: "冲动",
  prequel: "前情",
};

export const DRIVE_LABEL: Record<string, string> = {
  loneliness: "孤独",
  boredom: "无聊",
  longing: "想念",
  tension: "紧张",
  fatigue: "疲惫",
  urgeToShare: "分享欲",
  anxiety: "不安",
};

/** 未知枚举值兜底：宁可显示原始值，也不说假话。 */
export function labelOf(map: Record<string, string>, key: string | null | undefined): string {
  if (!key) return "—";
  return map[key] ?? key;
}

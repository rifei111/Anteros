/** 时间、金额、字节等展示格式化（一律用本地时区，UTC 只存在于内核）。 */

const pad = (value: number): string => String(value).padStart(2, "0");

/** HH:mm */
export function formatClock(ts: number): string {
  const date = new Date(ts);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** YYYY-MM-DD HH:mm */
export function formatDateTime(ts: number | null | undefined): string {
  if (typeof ts !== "number" || ts <= 0) return "—";
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${formatClock(ts)}`;
}

/** 日期分隔：今天 / 昨天 / YYYY-MM-DD */
export function formatDayLabel(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const startOfDay = (value: Date): number =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 相邻消息间隔 ≥5 分钟才插一条居中的时间戳（仿微信）。 */
export function shouldShowTimestamp(previousTs: number | null, currentTs: number): boolean {
  if (previousTs === null) return true;
  return currentTs - previousTs >= 5 * 60 * 1000;
}

export function formatCny(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `¥${safe.toFixed(2)}`;
}

export function formatPercent(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${(safe * 100).toFixed(0)}%`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index] ?? "B"}`;
}

/** 相对时间：刚刚 / 3 分钟前 / 2 小时前 / 昨天 HH:mm / YYYY-MM-DD */
export function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 2 * 86_400_000) return `昨天 ${formatClock(ts)}`;
  return formatDateTime(ts);
}

export function truncate(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}…`;
}

/** 会话列表里的时间：今天显示 HH:mm，昨天显示「昨天」，更早显示日期。 */
export function formatListTime(ts: number | null): string {
  if (typeof ts !== "number" || ts <= 0) return "";
  const now = new Date();
  const date = new Date(ts);
  const sameDay =
    now.getFullYear() === date.getFullYear() &&
    now.getMonth() === date.getMonth() &&
    now.getDate() === date.getDate();
  if (sameDay) return formatClock(ts);
  const dayLabel = formatDayLabel(ts);
  return dayLabel === "昨天" ? "昨天" : `${date.getMonth() + 1}/${date.getDate()}`;
}

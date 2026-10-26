/** 时间工具：内部一律 UTC 毫秒，人味计算用当地时间（规范 1 §0 硬约束 1）。 */

export function nowMs(): number {
  return Date.now();
}

export interface LocalTimeParts {
  hour: number;
  minute: number;
  weekday: number;
  ymd: string;
  timestamp: number;
}

export function localParts(ts: number, tz: string): LocalTimeParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = new Map(formatter.formatToParts(new Date(ts)).map((part) => [part.type, part.value]));
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    hour: Number(parts.get("hour") ?? "0"),
    minute: Number(parts.get("minute") ?? "0"),
    weekday: Math.max(0, weekdayNames.indexOf(parts.get("weekday") ?? "Sun")),
    ymd: `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`,
    timestamp: ts,
  };
}

/** 当天 00:00（当地时间）对应的 UTC 毫秒。 */
export function startOfLocalDay(ts: number, tz: string): number {
  const p = localParts(ts, tz);
  const guess = ts - ((p.hour * 3600 + p.minute * 60) * 1000 + (ts % 60_000));
  return guess;
}

export function formatLocal(ts: number, tz: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ts));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
/**
 * 世界时钟（草案 3.1 / 3.5 / 3.7，规范 1 §3.1）。
 *
 * 单一主时钟：由本地时间 + 日程 + 慢变量推出「现在几号、几点、什么时段、在不在、
 * 大概什么状态」。所有"人味计算"用 users.tz 当地时间（禁 UTC 直判）。
 *
 * 冷启动口径（草案 3.7 / 用户 2026-10 指示）：
 *   - life.allowOwnRoutine 默认 false → **不生成"正在做的事"**，schedule 返回
 *     undefined，prompt 里不许出现编造的物理事实；
 *   - 天气默认 null（不编），只在有真实数据源时才填；
 *   - 能量/情绪是慢变量：有限幅、受时间与对话密度影响，不迁怒。
 */
import type { PresenceState, ScheduleSlot, WorldState } from "@anteros/shared";
import type { Db } from "../db/database.js";
import type { KernelDeps } from "../contracts.js";
import type { PersonaService } from "./persona.js";
import type { PresenceService } from "./presence.js";
import { clamp, localParts, startOfLocalDay } from "../util/time.js";
import { SettingsService } from "../settings.js";

export type Daypart = WorldState["daypart"];

export function daypartOf(hour: number): Daypart {
  if (hour < 5) return "late_night";
  if (hour < 9) return "morning";
  if (hour < 12) return "noon";
  if (hour < 17) return "afternoon";
  if (hour < 20) return "evening";
  return "night";
}

export const DAYPART_LABEL: Record<Daypart, string> = {
  late_night: "凌晨",
  morning: "早上",
  noon: "上午",
  afternoon: "下午",
  evening: "傍晚",
  night: "晚上",
};

/**
 * 真实时间锚点（只做公历节日 + 节气近似日；农历节日无依赖库，不做）。
 * 节气取常见近似日期（±1 天，不当作精确天文时刻——它只用于"今天是什么日子"
 * 这种低风险叙述，草案 3.1 允许）。
 */
const GREGORIAN_ANCHORS: ReadonlyArray<readonly [number, number, string]> = [
  [1, 1, "元旦"],
  [2, 14, "情人节"],
  [3, 8, "妇女节"],
  [5, 1, "劳动节"],
  [6, 1, "儿童节"],
  [10, 1, "国庆"],
  [12, 25, "圣诞"],
];

const SOLAR_TERMS: ReadonlyArray<readonly [number, number, string]> = [
  [1, 6, "小寒"], [1, 20, "大寒"], [2, 4, "立春"], [2, 19, "雨水"],
  [3, 5, "惊蛰"], [3, 20, "春分"], [4, 4, "清明"], [4, 20, "谷雨"],
  [5, 5, "立夏"], [5, 21, "小满"], [6, 5, "芒种"], [6, 21, "夏至"],
  [7, 7, "小暑"], [7, 23, "大暑"], [8, 7, "立秋"], [8, 23, "处暑"],
  [9, 7, "白露"], [9, 23, "秋分"], [10, 8, "寒露"], [10, 23, "霜降"],
  [11, 7, "立冬"], [11, 22, "小雪"], [12, 7, "大雪"], [12, 22, "冬至"],
];

export function timeAnchorOf(ymd: string): string | undefined {
  const [, monthRaw, dayRaw] = ymd.split("-");
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!Number.isFinite(month) || !Number.isFinite(day)) return undefined;
  for (const [m, d, label] of SOLAR_TERMS) if (m === month && d === day) return label;
  for (const [m, d, label] of GREGORIAN_ANCHORS) if (m === month && d === day) return label;
  // 节气/节日的次日常见描述：元旦第二天、圣诞后一天这类不编，直接不给锚点
  return undefined;
}

interface SlowVars {
  energy: number;
  valence: number;
  arousal: number;
  updatedTs: number;
}

const DEFAULT_SLOW: Omit<SlowVars, "updatedTs"> = { energy: 0.6, valence: 0.05, arousal: 0.45 };

/** 白天各时段的能量目标（昼夜节律；不是真实生理模型，只是"像个有作息的人"）。 */
function energyTarget(daypart: Daypart): number {
  switch (daypart) {
    case "late_night":
      return 0.08;
    case "morning":
      return 0.72;
    case "noon":
      return 0.62;
    case "afternoon":
      return 0.5;
    case "evening":
      return 0.45;
    case "night":
      return 0.3;
  }
}

function arousalTarget(daypart: Daypart): number {
  switch (daypart) {
    case "late_night":
      return 0.2;
    case "morning":
      return 0.5;
    case "noon":
      return 0.55;
    case "afternoon":
      return 0.45;
    case "evening":
      return 0.5;
    case "night":
      return 0.38;
  }
}

const DEFAULT_ROUTINE: ReadonlyArray<{ start: number; end: number; activity: string; presence: PresenceState; publicNarratable: boolean }> = [
  // 插画师作息偏晚：10:30 才起，下午赶稿（忙），晚上看电影/打游戏
  { start: 10 * 60 + 30, end: 12 * 60, activity: "起床、随便弄点吃的", presence: "idle", publicNarratable: false },
  { start: 13 * 60, end: 18 * 60, activity: "画画、赶稿", presence: "busy", publicNarratable: true },
  { start: 19 * 60 + 30, end: 22 * 60 + 30, activity: "看电影或打游戏", presence: "idle", publicNarratable: false },
];

function localMinutes(now: number, tz: string): number {
  const parts = localParts(now, tz);
  return parts.hour * 60 + parts.minute;
}

export interface WorldSnapshot {
  world: WorldState;
  busy: boolean;
}

export class WorldService {
  private readonly db: Db;
  private readonly settings: SettingsService;

  constructor(
    private readonly deps: KernelDeps,
    private readonly persona: PersonaService,
    private readonly presence: PresenceService,
  ) {
    this.db = deps.db;
    this.settings = new SettingsService(deps.db);
  }

  get(now: number): WorldSnapshot {
    return this.compute(now, false);
  }

  /** 推进慢变量（世界 tick；幂等：按 now 计算，累计不超过 24h）。 */
  tick(now: number): WorldSnapshot {
    return this.compute(now, true);
  }

  private compute(now: number, persist: boolean): WorldSnapshot {
    const local = localParts(now, this.deps.tz);
    const daypart = daypartOf(local.hour);
    const allowRoutine = this.settings.get("life.allowOwnRoutine") === true;
    const schedule = allowRoutine ? this.scheduleFor(now) : undefined;
    const busy = schedule !== undefined && schedule.some((slot) => slot.startTs <= now && slot.endTs > now && slot.presence === "busy");

    const presenceSnap = this.presence.get(now, busy);
    const slow = this.evolveSlow(now, daypart);
    if (persist) this.writeSlow(slow, now);

    const world: WorldState = {
      nowTs: now,
      localIso: `${local.ymd} ${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`,
      tz: this.deps.tz,
      daypart,
      timeAnchor: timeAnchorOf(local.ymd),
      presence: presenceSnap.state,
      presenceSinceTs: presenceSnap.sinceTs,
      energy: slow.energy,
      moodValence: slow.valence,
      moodArousal: slow.arousal,
      schedule,
      lifeSimulationEnabled: allowRoutine,
    };
    return { world, busy };
  }

  /**
   * 日程：开了生活模拟才给；先读 life_calendar，没有就按人设生成一份默认作息。
   * 生成的只是"它自己大概在做什么"，不虚构用户日程，也不许当作可当面验证的
   * 物理事实（publicNarratable=false 的槽位不进 prompt）。
   */
  private scheduleFor(now: number): ScheduleSlot[] {
    const start = startOfLocalDay(now, this.deps.tz);
    const end = start + 86_400_000;
    const rows = this.db.all<{
      start_ts: number;
      end_ts: number;
      activity: string;
      public: number;
      source: string;
      location_tag: string | null;
    }>(
      "SELECT start_ts, end_ts, activity, public, source, location_tag FROM life_calendar WHERE agent_id = ? AND end_ts > ? AND start_ts < ? ORDER BY start_ts",
      [this.deps.agentId, start, end],
    );
    if (rows.length > 0) {
      return rows.map((row) => ({
        startTs: row.start_ts,
        endTs: row.end_ts,
        activity: row.activity,
        presence: this.presenceOfActivity(row.activity),
        publicNarratable: row.public === 1,
        source: row.source === "synced" || row.source === "generated" ? row.source : "persona",
      }));
    }
    // 默认作息按当地 00:00 偏移生成（当地时间，不是 UTC）
    return DEFAULT_ROUTINE.map((slot) => ({
      startTs: start + slot.start * 60_000,
      endTs: start + slot.end * 60_000,
      activity: slot.activity,
      presence: slot.presence,
      publicNarratable: slot.publicNarratable,
      source: "persona" as const,
    }));
  }

  private presenceOfActivity(activity: string): PresenceState {
    if (/(会|谈事|上班|赶稿|赶工|开会|面试|忙|工作)/u.test(activity)) return "busy";
    if (/(睡|休息)/u.test(activity)) return "sleep";
    return "idle";
  }

  /**
   * 慢变量演化：能量向昼夜目标靠拢，情绪向基线靠拢；对话密度抬高唤醒度，
   * 冲突期（strained）压低效价。限幅：单次 tick 最多推进 24h，避免机器休眠
   * 后一夜之间属性跳变。
   */
  private evolveSlow(now: number, daypart: Daypart): SlowVars {
    const stored = this.db.getJson<SlowVars | null>(`mind.world:${this.deps.agentId}`, null);
    const base: SlowVars = stored === null ? { ...DEFAULT_SLOW, updatedTs: now - 3_600_000 } : stored;
    const hours = clamp((now - base.updatedTs) / 3_600_000, 0, 24);
    if (hours <= 0) return base;

    const recentMessages = this.db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM messages WHERE agent_id = ? AND ts >= ?",
      [this.deps.agentId, now - 2 * 3_600_000],
    );
    const relation = this.db.get<{ stage: string }>("SELECT stage FROM relation_state WHERE agent_id = ?", [this.deps.agentId]);
    const strained = relation?.stage === "strained";

    const energyDelta = (energyTarget(daypart) - base.energy) * Math.min(1, 0.35 * hours);
    const energy = clamp(base.energy + energyDelta, 0.02, 1);

    // 情绪：向基线回归；对话密度与冲突是外部推力
    const densityPush = clamp((recentMessages?.c ?? 0) / 8, 0, 1) * 0.06;
    const valenceTarget = strained ? -0.35 : 0.08;
    const valence = clamp(base.valence + (valenceTarget - base.valence) * Math.min(1, 0.25 * hours) + densityPush * Math.min(1, hours), -1, 1);
    const arousal = clamp(base.arousal + (arousalTarget(daypart) - base.arousal) * Math.min(1, 0.3 * hours) + densityPush, 0, 1);

    // updatedTs 不在这里推进：tick() 落库时会写入 now，get() 只读不写。
    // （若这里伪造"部分推进"，慢变量会以错误的 elapsed 反复演化。）
    return { energy, valence, arousal, updatedTs: base.updatedTs };
  }

  private writeSlow(slow: SlowVars, now: number): void {
    this.db.setJson(`mind.world:${this.deps.agentId}`, { ...slow, updatedTs: now });
  }

  /** 情绪软表述素材（给表达层转成人话，不直接进 prompt 的数字）。 */
  moodWords(slow: { valence: number; arousal: number }): string {
    const { valence, arousal } = slow;
    if (valence <= -0.4) return arousal > 0.5 ? "有点烦躁" : "有点低落";
    if (valence <= -0.15) return arousal > 0.5 ? "不太提得起劲" : "情绪偏低";
    if (valence >= 0.4) return arousal > 0.5 ? "心情挺好" : "心里挺松的";
    if (valence >= 0.15) return arousal > 0.5 ? "状态不错" : "比较平静";
    return arousal > 0.55 ? "有点坐不住" : "平平的";
  }

  /** 能量软表述（不暴露数值）。 */
  static energyWord(energy: number): string {
    if (energy >= 0.7) return "精神还不错";
    if (energy >= 0.45) return "正常电量";
    if (energy >= 0.25) return "有点乏";
    return "电量很低";
  }
}

/**
 * 在场状态机（规范 1 §3.4，草案 3.1 / 4.4）。
 *
 * 优先级（冲突取更保守的那个）：
 *   sleep(23:30–07:30 本地时间) > busy(日程会议) > phone_in_hand(最近 5 分钟有交互)
 *   > idle(3 小时内有交互/白天普通状态) > away(长时间没交互)
 *
 * "保守"的含义：能少说就少说——睡了就不回、忙就短答、不在就晚回，
 * 而不是"在线就秒回"。所有时间判断都用 users.tz 的当地时间。
 */
import type { PresenceState } from "@anteros/shared";
import type { Db } from "../db/database.js";
import type { KernelDeps } from "../contracts.js";
import { localParts } from "../util/time.js";

/** 睡眠窗口：本地 23:30 – 次日 07:30（草案 3.1）。 */
export const SLEEP_START_MINUTES = 23 * 60 + 30;
export const SLEEP_END_MINUTES = 7 * 60 + 30;

/** phone_in_hand 的判定窗口：最近 5 分钟有交互（草案 4.4）。 */
export const PHONE_WINDOW_MS = 5 * 60_000;
/** 超过这么久没交互就当作不在（away）。 */
export const AWAY_WINDOW_MS = 3 * 60 * 60_000;

export interface PresenceInput {
  now: number;
  tz: string;
  /** 日程里当前正是会议/忙 */
  busy: boolean;
  /** 最近一次任意交互（用户或它自己发消息）的 ts；没有则为 null */
  lastInteractionTs: number | null;
}

export function minutesOfDay(hour: number, minute: number): number {
  return hour * 60 + minute;
}

export function isSleepWindow(hour: number, minute: number): boolean {
  const at = minutesOfDay(hour, minute);
  // 跨零点：23:30–24:00 或 00:00–07:30
  return at >= SLEEP_START_MINUTES || at < SLEEP_END_MINUTES;
}

export function resolvePresence(input: PresenceInput): PresenceState {
  const local = localParts(input.now, input.tz);
  if (isSleepWindow(local.hour, local.minute)) return "sleep";
  if (input.busy) return "busy";
  const last = input.lastInteractionTs;
  if (last !== null && input.now - last <= PHONE_WINDOW_MS) return "phone_in_hand";
  if (last !== null && input.now - last <= AWAY_WINDOW_MS) return "idle";
  return "away";
}

export const PRESENCE_LABEL: Record<PresenceState, string> = {
  phone_in_hand: "手机在手上（回得快，但句子短）",
  idle: "闲着（能聊一会儿，但不一定秒回）",
  busy: "在忙（先简短回应，长内容晚点说）",
  sleep: "睡了（别回，等醒了再说）",
  away: "不在（可能过一阵才看到）",
};

export interface PresenceSnapshot {
  state: PresenceState;
  sinceTs: number;
  confidence: number;
  source: "behavior" | "calendar" | "default";
}

interface PresenceRow {
  agent_id: number;
  state: string;
  since_ts: number;
  confidence: number;
  source: string;
}

const STATES: readonly PresenceState[] = ["phone_in_hand", "idle", "busy", "sleep", "away"];

function validState(state: string): PresenceState {
  return STATES.includes(state as PresenceState) ? (state as PresenceState) : "idle";
}

function validSource(source: string): PresenceSnapshot["source"] {
  return source === "behavior" || source === "calendar" ? source : "default";
}

export class PresenceService {
  private readonly db: Db;

  constructor(private readonly deps: KernelDeps) {
    this.db = deps.db;
  }

  /** 最近一次交互（任意角色消息）；没有则 null。 */
  lastInteractionTs(): number | null {
    const row = this.db.get<{ ts: number | null }>("SELECT MAX(ts) AS ts FROM messages WHERE agent_id = ?", [this.deps.agentId]);
    return row?.ts ?? null;
  }

  /**
   * 按当前时间算出在场并落库（幂等：状态不变时保留 since_ts，
   * 这样客户端看到的"在线多久了"不会每轮对话都重置）。
   */
  get(now: number, busy: boolean): PresenceSnapshot {
    const row = this.read();
    const resolved = resolvePresence({ now, tz: this.deps.tz, busy, lastInteractionTs: this.lastInteractionTs() });
    if (resolved === row.state) {
      return { state: resolved, sinceTs: row.sinceTs, confidence: row.confidence, source: validSource(row.source) };
    }
    const source: PresenceSnapshot["source"] = resolved === "busy" ? "calendar" : "default";
    // 从"睡/忙/不在"这类状态里出来时置信度低一点（刚切换，行为还没印证）
    this.write(resolved, now, 0.55, source);
    return { state: resolved, sinceTs: now, confidence: 0.55, source };
  }

  /** 行为触发的在场更新（用户正在输入、应用聚焦等）。 */
  touch(state: PresenceState, source: "behavior" | "calendar" | "default", now: number): void {
    if (!STATES.includes(state)) throw new Error(`非法在场状态：${String(state)}`);
    const row = this.read();
    if (row.state === state) {
      // 同一状态只刷新置信度，不动 since_ts
      this.db.run("UPDATE presence_state SET confidence = MIN(1, confidence + 0.1), source = ? WHERE agent_id = ?", [source, this.deps.agentId]);
      return;
    }
    this.write(state, now, 0.8, source);
  }

  private write(state: PresenceState, sinceTs: number, confidence: number, source: PresenceSnapshot["source"]): void {
    this.db.run(
      "INSERT INTO presence_state(agent_id, state, since_ts, confidence, source) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(agent_id) DO UPDATE SET state = excluded.state, since_ts = excluded.since_ts, confidence = excluded.confidence, source = excluded.source",
      [this.deps.agentId, state, sinceTs, confidence, source],
    );
  }

  private read(): PresenceSnapshot {
    const row = this.db.get<PresenceRow>("SELECT * FROM presence_state WHERE agent_id = ?", [this.deps.agentId]);
    if (row !== undefined) {
      return { state: validState(row.state), sinceTs: row.since_ts, confidence: row.confidence, source: validSource(row.source) };
    }
    const now = Date.now();
    this.write("idle", now, 0.4, "default");
    return { state: "idle", sinceTs: now, confidence: 0.4, source: "default" };
  }
}

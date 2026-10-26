/**
 * 主动层的候选动作（草案 5.4 / 5.7，规范 1 §3.6）。
 *
 * 这里只产出"由头"（reason + payload 素材），不产出一句具体发言，更不编造
 * 物理事实：所有素材都必须是"站得住"的——记忆里真发生过的事、真实的节日/
 * 节气、真实越阈的内部状态。措辞原则：能说"想到你上次说的…"，不能说
 * "我刚在楼下看到…"（除非世界层真的有 synced 的日程/数据）。
 *
 * 五类：open_loop（未闭合话题）、time_anchor（时间锚点）、state_change
 * （内部状态变化）、share（想分享）、impulse（无理由冲动，每日 ≤2 次）。
 */
import type { ActionItem, DriveState, MemoryItem, Persona, RelationState, WorldState } from "@anteros/shared";
import type { Db } from "../db/database.js";
import type { KernelDeps } from "../contracts.js";
import { Rng } from "../util/rng.js";
import { localParts, startOfLocalDay } from "../util/time.js";
import { DRIVE_LABEL, type DriveName } from "./drives.js";
import { stagePhrase } from "./relation.js";

export type ActionReason = "open_loop" | "time_anchor" | "state_change" | "share" | "impulse";

export interface ActionCandidateInput {
  now: number;
  persona: Persona;
  relation: RelationState;
  world: WorldState;
  drives: DriveState;
  crossed: Array<{ name: DriveName; value: number; threshold: number }>;
  openLoops: MemoryItem[];
  /** 最近 24h 用户说过的重要情节（redline/important） */
  recentUserMemories: MemoryItem[];
  db: Db;
  agentId: number;
  tz: string;
}

/** impulse 的日上限（草案 5.7：无理由冲动每日最多 2 次，且不补发）。 */
export const MAX_IMPULSES_PER_DAY = 2;

function makeItem(
  kind: ActionItem["kind"],
  reason: ActionReason,
  payload: Record<string, unknown>,
  now: number,
  ttlMs: number,
): ActionItem {
  return {
    id: 0,
    kind,
    payload: { reason, ...payload },
    createdTs: now,
    deadlineTs: now + ttlMs,
    ttlMs,
    state: "queued",
    reason,
  };
}

const DRIVE_HINT: Partial<Record<DriveName, string>> = {
  loneliness: "有点想找你说话，但别显得太急",
  longing: "想起你，想问一句近况",
  boredom: "闲下来，想找点话说",
  urgeToShare: "有件小事想跟你说",
  tension: "心里有点绷着，想确认你还好",
  anxiety: "有点悬着，想听你说一句没事",
  fatigue: "累了，想跟人说一声",
};

/** 当日已发生的冲动次数（含 dispatched/expired，防"重试补发"）。 */
function impulsesToday(db: Db, agentId: number, now: number, tz: string): number {
  const start = startOfLocalDay(now, tz);
  return db.get<{ c: number }>("SELECT COUNT(*) AS c FROM action_queue WHERE agent_id = ? AND kind = 'impulse' AND created_ts >= ?", [agentId, start])?.c ?? 0;
}

export function buildCandidates(input: ActionCandidateInput): ActionItem[] {
  const { now, relation, world, openLoops, recentUserMemories } = input;
  const candidates: ActionItem[] = [];

  // 1) 内部状态变化：drive 越阈（最强信号，排最前）
  const strongest = [...input.crossed].sort((a, b) => b.value / b.threshold - a.value / a.threshold)[0];
  if (strongest !== undefined) {
    const hint = DRIVE_HINT[strongest.name] ?? DRIVE_LABEL[strongest.name];
    candidates.push(
      makeItem("proactive", "state_change", { drive: strongest.name, hint, reason_text: hint }, now, 2 * 3_600_000),
    );
  } else if (relation.lastTransitionTs !== null && now - relation.lastTransitionTs <= 6 * 3_600_000) {
    candidates.push(
      makeItem("proactive", "state_change", {
        relation: relation.stage,
        hint: `关系刚变成「${relation.stage}」，可以顺着这个气氛说点什么；别点破状态本身`,
        reason_text: stagePhrase(relation.stage),
      }, now, 6 * 3_600_000),
    );
  }

  // 2) 未闭合话题：拖着没完的事
  const loop = [...openLoops].sort((a, b) => (b.urgency ?? 0) - (a.urgency ?? 0))[0];
  if (loop !== undefined && (loop.urgency ?? 0) >= 0.45) {
    const topic = loop.topic ?? loop.text ?? "";
    if (topic.length > 0) {
      candidates.push(
        makeItem("proactive", "open_loop", { loopId: loop.id, topic, hint: `想到你之前说的「${topic}」，可以问一句后来怎么样了` }, now, 4 * 3_600_000),
      );
    }
  }

  // 3) 时间锚点：真实节日/节气，不是编的
  if (world.timeAnchor !== undefined && relation.stage !== "stranger") {
    candidates.push(
      makeItem("proactive", "time_anchor", { anchor: world.timeAnchor, hint: `今天是${world.timeAnchor}，可以用一句很短的由头开口（别煽情）` }, now, 6 * 3_600_000),
    );
  }

  // 4) 想分享：用户最近说过的重要事（redline/important），只能引用真实记忆
  const memory = recentUserMemories.find((item) => item.importance !== "detail" && (item.text !== undefined || item.slotKey !== undefined));
  if (memory !== undefined && relation.stage !== "stranger") {
    const gist = (memory.text ?? memory.topic ?? memory.slotKey ?? "").slice(0, 40);
    if (gist.length > 0) {
      candidates.push(
        makeItem("proactive", "share", { memoryId: memory.id, hint: `想到你说的「${gist}」，想问一句，不要复述原话` }, now, 6 * 3_600_000),
      );
    }
  }

  // 5) 无理由冲动：每天 ≤2 次，概率门控（确定性 rng，可回放）
  const todayCount = impulsesToday(input.db, input.agentId, now, input.tz);
  if (todayCount < MAX_IMPULSES_PER_DAY) {
    const local = localParts(now, input.tz);
    // 每 3 小时一个评估窗；深夜/睡着时不自作主张
    const slot = Math.floor((local.hour * 60 + local.minute) / 180);
    const rng = Rng.fromString(`${input.agentId}:${local.ymd}:${slot}:impulse`);
    const asleep = world.presence === "sleep" || world.presence === "away";
    if (!asleep && rng.next() < 0.18) {
      candidates.push(makeItem("impulse", "impulse", { hint: "没由头，就是突然想说句话——很短、别解释" }, now, 30 * 60_000));
    }
  }

  return candidates;
}

/** 供 MindService 用：从 db 读最近的重要用户情节（只读，不产生副作用）。 */
export function recentUserMemories(db: Db, agentId: number, now: number, limit = 20): MemoryItem[] {
  const rows = db.all<{ id: number }>(
    "SELECT id FROM memory_episodic WHERE agent_id = ? AND deleted_ts IS NULL AND source = 'user_said' AND t_start_ts >= ? AND importance IN ('redline','important') ORDER BY t_start_ts DESC LIMIT ?",
    [agentId, now - 86_400_000, limit],
  );
  const items: MemoryItem[] = [];
  for (const row of rows) {
    const item = db.get<{ id: number; text: string; importance: "redline" | "important" | "detail"; entities: string; confidence: number; salience: number; source: string; t_start_ts: number; last_access_ts: number | null; access_log: string }>(
      "SELECT * FROM memory_episodic WHERE id = ? LIMIT 1",
      [row.id],
    );
    if (item === undefined) continue;
    items.push({
      id: item.id,
      kind: "episodic",
      text: item.text,
      importance: item.importance,
      confidence: item.confidence,
      salience: item.salience,
      entities: safeArray(item.entities),
      source: item.source,
      createdAt: item.t_start_ts,
      lastAccessTs: item.last_access_ts,
      accessCount: 1,
    });
  }
  return items;
}

function safeArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 叙事层（草案 3.6，规范 2 §4.5）。
 *
 * 结构 → 槽位（确定性投影，零 LLM）→ prose（由表达层生成时回写）。
 * 这里只负责**槽位**：identity / relationship / situation / open_threads。
 * 槽位是内核自己的"小本子"，进 prompt 时由表达层翻成人话，不能直接
 * 把 JSON 丢给模型（模型会把数值当台词）。
 *
 * 冷启动：字段缺失/未知一律省略，不补"正在做的事"这类可被证伪的物理事实。
 */
import type { DriveState, MemoryItem, Persona, RelationState, WorldState } from "@anteros/shared";
import type { Db } from "../db/database.js";
import type { KernelDeps } from "../contracts.js";
import { relationDays, STAGE_PROMPT } from "./relation.js";
import { DAYPART_LABEL } from "./world.js";
import { PRESENCE_LABEL } from "./presence.js";
import { DRIVE_LABEL, DRIVE_NAMES } from "./drives.js";

export const NARRATIVE_SLOTS = ["identity", "relationship", "situation", "open_threads"] as const;
export type NarrativeSlotKey = (typeof NARRATIVE_SLOTS)[number];

export interface NarrativeContext {
  now: number;
  tz: string;
  persona: Persona;
  relation: RelationState;
  world: WorldState;
  drives: DriveState;
  openLoops: MemoryItem[];
}

/** 亲近度只给"低/中/高"三档，数值不出内核（草案 3.6：关系数值不暴露）。 */
export function intimacyBand(intimacy: number): "低" | "中" | "高" {
  if (intimacy >= 0.55) return "高";
  if (intimacy >= 0.25) return "中";
  return "低";
}

export function ageOf(birthTs: number, now: number): number {
  return Math.max(0, Math.floor((now - birthTs) / (365.2425 * 86_400_000)));
}

/** 确定性投影：同样的输入永远得到同样的槽位（可回放）。 */
export function projectSlots(ctx: NarrativeContext): Record<NarrativeSlotKey, unknown> {
  const { persona, relation, world, drives } = ctx;
  const age = ageOf(persona.birthTs, ctx.now);
  const currentSlot = world.schedule?.find((slot) => slot.startTs <= ctx.now && slot.endTs > ctx.now);

  const topDrives = DRIVE_NAMES.map((name) => ({ name, value: drives[name], label: DRIVE_LABEL[name] }))
    .filter((item) => item.value >= 0.5)
    .sort((a, b) => b.value - a.value)
    .slice(0, 2)
    .map((item) => item.label);

  return {
    identity: {
      name: persona.name,
      age,
      city: persona.city,
      background: persona.immutable.background,
      values: persona.immutable.values,
      interests: persona.interests,
      speechStyle: persona.speechStyle,
    },
    relationship: {
      stage: relation.stage,
      phrase: STAGE_PROMPT[relation.stage],
      daysKnown: relationDays(relation, ctx.now),
      mode: relation.mode,
      intimacyBand: intimacyBand(relation.intimacy),
    },
    situation: {
      daypart: world.daypart,
      daypartLabel: DAYPART_LABEL[world.daypart],
      localIso: world.localIso,
      presence: world.presence,
      presenceLabel: PRESENCE_LABEL[world.presence],
      energyWord: world.energy >= 0.7 ? "精神不错" : world.energy >= 0.45 ? "正常电量" : world.energy >= 0.25 ? "有点乏" : "电量很低",
      // 只在"它自己的日程开了、且这个槽位允许叙述"时才给 activity
      activity: currentSlot !== undefined && currentSlot.publicNarratable ? currentSlot.activity : undefined,
      timeAnchor: world.timeAnchor,
      mood: topDrives,
      allowOwnRoutine: world.lifeSimulationEnabled,
    },
    open_threads: ctx.openLoops.slice(0, 5).map((item) => ({
      topic: item.topic ?? item.text ?? "",
      urgency: item.urgency ?? 0.5,
      openedTs: item.createdAt,
    })),
  };
}

interface NarrativeRow {
  agent_id: number;
  slot_key: string;
  value: string;
  prose: string | null;
  version: number;
  updated_ts: number;
}

export interface NarrativeSlot {
  slotKey: string;
  value: unknown;
  prose: string | null;
  updatedTs: number;
}

export class NarrativeService {
  private readonly db: Db;

  constructor(private readonly deps: KernelDeps) {
    this.db = deps.db;
  }

  get(): NarrativeSlot[] {
    const rows = this.db.all<NarrativeRow>("SELECT * FROM narrative_slots WHERE agent_id = ?", [this.deps.agentId]);
    const order = new Map<string, number>(NARRATIVE_SLOTS.map((key, index) => [key, index]));
    return rows
      .sort((a, b) => (order.get(a.slot_key) ?? 99) - (order.get(b.slot_key) ?? 99))
      .map((row) => ({
        slotKey: row.slot_key,
        value: parseValue(row.value),
        prose: row.prose,
        updatedTs: row.updated_ts,
      }));
  }

  /**
   * 重算槽位（确定性），保留 prose（prose 是表达层写回来的，不在这里动）。
   * 5 分钟内已刷过就跳过，避免每条消息都写一遍库。
   */
  refresh(ctx: NarrativeContext, force = false): void {
    const existing = this.get();
    if (!force && existing.length === NARRATIVE_SLOTS.length) {
      const newest = Math.max(...existing.map((slot) => slot.updatedTs));
      if (ctx.now - newest < 5 * 60_000) return;
    }
    const slots = projectSlots(ctx);
    this.db.tx(() => {
      for (const key of NARRATIVE_SLOTS) {
        const value = JSON.stringify(slots[key]);
        this.db.run(
          `INSERT INTO narrative_slots(agent_id, slot_key, value, version, updated_ts)
           VALUES (?, ?, ?, 1, ?)
           ON CONFLICT(agent_id, slot_key) DO UPDATE SET value = excluded.value,
             version = narrative_slots.version + 1, updated_ts = excluded.updated_ts`,
          [this.deps.agentId, key, value, ctx.now],
        );
      }
    });
  }

  /** 表达层生成 prose 后回写（只写 prose，不动结构槽位）。 */
  writeProse(slotKey: string, prose: string, now: number): void {
    this.db.run(
      "INSERT INTO narrative_slots(agent_id, slot_key, value, prose, version, updated_ts) VALUES (?, ?, 'null', ?, 1, ?) " +
        "ON CONFLICT(agent_id, slot_key) DO UPDATE SET prose = excluded.prose, updated_ts = excluded.updated_ts",
      [this.deps.agentId, slotKey, prose.slice(0, 2000), now],
    );
  }
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

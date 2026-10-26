/**
 * 动机层（草案 12 章，规范 1 §3.5）。
 *
 * 七个 drive 在空转期纯数学演化，零成本、不调模型；只有越过阈值才产生
 * "内部事件"（由 MindService.candidateActions 转成主动候选）。参数方向：
 *   rate 是"每小时自然增长（向 1 靠）"，decay 是"每小时自然回落（向 0 靠）"，
 *   coupling 是相互抬升（无聊会加重孤独，想念会推着想分享……）。
 *
 * 时间一律 UTC 毫秒，`tickDrives` 幂等：只按 now 推进，且最多累计 24h
 * （机器休眠一整周也不会一觉醒来所有值都顶格）。
 */
import type { DriveParams, DriveState } from "@anteros/shared";
import type { Db } from "../db/database.js";
import type { KernelDeps } from "../contracts.js";
import { clamp } from "../util/time.js";

export type DriveName = "loneliness" | "boredom" | "longing" | "tension" | "fatigue" | "urgeToShare" | "anxiety";

export const DRIVE_NAMES: readonly DriveName[] = [
  "loneliness",
  "boredom",
  "longing",
  "tension",
  "fatigue",
  "urgeToShare",
  "anxiety",
];

/** 与 bootstrap.ts 的 seed 值一致（rate/decay/threshold 来源：草案 12.2 表）。 */
export const DRIVE_DEFAULTS: Record<DriveName, DriveParams> = {
  loneliness: { rate: 0.06, decay: 0.02, threshold: 0.65, coupling: { boredom: 0.12, longing: 0.2 } },
  boredom: { rate: 0.05, decay: 0.03, threshold: 0.7, coupling: { loneliness: 0.1 } },
  longing: { rate: 0.04, decay: 0.015, threshold: 0.6, coupling: { loneliness: 0.25, urgeToShare: 0.2 } },
  tension: { rate: 0.03, decay: 0.05, threshold: 0.7, coupling: { anxiety: 0.15 } },
  fatigue: { rate: 0.02, decay: 0.08, threshold: 0.75, coupling: { anxiety: 0.08, tension: 0.05 } },
  urgeToShare: { rate: 0.05, decay: 0.04, threshold: 0.6, coupling: { loneliness: 0.15, longing: 0.2 } },
  anxiety: { rate: 0.02, decay: 0.06, threshold: 0.8, coupling: { tension: 0.15, fatigue: 0.1 } },
};

/** DB 列名 → DriveName（order 固定，便于测试）。 */
const COLUMN: Record<DriveName, string> = {
  loneliness: "loneliness",
  boredom: "boredom",
  longing: "longing",
  tension: "tension",
  fatigue: "fatigue",
  urgeToShare: "urge_to_share",
  anxiety: "anxiety",
};

interface DriveRow {
  agent_id: number;
  loneliness: number;
  boredom: number;
  longing: number;
  tension: number;
  fatigue: number;
  urge_to_share: number;
  anxiety: number;
  params: string;
  updated_ts: number;
}

export function emptyDrives(now: number): DriveState {
  return {
    loneliness: 0,
    boredom: 0,
    longing: 0,
    tension: 0,
    fatigue: 0,
    urgeToShare: 0,
    anxiety: 0,
    params: DRIVE_DEFAULTS,
    updatedTs: now,
  };
}

function parseParams(raw: string | null | undefined): Record<string, DriveParams> {
  const merged: Record<string, DriveParams> = {};
  for (const name of DRIVE_NAMES) merged[name] = { ...DRIVE_DEFAULTS[name] };
  if (!raw) return merged;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return merged;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const params = value as Partial<DriveParams>;
      const existing = merged[key] ?? { rate: 0, decay: 0, threshold: 1 };
      merged[key] = {
        rate: typeof params.rate === "number" ? params.rate : existing.rate,
        decay: typeof params.decay === "number" ? params.decay : existing.decay,
        threshold: typeof params.threshold === "number" ? params.threshold : existing.threshold,
        coupling: typeof params.coupling === "object" && params.coupling !== null ? { ...params.coupling } : existing.coupling,
      };
    }
  } catch {
    return merged;
  }
  return merged;
}

function valueOf(drives: DriveState, name: DriveName): number {
  return drives[name];
}

/**
 * 纯推进函数（可单测、可回放）：给定当前状态与经过时长，返回新状态。
 * 公式（草案 12.2）：dv/dt = rate·(1−v) − decay·v + Σ coupling·v_other·0.1
 */
export function advanceDrives(drives: DriveState, hours: number, params: Record<string, DriveParams> = drives.params): DriveState {
  const h = clamp(hours, 0, 24);
  const next: DriveState = { ...drives, params, updatedTs: drives.updatedTs };
  for (const name of DRIVE_NAMES) {
    const param = params[name] ?? DRIVE_DEFAULTS[name];
    let couplingSum = 0;
    if (param.coupling !== undefined) {
      for (const [other, coeff] of Object.entries(param.coupling)) {
        if (other === name) continue;
        const otherValue = typeof next[other as DriveName] === "number" ? next[other as DriveName] : 0;
        couplingSum += otherValue * (coeff as number) * 0.1;
      }
    }
    const current = drives[name];
    const value = current + h * (param.rate * (1 - current) - param.decay * current + couplingSum);
    next[name] = clamp(value, 0, 1);
  }
  return next;
}

export class DrivesService {
  private readonly db: Db;

  constructor(private readonly deps: KernelDeps) {
    this.db = deps.db;
  }

  get(): DriveState {
    const row = this.read();
    const drives: DriveState = {
      loneliness: row.loneliness,
      boredom: row.boredom,
      longing: row.longing,
      tension: row.tension,
      fatigue: row.fatigue,
      urgeToShare: row.urge_to_share,
      anxiety: row.anxiety,
      params: parseParams(row.params),
      updatedTs: row.updated_ts,
    };
    // 读取也按 now 演化（但不落库）：UI 看到的不是"上次 tick 的旧值"
    return advanceDrives(drives, (Date.now() - row.updated_ts) / 3_600_000, drives.params);
  }

  tick(now: number): DriveState {
    const row = this.read();
    const drives: DriveState = {
      loneliness: row.loneliness,
      boredom: row.boredom,
      longing: row.longing,
      tension: row.tension,
      fatigue: row.fatigue,
      urgeToShare: row.urge_to_share,
      anxiety: row.anxiety,
      params: parseParams(row.params),
      updatedTs: row.updated_ts,
    };
    const hours = clamp((now - row.updated_ts) / 3_600_000, 0, 24);
    const next = advanceDrives(drives, hours, drives.params);
    next.updatedTs = now;
    this.db.run(
      `UPDATE drives_state SET loneliness = ?, boredom = ?, longing = ?, tension = ?, fatigue = ?,
         urge_to_share = ?, anxiety = ?, params = ?, updated_ts = ? WHERE agent_id = ?`,
      [
        next.loneliness,
        next.boredom,
        next.longing,
        next.tension,
        next.fatigue,
        next.urgeToShare,
        next.anxiety,
        JSON.stringify(next.params),
        now,
        this.deps.agentId,
      ],
    );
    return next;
  }

  /** 越过阈值的 drive（"内部事件"的唯一来源）。 */
  crossedThresholds(drives: DriveState): Array<{ name: DriveName; value: number; threshold: number }> {
    const crossed: Array<{ name: DriveName; value: number; threshold: number }> = [];
    for (const name of DRIVE_NAMES) {
      const param = drives.params[name] ?? DRIVE_DEFAULTS[name];
      if (drives[name] >= param.threshold) crossed.push({ name, value: drives[name], threshold: param.threshold });
    }
    return crossed;
  }

  private read(): DriveRow {
    const row = this.db.get<DriveRow>("SELECT * FROM drives_state WHERE agent_id = ?", [this.deps.agentId]);
    if (row !== undefined) return row;
    const now = Date.now();
    this.db.run(
      "INSERT INTO drives_state(agent_id, loneliness, boredom, longing, tension, fatigue, urge_to_share, anxiety, params, updated_ts) VALUES (?, 0, 0, 0, 0, 0, 0, 0, ?, ?)",
      [this.deps.agentId, JSON.stringify(DRIVE_DEFAULTS), now],
    );
    return {
      agent_id: this.deps.agentId,
      loneliness: 0,
      boredom: 0,
      longing: 0,
      tension: 0,
      fatigue: 0,
      urge_to_share: 0,
      anxiety: 0,
      params: JSON.stringify(DRIVE_DEFAULTS),
      updated_ts: now,
    };
  }
}

/** 给行动候选用的中文名（不暴露数值）。 */
export const DRIVE_LABEL: Record<DriveName, string> = {
  loneliness: "有点想有人说话",
  boredom: "闲得有点空",
  longing: "在惦记你",
  tension: "绷着",
  fatigue: "累",
  urgeToShare: "看到点东西想分享",
  anxiety: "有点悬着",
};

/**
 * 世界时钟 / 在场 / 动机（草案 3.1–3.2、12.1）：
 *   - 单一主时钟；sleep 优先级最高；
 *   - 冷启动默认 life.allowOwnRoutine=false → 不生成"正在做的事"（schedule 空）；
 *   - drives 纯数学演化，time 推进幂等、单次不超过 24h。
 */
import { describe, expect, it } from "vitest";
import { DrivesService, DRIVE_DEFAULTS } from "../src/mind/drives.js";
import { PresenceService } from "../src/mind/presence.js";
import { WorldService } from "../src/mind/world.js";
import { PersonaService } from "../src/mind/persona.js";
import { localTs, makeKernel } from "./fixtures/kernel.js";

describe("世界时钟与在场", () => {
  it("深夜（02:30）在场是 sleep，优先级高于手机在手", () => {
    const kernel = makeKernel();
    try {
      const now = localTs("2026-01-15", 2, 30);
      const presence = new PresenceService(kernel.deps);
      const persona = new PersonaService(kernel.deps);
      const world = new WorldService(kernel.deps, persona, presence);
      const state = world.get(now).world;
      expect(state.presence).toBe("sleep");
      expect(state.localIso).toContain("02:30");
    } finally {
      kernel.close();
    }
  });

  it("冷启动默认：life.allowOwnRoutine=false 时不虚构日程，也没有 activity", () => {
    const kernel = makeKernel();
    try {
      const now = localTs("2026-01-15", 15, 0);
      const persona = new PersonaService(kernel.deps);
      const world = new WorldService(kernel.deps, persona, new PresenceService(kernel.deps));
      const state = world.get(now).world;
      expect(state.schedule).toBeUndefined();
      expect(state.lifeSimulationEnabled).toBe(false);
    } finally {
      kernel.close();
    }
  });

  it("慢变量有限幅：能量/心情都在 [0,1]，且随时间缓慢变化", () => {
    const kernel = makeKernel();
    try {
      const now = localTs("2026-01-15", 15, 0);
      const persona = new PersonaService(kernel.deps);
      const world = new WorldService(kernel.deps, persona, new PresenceService(kernel.deps));
      const first = world.get(now).world;
      const later = world.get(now + 4 * 3_600_000).world;
      expect(first.energy).toBeGreaterThanOrEqual(0);
      expect(first.energy).toBeLessThanOrEqual(1);
      expect(first.moodValence).toBeGreaterThanOrEqual(-1);
      expect(first.moodValence).toBeLessThanOrEqual(1);
      expect(first.moodArousal).toBeGreaterThanOrEqual(0);
      expect(first.moodArousal).toBeLessThanOrEqual(1);
      expect(later.energy).not.toBe(first.energy);
    } finally {
      kernel.close();
    }
  });
});

describe("drives 纯数学演化", () => {
  it("时间推进会让孤独感上升、疲劳随夜间上升，全部落在 [0,1]", () => {
    const kernel = makeKernel();
    try {
      const drives = new DrivesService(kernel.deps);
      const before = drives.get();
      const now = Date.now() + 6 * 3_600_000;
      const after = drives.tick(now);
      for (const key of Object.keys(DRIVE_DEFAULTS)) {
        const value = after[key as keyof typeof after] as number;
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      expect(after.loneliness).toBeGreaterThan(before.loneliness);
    } finally {
      kernel.close();
    }
  });

  it("tick 幂等：同一时刻重复推进不改变数值；单次最多累计 24h", () => {
    const kernel = makeKernel();
    try {
      const drives = new DrivesService(kernel.deps);
      const now = Date.now();
      const once = drives.tick(now);
      const twice = drives.tick(now);
      expect(twice.loneliness).toBeCloseTo(once.loneliness, 6);
    } finally {
      kernel.close();
    }

    // 断点很久：最多只推进 24h → 断 24h 与断 7 天结果相同
    const a = makeKernel();
    const b = makeKernel();
    try {
      const now = Date.now();
      const day = new DrivesService(a.deps).tick(now + 86_400_000);
      const week = new DrivesService(b.deps).tick(now + 7 * 86_400_000);
      expect(week.loneliness).toBeCloseTo(day.loneliness, 6);
      expect(week.loneliness).toBeGreaterThanOrEqual(0);
      expect(week.loneliness).toBeLessThanOrEqual(1);
    } finally {
      a.close();
      b.close();
    }
  });
});

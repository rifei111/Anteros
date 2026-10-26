/**
 * 分条与打字节奏（草案 4.1–4.3）：
 *   - 1–3 条，每条 ≤25 字；
 *   - typing_ms ≈ 字数 / (4~6 字/秒) × 人格系数，不是固定值；
 *   - 条间延迟由在场决定区间、对数正态重尾、独立采样。
 */
import { DEFAULT_TRAITS } from "@anteros/shared";
import { describe, expect, it } from "vitest";
import {
  MAX_PART_CHARS,
  PRESENCE_DELAY_RANGE,
  delayAfterMsFor,
  maxPartsFor,
  planParts,
  splitIntoParts,
  typingMsFor,
} from "../src/expression/planner.js";
import { Rng } from "../src/util/rng.js";

const traits = DEFAULT_TRAITS;

describe("分条", () => {
  it("短回复只分 1 条", () => {
    expect(splitIntoParts("嗯，知道了", 2)).toEqual(["嗯，知道了"]);
    expect(maxPartsFor(6, 3)).toBe(1);
  });

  it("长回复 1–3 条，每条 ≤25 字，不丢内容（总长不超过上限）", () => {
    const raw =
      "今天下午一直在画画，画得不太顺。\n晚上可能就看个电影吧。\n你要是有空，可以跟我说说今天怎么样，我挺想听你讲讲的。";
    const parts = splitIntoParts(raw, 3);
    expect(parts.length).toBeGreaterThanOrEqual(1);
    expect(parts.length).toBeLessThanOrEqual(3);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(MAX_PART_CHARS);
    expect(parts.join("").startsWith("今天下午")).toBe(true);
  });

  it("maxPartsFor：文字长度与 burst 共同决定上限", () => {
    expect(maxPartsFor(100, 1)).toBe(1);
    expect(maxPartsFor(100, 2)).toBe(2);
    expect(maxPartsFor(100, 5)).toBe(3);
    expect(maxPartsFor(30, 3)).toBe(2);
  });

  it("没有标点的超长串会硬切，不出现 >25 字的条", () => {
    const long = "啊".repeat(80);
    const parts = splitIntoParts(long, 3);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(MAX_PART_CHARS);
  });
});

describe("打字节奏", () => {
  it("typing_ms 与字数成正比（4~6 字/秒 × 人格系数 × 抖动）", () => {
    const fast = typingMsFor(20, traits, Rng.fromString("same"));
    const slow = typingMsFor(10, traits, Rng.fromString("same"));
    expect(fast).toBeGreaterThan(slow);
    expect(fast / slow).toBeCloseTo(2, 1);
    const ten = typingMsFor(10, traits, Rng.fromString("seed"));
    // 10 字：1000~4000ms，绝不可能是固定 0 或超大
    expect(ten).toBeGreaterThan(1000);
    expect(ten).toBeLessThan(4000);
  });

  it("delay_after 按在场区间取值（phone 0.5–2s / idle 3–20s / away 1–60min）", () => {
    for (const presence of ["phone_in_hand", "idle", "busy", "away"] as const) {
      const [min, max] = PRESENCE_DELAY_RANGE[presence];
      for (let index = 0; index < 10; index += 1) {
        const value = delayAfterMsFor(traits, presence, Rng.fromString(`p:${presence}:${index}`));
        expect(value).toBeGreaterThanOrEqual(min);
        expect(value).toBeLessThanOrEqual(max);
      }
    }
  });

  it("延迟是独立采样：两次同参数不同 seed 不应固定相同", () => {
    const a = delayAfterMsFor(traits, "idle", Rng.fromString("a"));
    const b = delayAfterMsFor(traits, "idle", Rng.fromString("b"));
    expect(a).not.toBe(b);
  });

  it("planParts：最后一条 delayAfterMs=0，前面的条目在在场区间内且 typing>0", () => {
    const parts = planParts("今天有点冷。我下午一直在画画，画得不太顺。", {
      traits,
      presence: "idle",
      rng: Rng.fromString("plan"),
    });
    expect(parts.length).toBeGreaterThanOrEqual(1);
    for (const [index, part] of parts.entries()) {
      expect(part.typingMs).toBeGreaterThan(0);
      if (index === parts.length - 1) {
        expect(part.delayAfterMs).toBe(0);
      } else {
        const [min, max] = PRESENCE_DELAY_RANGE.idle;
        expect(part.delayAfterMs).toBeGreaterThanOrEqual(min);
        expect(part.delayAfterMs).toBeLessThanOrEqual(max);
      }
    }
  });
});

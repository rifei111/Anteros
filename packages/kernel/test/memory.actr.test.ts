/**
 * ACT-R 激活与提取概率（草案 1.2 算例 + 间隔效应）。
 *
 * 口径：时间单位是秒（草案算例就是这么算的）；激活换算成 P 时用 τ=-6、s=0.4。
 * 允许 ±0.05 的误差（草案自己给的是两位小数）。
 */
import { describe, expect, it } from "vitest";
import { baseLevel, recallProbability, ACTR_DEFAULTS } from "../src/memory/actr.js";

const DAY = 86_400_000;
const NOW = 1_760_000_000_000; // 固定 now，避免测试依赖真实时钟

describe("ACT-R 基线激活（草案 1.2 算例）", () => {
  it("只在 30 天前记过一次：d=0.3 → B≈-4.43，概率≈0.98", () => {
    const b = baseLevel([NOW - 30 * DAY], NOW, 0.3);
    expect(b).toBeCloseTo(-4.43, 1); // |误差| < 0.05
    expect(recallProbability(b, -6, 0.4)).toBeCloseTo(0.98, 1);
  });

  it("d=0.5 → B≈-7.38，概率≈0.03（更健忘）", () => {
    const b = baseLevel([NOW - 30 * DAY], NOW, 0.5);
    expect(b).toBeCloseTo(-7.38, 1);
    expect(recallProbability(b, -6, 0.4)).toBeCloseTo(0.03, 1);
  });

  it("d=0.7 → B≈-10.34，概率≈0（几乎提取不出来）", () => {
    const b = baseLevel([NOW - 30 * DAY], NOW, 0.7);
    expect(b).toBeCloseTo(-10.34, 1);
    expect(recallProbability(b, -6, 0.4)).toBeLessThan(0.001);
  });

  it("间隔效应：0/1/3 天各回忆一次，30 天后 B≈-6.26（高于只记一次的 -7.38）", () => {
    const spaced = baseLevel([NOW - 30 * DAY, NOW - 29 * DAY, NOW - 27 * DAY], NOW, 0.5);
    expect(spaced).toBeCloseTo(-6.26, 1);
    // 幂律下"多回忆几次"会显著抬高可提取性，这是只记一次的 30 天值做不到的
    const single = baseLevel([NOW - 30 * DAY], NOW, 0.5);
    expect(spaced).toBeGreaterThan(single + 0.9);
    // 按公式 P=1/(1+e^{-(A-τ)/s})，τ=-6、s=0.4 时精确值约 0.34。
    // 草案文字写"约 0.26"是草案算例的取整/笔误（其单点算例 -4.43/0.98、-7.38/0.03
    // 都能反推出 τ=-6、s=0.4），本测试以公式口径为准。
    expect(recallProbability(spaced, -6, 0.4)).toBeCloseTo(0.34, 1);
  });

  it("编码瞬间不会因为 t=0 变成无穷大（1 秒平滑）", () => {
    const b = baseLevel([NOW], NOW, 0.5);
    expect(Number.isFinite(b)).toBe(true);
    expect(b).toBeCloseTo(0, 5);
  });

  it("没有访问记录时激活为 -Infinity（不可能被提取）", () => {
    expect(baseLevel([], NOW, 0.5)).toBe(Number.NEGATIVE_INFINITY);
    expect(recallProbability(Number.NEGATIVE_INFINITY, -6, 0.4)).toBe(0);
  });

  it("默认参数落在规范 1 §2.2 的范围里", () => {
    expect(ACTR_DEFAULTS.d).toBeGreaterThanOrEqual(0.35);
    expect(ACTR_DEFAULTS.d).toBeLessThanOrEqual(0.65);
    expect(ACTR_DEFAULTS.tau).toBeGreaterThanOrEqual(-6.5);
    expect(ACTR_DEFAULTS.tau).toBeLessThanOrEqual(-5.0);
    expect(ACTR_DEFAULTS.s).toBeGreaterThanOrEqual(0.15);
    expect(ACTR_DEFAULTS.s).toBeLessThanOrEqual(0.4);
  });
});

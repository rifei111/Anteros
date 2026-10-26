/**
 * 人格参数采样（草案 2.5 出生采样 / 2.7 MBTI 只作先验）：
 *   - 同一 seed 可复现（persona 重建后人格不漂）；
 *   - 采样值落在草案 2.2 的范围内；
 *   - MBTI 只投影成 traits，不进 prompt。
 */
import { describe, expect, it } from "vitest";
import { TRAIT_RANGES, projectMbti, sampleTraits, validateTraits } from "../src/mind/traits.js";
import { mbtiProjection } from "../src/mind/persona.js";

describe("traits 采样", () => {
  it("同一 seed 采样结果完全可复现", () => {
    expect(sampleTraits("persona:1")).toEqual(sampleTraits("persona:1"));
    expect(sampleTraits(42)).toEqual(sampleTraits(42));
  });

  it("不同 seed 会得到不同的人格（不是常量）", () => {
    const a = sampleTraits("persona:1");
    const b = sampleTraits("persona:2");
    expect(a).not.toEqual(b);
  });

  it("采样值全部落在草案 2.2 的参数范围内", () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const traits = sampleTraits(`persona:${seed}`);
      for (const [key, [min, max]] of Object.entries(TRAIT_RANGES)) {
        const value = traits[key as keyof typeof traits];
        if (typeof value !== "number") continue;
        expect(value, `${key} seed=${seed}`).toBeGreaterThanOrEqual(min);
        expect(value, `${key} seed=${seed}`).toBeLessThanOrEqual(max);
      }
      expect(traits.burstMax).toBeGreaterThanOrEqual(2);
      expect(traits.burstMax).toBeLessThanOrEqual(3);
      expect(traits.burstMin).toBe(1);
      expect(traits.mbti).toBeNull();
      expect(validateTraits(traits)).toEqual([]);
    }
  });

  it("MBTI 只投影到 traits：合法类型返回范围内参数，非法类型抛错", () => {
    const projected = mbtiProjection("ENFP");
    expect(projected.mbti).toBe("ENFP");
    for (const [key, value] of Object.entries(projected)) {
      if (typeof value !== "number") continue;
      const range = TRAIT_RANGES[key as keyof typeof TRAIT_RANGES];
      if (range === undefined) continue;
      expect(value).toBeGreaterThanOrEqual(range[0]);
      expect(value).toBeLessThanOrEqual(range[1]);
    }
    // 方向性差别：F 比 T 更暖，E 比 I 更主动（只投影到参数，不改人格文本）
    expect(projectMbti("INTP").warmth).toBeLessThan(projectMbti("INFP").warmth ?? 0);
    expect(projectMbti("INFP").initiative).toBeLessThan(projectMbti("ENFP").initiative ?? 0);
    expect(() => mbtiProjection("XXXX")).toThrow(/MBTI/);
  });
});

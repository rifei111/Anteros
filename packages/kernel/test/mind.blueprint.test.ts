/**
 * 人设文本 → 人格内核（草案 2.2 参数投影 / 2.7 MBTI 只投影）单测。
 *
 * 三件事必须锁住：
 *   1. 用户写"健忘"，d 必须变大（更健忘）、τ 必须变高（需要提示才想起来）；
 *   2. 再怎么离谱的输入，最后都要落在草案区间里，且越界原因写进 clamped；
 *   3. 模型输出坏掉时不能整体失败，要退回规则引擎并留下 warning。
 */
import { describe, expect, it } from "vitest";
import type { Persona } from "@anteros/shared";
import { DEFAULT_TRAITS } from "@anteros/shared";
import {
  TRAIT_BOUNDS,
  clampTraits,
  deriveBlueprintFromText,
  parseLlmBlueprint,
} from "../src/mind/blueprint.js";

const basePersona: Persona = {
  id: 1,
  name: "小满",
  city: "成都",
  birthTs: Date.UTC(2003, 4, 12, 8, 0, 0),
  traits: { ...DEFAULT_TRAITS },
  interests: ["雨天", "老电影"],
  immutable: { background: "23 岁，成都，画插画。", values: ["不装熟"], taboo: ["被要求假装真人"] },
  speechStyle: { habits: [], punctuation: "minimal", sentenceLength: "short" },
};

describe("deriveBlueprintFromText", () => {
  it("把「健忘」翻译成更难回忆的参数，而不是一句形容词", () => {
    const blueprint = deriveBlueprintFromText("她叫林野，26 岁，在杭州做夜班护士，有点健忘，话不多。", basePersona);
    expect(blueprint.name).toBe("林野");
    expect(blueprint.city).toBe("杭州");
    expect(blueprint.ageYears).toBe(26);
    expect(blueprint.traits.memoryD).toBeGreaterThan(DEFAULT_TRAITS.memoryD);
    expect(blueprint.traits.memoryTau).toBeGreaterThan(DEFAULT_TRAITS.memoryTau);
    expect(blueprint.speechStyle.sentenceLength).toBe("short");
    expect(blueprint.rationale.length).toBeGreaterThan(0);
  });

  it("记性好往反方向推：d 更小、τ 更负、细节敏感更高", () => {
    const blueprint = deriveBlueprintFromText("叫她阿枝，记性特别好，记得住别人随口说过的话，喜欢猫和便利店。", basePersona);
    expect(blueprint.traits.memoryD).toBeLessThan(DEFAULT_TRAITS.memoryD);
    expect(blueprint.traits.memoryTau).toBeLessThan(DEFAULT_TRAITS.memoryTau);
    expect(blueprint.traits.detailPref).toBeGreaterThan(DEFAULT_TRAITS.detailPref);
    expect(blueprint.interests.length).toBeGreaterThan(0);
  });

  it("口头禅只从原文里摘，不生造（重复的引号包裹要去重）", () => {
    const blueprint = deriveBlueprintFromText('她口头禅是"算了算了"，说话很短。', basePersona);
    expect(blueprint.habits).toContain("算了算了");
    expect(blueprint.habits.filter((item) => /算了算了/.test(item)).length).toBe(1);
  });

  it("MBTI 只作投影：进 traits，不进 prompt（这里只验数值被推动）", () => {
    const warm = deriveBlueprintFromText("她是 ENFP，热情，爱聊天。", basePersona);
    const cold = deriveBlueprintFromText("她是 ISTJ，冷静，话少。", basePersona);
    expect(warm.traits.warmth).toBeGreaterThan(cold.traits.warmth);
  });

  it("人设太短要给出可执行的提醒，而不是默默用默认值", () => {
    const blueprint = deriveBlueprintFromText("她叫小七。", basePersona);
    expect(blueprint.warnings.length).toBeGreaterThan(0);
    expect(blueprint.warnings.join("")).toContain("人设太短");
  });
});

describe("clampTraits", () => {
  it("越界的值被钳住，并留下人话原因", () => {
    const clamped: string[] = [];
    const traits = clampTraits({ memoryD: 0.95, memoryTau: -8, emotionGain: 9, burstMin: 3, burstMax: 1 }, clamped);
    expect(traits.memoryD).toBe(TRAIT_BOUNDS.memoryD.max);
    expect(traits.memoryTau).toBe(TRAIT_BOUNDS.memoryTau.min);
    expect(traits.emotionGain).toBe(TRAIT_BOUNDS.emotionGain.max);
    expect(traits.burstMin).toBeLessThanOrEqual(traits.burstMax);
    expect(clamped.length).toBe(4);
    expect(clamped.join("")).toContain("最少条数");
  });
});

describe("parseLlmBlueprint", () => {
  const fallback = deriveBlueprintFromText("她叫林野，26 岁，在杭州做夜班护士，有点健忘。", basePersona);

  it("合法 JSON 覆盖规则结果，engine 标成 llm", () => {
    const raw = JSON.stringify({
      name: "林野",
      city: "杭州",
      ageYears: 26,
      background: "夜班护士，作息颠倒。",
      interests: ["夜班", "便利店"],
      values: ["答应的事做到"],
      habits: [],
      punctuation: "minimal",
      sentenceLength: "short",
      traits: { memoryD: 0.55, memoryTau: -5.4 },
      rationale: [{ key: "memoryD", label: "记忆衰减 d", value: "0.55", why: "夜班缺觉，忘性大" }],
    });
    const blueprint = parseLlmBlueprint(raw, fallback, "test-model");
    expect(blueprint.engine).toBe("llm");
    expect(blueprint.traits.memoryD).toBeCloseTo(0.55, 3);
    expect(blueprint.rationale[0]?.why).toContain("忘性");
  });

  it("模型吐出非 JSON 时退回规则结果，并说明原因", () => {
    const blueprint = parseLlmBlueprint("我觉得她是个温柔的人吧", fallback, "test-model");
    expect(blueprint.engine).toBe("rules");
    expect(blueprint.warnings.join("")).toContain("模型输出");
  });

  it("模型给了区间外的数也要被钳住", () => {
    const raw = JSON.stringify({ traits: { memoryD: 3, burstMax: 99 } });
    const blueprint = parseLlmBlueprint(raw, fallback, "test-model");
    expect(blueprint.traits.memoryD).toBe(TRAIT_BOUNDS.memoryD.max);
    expect(blueprint.traits.burstMax).toBe(TRAIT_BOUNDS.burstMax.max);
    expect(blueprint.clamped.length).toBeGreaterThan(0);
  });
});

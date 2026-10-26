/**
 * 反模板（草案 4.6）：3-gram 指纹 0.78 打回、结构黑名单、开场 30 天不复用、
 * 口癖只记录不启用。
 */
import { describe, expect, it } from "vitest";
import {
  AntiTemplateGuard,
  openingOf,
  structureIssue,
  threeGramSimilarity,
} from "../src/expression/antitemplate.js";
import { insertMessage, makeKernel } from "./fixtures/kernel.js";

const NOW = 1_760_000_000_000;

describe("3-gram 指纹", () => {
  it("同一句话相似度为 1，不同意思的句子很低", () => {
    expect(threeGramSimilarity("今天下雨了", "今天下雨了")).toBe(1);
    expect(threeGramSimilarity("今天下雨了", "我下午一直在画画")).toBeLessThan(0.2);
  });

  it("换词不换结构仍能识别（明显高于无关句子，但不会误判成 1）", () => {
    const score = threeGramSimilarity("我有点难过，想一个人待着", "我有点难过，想自己待一会儿");
    expect(score).toBeGreaterThan(0.4);
    expect(score).toBeLessThan(1);
    expect(score).toBeGreaterThan(threeGramSimilarity("我有点难过，想一个人待着", "刚画完一张夜景"));
  });
});

describe("结构黑名单", () => {
  it("每段都以「嗯」开头 / 排比三段式 / 复述+评价 都会被标出来", () => {
    expect(structureIssue("嗯，今天好累。嗯，想早点睡。", null)).toBe("每段都以「嗯」开头");
    expect(structureIssue("我有点累，想早点睡，明天再说。", null)).toBe("排比三段式");
    expect(structureIssue("你说今天加班，那确实挺累的。", null)).toBe("复述+评价");
    expect(structureIssue("刚才在画画，不太顺。", null)).toBeNull();
  });

  it("连续两轮同句式会被标出来", () => {
    expect(structureIssue("今天真的挺累的。", "今晚真的挺冷的。")).toBe("连续两轮同句式");
  });
});

describe("AntiTemplateGuard", () => {
  it("与最近回复高度相似 → 打回重写；全新的话放行", () => {
    const kernel = makeKernel();
    try {
      insertMessage(kernel.db, kernel.deps.agentId, "agent", "今天有点冷，记得穿厚点", NOW);
      const guard = new AntiTemplateGuard(kernel.db, kernel.deps.agentId);

      const duplicate = guard.check("今天有点冷，记得穿厚点", NOW, null);
      expect(duplicate.rewrite).toBe(true);
      expect(duplicate.maxSimilarity).toBeGreaterThan(0.78);
      expect(duplicate.reasons.length).toBeGreaterThan(0);

      const fresh = guard.check("刚画完一张夜景，眼睛有点花", NOW, null);
      expect(fresh.rewrite).toBe(false);
      expect(fresh.maxSimilarity).toBeLessThan(0.78);
    } finally {
      kernel.close();
    }
  });

  it("同一开场 30 天内复用时会被拦下", () => {
    const kernel = makeKernel();
    try {
      insertMessage(kernel.db, kernel.deps.agentId, "agent", "明天可能会下雨", NOW);
      const guard = new AntiTemplateGuard(kernel.db, kernel.deps.agentId);
      const check = guard.check("明天可能会下雪吧", NOW, null);
      expect(openingOf("明天可能会下雨")).toBe(openingOf("明天可能会下雪吧"));
      expect(check.openingReused).toBe(true);
      expect(check.rewrite).toBe(true);
    } finally {
      kernel.close();
    }
  });

  it("口癖只记录、不启用：accepted 恒为 0，重复次数累加", () => {
    const kernel = makeKernel();
    try {
      const guard = new AntiTemplateGuard(kernel.db, kernel.deps.agentId);
      guard.record("其实也还好吧", NOW);
      guard.record("其实也还好吧", NOW + 1000);
      const row = kernel.db.get<{ used_count: number; accepted: number }>(
        "SELECT used_count, accepted FROM style_habits WHERE agent_id = ? AND phrase = ?",
        [kernel.deps.agentId, "其实也还好吧"],
      );
      expect(row?.used_count).toBe(2);
      expect(row?.accepted).toBe(0);
    } finally {
      kernel.close();
    }
  });
});

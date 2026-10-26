/**
 * 规则抽取（草案 1.7 第一级：零成本、约 70% 覆盖）。
 * 正反例都要有：承诺 → redline、普通闲聊 → detail、"改天请你吃饭" → open_loop。
 */
import { describe, expect, it } from "vitest";
import { extractRules, mergeExtractions, parseLlmExtraction } from "../src/memory/extraction.js";

function kinds(text: string): string[] {
  return extractRules(text).candidates.map((candidate) => candidate.kind);
}

describe("规则抽取的正反例", () => {
  it("承诺句式 → redline", () => {
    const result = extractRules("我答应你，这周末一定把画稿给你");
    const redline = result.candidates.filter((candidate) => candidate.importance === "redline");
    expect(redline.length).toBeGreaterThan(0);
    expect(redline[0]?.text).toContain("答应");
  });

  it("重大否定/禁忌 → redline，普通否定不升级", () => {
    expect(extractRules("我绝对不吃香菜").candidates.some((candidate) => candidate.importance === "redline")).toBe(true);
    // "不"本身很常见，不能一律 redline
    const ordinary = extractRules("今天不太想出门");
    expect(ordinary.candidates.every((candidate) => candidate.importance !== "redline")).toBe(true);
  });

  it("普通闲聊 → detail（不虚高成 important/redline）", () => {
    const result = extractRules("今天中午吃了碗面，味道还行");
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0]?.kind).toBe("episodic");
    expect(result.candidates[0]?.importance).toBe("detail");
  });

  it("未闭合话题 → open_loop（含 loops 与 open_loop 候选）", () => {
    const result = extractRules("改天请你吃饭");
    expect(result.loops.length).toBeGreaterThan(0);
    expect(result.loops[0]?.topic.length).toBeGreaterThan(0);
    expect(kinds("改天请你吃饭")).toContain("open_loop");
    // "下次""回头"这类也算未闭合
    expect(extractRules("下次再聊").loops.length).toBeGreaterThan(0);
    // 已完成的陈述不算未闭合
    expect(extractRules("昨天已经吃过了").loops.length).toBe(0);
  });

  it("情绪词被识别成情绪强度，情绪强度足以抬高 importance", () => {
    const result = extractRules("我真的特别难过，压力好大");
    expect(result.candidates.some((candidate) => candidate.emotion !== undefined)).toBe(true);
    expect(result.candidates.some((candidate) => candidate.importance === "important" || candidate.importance === "redline")).toBe(
      true,
    );
  });

  it("三级结果去重：同一句重复喂两次不会重复落库", () => {
    const single = extractRules("我答应你，这周末一定把画稿给你");
    const merged = mergeExtractions([single, single]);
    expect(merged.candidates.length).toBe(single.candidates.length);
    expect(merged.loops.length).toBe(single.loops.length);
  });

  it("LLM 抽取只接受原文片段：编造的句子被丢弃", () => {
    const source = "我答应你，这周末一定把画稿给你";
    const raw = JSON.stringify({
      memories: [
        { text: "这周末一定把画稿给你", kind: "episodic", importance: "redline" },
        { text: "他说他其实是个画家", kind: "episodic", importance: "important" }, // 原文没有 → 丢弃
      ],
      facts: [],
      open_loops: [],
    });
    const parsed = parseLlmExtraction(raw, source);
    expect(parsed.candidates.length).toBe(1);
    expect(parsed.candidates[0]?.text).toContain("画稿");
  });
});

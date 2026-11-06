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
  pickVoicePart,
  placeVoiceOnContent,
  splitIntoParts,
  splitIntoPartsWithVoice,
  typingMsFor,
} from "../src/expression/planner.js";
import { Rng } from "../src/util/rng.js";

const traits = DEFAULT_TRAITS;

describe("分条", () => {
  it("短回复只分 1 条（不替模型补句号）", () => {
    expect(splitIntoParts("嗯，知道了", 2)).toEqual(["嗯，知道了"]);
    expect(maxPartsFor(6, 3)).toBe(1);
  });

  it("分条不会把半句话读成结巴：切点不落在词中间，也不补句号", () => {
    // 用户实测的原句：曾被切成「…是在测试我反应快。不快嘛还是说…」
    const raw = "咦，又发一个1呀是在测试我反应快不快嘛还是说单纯想刷个存在感捏~";
    const parts = splitIntoParts(raw, 3);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(MAX_PART_CHARS);
    // 关键：不能出现"快。不"这种被句号劈开的写法
    expect(parts.join("|")).not.toContain("快。不");
    // 原句里的字一个都不丢（除了被清理的空白）
    expect(parts.join("").replace(/[，,。！？]/g, "")).toBe(raw.replace(/[，,。！？]/g, ""));
  });

  it("长句按标点断，标点留在前一条上", () => {
    const raw = "今天下午一直在画画，画得不太顺。晚上可能就看个电影吧。你要是有空可以跟我说说今天怎么样。";
    const parts = splitIntoParts(raw, 3);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(MAX_PART_CHARS);
    expect(parts.every((part) => part.length > 0)).toBe(true);
    expect(parts.some((part) => /[。！？]$/.test(part))).toBe(true);
  });

  it("长回复 1–6 条，每条 ≤32 字，不丢内容（总长不超过上限）", () => {
    const raw =
      "今天下午一直在画画，画得不太顺。\n晚上可能就看个电影吧。\n你要是有空，可以跟我说说今天怎么样，我挺想听你讲讲的。";
    const parts = splitIntoParts(raw, 3);
    expect(parts.length).toBeGreaterThanOrEqual(1);
    expect(parts.length).toBeLessThanOrEqual(3);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(MAX_PART_CHARS);
    expect(parts.join("").startsWith("今天下午")).toBe(true);
  });

  it("maxPartsFor：短句收敛，长句按装得下的条数切，硬上限 20", () => {
    expect(maxPartsFor(6, 3)).toBe(1);
    expect(maxPartsFor(30, 3)).toBe(2);
    // burst ≤ 1 = 明确只要一条（主动消息）
    expect(maxPartsFor(100, 1)).toBe(1);
    // 100 字 / 32 字一条 = 4 条，性格再收敛也不能把字挤掉
    expect(maxPartsFor(100, 2)).toBe(4);
    expect(maxPartsFor(100, 5)).toBe(5);
    // 600 字 → 19 条；700 字本该 22 条，被压回 20 条硬上限
    expect(maxPartsFor(600, 3)).toBe(19);
    expect(maxPartsFor(700, 3)).toBe(20);
  });

  it("长回复能真的分成很多条（上限 20），且每条 ≤32 字", () => {
    const sentence = "今天下午一直在画画，画得不太顺";
    const raw = Array.from({ length: 12 }, () => `${sentence}。`).join("");
    const parts = splitIntoParts(raw, 3);
    expect(parts.length).toBeGreaterThan(3);
    expect(parts.length).toBeLessThanOrEqual(20);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(MAX_PART_CHARS);
  });

  it("没有标点的超长串会硬切，不出现 >32 字的条", () => {
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
  it("模型一行一句时：一行一条，绝不把两行拼成一个气泡", () => {
    const raw = [
      "可以的呀",
      "那我一句一句来",
      "你要不先告诉我怎么称呼你",
      "不然我真的猜不出你是谁呀",
    ].join("\n");
    const parts = splitIntoParts(raw, 3);
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("可以的呀");
    expect(parts[3]).toBe("不然我真的猜不出你是谁呀");
    // 每一条都不该跨行
    for (const part of parts) expect(part).not.toContain("\n");
  });

  it("收尾括号不会被单独切成一条", () => {
    const parts = splitIntoParts("（模型这次没连上，等下再试一下。）", 3);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe("（模型这次没连上，等下再试一下。）");
  });

  it("行数超过上限时合并到 20 条，且不把词劈开", () => {
    const raw = Array.from({ length: 30 }, (_, index) => `第${index + 1}句在这里`).join("\n");
    const parts = splitIntoParts(raw, 3);
    expect(parts.length).toBeLessThanOrEqual(20);
    expect(parts.length).toBeGreaterThan(3);
    // 每条要么是完整的一句，要么是「A，B」这种接缝合并，不该出现半句话
    for (const part of parts) {
      expect(raw).toContain(part.split("，")[0]);
    }
  });

  it("单行长句仍然按标点断，标点留在前一条", () => {
    const raw = "今天下午一直在画画，画得不太顺。晚上可能就看个电影吧。你要是有空，可以跟我说说今天怎么样，我挺想听你讲讲的。";
    const parts = splitIntoParts(raw, 3);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.some((part) => part.endsWith("。"))).toBe(true);
    expect(parts.join("")).toBe(raw);
  });
});

describe("语音标记（<voice>…</voice>）", () => {
  it("混合输出：普通段照旧分条，语音段标 voice，顺序与原文一致", () => {
    const raw = "今天有点冷。\n<voice>你快过来呀</voice>\n我下午一直在画画。";
    const parts = splitIntoPartsWithVoice(raw, 3);
    expect(parts.map((part) => part.text)).toEqual(["今天有点冷。", "你快过来呀", "我下午一直在画画。"]);
    expect(parts.map((part) => part.voice)).toEqual([false, true, false]);
    // 标签绝不能漏进正文
    for (const part of parts) expect(part.text).not.toMatch(/<\/?voice/i);
  });

  it("多个 <voice> 标记各自成条：一句一条，可以标多句（用户 2026-11-04）", () => {
    const raw = "今天有点冷。\n<voice>你快过来呀</voice>\n<voice>我把手画麻了</voice>\n嗯，等你。";
    const parts = splitIntoPartsWithVoice(raw, 3);
    expect(parts.map((part) => part.text)).toEqual(["今天有点冷。", "你快过来呀", "我把手画麻了", "嗯，等你。"]);
    expect(parts.map((part) => part.voice)).toEqual([false, true, true, false]);
    // 每条语音都是一句话：不是把长句拼成一条，而是拆成一句一条各发各的
    const spoken = parts.filter((part) => part.voice);
    expect(spoken.length).toBe(2);
    for (const part of spoken) expect(part.text).not.toContain("\n");
  });

  it("大小写不敏感、可跨行，且一处标记里多句时一句一条", () => {
    const raw = "嗯。\n<VOICE>今天有点冷。\n你快过来呀</VOICE>\n好";
    const parts = splitIntoPartsWithVoice(raw, 3);
    expect(parts.map((part) => part.text)).toEqual(["嗯。", "今天有点冷。", "你快过来呀", "好"]);
    expect(parts.map((part) => part.voice)).toEqual([false, true, true, false]);
  });

  it("语音段超长时继续切，每条都是 voice 且 ≤32 字", () => {
    const raw = `<voice>${"啊".repeat(80)}</voice>`;
    const parts = splitIntoPartsWithVoice(raw, 3);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.voice).toBe(true);
      expect(part.text.length).toBeLessThanOrEqual(MAX_PART_CHARS);
      expect(part.text.length).toBeGreaterThan(0);
    }
  });

  it("没有语音标记时与 splitIntoParts 完全一致", () => {
    const raw = "今天下午一直在画画，画得不太顺。晚上可能就看个电影吧。";
    expect(splitIntoPartsWithVoice(raw, 3).map((part) => part.text)).toEqual(splitIntoParts(raw, 3));
    expect(splitIntoPartsWithVoice(raw, 3).every((part) => part.voice === false)).toBe(true);
  });

  it("全空（含只有空标记）时回兜底一条空文本、非语音", () => {
    expect(splitIntoPartsWithVoice("   \n ", 3)).toEqual([{ text: "", voice: false }]);
    expect(splitIntoPartsWithVoice("<voice> </voice>", 3)).toEqual([{ text: "", voice: false }]);
  });

  it("历史里那种「用语音说的」前缀是标注，不许发出去（模型会照抄）", () => {
    // 用户实测的原样：它把系统的标注当成自己的话写了出来
    expect(splitIntoParts("（我刚才用语音说的）那我试试看哦", 3)).toEqual(["那我试试看哦"]);
    expect(splitIntoParts("（我刚用语音说的）晚安呀\n明天再聊", 3)).toEqual(["晚安呀", "明天再聊"]);
    expect(splitIntoParts("（他/她用语音说的）好", 3)).toEqual(["好"]);
    // 句子中间的括号说明是内容，不能误删
    expect(splitIntoParts("他刚才用语音说的那句话我没听清", 3)).toEqual(["他刚才用语音说的那句话我没听清"]);
  });

  it("说过「不好意思发语音」的句子不许再出声（自己打自己脸那种）", () => {
    // 用户 2026-11-04 抓到的原样：嘴上说不好意思发，手上一句语音发出去了
    const parts = splitIntoPartsWithVoice("<voice>而且我也不太好意思发</voice>", 3);
    expect(parts).toEqual([{ text: "而且我也不太好意思发", voice: false }]);
    // 只想打字那句话同样不能出声
    expect(splitIntoPartsWithVoice("<voice>我这边只能打字</voice>", 3)).toEqual([
      { text: "我这边只能打字", voice: false },
    ]);
    // 真正想出声的句子不受影响
    expect(splitIntoPartsWithVoice("<voice>那我试试看哦</voice>", 3)).toEqual([
      { text: "那我试试看哦", voice: true },
    ]);
    // 兜底挑句时也要跳过这类句子
    expect(pickVoicePart([{ text: "我也不太好意思发语音。" }, { text: "今天下雨了。" }])).toBe(1);
    expect(pickVoicePart([{ text: "我这边只能打字。" }])).toBe(-1);
  });

  it("铺垫句留文字、语音落到后面那句真话上（人类说话的次序）", () => {
    // 用户 2026-11-04 抓到的原样：它把「不过先说好，别笑我」这句铺垫本身发成了语音
    const parts = [{ text: "不过先说好，别笑我。" }, { text: "那我试试看哦" }];
    expect(placeVoiceOnContent(parts, [0])).toEqual([1]);
    // 铺垫后面还有铺垫，就继续往后找
    expect(placeVoiceOnContent([{ text: "先说好，别笑我" }, { text: "别嫌我啰嗦" }, { text: "今天下雨了。" }], [0])).toEqual([2]);
    // 铺垫后面没内容了：这一轮干脆不发声（等对方回了再说）
    expect(placeVoiceOnContent([{ text: "好嘛好嘛" }, { text: "不过先说好，别笑我。" }], [1])).toEqual([]);
    // 本来就是内容的句子不受影响
    expect(placeVoiceOnContent([{ text: "那我试试看哦" }], [0])).toEqual([0]);
    // 兜底挑句时也跳过铺垫
    expect(pickVoicePart([{ text: "不过先说好，别笑我。" }, { text: "今天下雨了。" }])).toBe(1);
    expect(pickVoicePart([{ text: "不过先说好，别笑我。" }])).toBe(-1);
  });

  it("没标 <voice> 时挑一条最像该用声音说的：短、带情绪，不再永远挑第一句", () => {
    // 第一句是铺垫，第二句才是该出声的那句
    expect(
      pickVoicePart([{ text: "今天上班好累啊，回家一路上都在下雨。" }, { text: "那我试试看哦" }]),
    ).toBe(1);
    // 带问号/感叹的优先
    expect(pickVoicePart([{ text: "我在呢。" }, { text: "你真的要走吗？" }])).toBe(1);
    // 都一样短、都没有情绪标点时挑靠后那条（情绪落点通常在后面）
    expect(pickVoicePart([{ text: "好的呀。" }, { text: "知道了呀。" }])).toBe(1);
    // 都超长时也挑最短的那条
    expect(
      pickVoicePart([{ text: "一".repeat(40) }, { text: "二".repeat(30) }, { text: "三".repeat(28) }]),
    ).toBe(2);
    expect(pickVoicePart([])).toBe(-1);
    expect(pickVoicePart([{ text: "   " }])).toBe(-1);
  });

  it("planParts 透传 voice：只有语音条写 voice:true，其余不带这个键", () => {
    const parts = planParts("今天有点冷。<voice>你快过来呀</voice>我在画画。", {
      traits,
      presence: "idle",
      rng: Rng.fromString("voice-plan"),
    });
    expect(parts.map((part) => part.text)).toEqual(["今天有点冷。", "你快过来呀", "我在画画。"]);
    expect(parts[1]?.voice).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(parts[0], "voice")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parts[2], "voice")).toBe(false);
    // 语音条也要吃 typing/延迟的既有节奏：最后一条 delayAfterMs=0
    expect(parts[parts.length - 1]?.delayAfterMs).toBe(0);
    for (const part of parts) expect(part.text).not.toMatch(/<\/?voice/i);
  });
});
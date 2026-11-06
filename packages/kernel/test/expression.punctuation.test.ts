import { describe, expect, it } from "vitest";
import { polishPunctuation } from "../src/expression/punctuation.js";

/**
 * v1.0.12 回退后的口径：这一层只收拾，不发明。
 *
 * 曾经的错法是"帮模型补标点"，于是分条把一句话切在两半时，
 * 前半截被补上句号，「是在测试我反应快不快嘛」读成「…反应快。不快嘛」。
 */
describe("语言策略：只收拾，不补标点", () => {
  it("句末没标点也不补：标点是模型的职责", () => {
    expect(polishPunctuation("今天好累")).toBe("今天好累");
    expect(polishPunctuation("你吃了吗")).toBe("你吃了吗");
    expect(polishPunctuation("在干嘛呢")).toBe("在干嘛呢");
  });

  it("原有标点原样保留", () => {
    expect(polishPunctuation("今天好累。")).toBe("今天好累。");
    expect(polishPunctuation("真的吗？")).toBe("真的吗？");
    expect(polishPunctuation("好耶！")).toBe("好耶！");
    expect(polishPunctuation("好的~")).toBe("好的~");
  });

  it("长句里不插逗号", () => {
    expect(polishPunctuation("今天加班到很晚但是我还是想跟你说个事")).toBe(
      "今天加班到很晚但是我还是想跟你说个事",
    );
  });

  it("重复标点收拾成一个", () => {
    expect(polishPunctuation("真的吗？？")).toBe("真的吗？");
    expect(polishPunctuation("好。。")).toBe("好。");
    expect(polishPunctuation("嗯，，知道了")).toBe("嗯，知道了");
  });

  it("不清空表情与空串", () => {
    expect(polishPunctuation("")).toBe("");
    expect(polishPunctuation("   ")).toBe("");
    expect(polishPunctuation("😂")).toBe("😂");
  });

  it("不动数字与链接里的冒号/斜杠", () => {
    expect(polishPunctuation("明天 9:30 见")).toBe("明天 9:30 见");
    expect(polishPunctuation("看 https://example.com/a")).toBe("看 https://example.com/a");
  });

  it("半句话不会被打上句号（用户报的那个结巴）", () => {
    const half = "是在测试我反应快";
    expect(polishPunctuation(half)).toBe(half);
  });
});
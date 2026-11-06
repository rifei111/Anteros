import { describe, expect, it } from "vitest";
import { stripReasoning } from "../src/llm/sanitize.js";

describe("剥掉模型的思考过程", () => {
  it("完整标签包住的思考整段删掉，只留正文", () => {
    const raw = "<think\n用户在问我聊得怎么样，我要先安抚。\n</think>\n那你希望我怎么跟你聊呢";
    expect(stripReasoning(raw).text).toBe("那你希望我怎么跟你聊呢");
  });

  it("残缺标签（实测出现的 <think / </think 没有 >）也要能剥干净", () => {
    const raw = "<think\n（对方这么问，可能是有点认真了吧。\n我得说得软一点，别让他觉得我在顶他。\n）</think那你希望我怎么跟你聊嘛";
    const { text } = stripReasoning(raw);
    expect(text).toBe("那你希望我怎么跟你聊嘛");
    expect(text).not.toContain("think");
    expect(text).not.toContain("我得说得软一点");
  });

  it("只有开标签、没有收尾：开标签之后全部丢掉", () => {
    const raw = "好呀\n<think\n我要不要多说一句";
    expect(stripReasoning(raw).text).toBe("好呀");
  });

  it("中文【思考】块也剥掉", () => {
    const raw = "【思考】\n他在测试我\n【/思考】\n在呢";
    expect(stripReasoning(raw).text).toBe("在呢");
  });

  it("正文里的正常括号不误删", () => {
    const raw = "（笑）你先说";
    expect(stripReasoning(raw).text).toBe("（笑）你先说");
  });

  it("开头整行括号旁白删掉，保留后面的正文", () => {
    const raw = "（他这句话有点认真，我得认真接）\n没有呀，你想听真话还是客气话";
    expect(stripReasoning(raw).text).toBe("没有呀，你想听真话还是客气话");
  });

  it("没有思考内容时不改动正文", () => {
    const raw = "好呀\n那我记着了";
    expect(stripReasoning(raw).text).toBe(raw);
  });
});
/**
 * 「留着没说出口的那句话」（v1.0.34）：
 *   - `<voice wait>` 解析成 hold，标签不进正文；
 *   - 槽位存取 / 逐轮计数 / 30 分钟老化；
 *   - 下一轮装配时那句话会摆到它面前（递料，不替它发）。
 */
import { Db } from "../src/db/database.js";
import { describe, expect, it } from "vitest";
import { planParts, splitIntoPartsWithVoice } from "../src/expression/planner.js";
import { VoiceHoldStore } from "../src/services/voice-hold.js";
import { DEFAULT_TRAITS } from "@anteros/shared";
import { Rng } from "../src/util/rng.js";
import { ExpressionService } from "../src/expression/service.js";
import { MemoryService } from "../src/memory/service.js";
import { MindService } from "../src/mind/service.js";
import { makeKernel } from "./fixtures/kernel.js";
import type { LlmPort } from "../src/contracts.js";

const NOW = 1_760_000_000_000;
const PLAN_INPUT = {
  traits: DEFAULT_TRAITS,
  presence: "phone_beside" as const,
  rng: Rng.fromString("voice-hold"),
};

function fakeLlm(): LlmPort {
  return {
    isConfigured: () => true,
    generate: async () => ({ text: "嗯。", model: "fake-model", usage: { inputTokens: 1, outputTokens: 1 } }),
    status: () => ({ configured: true, providerId: "fake", baseUrl: null, model: "fake-model", lastError: null }),
  };
}

describe("<voice wait>：留着没说出口的那句话", () => {
  it("解析：wait 标出的句子带 hold，正文不含标签；普通 <voice> 不带 hold", () => {
    const parts = splitIntoPartsWithVoice("这句话打字说\n<voice wait>那我试试看哦</voice>", 3);
    expect(parts).toEqual([
      { text: "这句话打字说", voice: false },
      { text: "那我试试看哦", voice: true, hold: true },
    ]);
    const plain = splitIntoPartsWithVoice("<voice>现在就发</voice>", 3);
    expect(plain).toEqual([{ text: "现在就发", voice: true }]);
    // planParts 要把 hold 带到 PlannedPart 上（下游靠它判断"这轮不发"）
    const planned = planParts("<voice wait>等会儿再说这句</voice>", PLAN_INPUT);
    expect(planned[0]?.hold).toBe(true);
    expect(planned[0]?.text).toBe("等会儿再说这句");
  });

  it("槽位：存进去、取出来记得次数，超过三轮作废", () => {
    const db = new Db(":memory:");
    db.migrate();
    try {
      const store = new VoiceHoldStore(db);
      store.put("wechat:alice", "那我试试看哦", 7, NOW);
      expect(store.peek("wechat:alice", NOW + 1000)?.text).toBe("那我试试看哦");
      expect(store.peek("wechat:alice", NOW + 1000)?.seen).toBe(0);
      // 每轮到一次 +1；到第三轮还可以用，第四轮就作废
      expect(store.claim("wechat:alice", NOW + 2000)?.seen).toBe(1);
      expect(store.claim("wechat:alice", NOW + 3000)?.seen).toBe(2);
      expect(store.claim("wechat:alice", NOW + 4000)?.seen).toBe(3);
      expect(store.claim("wechat:alice", NOW + 5000)).toBeNull();
      expect(store.peek("wechat:alice", NOW + 5000)).toBeNull();
    } finally {
      db.close();
    }
  });

  it("槽位：30 分钟就过期（话说晚了不如不说）；会话之间互不干扰", () => {
    const db = new Db(":memory:");
    db.migrate();
    try {
      const store = new VoiceHoldStore(db);
      store.put("wechat:alice", "留一句", 1, NOW);
      store.put("wechat:bob", "另一句", 2, NOW);
      expect(store.claim("wechat:bob", NOW + 1000)?.text).toBe("另一句");
      expect(store.claim("wechat:alice", NOW + 31 * 60_000)).toBeNull();
      expect(store.peek("wechat:bob", NOW + 1000)?.text).toBe("另一句");
      store.clear("wechat:bob");
      expect(store.peek("wechat:bob", NOW + 1000)).toBeNull();
    } finally {
      db.close();
    }
  });

  it("下一轮装配时，那句话会出现在系统段里（说不说仍由它自己定）", async () => {
    const kernel = makeKernel();
    const memory = new MemoryService(kernel.deps, null);
    const mind = new MindService(kernel.deps, memory);
    const expression = new ExpressionService(kernel.deps, mind, memory, fakeLlm());
    try {
      const bundle = await expression.assemble({
        agentId: kernel.deps.agentId,
        userText: "嗯",
        trigger: "reply",
        now: NOW,
        heldVoice: "那我试试看哦",
      });
      expect(bundle.system).toContain("【你上一轮留着没说出口的一句话】");
      expect(bundle.system).toContain("那我试试看哦");
      // 没有留着的话就不该出现这一段
      const plain = await expression.assemble({
        agentId: kernel.deps.agentId,
        userText: "嗯",
        trigger: "reply",
        now: NOW,
      });
      expect(plain.system).not.toContain("【你上一轮留着没说出口的一句话】");
    } finally {
      kernel.close();
    }
  });
});
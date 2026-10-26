/**
 * 上下文装配与计划产出（规范 2 §2；草案 4.5）：
 *   - 系统段包含人设/关系/时间在场/约束/证据层，且零预置模板（不给例句）；
 *   - messages 是最近对话原文；
 *   - planReply 产出 1–3 条、每条 ≤25 字，并带可回放的 ctxSnapshot。
 */
import type { LlmPort } from "../src/contracts.js";
import { describe, expect, it } from "vitest";
import { ExpressionService } from "../src/expression/service.js";
import { MemoryService } from "../src/memory/service.js";
import { MindService } from "../src/mind/service.js";
import { insertMessage, makeKernel } from "./fixtures/kernel.js";

const NOW = 1_760_000_000_000;

function fakeLlm(text = "今天有点冷。我下午一直在画画，画得不太顺。"): LlmPort {
  return {
    isConfigured: () => true,
    generate: async () => ({ text, model: "fake-model", usage: { inputTokens: 11, outputTokens: 22 } }),
    status: () => ({ configured: true, providerId: "fake", baseUrl: null, model: "fake-model", lastError: null }),
  };
}

function wiring() {
  const kernel = makeKernel();
  const memory = new MemoryService(kernel.deps, null);
  const mind = new MindService(kernel.deps, memory);
  const expression = new ExpressionService(kernel.deps, mind, memory, fakeLlm());
  return { kernel, memory, mind, expression };
}

describe("上下文装配", () => {
  it("系统段有人设、关系、时间在场、表达约束；messages 是最近对话原文", async () => {
    const { kernel, memory, expression } = wiring();
    try {
      insertMessage(kernel.db, kernel.deps.agentId, "user", "在吗", NOW - 2000);
      insertMessage(kernel.db, kernel.deps.agentId, "agent", "嗯，在的", NOW - 1000);

      const bundle = await expression.assemble({
        agentId: kernel.deps.agentId,
        userText: "今天有点累",
        trigger: "reply",
        now: NOW,
      });
      expect(bundle.system).toContain("小满");
      expect(bundle.system).toContain("成都");
      expect(bundle.system).toContain("【你是谁】");
      expect(bundle.system).toContain("【表达约束】");
      expect(bundle.system).toContain("【现在是】");
      expect(bundle.messages.map((message) => message.content)).toEqual(["在吗", "嗯，在的"]);
      expect(bundle.slots["identity"]).toBeDefined();
      expect(bundle.slots["relationship"]).toBeDefined();
    } finally {
      kernel.close();
    }
  });

  it("证据层：pinned 事实必给，但不给例句（零预置模板）", async () => {
    const { kernel, memory, expression } = wiring();
    try {
      memory.rememberEpisode({
        agentId: kernel.deps.agentId,
        text: "我答应你，这周末一定把画稿给你",
        now: NOW,
        importance: "redline",
      });
      const bundle = await expression.assemble({
        agentId: kernel.deps.agentId,
        userText: "你还记得答应我的事吗",
        trigger: "reply",
        now: NOW,
      });
      expect(bundle.system).toContain("【证据层】");
      expect(bundle.system).toContain("画稿");
      expect(bundle.pinned.length).toBeGreaterThan(0);
      // 不内置问候/共情/开场句库，也不在 prompt 里给"例如"式例句
      for (const banned of ["你好呀", "早上好", "别难过", "我理解你的感受", "例如：", "比如："]) {
        expect(bundle.system.includes(banned), banned).toBe(false);
      }
    } finally {
      kernel.close();
    }
  });
});

describe("planReply", () => {
  it("分条 1–3 条、每条 ≤25 字，带模型信息与可回放 ctxSnapshot", async () => {
    const { kernel, expression } = wiring();
    try {
      const plan = await expression.planReply({
        agentId: kernel.deps.agentId,
        userText: "今天怎么样",
        trigger: "reply",
        now: NOW,
      });
      expect(plan.parts.length).toBeGreaterThanOrEqual(1);
      expect(plan.parts.length).toBeLessThanOrEqual(3);
      for (const part of plan.parts) {
        expect(part.text.length).toBeGreaterThan(0);
        expect(part.text.length).toBeLessThanOrEqual(25);
        expect(part.typingMs).toBeGreaterThan(0);
      }
      expect(plan.fullText.length).toBeGreaterThan(0);
      expect(plan.model).toBe("fake-model");
      expect(plan.prompt).toContain("小满");
      const ctx = plan.ctxSnapshot as { seed?: string; memoryIds?: number[]; presence?: string };
      expect(typeof ctx.seed).toBe("string");
      expect(Array.isArray(ctx.memoryIds)).toBe(true);
      expect(ctx.presence).toBeDefined();
    } finally {
      kernel.close();
    }
  });
});

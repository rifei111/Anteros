/**
 * MemoryService 集成：抽取落库、召回更新 access_log、语义事实 supersede、pinned、软删。
 * 全部用内存 SQLite（规范 1 §6：单测不碰真实库）。
 */
import { describe, expect, it } from "vitest";
import { MemoryService } from "../src/memory/service.js";
import { insertMessage, makeKernel } from "./fixtures/kernel.js";

const NOW = 1_760_000_000_000;

describe("MemoryService", () => {
  it("规则抽取会落库：承诺进 redline、未闭合话题进 open_loops", async () => {
    const kernel = makeKernel();
    try {
      const memory = new MemoryService(kernel.deps, null);
      const count = await memory.extract(kernel.deps.agentId, [{ id: 1, text: "改天请你吃饭", ts: NOW }], NOW);
      expect(count).toBeGreaterThan(0);
      const stats = memory.stats(kernel.deps.agentId);
      expect(stats.openLoops).toBeGreaterThan(0);
      expect(stats.total).toBeGreaterThan(0);
    } finally {
      kernel.close();
    }
  });

  it("召回会更新 last_access_ts 与 access_log（ACT-R 的间隔效应来源）", () => {
    const kernel = makeKernel();
    try {
      const memory = new MemoryService(kernel.deps, null);
      const agentId = kernel.deps.agentId;
      const id = memory.rememberEpisode({ agentId, text: "他说他在画一张雨天的插画", now: NOW, importance: "important" });

      const result = memory.recall({ agentId, text: "雨天的插画", now: NOW + 1000 });
      expect(result.items.some((item) => item.id === id)).toBe(true);

      const row = kernel.db.get<{ access_log: string; last_access_ts: number }>(
        "SELECT access_log, last_access_ts FROM memory_episodic WHERE id = ?",
        [id],
      );
      const log = JSON.parse(row?.access_log ?? "[]") as number[];
      expect(log.length).toBe(2); // 编码时刻 + 这次召回
      expect(row?.last_access_ts).toBe(NOW + 1000);
    } finally {
      kernel.close();
    }
  });

  it("pinned 证据：redline 与未闭合话题优先兜底注入", () => {
    const kernel = makeKernel();
    try {
      const memory = new MemoryService(kernel.deps, null);
      const agentId = kernel.deps.agentId;
      const pinnedId = memory.rememberEpisode({ agentId, text: "我答应你，这周末一定把画稿给你", now: NOW, importance: "redline" });
      memory.rememberEpisode({ agentId, text: "今天吃了碗面", now: NOW, importance: "detail" });
      memory.openLoop({ agentId, topic: "改天请你吃饭", now: NOW, urgency: 0.8 });

      const pinned = memory.pinnedEvidence(agentId, NOW);
      expect(pinned.some((item) => item.id === pinnedId)).toBe(true);
      expect(pinned.some((item) => item.kind === "open_loop")).toBe(true);
    } finally {
      kernel.close();
    }
  });

  it("语义事实更新走 supersede：旧行保留、superseded_by 指向新行", () => {
    const kernel = makeKernel();
    try {
      const memory = new MemoryService(kernel.deps, null);
      const agentId = kernel.deps.agentId;
      const first = memory.upsertSemantic({ agentId, slotKey: "pref.like:咖啡", value: "美式", confidence: 0.6, now: NOW });
      const second = memory.upsertSemantic({ agentId, slotKey: "pref.like:咖啡", value: "拿铁", confidence: 0.7, now: NOW + 1000 });
      expect(second).not.toBe(first);

      const oldRow = kernel.db.get<{ superseded_by: number | null; deleted_ts: number | null }>(
        "SELECT superseded_by, deleted_ts FROM memory_semantic WHERE id = ?",
        [first],
      );
      expect(oldRow?.superseded_by).toBe(second);
      // 旧行不删：要能回溯"它改过什么看法"
      expect(oldRow?.deleted_ts).toBeNull();

      const stats = memory.stats(agentId);
      expect(stats.semantic).toBe(1); // 当前事实只算一条
    } finally {
      kernel.close();
    }
  });

  it("deleteAll 是软删：写 deleted_ts，统计清零", () => {
    const kernel = makeKernel();
    try {
      const memory = new MemoryService(kernel.deps, null);
      const agentId = kernel.deps.agentId;
      const id = memory.rememberEpisode({ agentId, text: "一件小事", now: NOW });
      insertMessage(kernel.db, agentId, "user", "你好", NOW);

      const removed = memory.deleteAll(agentId, NOW + 1);
      expect(removed).toBeGreaterThan(0);
      expect(memory.stats(agentId).total).toBe(0);
      const row = kernel.db.get<{ deleted_ts: number | null }>("SELECT deleted_ts FROM memory_episodic WHERE id = ?", [id]);
      expect(row?.deleted_ts).toBe(NOW + 1);
    } finally {
      kernel.close();
    }
  });
});

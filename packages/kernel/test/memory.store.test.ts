/**
 * 记忆存储的硬约束（规范 1 §3.1、草案 1.4）：
 *   - memory_persona 只允许种子人格（mutable=0）写入，抽取管线不得写；
 *   - 软删除保留行、semantic 更新靠 superseded_by 指向新行。
 */
import { describe, expect, it } from "vitest";
import { PersonaMemoryWriteError, insertPersonaMemory, listPersonaMemory } from "../src/memory/store.js";
import { MemoryService } from "../src/memory/service.js";
import { makeKernel } from "./fixtures/kernel.js";

const NOW = 1_760_000_000_000;

describe("persona 记忆的写保护", () => {
  it("种子人格（mutable=0）可写", () => {
    const kernel = makeKernel();
    try {
      insertPersonaMemory(kernel.db, kernel.deps.agentId, "identity.name", "小满", 0);
      expect(listPersonaMemory(kernel.db, kernel.deps.agentId).length).toBe(1);
    } finally {
      kernel.close();
    }
  });

  it("可变人格（mutable=1）写入直接抛错：抽取管线不得改人格", () => {
    const kernel = makeKernel();
    try {
      expect(() => insertPersonaMemory(kernel.db, kernel.deps.agentId, "identity.name", "别人", 1)).toThrow(PersonaMemoryWriteError);
    } finally {
      kernel.close();
    }
  });

  it("抽取落库不会写 memory_persona", async () => {
    const kernel = makeKernel();
    try {
      const memory = new MemoryService(kernel.deps, null);
      await memory.extract(kernel.deps.agentId, [{ id: 1, text: "我答应你，这周末一定把画稿给你", ts: NOW }], NOW);
      expect(listPersonaMemory(kernel.db, kernel.deps.agentId)).toEqual([]);
    } finally {
      kernel.close();
    }
  });
});

/**
 * 清空/重置记忆时，关系与驱动也要归零。
 *
 * 之前的坑：记忆删干净了，relation_state 还挂着 intimacy，界面上亲密度一路涨，
 * 用户看到的就是「清理记忆之后关系数值永远不会变」。
 */
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResetService } from "../src/services/reset.js";
import { makeKernel } from "./fixtures/kernel.js";

describe("重置记忆时关系归零", () => {
  it("intimacy / stage / 转移日志都被清零，驱动也回到初始", () => {
    const kernel = makeKernel();
    try {
      const { db } = kernel.deps;
      const agentId = kernel.deps.agentId;

      // 伪造一段「已经很熟」的状态
      db.run(
        "UPDATE relation_state SET stage = 'close', intimacy = 0.82, trust = 0.91, mode = 'full_human', last_transition_ts = ?, transition_log = ? WHERE agent_id = ?",
        [Date.now(), JSON.stringify([{ from: "familiar", to: "close", ts: Date.now() }]), agentId],
      );
      db.run(
        "UPDATE drives_state SET loneliness = 0.9, longing = 0.7, tension = 0.5, updated_ts = ? WHERE agent_id = ?",
        [Date.now(), agentId],
      );

      const reset = new ResetService(kernel.deps.db, join(tmpdir(), "anteros-test-reset"), kernel.deps.log);
      reset.resetMemory(agentId, { keepChat: true });

      const relation = db.get<{ stage: string; intimacy: number; trust: number; mode: string; transition_log: string; last_transition_ts: number | null }>(
        "SELECT stage, intimacy, trust, mode, transition_log, last_transition_ts FROM relation_state WHERE agent_id = ?",
        [agentId],
      );
      expect(relation?.stage).toBe("stranger");
      expect(relation?.intimacy).toBe(0);
      expect(relation?.trust).toBe(0.5);
      expect(relation?.mode).toBe("standard");
      expect(relation?.transition_log).toBe("[]");
      expect(relation?.last_transition_ts ?? null).toBeNull();

      const drives = db.get<{ loneliness: number; longing: number }>(
        "SELECT loneliness, longing FROM drives_state WHERE agent_id = ?",
        [agentId],
      );
      expect(drives?.loneliness).toBe(0);
      expect(drives?.longing).toBe(0);
    } finally {
      kernel.close();
    }
  });
});
/**
 * 关系状态机（规范 1 §3.2–§3.3）：
 *   - 非法转移被拒、不允许跳级；
 *   - intimacy 只能由 transition_log 事件累加，直接赋值抛错；
 *   - 阶段文本进 prompt 时只有人话，不暴露数值。
 */
import { describe, expect, it } from "vitest";
import { ALLOWED_NEXT, RelationService, canTransition, evaluateTransition, stagePhrase } from "../src/mind/relation.js";
import type { RelationStage } from "@anteros/shared";
import { DAY, insertMessage, makeKernel } from "./fixtures/kernel.js";

const STAGES: RelationStage[] = ["stranger", "acquainted", "familiar", "close", "strained", "repairing"];

describe("关系状态机", () => {
  it("stranger → familiar 是跳级，必须被拒", () => {
    expect(canTransition("stranger", "familiar")).toBe(false);
    expect(canTransition("stranger", "close")).toBe(false);
    const metrics = { userDays: 100, privateShares: 100, sharedExperiences: 100, repairs: 100 };
    // 判据只在相邻阶段成立，不会因为"累计量很大"就直接返回 familiar
    expect(evaluateTransition("stranger", 0.9, metrics)?.to).toBe("acquainted");
  });

  it("允许边与转移表一致（stranger→acquainted、strained→repairing→close）", () => {
    expect(canTransition("stranger", "acquainted")).toBe(true);
    expect(canTransition("acquainted", "familiar")).toBe(true);
    expect(canTransition("familiar", "close")).toBe(true);
    expect(canTransition("close", "strained")).toBe(true);
    expect(canTransition("strained", "repairing")).toBe(true);
    expect(canTransition("repairing", "close")).toBe(true);
    for (const stage of STAGES) {
      for (const target of ALLOWED_NEXT[stage]) expect(canTransition(stage, target)).toBe(true);
    }
  });

  it("intimacy 只能由事件累加：直接赋值抛错", () => {
    const kernel = makeKernel();
    try {
      const relation = new RelationService(kernel.deps);
      expect(() => relation.setIntimacy(0.9)).toThrow(/事件累加/);
    } finally {
      kernel.close();
    }
  });

  it("分享私事 + 情绪 + 当天第一条 → intimacy 按事件增量累加", () => {
    const kernel = makeKernel();
    try {
      const relation = new RelationService(kernel.deps);
      const now = Date.now();
      const before = relation.get();
      const after = relation.observeUserTurn("其实我最近挺累的，压力很大", now);
      // daily_chat 0.02 + share_private 0.06 + emotional 0.04 = 0.12
      expect(after.intimacy).toBeCloseTo(before.intimacy + 0.12, 6);
      expect(after.trust).toBeCloseTo(before.trust + 0.055, 6);
      // 事件写进 transition_log，数值不是凭空赋值来的
      expect(after.transitionLog.some((entry) => entry.trigger === "user:private")).toBe(true);
    } finally {
      kernel.close();
    }
  });

  it("累计 3 天有效对话后 stranger → acquainted", () => {
    const kernel = makeKernel();
    try {
      const relation = new RelationService(kernel.deps);
      const now = Date.now();
      insertMessage(kernel.db, kernel.deps.agentId, "user", "第一天", now - 2 * DAY);
      insertMessage(kernel.db, kernel.deps.agentId, "user", "第二天", now - DAY);
      insertMessage(kernel.db, kernel.deps.agentId, "user", "今天", now);
      const after = relation.observeUserTurn("嗯嗯，今天还行", now);
      expect(after.stage).toBe("acquainted");
      expect(after.transitionLog.some((entry) => entry.to === "acquainted")).toBe(true);
    } finally {
      kernel.close();
    }
  });

  it("冲突语气从任何阶段进 strained，之后只能走 repairing", () => {
    const kernel = makeKernel();
    try {
      const relation = new RelationService(kernel.deps);
      const now = Date.now();
      const strained = relation.observeUserTurn("我讨厌你，别烦我", now);
      expect(strained.stage).toBe("strained");
      expect(canTransition(strained.stage, "acquainted")).toBe(false);
      const repairing = relation.setMode("standard");
      expect(repairing.stage).toBe("strained");
    } finally {
      kernel.close();
    }
  });

  it("setMode 只接受 standard / full_human，非法值抛错", () => {
    const kernel = makeKernel();
    try {
      const relation = new RelationService(kernel.deps);
      expect(() => relation.setMode("admin")).toThrow(/非法关系模式/);
      expect(relation.setMode("full_human").mode).toBe("full_human");
    } finally {
      kernel.close();
    }
  });

  it("阶段文本只有人话，不出现数值", () => {
    for (const stage of STAGES) {
      const phrase = stagePhrase(stage);
      expect(phrase.length).toBeGreaterThan(0);
      expect(/[0-9]|%/.test(phrase)).toBe(false);
    }
  });
});

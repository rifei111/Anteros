/**
 * 关系状态机（规范 1 §3.2–§3.3，草案 3.4）。
 *
 * 三条硬规则，代码里是硬闸：
 *   1. intimacy 只能由 transition_log 里的事件累加，直接赋值一律抛错；
 *   2. 阶段只能沿允许的边迁移，不允许跳级（stranger→familiar 直接拒绝）；
 *   3. 阶段文本进 prompt 时只给一句人话，不暴露任何数值（关系数值是内核内部量）。
 *
 * 事件增量口径（规范 1 §3.3 表的简化取整；量级经过测试校准：约 4 天闲聊+
 * 2 次私事分享能到 acquainted→familiar 的 0.2 线）：
 *   daily_chat 0.02 / share_private 0.06 / emotional 0.04 / shared_experience 0.08
 *   its_turn 0.01 / joke 0.02 / conflict -0.15 / repair 0.05
 */
import type { AgentMode, RelationStage, RelationState, RelationTransition } from "@anteros/shared";
import type { Db } from "../db/database.js";
import type { KernelDeps } from "../contracts.js";
import { clamp, localParts, startOfLocalDay } from "../util/time.js";

export type RelationEvent =
  | "daily_chat"
  | "share_private"
  | "emotional"
  | "shared_experience"
  | "its_turn"
  | "joke"
  | "conflict"
  | "repair";

/** 每类事件对 intimacy / trust 的增量（规范 1 §3.3）。 */
export const EVENT_DELTAS: Record<RelationEvent, { intimacy: number; trust: number }> = {
  daily_chat: { intimacy: 0.02, trust: 0.005 },
  share_private: { intimacy: 0.06, trust: 0.03 },
  emotional: { intimacy: 0.04, trust: 0.02 },
  shared_experience: { intimacy: 0.08, trust: 0.02 },
  its_turn: { intimacy: 0.01, trust: 0.002 },
  joke: { intimacy: 0.02, trust: 0.005 },
  conflict: { intimacy: -0.15, trust: -0.12 },
  repair: { intimacy: 0.05, trust: 0.04 },
};

/** 允许的下一阶段（"任何阶段都可能 strained" 单列，不允许跳级）。 */
export const ALLOWED_NEXT: Record<RelationStage, readonly RelationStage[]> = {
  stranger: ["acquainted", "strained"],
  acquainted: ["familiar", "strained"],
  familiar: ["close", "strained"],
  close: ["strained"],
  strained: ["repairing"],
  repairing: ["close", "strained"],
};

/** 阶段 → 进 prompt 的一句话（只有人话，没有数值；草案 3.4）。 */
export const STAGE_PROMPT: Record<RelationStage, string> = {
  stranger: "刚认识不久：客气、留距离，别自来熟，也别盘问。",
  acquainted: "认识一阵了：说话自然些，可以问近况，但别越界。",
  familiar: "挺熟的：可以开玩笑、可以直说，不用客套。",
  close: "很亲近：可以示弱、可以惦记对方，但别黏人、别查岗。",
  strained: "最近气氛有点僵：短句、留空间，先别解释、别硬贴。",
  repairing: "在缓和：态度放软，慢慢来，别急着回到从前。",
};

export function stagePhrase(stage: RelationStage): string {
  return STAGE_PROMPT[stage];
}

/** 转移判据用到的累计量（全部来自 transition_log 与 messages，不另建表）。 */
export interface RelationMetrics {
  /** 有过对话的本地日历天数 */
  userDays: number;
  /** 分享私事次数 */
  privateShares: number;
  /** 共享经历次数（一起做过/约好的事） */
  sharedExperiences: number;
  /** 冲突后求和/缓和次数 */
  repairs: number;
}

export interface StageCriteria {
  to: RelationStage;
  reason: string;
}

/**
 * 阶段判据（规范 1 §3.3 转移表）：
 *   stranger → acquainted：有效对话累计 ≥3 天
 *   acquainted → familiar：分享私事 ≥2 次且 intimacy ≥0.2
 *   familiar → close：共享经历 ≥5 次且 intimacy ≥0.55
 *   strained → repairing：求和/缓和事件 ≥2 次
 *   repairing → close：共享经历 ≥1 次且 intimacy ≥0.55
 */
export function evaluateTransition(stage: RelationStage, intimacy: number, metrics: RelationMetrics): StageCriteria | null {
  if (stage === "stranger" && metrics.userDays >= 3) {
    return { to: "acquainted", reason: `累计对话 ${metrics.userDays} 天` };
  }
  if (stage === "acquainted" && metrics.privateShares >= 2 && intimacy >= 0.2) {
    return { to: "familiar", reason: "分享私事 ≥2 次且亲近度达标" };
  }
  if (stage === "familiar" && metrics.sharedExperiences >= 5 && intimacy >= 0.55) {
    return { to: "close", reason: "共享经历 ≥5 次且亲近度达标" };
  }
  if (stage === "strained" && metrics.repairs >= 2) {
    return { to: "repairing", reason: "冲突后缓和 ≥2 次" };
  }
  if (stage === "repairing" && metrics.sharedExperiences >= 1 && intimacy >= 0.55) {
    return { to: "close", reason: "缓和后重新积累到亲近线" };
  }
  return null;
}

export function canTransition(from: RelationStage, to: RelationStage): boolean {
  return ALLOWED_NEXT[from].includes(to);
}

interface RelationRow {
  agent_id: number;
  stage: string;
  intimacy: number;
  trust: number;
  mode: string;
  since_ts: number;
  last_transition_ts: number | null;
  transition_log: string;
}

const CONFLICT_RE = /(分手|讨厌你|别烦我|不想理你|滚开|闭嘴|烦死了|再也不|别联系)/u;
const REPAIR_RE = /(对不起|抱歉|是我不好|没事了|算了|不气了|理解你|辛苦了|别介意)/u;
const PRIVATE_RE = /(其实我|说实话|跟(?:你|您)说|我家里|我(?:爸|妈|父母)|前任|工资|存款|体检|生病|住院|秘密|没人知道|我小时候|第一次跟别人说|我最近在)/u;
const EMOTION_RE = /(难过|开心|高兴|烦|累|压力|焦虑|害怕|委屈|崩溃|失眠|孤独|生气|伤心|慌|压抑|低落)/u;
const SHARED_AGENT_RE = /(陪你|一起|我们|下次|我在|记得|约好)/u;

function parseLog(raw: string): RelationTransition[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is RelationTransition =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as RelationTransition).from === "string" &&
        typeof (item as RelationTransition).to === "string" &&
        typeof (item as RelationTransition).trigger === "string" &&
        typeof (item as RelationTransition).ts === "number",
    );
  } catch {
    return [];
  }
}

function countTrigger(log: readonly RelationTransition[], trigger: string): number {
  return log.filter((entry) => entry.trigger === trigger).length;
}

export class RelationService {
  private readonly db: Db;

  constructor(private readonly deps: KernelDeps) {
    this.db = deps.db;
  }

  get(): RelationState {
    this.ensureRow();
    const row = this.readRow();
    const stage = this.validStage(row.stage);
    return {
      stage,
      intimacy: row.intimacy,
      trust: row.trust,
      mode: row.mode === "full_human" ? "full_human" : "standard",
      sinceTs: row.since_ts,
      lastTransitionTs: row.last_transition_ts,
      transitionLog: parseLog(row.transition_log),
    };
  }

  observeUserTurn(text: string, now: number): RelationState {
    const trimmed = text.trim();
    let relation = this.get();

    if (CONFLICT_RE.test(trimmed)) {
      // 冲突事件：先掉数值，再强制进 strained（允许从任何阶段进，但只能在允许边内）
      relation = this.applyEvent("conflict", now, "user:conflict");
      return this.forceStage(relation, "strained", "冲突语气", now);
    }

    // 当天第一条用户消息算一次"日常在场"
    const todayStart = startOfLocalDay(now, this.deps.tz);
    const todayUserCount = this.db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM messages WHERE agent_id = ? AND role = 'user' AND ts >= ? AND ts < ?",
      [this.deps.agentId, todayStart, now],
    );
    if ((todayUserCount?.c ?? 0) <= 1) relation = this.applyEvent("daily_chat", now, "user:daily");

    if (PRIVATE_RE.test(trimmed)) relation = this.applyEvent("share_private", now, "user:private");
    if (EMOTION_RE.test(trimmed)) relation = this.applyEvent("emotional", now, "user:emotion");
    if (REPAIR_RE.test(trimmed)) relation = this.applyEvent("repair", now, "user:repair");

    return this.maybeTransition(now);
  }

  observeAgentTurn(text: string, now: number): RelationState {
    const trimmed = text.trim();
    let relation = this.applyEvent("its_turn", now, "agent:turn");

    // 共享经历：同一个 6 小时内只记一次，防止一句话反复刷亲近度
    const log = relation.transitionLog;
    const lastShared = [...log].reverse().find((entry) => entry.trigger === "agent:shared");
    if (SHARED_AGENT_RE.test(trimmed) && (lastShared === undefined || now - lastShared.ts > 6 * 3_600_000)) {
      relation = this.applyEvent("shared_experience", now, "agent:shared");
    }
    if (/(哈哈|笑死|好玩|有趣)/u.test(trimmed)) relation = this.applyEvent("joke", now, "agent:joke");

    return this.maybeTransition(now);
  }

  setMode(mode: AgentMode): RelationState {
    if (mode !== "standard" && mode !== "full_human") throw new Error(`非法关系模式：${String(mode)}`);
    const relation = this.get();
    this.db.tx(() => {
      this.db.run("UPDATE relation_state SET mode = ? WHERE agent_id = ?", [mode, this.deps.agentId]);
      this.db.run("UPDATE agents SET mode = ?, state_version = state_version + 1 WHERE id = ?", [mode, this.deps.agentId]);
      const log = relation.transitionLog.concat([{ from: relation.stage, to: relation.stage, trigger: `mode:${mode}`, ts: Date.now() }]);
      this.db.run("UPDATE relation_state SET transition_log = ? WHERE agent_id = ?", [JSON.stringify(log.slice(-500)), this.deps.agentId]);
    });
    return this.get();
  }

  /**
   * 设计禁止：intimacy 只能由事件累加（规范 1 §3.2）。
   * 保留这个方法只为了在有人试图直接赋值时立刻炸掉，而不是悄悄写坏数据。
   */
  setIntimacy(_value: number): never {
    throw new Error("intimacy 只能由 transition_log 事件累加，禁止直接赋值（规范 1 §3.2）");
  }

  /* ───────────────────────────── 内部 ───────────────────────────── */

  /** 事件累加：唯一的 intimacy/trust 写入路径。 */
  private applyEvent(event: RelationEvent, now: number, trigger: string): RelationState {
    const relation = this.get();
    const delta = EVENT_DELTAS[event];
    const intimacy = clamp(relation.intimacy + delta.intimacy, 0, 1);
    const trust = clamp(relation.trust + delta.trust, 0, 1);
    const log = relation.transitionLog.concat([{ from: relation.stage, to: relation.stage, trigger, ts: now }]);
    this.db.run("UPDATE relation_state SET intimacy = ?, trust = ?, transition_log = ? WHERE agent_id = ?", [
      intimacy,
      trust,
      JSON.stringify(log.slice(-500)),
      this.deps.agentId,
    ]);
    return this.get();
  }

  /** 强制迁移（冲突用）：只走允许边，否则忽略。 */
  private forceStage(relation: RelationState, to: RelationStage, reason: string, now: number): RelationState {
    if (relation.stage === to || !canTransition(relation.stage, to)) return relation;
    return this.writeStage(relation, to, reason, now);
  }

  private maybeTransition(now: number): RelationState {
    const relation = this.get();
    const metrics = this.metrics(relation);
    const criteria = evaluateTransition(relation.stage, relation.intimacy, metrics);
    if (criteria === null) return relation;
    if (!canTransition(relation.stage, criteria.to)) return relation;
    return this.writeStage(relation, criteria.to, criteria.reason, now);
  }

  private writeStage(relation: RelationState, to: RelationStage, reason: string, now: number): RelationState {
    const log = relation.transitionLog.concat([{ from: relation.stage, to, trigger: reason, ts: now }]);
    this.db.run(
      "UPDATE relation_state SET stage = ?, since_ts = ?, last_transition_ts = ?, transition_log = ? WHERE agent_id = ?",
      [to, now, now, JSON.stringify(log.slice(-500)), this.deps.agentId],
    );
    this.deps.log.info(`relation: ${relation.stage} → ${to}（${reason}）`);
    return this.get();
  }

  private metrics(relation: RelationState): RelationMetrics {
    const log = relation.transitionLog;
    return {
      userDays: this.userDays(relation.sinceTs),
      privateShares: countTrigger(log, "user:private"),
      sharedExperiences: countTrigger(log, "agent:shared") + countTrigger(log, "user:shared"),
      repairs: countTrigger(log, "user:repair") + countTrigger(log, "agent:repair"),
    };
  }

  /** 有过对话的本地日历天数（用 users.tz，禁止 UTC 直判）。 */
  private userDays(limitSince: number): number {
    const rows = this.db.all<{ ts: number }>(
      "SELECT ts FROM messages WHERE agent_id = ? AND role = 'user' ORDER BY ts DESC LIMIT 2000",
      [this.deps.agentId],
    );
    const days = new Set<string>();
    for (const row of rows) {
      if (row.ts < limitSince) continue;
      days.add(localParts(row.ts, this.deps.tz).ymd);
    }
    return days.size;
  }

  private ensureRow(): void {
    const year = 365 * 24 * 3_600_000;
    this.db.run(
      "INSERT OR IGNORE INTO relation_state(agent_id, stage, intimacy, trust, mode, since_ts, transition_log) VALUES (?, 'stranger', 0, 0.5, 'standard', ?, '[]')",
      [this.deps.agentId, Date.now() - year],
    );
  }

  private readRow(): RelationRow {
    const row = this.db.get<RelationRow>("SELECT * FROM relation_state WHERE agent_id = ?", [this.deps.agentId]);
    if (row === undefined) {
      this.ensureRow();
      const retry = this.db.get<RelationRow>("SELECT * FROM relation_state WHERE agent_id = ?", [this.deps.agentId]);
      if (retry === undefined) throw new Error("relation_state 初始化失败");
      return retry;
    }
    return row;
  }

  private validStage(stage: string): RelationStage {
    const allowed: RelationStage[] = ["stranger", "acquainted", "familiar", "close", "strained", "repairing"];
    return allowed.includes(stage as RelationStage) ? (stage as RelationStage) : "stranger";
  }
}

/** 首次见面到现在的关系天数（叙事层用，不暴露数值给模型）。 */
export function relationDays(relation: RelationState, now: number): number {
  return Math.max(1, Math.floor((now - relation.sinceTs) / 86_400_000));
}

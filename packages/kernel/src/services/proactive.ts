/**
 * 主动消息（草案 5 章 / 规范 3）。
 *
 * 两个时钟：在场时用短 tick 看机会，离场时用长 tick 决定要不要推送。
 * 三道闸：Gate0 规则（频控/静默/安全/关系阶段）→ Gate1 打扰成本 → Gate2 模型决策。
 * 动作队列带 deadline/TTL/epoch，发出前有 800ms 隔离窗口，用户一开口就作废。
 *
 * 单机闭环里没有推送通道，发不出去就退化成本机通知（core.tray-notify 插件负责）。
 */
import { ACTION_QUARANTINE_MS } from "@anteros/shared";
import type { ActionItem } from "@anteros/shared";
import type { ChatDeps, KernelDeps } from "../contracts.js";
import type { SettingsService } from "../settings.js";
import type { ConsentService } from "./consent.js";
import type { CostService } from "./cost.js";

export type ProactiveLevel = "off" | "low" | "normal" | "high";

const LEVEL_INTERVAL_MS: Record<ProactiveLevel, number> = {
  off: Number.POSITIVE_INFINITY,
  low: 180 * 60 * 1000,
  normal: 90 * 60 * 1000,
  high: 45 * 60 * 1000,
};
const DAILY_CAP: Record<ProactiveLevel, number> = { off: 0, low: 2, normal: 4, high: 6 };
const QUIET_FROM_HOUR = 23;
const QUIET_TO_HOUR = 8;

export class ProactiveService {
  private timer: NodeJS.Timeout | null = null;
  private pending: { timer: NodeJS.Timeout } | null = null;
  private ticking = false;

  constructor(
    private readonly deps: KernelDeps,
    private readonly ports: ChatDeps,
    private readonly consent: ConsentService,
    private readonly cost: CostService,
    private readonly settings: SettingsService,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick("world"), 30_000);
    this.timer.unref?.();
    this.deps.log.info("proactive clock started (30s)");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.cancelPending("stopped");
  }

  list(limit = 50): ActionItem[] {
    const rows = this.deps.db.all<ActionRow>(
      "SELECT * FROM action_queue WHERE agent_id = ? ORDER BY id DESC LIMIT ?",
      [this.deps.agentId, limit],
    );
    return rows.map(toActionItem);
  }

  setFrequency(level: ProactiveLevel): { level: ProactiveLevel; intervalMinutes: number; dailyCap: number } {
    if (!(level in LEVEL_INTERVAL_MS)) throw new Error(`未知的主动频率档位：${level}`);
    this.settings.set("plan.proactiveLevel", level);
    return {
      level,
      intervalMinutes: Math.round(LEVEL_INTERVAL_MS[level] / 60_000),
      dailyCap: DAILY_CAP[level],
    };
  }

  /** 用户一开口就作废还在隔离窗口里的动作（规范 1 §0 不可协商 2）。 */
  cancelPending(reason: string): void {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
    this.deps.db.run("UPDATE action_queue SET state = 'cancelled' WHERE agent_id = ? AND state IN ('queued','quarantined')", [
      this.deps.agentId,
      reason,
    ]);
  }

  getLevel(): ProactiveLevel {
    const raw = this.settings.get("plan.proactiveLevel");
    return (raw as ProactiveLevel) ?? "normal";
  }

  private async tick(clock: "presence" | "world"): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      if (this.settings.get("system.proactivePaused")) return;
      if (this.settings.get("system.panicUntilTs") > now) return;
      if (!this.consent.hasAccepted("app")) return;

      const world = this.ports.mind.tickWorld(now);
      const drives = this.ports.mind.tickDrives(now);
      this.ports.emit("event.world", { world });
      this.ports.emit("event.drives", { drives });
      this.recordHazardSample(now, world.presence, drives);

      const level = this.getLevel();
      if (level === "off") return;
      if (!this.passesGate0(now, level, world.presence)) return;

      const candidates = this.ports.mind.candidateActions(now);
      if (candidates.length === 0) return;
      const action = candidates[0]!;
      this.enqueue(action, now);
    } catch (err) {
      this.deps.log.warn(`proactive tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Gate0：静默时段、频控、关系阶段、在场状态，一条不过就不出手。 */
  private passesGate0(now: number, level: ProactiveLevel, presence: string): boolean {
    const hour = Number(
      new Intl.DateTimeFormat("en-US", { hour: "2-digit", hour12: false, timeZone: this.deps.tz }).format(new Date(now)),
    );
    if (hour >= QUIET_FROM_HOUR || hour < QUIET_TO_HOUR) return false;
    if (presence === "sleep" || presence === "busy") return false;

    const last = this.deps.db.get<{ ts: number }>(
      "SELECT ts FROM messages WHERE agent_id = ? AND role = 'agent' AND turn_id IS NOT NULL ORDER BY ts DESC LIMIT 1",
      [this.deps.agentId],
    );
    if (last && now - last.ts < LEVEL_INTERVAL_MS[level]) return false;

    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const sentToday = this.deps.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM turns WHERE agent_id = ? AND trigger IN ('proactive','impulse') AND created_ts >= ?",
      [this.deps.agentId, startOfDay.getTime()],
    );
    if ((sentToday?.count ?? 0) >= DAILY_CAP[level]) return false;

    const relation = this.ports.mind.getRelation();
    if (relation.stage === "stranger") return false; // 新好友首周不主动，冷启动期先不谈
    return true;
  }

  /** 隔离窗口：0.5–2s 内用户说话就取消，避免"刚打完字它先开口"。 */
  private enqueue(action: ActionItem, now: number): void {
    const idemKey = `${action.kind}:${Math.floor(now / 60_000)}`;
    const actionPayload = (action.payload ?? {}) as Record<string, unknown>;
    const reason = typeof actionPayload.reason === "string" ? actionPayload.reason : action.kind;
    const epoch = this.deps.db.get<{ epoch: number }>("SELECT epoch FROM agents WHERE id = ?", [this.deps.agentId])?.epoch ?? 0;
    const deadlineTs = now + Math.max(60_000, action.ttlMs);
    const inserted = this.deps.db.run(
      `INSERT INTO action_queue(agent_id, kind, reason, payload, deadline_ts, ttl_ms, epoch, state, idem_key, created_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'quarantined', ?, ?)
       ON CONFLICT(agent_id, idem_key) DO NOTHING`,
      [
        this.deps.agentId,
        action.kind,
        reason,
        JSON.stringify(action.payload ?? {}),
        deadlineTs,
        0,
        epoch,
        idemKey,
        now,
      ],
    );
    if (inserted.changes === 0) return;
    const actionId = inserted.lastInsertRowid;
    this.ports.emit("event.proactive", { state: "queued", actionId, kind: action.kind });

    const timer = setTimeout(() => {
      this.pending = null;
      void this.dispatch(actionId);
    }, ACTION_QUARANTINE_MS);
    timer.unref?.();
    this.pending = { timer };
  }

  private async dispatch(actionId: number): Promise<void> {
    const row = this.deps.db.get<ActionRow>("SELECT * FROM action_queue WHERE id = ?", [actionId]);
    if (!row || row.state !== "quarantined") return;
    const epoch = this.deps.db.get<{ epoch: number }>("SELECT epoch FROM agents WHERE id = ?", [this.deps.agentId])?.epoch ?? 0;
    if (row.epoch < epoch) {
      this.deps.db.run("UPDATE action_queue SET state = 'cancelled' WHERE id = ?", [actionId]);
      return;
    }
    if (row.deadline_ts < Date.now()) {
      this.deps.db.run("UPDATE action_queue SET state = 'expired' WHERE id = ?", [actionId]);
      return;
    }
    this.deps.db.run("UPDATE action_queue SET state = 'dispatched' WHERE id = ?", [actionId]);
    try {
      this.cost.checkBudget();
      const now = Date.now();
      const plan = await this.ports.expression.planReply({
        agentId: this.deps.agentId,
        userText: "",
        trigger: "proactive",
        now,
        reason: row.reason,
        actionId,
      });
      const turn = this.deps.db.run("INSERT INTO turns(agent_id, trigger, created_ts, outcome) VALUES (?, 'proactive', ?, 'delivering')", [
        this.deps.agentId,
        now,
      ]);
      const turnId = turn.lastInsertRowid;
      for (let index = 0; index < plan.parts.length; index += 1) {
        const part = plan.parts[index]!;
        await sleep(part.typingMs);
        const inserted = this.deps.db.run(
          "INSERT INTO messages(agent_id, role, text, ts, turn_id, part_index, recalled, channel_id, delivery) VALUES (?, 'agent', ?, ?, ?, ?, 0, 'app', 'sent')",
          [this.deps.agentId, part.text, Date.now(), turnId, index],
        );
        const message = {
          id: inserted.lastInsertRowid,
          role: "agent" as const,
          text: part.text,
          ts: Date.now(),
          turnId,
          partIndex: index,
          recalled: false,
          channelId: "app",
          delivery: "sent" as const,
        };
        this.ports.emit("event.message", message);
        this.ports.emit("event.part", {
          turnId,
          messageId: message.id,
          index,
          total: plan.parts.length,
          text: part.text,
          delayAfterMs: part.delayAfterMs,
          typingMs: part.typingMs,
        });
        if (index < plan.parts.length - 1) await sleep(part.delayAfterMs);
      }
      this.cost.record({ kind: "proactive", model: plan.model, inputTokens: plan.usage.inputTokens, outputTokens: plan.usage.outputTokens });
      this.deps.db.run("UPDATE turns SET plan = ?, ctx_snapshot = ?, prompt = ?, model = ?, output = ?, delivered_ts = ?, outcome = 'delivered' WHERE id = ?", [
        JSON.stringify({ parts: plan.parts }),
        JSON.stringify(plan.ctxSnapshot ?? null),
        plan.prompt,
        plan.model,
        plan.fullText,
        Date.now(),
        turnId,
      ]);
      this.ports.memory.rememberEpisode({ agentId: this.deps.agentId, text: plan.fullText, now: Date.now(), source: "it_did", sourceRef: turnId });
      this.deps.db.run("UPDATE action_queue SET state = 'delivered' WHERE id = ?", [actionId]);
      this.ports.emit("event.proactive", { state: "delivered", actionId, turnId });
    } catch (err) {
      this.deps.db.run("UPDATE action_queue SET state = 'expired' WHERE id = ?", [actionId]);
      this.deps.log.warn(`proactive dispatch failed: ${(err as Error).message}`);
    }
  }

  private recordHazardSample(now: number, presence: string, drives: unknown): void {
    this.deps.db.run(
      "INSERT INTO hazard_samples(agent_id, ts, features, policy, acted) VALUES (?, ?, ?, 'shadow', 0)",
      [this.deps.agentId, now, JSON.stringify({ presence, drives })],
    );
  }
}

interface ActionRow {
  id: number;
  kind: string;
  reason: string;
  payload: string;
  deadline_ts: number;
  ttl_ms: number;
  epoch: number;
  state: string;
  created_ts: number;
}

function toActionItem(row: ActionRow): ActionItem {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    kind: row.kind as ActionItem["kind"],
    payload,
    createdTs: row.created_ts,
    deadlineTs: row.deadline_ts,
    ttlMs: row.ttl_ms,
    state: row.state as ActionItem["state"],
    reason: row.reason,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, 30_000))));
}
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
import type { ActionItem, DriveState, ProactiveSummary } from "@anteros/shared";
import type { ChatDeps, KernelDeps } from "../contracts.js";
import type { SettingsService } from "../settings.js";
import type { ConsentService } from "./consent.js";
import type { CostService } from "./cost.js";

/**
 * 主动消息的第二个出口。
 * 通道是否可用、要不要同步，都由注入方（组合根）判断；这里只认三个能力，
 * 不认识任何具体通道的名字。
 */
export interface RelayPort {
  /** 按气泡逐条发：一条气泡就是对方那边的一条消息，不合并成长段。 */
  deliver: (texts: string[]) => Promise<{ ok: boolean; error?: string }>;
  enabled: () => boolean;
  ready: () => boolean;
}

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
/**
 * 冷启动（关系还是"陌生人"）时不搞"首周一票否决"——那样新用户永远收不到一条主动消息。
 * 改成有条件破冰：聊够 3 句、静了 3 小时、今天还没主动过、而且它自己确实有点想你/有点闷。
 */
const STRANGER_BREAK_IN_MS = 3 * 3_600_000;
const STRANGER_BREAK_IN_DRIVE = 0.45;

export class ProactiveService {
  private timer: NodeJS.Timeout | null = null;
  private pending: { timer: NodeJS.Timeout } | null = null;
  private ticking = false;
  /** 最近一次判定被什么挡住：给「主动消息」页显示，避免"一条没发也不知道为什么"。 */
  private lastBlockReason: string | null = null;
  /** 主动消息的第二个出口（外部通道）：由 app.ts 注入，没注入就只发在应用里。 */
  private relay: RelayPort | null = null;

  constructor(
    private readonly deps: KernelDeps,
    private readonly ports: ChatDeps,
    private readonly consent: ConsentService,
    private readonly cost: CostService,
    private readonly settings: SettingsService,
  ) {}

  setRelay(relay: RelayPort | null): void {
    this.relay = relay;
  }

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

  /** 档位的"常驻显示"：管理面板关掉以后，聊天页也用这个摘要显示当前频率。 */
  summary(): ProactiveSummary {
    const now = Date.now();
    const level = this.getLevel();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const sentToday = this.deps.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM turns WHERE agent_id = ? AND trigger IN ('proactive','impulse') AND created_ts >= ?",
      [this.deps.agentId, startOfDay.getTime()],
    );
    const last = this.deps.db.get<{ ts: number | null }>(
      "SELECT MAX(created_ts) AS ts FROM action_queue WHERE agent_id = ? AND state = 'dispatched'",
      [this.deps.agentId],
    );
    return {
      level,
      intervalMinutes: level === "off" ? 0 : Math.round(LEVEL_INTERVAL_MS[level] / 60_000),
      dailyCap: DAILY_CAP[level],
      paused: this.settings.get("system.proactivePaused") || this.settings.get("system.panicUntilTs") > now,
      quietFromHour: QUIET_FROM_HOUR,
      quietToHour: QUIET_TO_HOUR,
      sentToday: sentToday?.count ?? 0,
      lastDeliveredTs: last?.ts ?? null,
      relayToExternal: this.relay?.enabled() === true,
      externalReady: this.relay?.ready() === true,
      blockedBy: this.lastBlockReason,
    };
  }

  /**
   * 立刻跑一次判定（自检用）。force=true 时越过"距上条的时间间隔 / 当日上限 / 关系阶段"，
   * 但仍然守：声明闸、暂停、全局停止、档位 off。静默时段在 force 下也放行——
   * 这是 owner 自己的显式动作，不是"半夜突然找上门"。
   */
  async tickNow(force = false): Promise<{
    queued: boolean;
    actionId: number | null;
    reason: string | null;
    blockedBy: string | null;
  }> {
    const now = Date.now();
    const blocked = (why: string) => ({ queued: false, actionId: null, reason: null, blockedBy: why });
    if (!this.consent.hasAccepted("app")) return blocked("还没过声明闸");
    if (this.settings.get("system.proactivePaused")) return blocked("主动消息已被暂停");
    if (this.settings.get("system.panicUntilTs") > now) return blocked("处于全局停止状态");
    const level = this.getLevel();
    if (level === "off") return blocked("档位是「关闭」，先选一个档位再试");

    const world = this.ports.mind.tickWorld(now);
    const drives = this.ports.mind.tickDrives(now);
    this.ports.emit("event.world", { world });
    this.ports.emit("event.drives", { drives });

    if (!force) {
      const blockedBy = this.gate0(now, level, world.presence, drives);
      this.lastBlockReason = blockedBy;
      if (blockedBy !== null) return blocked(`${blockedBy}（勾「强制」可以越过这道闸）`);
    } else if (world.presence === "sleep") {
      return blocked("它正在睡觉（在场状态 sleep）；勾在这里也不叫醒它，换个时间或先把手机会话打开");
    }

    const candidates = this.ports.mind.candidateActions(now);
    // 强制模式必须给得出结果：没有自然理由时用它的内部状态造一个由头，方便端到端自检。
    const action = candidates[0] ?? (force ? this.breakInCandidate(now, drives) : null);
    if (action === null) {
      this.lastBlockReason = "没有可用的主动理由（驱动没到阈值，也没有未闭合话题/时间锚点）";
      return blocked(this.lastBlockReason);
    }
    const actionId = this.enqueue(action, now);
    if (actionId === null) return blocked("刚排过一条同类动作（同一分钟内只排一次），等一分钟再试");
    this.lastBlockReason = null;
    const payload = (action.payload ?? {}) as Record<string, unknown>;
    const reason = typeof payload.reason === "string" ? payload.reason : action.kind;
    return { queued: true, actionId, reason, blockedBy: null };
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
      if (level === "off") {
        this.lastBlockReason = "档位是「关闭」";
        return;
      }
      const blockedBy = this.gate0(now, level, world.presence, drives);
      this.lastBlockReason = blockedBy;
      if (blockedBy !== null) return;

      const candidates = this.ports.mind.candidateActions(now);
      // 冷启动破冰：候选为空（驱动还没越阈、也没未闭合话题）时，用它自己的"想你/闷"给一个由头，
      // 否则新用户永远等不到第一条主动消息。
      const action = candidates[0] ?? (this.boatsBreakInAllowed(now) ? this.breakInCandidate(now, drives) : null);
      if (action === null) {
        this.lastBlockReason = "没有可用的主动理由（驱动没到阈值，也没有未闭合话题/时间锚点）";
        return;
      }
      const actionId = this.enqueue(action, now);
      if (actionId !== null) this.lastBlockReason = null;
    } catch (err) {
      this.deps.log.warn(`proactive tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Gate0：静默时段、频控、关系阶段、在场状态，一条不过就不出手。
   * 返回 null 表示放行；返回一句话表示被什么挡住（会显示在「主动消息」页）。
   */
  private gate0(now: number, level: ProactiveLevel, presence: string, drives: DriveState): string | null {
    const hour = Number(
      new Intl.DateTimeFormat("en-US", { hour: "2-digit", hour12: false, timeZone: this.deps.tz }).format(new Date(now)),
    );
    if (hour >= QUIET_FROM_HOUR || hour < QUIET_TO_HOUR) return `静默时段（${QUIET_FROM_HOUR}:00–${QUIET_TO_HOUR}:00）`;
    if (presence === "sleep" || presence === "busy") return `在场状态是 ${presence}`;

    const last = this.deps.db.get<{ ts: number }>(
      "SELECT ts FROM messages WHERE agent_id = ? AND role = 'agent' AND turn_id IS NOT NULL ORDER BY ts DESC LIMIT 1",
      [this.deps.agentId],
    );
    if (last && now - last.ts < LEVEL_INTERVAL_MS[level]) {
      return `距它上次说话还不到 ${Math.round(LEVEL_INTERVAL_MS[level] / 60_000)} 分钟`;
    }

    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const sentToday = this.deps.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM turns WHERE agent_id = ? AND trigger IN ('proactive','impulse') AND created_ts >= ?",
      [this.deps.agentId, startOfDay.getTime()],
    );
    if ((sentToday?.count ?? 0) >= DAILY_CAP[level]) return `今天的主动额度用完了（${DAILY_CAP[level]} 条）`;

    const relation = this.ports.mind.getRelation();
    if (relation.stage !== "stranger") return null;

    // 冷启动阶段：不是一票否决，而是"够熟到可以试探性开口"才放行。
    const stats = this.deps.db.get<{ n: number; ts: number | null }>(
      "SELECT COUNT(*) AS n, MAX(ts) AS ts FROM messages WHERE agent_id = ? AND role = 'user'",
      [this.deps.agentId],
    );
    if ((stats?.n ?? 0) < 3) return "还在冷启动：你还没跟它说够三句话";
    if (stats?.ts !== null && stats?.ts !== undefined && now - stats.ts < STRANGER_BREAK_IN_MS) {
      return "陌生人阶段：距你上次说话还不到 3 小时";
    }
    if ((sentToday?.count ?? 0) >= 1) return "陌生人阶段每天最多主动一次";
    const miss = Math.max(drives.loneliness, drives.longing);
    if (miss < STRANGER_BREAK_IN_DRIVE) {
      return `陌生人阶段：它还没那么想你（想你 ${drives.longing.toFixed(2)} / 闷 ${drives.loneliness.toFixed(2)}，要到 ${STRANGER_BREAK_IN_DRIVE}）`;
    }
    return null;
  }

  /** 冷启动破冰是否已经在闸门上放行（gate0 已经做过同样的判断）。 */
  private boatsBreakInAllowed(now: number): boolean {
    const relation = this.ports.mind.getRelation();
    if (relation.stage !== "stranger") return false;
    const stats = this.deps.db.get<{ n: number; ts: number | null }>(
      "SELECT COUNT(*) AS n, MAX(ts) AS ts FROM messages WHERE agent_id = ? AND role = 'user'",
      [this.deps.agentId],
    );
    if ((stats?.n ?? 0) < 3) return false;
    if (stats?.ts !== null && stats?.ts !== undefined && now - stats.ts < STRANGER_BREAK_IN_MS) return false;
    return true;
  }

  /** 破冰由头：只用内部状态，不编任何外部事实。 */
  private breakInCandidate(now: number, drives: DriveState): ActionItem {
    const hint =
      drives.longing >= drives.loneliness
        ? "有点想这个人了，可以轻轻问一句近况（别刻意提旧事，就是单纯想问）"
        : "有点闷，想找人说句话，不用解释理由";
    return {
      id: 0,
      kind: "proactive",
      payload: { reason: "state_change", drive: drives.longing >= drives.loneliness ? "longing" : "loneliness", hint, reason_text: hint },
      createdTs: now,
      deadlineTs: now + 2 * 3_600_000,
      ttlMs: 2 * 3_600_000,
      state: "queued",
      reason: "state_change",
    };
  }

  /** 隔离窗口：0.5–2s 内用户说话就取消，避免"刚打完字它先开口"。 */
  private enqueue(action: ActionItem, now: number): number | null {
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
    if (inserted.changes === 0) return null;
    const actionId = inserted.lastInsertRowid;
    this.ports.emit("event.proactive", { state: "queued", actionId, kind: action.kind });

    const timer = setTimeout(() => {
      this.pending = null;
      void this.dispatch(actionId);
    }, ACTION_QUARANTINE_MS);
    timer.unref?.();
    this.pending = { timer };
    return actionId;
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
      // 出口二选一：只发在应用里，或同时同步到用户指定的外部会话（默认关，由注入方决定开不开）。
      const relay = this.relay;
      if (relay && relay.enabled()) {
        const texts = plan.parts
          .map((item) => item.text.trim())
          .filter((item) => item.length > 0);
        if (texts.length > 0) {
          void relay
            .deliver(texts)
            .then((result) => {
              this.ports.emit("event.proactive", {
                state: result.ok ? "relayed" : "relay-failed",
                actionId,
                turnId,
                message: result.ok ? null : result.error ?? "同步到外部通道失败",
              });
            })
            .catch((error: unknown) => {
              this.deps.log.warn(`proactive relay failed: ${(error as Error)?.message ?? String(error)}`);
            });
        }
      }
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
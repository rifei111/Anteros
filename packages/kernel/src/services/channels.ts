/**
 * 通道出站 / 入站服务（草案 14.3 四条铁律 + 14.5 outbox 语义）。
 *
 * 本文件不出现任何具体通道名：只按插件 manifest 的 capabilities 分支。
 *  - 出站：有副作用的发送先落 messages（delivery='pending'）→ lease.begin → channel.send
 *    → 回写 sent / failed / unknown；unknown 永不自动重试（红线），只告警。
 *  - 白名单：settings['channel.allowlist.<pluginId>'] 的 JSON 数组，缺失/空 = 全拒，一票否决。
 *  - 入站：1s 轮询 channel.read_since，水位持久化在 settings['channel.waterline.<pluginId>']，
 *    去重后落 messages 并推 event.message；撤回只记 revoke.detected，不恢复原文。
 *  - 一键停用：转发给 PluginHost.panicStop()。
 */
import { AnterosError, ERROR_CODES } from "@anteros/shared";
import type {
  ChannelCapabilities,
  ChannelInboundMessage,
  ChannelInfo,
  ChatMessage,
  MessageDelivery,
  PluginInfo,
} from "@anteros/shared";
import type { KernelDeps } from "../contracts.js";
import { randomHex } from "../util/crypto.js";
import type { PluginService } from "./plugins.js";

const DEDUPE_WINDOW_MS = 30_000;
const INBOUND_POLL_MS = 1_000;
const INBOUND_LIMIT = 50;
const INBOUND_TIMEOUT_MS = 15_000;
const LEASE_TIMEOUT_MS = 60_000;
const WRITE_TIMEOUT_MS = 90_000;
const APP_CHANNEL_ID = "core.app-channel";

/** 发送结果里"可能已经发出去了"的错误码：只标 unknown，绝不重试。 */
const UNCERTAIN_CODES: ReadonlySet<string> = new Set([
  ERROR_CODES.ETIMEOUT,
  ERROR_CODES.ECRASH,
  ERROR_CODES.EIO,
]);

export interface ChannelSendInput {
  pluginId: string;
  target: string;
  text: string;
  /** 发送截止时间（本机毫秒）。缺省 now + 90s。 */
  deadlineTs?: number;
}

export type EnqueueStatus = "queued" | "blocked" | "duplicate";

export interface EnqueueOutcome {
  messageId: number | null;
  status: EnqueueStatus;
  reason?: string;
}

export interface SendOutcome {
  messageId: number;
  delivery: MessageDelivery;
  detail?: string;
}

interface MessageRow {
  id: number;
  agent_id: number;
  role: "user" | "agent" | "system";
  text: string;
  ts: number;
  turn_id: string | null;
  part_index: number | null;
  recalled: number;
  channel_id: string;
  delivery: string;
}

interface LeaseReply {
  granted?: unknown;
  leaseId?: unknown;
}

interface SendReply {
  status?: unknown;
  detail?: unknown;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function errorText(error: unknown): string {
  if (error instanceof AnterosError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorCode(error: unknown): string {
  if (error instanceof AnterosError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
}

function isChannelPlugin(info: PluginInfo): boolean {
  return info.kind === "channel";
}

function riskToCapability(risk: PluginInfo["riskLevel"]): ChannelCapabilities["riskLevel"] {
  if (risk === "high") return "red";
  if (risk === "medium") return "gray";
  return "none";
}

function capabilitiesOf(info: PluginInfo): ChannelCapabilities {
  const declared = new Set(info.capabilities);
  return {
    readCanBackfill: declared.has("channel.read"),
    writeIsDeterministic: declared.has("channel.write"),
    typingIsReal: false,
    canRecall: false,
    hostOccupancyMs: 0,
    riskLevel: riskToCapability(info.riskLevel),
  };
}

export class ChannelService {
  private readonly deps: KernelDeps;
  private readonly plugins: PluginService;

  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private readonly dedupe = new Map<string, { ts: number; messageId: number }>();
  private readonly seenInbound = new Map<string, number>();

  constructor(deps: KernelDeps, plugins: PluginService) {
    this.deps = deps;
    this.plugins = plugins;

    // 把出站/收件箱端口接给宿主：插件反向调 kernel.outbox.send / kernel.inbox.next 时走这里。
    plugins.attachPorts({
      outbox: {
        send: (input) => {
          const outcome = this.enqueue({
            pluginId: input.pluginId,
            target: input.target,
            text: input.parts.join("\n"),
            deadlineTs: input.deadlineTs,
          });
          return {
            outboxId: outcome.messageId ?? 0,
            status: outcome.status === "blocked" ? "blocked" : "queued",
          };
        },
      },
      inbox: {
        next: (input) => this.inboxNext(input.channelId || input.pluginId, input.limit),
      },
    });

    // 插件状态变化时刷新 event.channels。
    plugins.attachChannelsProvider(() => this.list());
  }

  // ── 查询 ─────────────────────────────────────────────────────────

  list(): ChannelInfo[] {
    const app: ChannelInfo = {
      pluginId: APP_CHANNEL_ID,
      displayName: "App 内对话",
      kind: "app",
      capabilities: {
        readCanBackfill: false,
        writeIsDeterministic: true,
        typingIsReal: false,
        canRecall: false,
        hostOccupancyMs: 0,
        riskLevel: "none",
      },
      enabled: true,
      status: "running",
      writeReady: true,
      health: null,
    };

    const external = this.plugins
      .list()
      .filter(isChannelPlugin)
      .map((info): ChannelInfo => {
        const capabilities = capabilitiesOf(info);
        return {
          pluginId: info.id,
          displayName: info.name.length > 0 ? info.name : info.id,
          kind: "external",
          capabilities,
          enabled: info.enabled,
          status: info.status,
          writeReady: info.enabled && info.status === "running" && capabilities.writeIsDeterministic,
          health: info.health,
        };
      });

    return [app, ...external];
  }

  /** 已启用且当前可写的通道插件。 */
  private writePlugins(): PluginInfo[] {
    return this.plugins.list().filter((info) => {
      if (!isChannelPlugin(info)) return false;
      if (!info.capabilities.includes("channel.write")) return false;
      return info.enabled && (info.status === "running" || info.status === "degraded");
    });
  }

  // ── 白名单 ───────────────────────────────────────────────────────

  allowlist(pluginId: string): string[] {
    const raw = this.readSetting(`channel.allowlist.${pluginId}`);
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
    } catch {
      return [];
    }
  }

  private assertAllowed(pluginId: string, target: string): void {
    const list = this.allowlist(pluginId);
    if (list.length > 0 && list.includes(target)) return;

    const reason =
      list.length === 0
        ? `通道 ${pluginId} 未配置白名单（默认全拒），已拒绝发送`
        : `目标 ${target} 不在通道 ${pluginId} 的白名单内，已拒绝发送`;
    this.reject(pluginId, target, reason);
    throw new AnterosError(ERROR_CODES.EPERM, reason, {
      hint: "在设置里为该通道配置允许的关系 id 列表后才能对外发送",
    });
  }

  private reject(pluginId: string, target: string, reason: string): void {
    this.deps.log.warn(reason);
    this.audit("channel.send.blocked", { pluginId, target, reason });
    this.plugins.emitEvent("event.notify", {
      channelId: pluginId,
      title: "通道发送被拒绝",
      body: reason,
    });
  }

  // ── 出站 ─────────────────────────────────────────────────────────

  /**
   * 入队：同步完成白名单、去重、落库，然后异步发送（插件反向调 kernel.outbox.send 用）。
   */
  enqueue(input: ChannelSendInput): EnqueueOutcome {
    if (input.text.trim().length === 0) {
      return { messageId: null, status: "blocked", reason: "消息正文为空" };
    }
    const plugin = this.plugins.list().find((info) => info.id === input.pluginId);
    if (!plugin) {
      return { messageId: null, status: "blocked", reason: `插件不存在：${input.pluginId}` };
    }
    try {
      this.assertAllowed(input.pluginId, input.target);
    } catch (error) {
      return { messageId: null, status: "blocked", reason: errorText(error) };
    }

    const duplicate = this.findDuplicate(input.pluginId, input.target, input.text);
    if (duplicate !== null) {
      return { messageId: duplicate, status: "duplicate", reason: "30 秒内重复内容已去重" };
    }

    const messageId = this.insertPending(input.pluginId, input.text);
    this.rememberDedupe(input.pluginId, input.target, input.text, messageId);
    const deadlineTs = input.deadlineTs ?? Date.now() + WRITE_TIMEOUT_MS;
    void this.deliver(input.pluginId, messageId, input.target, input.text, deadlineTs).catch((error) => {
      this.deps.log.error(`出站发送异常：${errorText(error)}`);
    });
    return { messageId, status: "queued" };
  }

  /**
   * 同步等待发送结果（测试与需要立即回报的调用方使用）。
   */
  async sendNow(input: ChannelSendInput): Promise<SendOutcome> {
    if (input.text.trim().length === 0) {
      throw new AnterosError(ERROR_CODES.EINVALID, "消息正文为空");
    }
    this.assertAllowed(input.pluginId, input.target);
    const duplicate = this.findDuplicate(input.pluginId, input.target, input.text);
    if (duplicate !== null) {
      return { messageId: duplicate, delivery: "pending", detail: "30 秒内重复内容已去重" };
    }
    const messageId = this.insertPending(input.pluginId, input.text);
    this.rememberDedupe(input.pluginId, input.target, input.text, messageId);
    const deadlineTs = input.deadlineTs ?? Date.now() + WRITE_TIMEOUT_MS;
    const delivery = await this.deliver(input.pluginId, messageId, input.target, input.text, deadlineTs);
    return { messageId, delivery };
  }

  private async deliver(
    pluginId: string,
    messageId: number,
    target: string,
    text: string,
    deadlineTs: number,
  ): Promise<MessageDelivery> {
    let leaseId: string | null = null;
    try {
      const lease = recordOf(
        await this.plugins.call(
          pluginId,
          "plugin.channel.lease.begin",
          { reason: "outbox.send", timeoutMs: LEASE_TIMEOUT_MS },
          { kind: "lease", timeoutMs: LEASE_TIMEOUT_MS },
        ),
      ) as LeaseReply;
      if (lease.granted !== true) {
        const detail = "通道未授予写租约（可能被其它写动作占用）";
        this.updateDelivery(messageId, "failed");
        this.deps.log.warn(`出站失败：${detail}`);
        return "failed";
      }
      if (typeof lease.leaseId === "string") leaseId = lease.leaseId;

      const reply = recordOf(
        await this.plugins.call(
          pluginId,
          "plugin.channel.send",
          { outboxId: messageId, target, text, deadlineTs },
          { kind: "write", timeoutMs: WRITE_TIMEOUT_MS },
        ),
      ) as SendReply;
      const status = reply.status;
      if (status === "sent" || status === "failed" || status === "unknown") {
        this.updateDelivery(messageId, status);
        if (status === "unknown") this.alarmUnknown(pluginId, messageId, target, reply.detail);
        return status;
      }
      // 插件返回了无法识别的状态：保守按 unknown 处理，绝不重试。
      this.updateDelivery(messageId, "unknown");
      this.alarmUnknown(pluginId, messageId, target, "插件返回了未知发送状态");
      return "unknown";
    } catch (error) {
      const code = errorCode(error);
      if (UNCERTAIN_CODES.has(code)) {
        this.updateDelivery(messageId, "unknown");
        this.alarmUnknown(pluginId, messageId, target, `${code}：${errorText(error)}`);
        return "unknown";
      }
      this.updateDelivery(messageId, "failed");
      this.deps.log.warn(`出站失败（${code || "unknown"}）：${errorText(error)}`);
      return "failed";
    } finally {
      if (leaseId !== null) {
        try {
          await this.plugins.call(
            pluginId,
            "plugin.channel.lease.end",
            { leaseId },
            { kind: "lease", timeoutMs: 10_000 },
          );
        } catch (error) {
          this.deps.log.warn(`释放写租约失败：${errorText(error)}`);
        }
      }
    }
  }

  private alarmUnknown(pluginId: string, messageId: number, target: string, detail: unknown): void {
    const suffix = typeof detail === "string" && detail.length > 0 ? `：${detail}` : "";
    const body = `消息 #${messageId} 的发送结果不确定（标记 unknown，不会自动重试），请人工确认${suffix}`;
    this.deps.log.warn(`通道 ${pluginId} → ${target} ${body}`);
    this.audit("channel.send.unknown", { pluginId, messageId, target, detail });
    this.plugins.emitEvent("event.notify", {
      channelId: pluginId,
      title: "发送结果不确定",
      body,
    });
  }

  // ── 入站 ─────────────────────────────────────────────────────────

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.pollInbound();
    }, INBOUND_POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async pollInbound(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const info of this.plugins.list()) {
        if (!isChannelPlugin(info)) continue;
        if (!info.capabilities.includes("channel.read")) continue;
        if (!info.enabled) continue;
        if (info.status !== "running" && info.status !== "degraded") continue;
        try {
          await this.pollChannel(info);
        } catch (error) {
          this.deps.log.warn(`轮询通道 ${info.id} 失败：${errorText(error)}`);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollChannel(info: PluginInfo): Promise<void> {
    const pluginId = info.id;
    const sinceTs = this.waterline(pluginId);
    const reply = recordOf(
      await this.plugins.call(
        pluginId,
        "plugin.channel.read_since",
        { sinceTs, limit: INBOUND_LIMIT },
        { kind: "read", timeoutMs: INBOUND_TIMEOUT_MS },
      ),
    );
    const messages = Array.isArray(reply.messages) ? (reply.messages as ChannelInboundMessage[]) : [];
    let maxTs = sinceTs;
    for (const message of messages) {
      if (message === null || typeof message !== "object") continue;
      const msgId = typeof message.msgId === "string" ? message.msgId : "";
      if (msgId.length === 0) continue;
      const key = `${pluginId}|${msgId}`;
      if (this.seenInbound.has(key)) continue;
      this.seenInbound.set(key, Date.now());
      if (message.ts > maxTs) maxTs = message.ts;

      // 撤回：只记录事件，不恢复原文（草案 14.5）。
      if (typeof message.text !== "string" || message.text.length === 0) {
        this.plugins.emitEvent("revoke.detected", { pluginId, msgId });
        continue;
      }
      const role = message.direction === "out" ? "agent" : "user";
      const id = this.insertInbound(pluginId, role, message.text, message.ts);
      const chat: ChatMessage = {
        id,
        role,
        text: message.text,
        ts: message.ts,
        recalled: false,
        channelId: pluginId,
        delivery: "sent",
      };
      this.plugins.emitEvent("event.message", chat);
    }
    const reported = typeof reply.waterline === "number" && Number.isFinite(reply.waterline) ? reply.waterline : 0;
    const next = Math.max(sinceTs, maxTs, reported);
    if (next !== sinceTs) this.setWaterline(pluginId, next);
    this.pruneSeen();
  }

  private inboxNext(channelId: string, limit: number): ChatMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.trunc(limit))) : 20;
    const rows = this.deps.db.all<MessageRow>(
      "SELECT * FROM messages WHERE channel_id = ? AND role = 'user' ORDER BY id DESC LIMIT ?",
      [channelId, safeLimit],
    );
    return rows.reverse().map((row) => this.toChatMessage(row));
  }

  private toChatMessage(row: MessageRow): ChatMessage {
    const turnId = typeof row.turn_id === "string" && row.turn_id.length > 0 ? Number(row.turn_id) : null;
    return {
      id: row.id,
      role: row.role,
      text: row.text,
      ts: row.ts,
      turnId: turnId !== null && Number.isFinite(turnId) ? turnId : null,
      partIndex: row.part_index ?? null,
      recalled: row.recalled === 1,
      channelId: row.channel_id,
      delivery: row.delivery as MessageDelivery,
    };
  }

  // ── 一键停用 ─────────────────────────────────────────────────────

  async panicStop(): Promise<{ stopped: string[]; restored: boolean; message: string }> {
    this.stop();
    return this.plugins.panicStop();
  }

  // ── 存储辅助 ─────────────────────────────────────────────────────

  private insertPending(pluginId: string, text: string): number {
    const result = this.deps.db.run(
      "INSERT INTO messages(agent_id, role, text, ts, channel_id, delivery) VALUES(?,?,?,?,?,?)",
      [this.deps.agentId, "agent", text, Date.now(), pluginId, "pending"],
    );
    return result.lastInsertRowid;
  }

  private insertInbound(pluginId: string, role: "user" | "agent", text: string, ts: number): number {
    const result = this.deps.db.run(
      "INSERT INTO messages(agent_id, role, text, ts, channel_id, delivery) VALUES(?,?,?,?,?,?)",
      [this.deps.agentId, role, text, ts, pluginId, "sent"],
    );
    return result.lastInsertRowid;
  }

  private updateDelivery(messageId: number, delivery: MessageDelivery): void {
    this.deps.db.run("UPDATE messages SET delivery = ? WHERE id = ?", [delivery, messageId]);
  }

  private readSetting(key: string): string | null {
    const row = this.deps.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key]);
    return row?.value ?? null;
  }

  private writeSetting(key: string, value: string): void {
    this.deps.db.run(
      "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
  }

  private waterline(pluginId: string): number {
    const raw = this.readSetting(`channel.waterline.${pluginId}`);
    if (raw === null) return 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private setWaterline(pluginId: string, ts: number): void {
    this.writeSetting(`channel.waterline.${pluginId}`, JSON.stringify(ts));
  }

  private audit(action: string, detail: Record<string, unknown>): void {
    try {
      this.deps.db.run(
        "INSERT INTO audit_log(actor_user_id, actor_role, action, target_agent_id, after, ts, idem_key) VALUES(?,?,?,?,?,?,?)",
        [
          this.deps.userId,
          "system",
          action,
          this.deps.agentId,
          JSON.stringify(detail),
          Date.now(),
          `${action}:${randomHex(6)}`,
        ],
      );
    } catch (error) {
      this.deps.log.warn(`写审计失败（${action}）：${errorText(error)}`);
    }
  }

  // ── 去重（30s 同目标同文本） ─────────────────────────────────────

  private findDuplicate(pluginId: string, target: string, text: string): number | null {
    const key = `${pluginId}|${target}|${text}`;
    const hit = this.dedupe.get(key);
    if (!hit) return null;
    if (Date.now() - hit.ts > DEDUPE_WINDOW_MS) {
      this.dedupe.delete(key);
      return null;
    }
    return hit.messageId;
  }

  private rememberDedupe(pluginId: string, target: string, text: string, messageId: number): void {
    const now = Date.now();
    for (const [key, value] of this.dedupe) {
      if (now - value.ts > DEDUPE_WINDOW_MS) this.dedupe.delete(key);
    }
    this.dedupe.set(`${pluginId}|${target}|${text}`, { ts: now, messageId });
  }

  private pruneSeen(): void {
    if (this.seenInbound.size < 2_000) return;
    const cutoff = Date.now() - 10 * 60_000;
    for (const [key, ts] of this.seenInbound) {
      if (ts < cutoff) this.seenInbound.delete(key);
    }
  }
}

/** 供装配层判断"当前有没有可写通道"，避免业务层自己猜。 */
export function hasWritableExternalChannel(list: readonly ChannelInfo[]): boolean {
  return list.some((channel) => channel.kind === "external" && channel.writeReady);
}

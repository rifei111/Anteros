/**
 * 对话编排（规范 1 §4 客户端协议 + §5 幂等/回放）。
 *
 * 这里做的是"把一次用户消息变成一条或多条气泡"的全流程：
 * 落库 → epoch 作废 → 关系/在场更新 → 装配上下文（表达层）→ 打字节奏 → 分条下发 → 成本与回放。
 *
 * 注意三条红线：
 * - 时间戳一律 UTC 毫秒，但"人味"决策用当地时间（交给 mind/expression 层）；
 * - 用户新输入立刻 epoch+1，把队列里过期的主动动作废掉；
 * - typing 时长来自真实计算的 typingMs，不是假装。
 */
import { ACTION_QUARANTINE_MS, AnterosError, ERROR_CODES } from "@anteros/shared";
import type { ChatMessage, ChatRole, MessageDelivery, RelationState } from "@anteros/shared";
import type { ChatDeps, ChatReplyResult, KernelDeps } from "../contracts.js";
import type { AuditService } from "./audit.js";
import type { ConsentService } from "./consent.js";
import type { CostService } from "./cost.js";

const MAX_USER_TEXT = 4000;

export interface ChatServiceParts {
  deps: KernelDeps;
  ports: ChatDeps;
  consent: ConsentService;
  cost: CostService;
  audit: AuditService;
}

export class ChatService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly parts: ChatServiceParts) {}

  /** 串行化：同一 agent 的装配不许并发（规范 1 §5.2）。 */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async send(input: {
    text: string;
    eventId?: string;
    clientTs?: number;
    presence?: { isTyping?: boolean; appFocused?: boolean; lastInteractionMs?: number };
  }): Promise<ChatReplyResult> {
    const { deps, consent } = this.parts;
    consent.requireConsent("app");
    const text = (input.text ?? "").trim();
    if (text.length === 0) throw new AnterosError(ERROR_CODES.EINVALID, "消息不能为空");
    if (text.length > MAX_USER_TEXT) {
      throw new AnterosError(ERROR_CODES.EINVALID, `消息太长（${text.length} 字），最多 ${MAX_USER_TEXT} 字`);
    }
    const eventId = input.eventId ?? null;
    if (eventId) {
      const previous = deps.db.get<{ result: string }>("SELECT result FROM idempotency WHERE event_id = ?", [eventId]);
      if (previous) return JSON.parse(previous.result) as ChatReplyResult;
    }

    return this.serial(async () => {
      const now = Date.now();
      const { ports } = this.parts;

      // 用户在场：手在手机上/正在用电脑
      ports.mind.touchPresence(input.presence?.appFocused === false ? "idle" : "phone_in_hand", "behavior");

      const created = deps.db.tx(() => {
        // epoch+1：队列里 epoch 更小的动作全部作废（规范 1 §0 不可协商 2）
        deps.db.run("UPDATE agents SET epoch = epoch + 1, state_version = state_version + 1 WHERE id = ?", [deps.agentId]);
        const epoch = this.currentEpoch();
        deps.db.run("UPDATE action_queue SET state = 'cancelled' WHERE agent_id = ? AND state IN ('queued','quarantined') AND epoch < ?", [
          deps.agentId,
          epoch,
        ]);
        const msg = deps.db.run(
          "INSERT INTO messages(agent_id, role, text, ts, recalled, channel_id, delivery) VALUES (?, 'user', ?, ?, 0, 'app', 'sent')",
          [deps.agentId, text, now],
        );
        const turn = deps.db.run("INSERT INTO turns(agent_id, user_msg_id, trigger, created_ts, outcome) VALUES (?, ?, 'reply', ?, 'planning')", [
          deps.agentId,
          msg.lastInsertRowid,
          now,
        ]);
        return { messageId: msg.lastInsertRowid, turnId: turn.lastInsertRowid, epoch };
      });

      const userMessage = this.getMessage(created.messageId);
      ports.emit("event.message", userMessage);

      const relation = ports.mind.observeUserTurn(text, now);
      this.emitRelation(relation);
      ports.emit("event.drives", ports.mind.tickDrives(now));

      // 记忆抽取不阻塞回复：先落用户这一句，回复完再抽取（管线内部决定规则命中的即时写）
      void ports.memory.extract(deps.agentId, [{ id: created.messageId, text, ts: now }], now).catch(() => undefined);

      this.parts.cost.checkBudget();
      let plan;
      try {
        plan = await ports.expression.planReply({ agentId: deps.agentId, userText: text, trigger: "reply", now });
      } catch (err) {
        deps.db.run("UPDATE turns SET outcome = 'failed' WHERE id = ?", [created.turnId]);
        throw err;
      }

      const firstPart = plan.parts[0] ?? { text: "", typingMs: 0, delayAfterMs: 0 };
      const total = plan.parts.length;
      const totalDelay = plan.parts.reduce((sum, part) => sum + part.typingMs + part.delayAfterMs, 0);
      this.parts.deps.log.info(`turn ${created.turnId}: ${total} 段，预计 ${Math.round(totalDelay / 100) / 10}s`);

      // 先告诉客户端"要打字了"，时长由服务端算好，客户端不得改（规范 1 §4）
      ports.emit("event.typing", {
        state: "start",
        plannedChars: firstPart.text.length,
        plannedMs: firstPart.typingMs,
      });

      let deliveredTs = 0;
      let firstTokenTs = 0;
      for (let index = 0; index < plan.parts.length; index += 1) {
        const part = plan.parts[index]!;
        await sleep(part.typingMs);
        if (index === 0) firstTokenTs = Date.now();
        const ts = Date.now();
        const inserted = deps.db.run(
          "INSERT INTO messages(agent_id, role, text, ts, turn_id, part_index, recalled, channel_id, delivery) VALUES (?, 'agent', ?, ?, ?, ?, 0, 'app', 'sent')",
          [deps.agentId, part.text, ts, created.turnId, index],
        );
        deliveredTs = ts;
        const message = this.getMessage(inserted.lastInsertRowid);
        ports.emit("event.message", message);
        ports.emit("event.part", {
          turnId: created.turnId,
          messageId: message.id,
          index,
          total,
          text: part.text,
          delayAfterMs: part.delayAfterMs,
          typingMs: part.typingMs,
        });
        if (index < plan.parts.length - 1) await sleep(part.delayAfterMs);
      }
      ports.emit("event.typing", { state: "stop" });

      // 成本 + 回放素材
      this.parts.cost.record({ kind: "reply", model: plan.model, inputTokens: plan.usage.inputTokens, outputTokens: plan.usage.outputTokens });
      deps.db.run(
        "UPDATE turns SET plan = ?, ctx_snapshot = ?, prompt = ?, model = ?, output = ?, first_token_ts = ?, delivered_ts = ?, outcome = 'delivered' WHERE id = ?",
        [
          JSON.stringify({ parts: plan.parts }),
          JSON.stringify(plan.ctxSnapshot ?? null),
          plan.prompt,
          plan.model,
          plan.fullText,
          firstTokenTs,
          deliveredTs,
          created.turnId,
        ],
      );
      deps.db.run("UPDATE agents SET state_version = state_version + 1 WHERE id = ?", [deps.agentId]);

      // 它自己的话也要进记忆（source=it_did）
      ports.memory.rememberEpisode({ agentId: deps.agentId, text: plan.fullText, now: Date.now(), source: "it_did", sourceRef: created.turnId });
      const agentRelation = ports.mind.observeAgentTurn(plan.fullText, Date.now());
      this.emitRelation(agentRelation);
      this.parts.deps.log.info(`turn ${created.turnId} delivered: ${plan.fullText.slice(0, 40)}`);

      const result: ChatReplyResult = { turnId: created.turnId, userMessage, accepted: true };
      if (eventId) {
        deps.db.run("INSERT OR REPLACE INTO idempotency(event_id, method, result, created_ts) VALUES (?, 'chat.send', ?, ?)", [
          eventId,
          JSON.stringify(result),
          Date.now(),
        ]);
        deps.db.run("DELETE FROM idempotency WHERE created_ts < ?", [Date.now() - 7 * 24 * 3600 * 1000]);
      }
      return result;
    });
  }

  history(input: { limit?: number; beforeId?: number } = {}): ChatMessage[] {
    const limit = Math.min(Math.max(input.limit ?? 60, 1), 300);
    const rows = input.beforeId
      ? this.parts.deps.db.all<MessageRow>("SELECT * FROM messages WHERE agent_id = ? AND id < ? ORDER BY id DESC LIMIT ?", [
          this.parts.deps.agentId,
          input.beforeId,
          limit,
        ])
      : this.parts.deps.db.all<MessageRow>("SELECT * FROM messages WHERE agent_id = ? ORDER BY id DESC LIMIT ?", [
          this.parts.deps.agentId,
          limit,
        ]);
    return rows.reverse().map(toChatMessage);
  }

  markRead(ids: number[]): number {
    const now = Date.now();
    let changed = 0;
    for (const id of ids) {
      changed += this.parts.deps.db.run("UPDATE messages SET client_ack_ts = ? WHERE id = ? AND agent_id = ?", [
        now,
        id,
        this.parts.deps.agentId,
      ]).changes;
    }
    return changed;
  }

  getMessage(id: number): ChatMessage {
    const row = this.parts.deps.db.get<MessageRow>("SELECT * FROM messages WHERE id = ?", [id]);
    if (!row) throw new AnterosError(ERROR_CODES.ENOTFOUND, `消息 ${id} 不存在`);
    return toChatMessage(row);
  }

  /** 撤回：只在发出后 5 秒内、每天最多 1 次（规范 1 §4）。 */
  recall(messageId: number): ChatMessage {
    const { deps } = this.parts;
    const row = deps.db.get<MessageRow>("SELECT * FROM messages WHERE id = ? AND agent_id = ?", [messageId, deps.agentId]);
    if (!row) throw new AnterosError(ERROR_CODES.ENOTFOUND, "这条消息不存在");
    if (row.role !== "agent") throw new AnterosError(ERROR_CODES.EINVALID, "只能撤回自己发出去的消息");
    if (Date.now() - row.ts > 5000) throw new AnterosError(ERROR_CODES.EINVALID, "超过 5 秒的消息不能撤回");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const used = deps.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE agent_id = ? AND recalled = 1 AND ts >= ?", [
      deps.agentId,
      today.getTime(),
    ]);
    if ((used?.count ?? 0) >= 1) throw new AnterosError(ERROR_CODES.ERATE, "今天已经撤回过了，明天再说");
    deps.db.run("UPDATE messages SET recalled = 1 WHERE id = ?", [messageId]);
    const updated = this.getMessage(messageId);
    this.parts.ports.emit("event.recall", { messageId, message: updated });
    return updated;
  }

  private currentEpoch(): number {
    const row = this.parts.deps.db.get<{ epoch: number }>("SELECT epoch FROM agents WHERE id = ?", [this.parts.deps.agentId]);
    return row?.epoch ?? 0;
  }

  private emitRelation(relation: RelationState): void {
    this.parts.ports.emit("event.relation", { relation });
  }
}

interface MessageRow {
  id: number;
  role: ChatRole;
  text: string;
  ts: number;
  turn_id: number | null;
  part_index: number | null;
  recalled: number;
  channel_id: string;
  delivery: MessageDelivery;
}

function toChatMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role,
    text: row.text,
    ts: row.ts,
    turnId: row.turn_id,
    partIndex: row.part_index ?? undefined,
    recalled: row.recalled === 1,
    channelId: row.channel_id,
    delivery: row.delivery,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, 30_000))));
}

export { ACTION_QUARANTINE_MS };
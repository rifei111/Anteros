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
import { ACTION_QUARANTINE_MS, AnterosError, ERROR_CODES, SPEECH_REWRITE_MAX_RATIO } from "@anteros/shared";
import type { ChatMessage, ChatRole, MessageAttachment, MessageDelivery, RelationState } from "@anteros/shared";
import type { ChatDeps, ChatReplyResult, KernelDeps, SpeechMood } from "../contracts.js";
import type { AuditService } from "./audit.js";
import type { ConsentService } from "./consent.js";
import type { CostService } from "./cost.js";
import { pickVoicePart, placeVoiceOnContent } from "../expression/planner.js";
import { SPEECH_REWRITE_SYSTEM, decideVoice, prosodyFor } from "./voice.js";
import type { VoiceHoldStore } from "./voice-hold.js";

const MAX_USER_TEXT = 4000;

/** 语音没听清时的本地回应池：不调模型（模型会编），只表达"没听见，再说一次"。 */
const UNHEARD_PHRASES = [
  "没听清，你再说一遍？",
  "刚才那条语音我没听清",
  "这声音有点小，再说一次吧",
  "你说什么？我这边没放出来",
];

export interface ChatServiceParts {
  deps: KernelDeps;
  ports: ChatDeps;
  consent: ConsentService;
  cost: CostService;
  audit: AuditService;
  /** 「留着没说出口的那句话」的槽位（`<voice wait>`，v1.0.34） */
  voiceHold: VoiceHoldStore;
  /**
   * 外部通道要不要把回话发成语音。业务层只问这一个布尔，不认是哪条通道：
   * 由组合根（app.ts）把通道自己的开关接进来（草案 14.14.3：业务代码不按通道名分支）。
   */
  externalVoice: () => boolean;
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
    /** 会话键：不同的人（或群）各自一条对话线，历史与上下文互不污染 */
    conversation?: string;
    presence?: { isTyping?: boolean; appFocused?: boolean; lastInteractionMs?: number };
    /** 每发出一条分条时回调（内置外部通道用它把话转出去；客户端不用传） */
    onPart?: (text: string, index: number) => void;
    /** 群聊里这句话是谁说的：落库供界面显示，也拼进模型上下文，免得张冠李戴 */
    author?: { name?: string | null; id?: string | null };
    /** 允许它自己决定这次回不回（群聊「自己决定」模式）：模型可以只回一句「不回」 */
    silenceAllowed?: boolean;
    /** 语音条：客户端先 media.upload 拿到 uploadId，再带着它调用本方法（文档 7.2） */
    uploadId?: string;
  }): Promise<ChatReplyResult> {
    const { deps, consent } = this.parts;
    consent.requireConsent("app");
    const uploadId = typeof input.uploadId === "string" && input.uploadId !== "" ? input.uploadId : null;
    const text = (input.text ?? "").trim();
    if (!uploadId && text.length === 0) throw new AnterosError(ERROR_CODES.EINVALID, "消息不能为空");
    if (text.length > MAX_USER_TEXT) {
      throw new AnterosError(ERROR_CODES.EINVALID, `消息太长（${text.length} 字），最多 ${MAX_USER_TEXT} 字`);
    }
    const eventId = input.eventId ?? null;
    if (eventId) {
      const previous = deps.db.get<{ result: string }>("SELECT result FROM idempotency WHERE event_id = ?", [eventId]);
      if (previous) return JSON.parse(previous.result) as ChatReplyResult;
    }

    const conversation = (input.conversation ?? "app").trim() || "app";
    const authorName = String(input.author?.name ?? "").trim();
    const authorId = String(input.author?.id ?? "").trim();
    return this.serial(async () => {
      const now = Date.now();
      const { ports } = this.parts;

      // 语音：先把录音转正。这里失败（过期/格式不对）要把人话直接抛给界面，
      // 而不是插一条永远转写不了的占位消息。
      const bound = uploadId ? ports.media.bindUpload(uploadId) : null;
      const bodyText = bound ? ports.media.placeholderFor(bound) : text;

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
          "INSERT INTO messages(agent_id, role, text, ts, recalled, channel_id, delivery, sender_name, sender_id, attachment) VALUES (?, 'user', ?, ?, 0, ?, 'sent', ?, ?, ?)",
          [
            deps.agentId,
            bodyText,
            now,
            conversation,
            authorName.length > 0 ? authorName : null,
            authorId.length > 0 ? authorId : null,
            bound ? JSON.stringify(bound) : null,
          ],
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

      // 语音要先转写、再进关系与记忆：抽取管线吃到 `[语音 12″]` 会把占位符记成事实（评审硬伤）。
      let userText = text;
      if (bound) {
        ports.emit("event.typing", { state: "transcribe" });
        const asr = await ports.media.transcribe(created.messageId);
        ports.emit("event.typing", { state: "stop" });
        if (!asr.ok) return this.replyToUnheard(created, conversation, asr.reason);
        if (asr.silent) return this.replyToUnheard(created, conversation, "这段语音里没有人声");
        userText = asr.text.trim();
        deps.db.run("UPDATE messages SET text = ? WHERE id = ? AND agent_id = ?", [userText, created.messageId, deps.agentId]);
        ports.emit("event.message", this.getMessage(created.messageId));
      }
      if (userText.length === 0) userText = text;
      const spokenText = authorName.length > 0 ? authorName + "：" + userText : userText;

      const relation = ports.mind.observeUserTurn(userText, now);
      this.emitRelation(relation);
      ports.emit("event.drives", ports.mind.tickDrives(now));

      // 记忆抽取不阻塞回复：先落用户这一句，回复完再抽取（管线内部决定规则命中的即时写）
      void ports.memory.extract(deps.agentId, [{ id: created.messageId, text: userText, ts: now }], now, conversation).catch(() => undefined);

      this.parts.cost.checkBudget();
      // 上一轮攒着的那句（如果有）：取出来准备递给模型；超过 3 轮 / 30 分钟会被丢掉。
      const held = this.parts.voiceHold.claim(conversation, now);
      if (held !== null) deps.log.info(`turn 装配：把上一轮留着的那句（第 ${held.seen} 次）递给它：「${held.text}」`);
      let plan;
      try {
        plan = await ports.expression.planReply({
          agentId: deps.agentId,
          userText: spokenText,
          trigger: "reply",
          now,
          conversation,
          silenceAllowed: input.silenceAllowed === true,
          // 上一轮它留着没说出口的话：摆到它面前，说不说它自己定（v1.0.34）
          heldVoice: held?.text,
        });
      } catch (err) {
        deps.db.run("UPDATE turns SET outcome = 'failed' WHERE id = ?", [created.turnId]);
        throw err;
      }

      const firstPart = plan.parts.find((part) => part.hold !== true) ?? { text: "", typingMs: 0, delayAfterMs: 0 };
      const total = plan.parts.filter((part) => part.hold !== true).length;
      const totalDelay = plan.parts
        .filter((part) => part.hold !== true)
        .reduce((sum, part) => sum + part.typingMs + part.delayAfterMs, 0);

      // 要不要出声（docs/语音条.md 10.1）：决定一次，预检在朗读稿改写之前（10.6 顺序）。
      const external = conversation !== "app";
      // 它自己标的句子优先：模型用 <voice>…</voice> 圈出「想用声音说」的那些话，可以标多句；
      // 没标就按「短、带情绪、像随口一句」挑一条——以前固定第一条，于是永远是第一句出声。
      // `<voice wait>` 标的那几句不算"这轮要发"：它们进的是待发语音槽（见下）。
      const heldParts = plan.parts.filter((part) => part.hold === true && part.text.trim() !== "");
      const marked = plan.parts.flatMap((part, index) => (part.voice === true && part.hold !== true ? [index] : []));
      if (heldParts.length > 0) {
        // 它这句话想用声音说、但觉得现在不是时候：不落库、不出声，先存着。
        // 下一轮（对方回话之后）会摆到它面前，由它自己决定还说。留太久就作废（VoiceHoldStore）。
        this.parts.voiceHold.put(conversation, heldParts.map((part) => part.text).join("；"), created.turnId, now);
        deps.log.info(`turn ${created.turnId}: 留着 ${heldParts.length} 句没说出口，等对方回了再看`);
      }
      if (plan.parts.every((part) => part.hold === true)) {
        // 全留着了：这一轮它是真的一句话都没说（人类也有这种时候）。不落库、不发气泡，
        // 只写一行日志，免得看到"打字半天什么都发不出来"时无从判断。
        deps.log.info(`turn ${created.turnId}: 这一轮它一句都没说，全留着等对方先开口`);
      }
      const pickedIndex = pickVoicePart(plan.parts);
      // 留着的那几句不参与「兜底挑一句出声」，否则它刚说"等会儿再说"、手上又立刻发了。
      const pickedOk = pickedIndex >= 0 && plan.parts[pickedIndex]?.hold !== true;
      const rawCandidates = marked.length > 0 ? marked : pickedOk ? [pickedIndex] : [];
      // 按人类说话的顺序挪一次：铺垫句（「先说好，别笑我」「我试试」）留文字，
      // 语音落到后面第一句真内容上；后面没内容就这一轮不出声（等对方回了再说）。
      const candidates = placeVoiceOnContent(plan.parts, rawCandidates);
      if (candidates.length === 0 && rawCandidates.length > 0) {
        deps.log.info(`turn ${created.turnId}: 要出声的只有铺垫句（${rawCandidates.join(",")}），这一轮不打语音，等它把话说出来`);
      }
      // 闸门逐句判：一句一句看长度、状态、档位。以前拿整段回复的字数去判，
      // 于是「整段很长、但只有一句要出声」会被直接卡掉（用户 2026-11-04 报的就是这个）。
      const voiceParts: Array<{ index: number; text: string }> = [];
      let skippedReason = "";
      for (const index of candidates) {
        const text = plan.parts[index]?.text ?? "";
        if (text.trim() === "") continue;
        const decision = this.outboundVoiceDecision(conversation, text, now);
        if (decision.action === "voice") voiceParts.push({ index, text });
        else if (skippedReason === "") skippedReason = decision.reason;
      }
      const voiceIndexes = voiceParts.map((item) => item.index);
      if (voiceIndexes.length > 0) {
        // 这一轮真出声了：上一轮攒着的那句就作废（话已经说了，别再重复一遍）
        this.parts.voiceHold.clear(conversation);
        deps.log.info(
          `turn ${created.turnId}: ${voiceIndexes.length} 句要出声（第 ${voiceIndexes.join(",")} 条，${
            marked.length > 0 ? "它标的" : "按语气挑的"
          }）`,
        );
      } else {
        deps.log.info(
          `turn ${created.turnId}: 不出声（${skippedReason === "" ? "没有适合出声的句子" : skippedReason}）${
            marked.length > 0 ? "——它标了句子但档位没开" : ""
          }`,
        );
      }
      // 一句一条：每句单独合成、单独发一条语音（用户 2026-11-04：长话不要拼成一条）。
      const voices: Array<{
        index: number;
        text: string;
        rate: number;
        volume: number;
        mood: SpeechMood;
        format: "mp3" | "wav";
      }> = [];
      if (voiceParts.length > 0) {
        const world = ports.mind.getWorld(now);
        const persona = ports.mind.getPersona();
        const warmth = persona.traits?.warmth ?? 0.5;
        const { rate, volume } = prosodyFor(world.moodArousal, world.energy, warmth, world.moodValence);
        const mood: SpeechMood = {
          arousal: world.moodArousal,
          valence: world.moodValence,
          energy: world.energy,
          warmth,
        };
        for (const item of voiceParts) {
          const ceiling = ports.media.speakCeilingCny(item.text, rate);
          if (!ports.media.affordable(ceiling)) {
            deps.log.info(`turn ${created.turnId}: 第 ${item.index} 条语音跳过——预算不够（约 ¥${ceiling.toFixed(2)}）`);
            continue;
          }
          voices.push({
            index: item.index,
            // 外部通道要 wav：旁路进程直接喂 waveOut，省掉 mp3 解码。
            text: await this.rewriteForSpeech(item.text),
            rate,
            volume,
            mood,
            format: external ? "wav" : "mp3",
          });
        }
      }
      this.parts.deps.log.info(`turn ${created.turnId}: ${total} 段，预计 ${Math.round(totalDelay / 100) / 10}s`);

      // 先告诉客户端"要打字了"，时长由服务端算好，客户端不得改（规范 1 §4）
      ports.emit("event.typing", {
        state: "start",
        plannedChars: firstPart.text.length,
        plannedMs: firstPart.typingMs,
      });

      let deliveredTs = 0;
      let firstTokenTs = 0;
      const voiceByIndex = new Map(voices.map((item) => [item.index, item]));
      const voiceMessageIds: number[] = [];
      for (let index = 0; index < plan.parts.length; index += 1) {
        const part = plan.parts[index]!;
        // 留着没说出口的那句：不落库、不发气泡（这一轮它是真的没吭声）
        if (part.hold === true) continue;
        await sleep(part.typingMs);
        if (index === 0) firstTokenTs = Date.now();
        const ts = Date.now();
        // 出站语音挂在它标中的那些气泡上（可能多条）：先插 pending 的 attachment
        // （界面显示「正在录」），合成成功后再补成 ready（文档 5.1：不改正文、不改气泡数量）。
        const pendingAttachment: MessageAttachment | null = voiceByIndex.has(index)
          ? { kind: "audio", path: "", mime: "", bytes: 0, durMs: 0, peaks: [], state: "pending" }
          : null;
        const inserted = deps.db.run(
          "INSERT INTO messages(agent_id, role, text, ts, turn_id, part_index, recalled, channel_id, delivery, attachment) VALUES (?, 'agent', ?, ?, ?, ?, 0, ?, 'sent', ?)",
          [deps.agentId, part.text, ts, created.turnId, index, conversation, pendingAttachment ? JSON.stringify(pendingAttachment) : null],
        );
        if (pendingAttachment) voiceMessageIds.push(inserted.lastInsertRowid);
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
        if (input.onPart) {
          try {
            input.onPart(part.text, index);
          } catch (callbackError) {
            deps.log.warn(`onPart 回调失败：${(callbackError as Error)?.message ?? String(callbackError)}`);
          }
        }
        if (index < plan.parts.length - 1) await sleep(part.delayAfterMs);
      }
      ports.emit("event.typing", { state: "stop" });

      // 语音合成：外部通道要等它落盘（旁路要拿文件去播），应用内异步补上就行。
      const voiceResults: NonNullable<ChatReplyResult["voices"]> = [];
      for (const item of voices) {
        const messageId = voiceMessageIds.shift() ?? 0;
        if (messageId <= 0) continue;
        const spec = {
          text: item.text,
          rate: item.rate,
          volume: item.volume,
          mood: item.mood,
          format: item.format,
        };
        if (external) {
          const attached = await this.attachVoice(messageId, spec);
          if (attached && attached.state === "ready") {
            voiceResults.push({
              index: item.index,
              messageId,
              path: ports.media.absPathFor(attached),
              durMs: attached.durMs,
            });
          }
        } else {
          void this.attachVoice(messageId, spec);
        }
      }

      // 真正说出口的话（留着没说出口的那句不算：它没说过，不该进记忆、也不该算"它的话"）
      const saidText = plan.parts
        .filter((part) => part.hold !== true)
        .map((part) => part.text)
        .join("\n");
      // 成本 + 回放素材
      this.parts.cost.record({ kind: "reply", model: plan.model, inputTokens: plan.usage.inputTokens, outputTokens: plan.usage.outputTokens });
      deps.db.run(
        "UPDATE turns SET plan = ?, ctx_snapshot = ?, prompt = ?, model = ?, output = ?, first_token_ts = ?, delivered_ts = ?, outcome = 'delivered' WHERE id = ?",
        [
          JSON.stringify({ parts: plan.parts }),
          JSON.stringify(plan.ctxSnapshot ?? null),
          plan.prompt,
          plan.model,
          saidText,
          firstTokenTs,
          deliveredTs,
          created.turnId,
        ],
      );
      deps.db.run("UPDATE agents SET state_version = state_version + 1 WHERE id = ?", [deps.agentId]);

      // 它自己的话也要进记忆（source=it_did）——只说出口的那些
      if (saidText.trim().length > 0) {
        ports.memory.rememberEpisode({
          agentId: deps.agentId,
          channelId: conversation,
          text: saidText,
          now: Date.now(),
          source: "it_did",
          sourceRef: created.turnId,
        });
      }
      const agentRelation = ports.mind.observeAgentTurn(saidText, Date.now());
      this.emitRelation(agentRelation);
      this.parts.deps.log.info(`turn ${created.turnId} delivered: ${saidText.slice(0, 40)}`);

      const result: ChatReplyResult = { turnId: created.turnId, userMessage, accepted: true };
      if (voiceResults.length > 0) result.voices = voiceResults;
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

  history(input: { limit?: number; beforeId?: number; conversation?: string } = {}): ChatMessage[] {
    const limit = Math.min(Math.max(input.limit ?? 60, 1), 300);
    const conversation = (input.conversation ?? "app").trim() || "app";
    const rows = input.beforeId
      ? this.parts.deps.db.all<MessageRow>(
          "SELECT * FROM messages WHERE agent_id = ? AND channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
          [this.parts.deps.agentId, conversation, input.beforeId, limit],
        )
      : this.parts.deps.db.all<MessageRow>(
          "SELECT * FROM messages WHERE agent_id = ? AND channel_id = ? ORDER BY id DESC LIMIT ?",
          [this.parts.deps.agentId, conversation, limit],
        );
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

  // ───────────────────────────── 语音条（docs/语音条.md） ─────────────────────────────

  /** 这次回话该不该出声；每个"不发"都带一句人话进日志，用户问起来能答。 */
  private outboundVoiceDecision(conversation: string, fullText: string, now: number) {
    const { ports } = this.parts;
    const world = ports.mind.getWorld(now);
    const relation = ports.mind.getRelation();
    const status = ports.media.status();
    const external = conversation !== "app";
    const externalVoiceOn = external ? this.parts.externalVoice() : false;
    // 外部通道走单独的开关：打开后一条回复只发一条语音。
    // 这里传给 decideVoice 的是「外部通道 + 要不要发语音条」，由它按语音消息的口径
    // 判字数（200 字而不是 56 字）——用 56 字卡的话，开关开了也永远不出声。
    return decideVoice({
      outbound: external ? (externalVoiceOn ? "always" : "off") : status.voiceOutbound,
      speakReady: status.speakReady,
      externalChannel: external,
      voiceMessage: externalVoiceOn,
      presence: world.presence,
      fullText,
      degraded: false,
      trigger: "reply",
      stage: relation.stage,
      moodValence: world.moodValence,
      moodArousal: world.moodArousal,
    });
  }

  /**
   * 朗读稿改写（文档 10.2）：只做读法转换，失败用原文、变长超过 1.6 倍也弃用。
   * 这是回复链路的一部分开销，按 reply 记账。
   */
  private async rewriteForSpeech(fullText: string): Promise<string> {
    const base = fullText.replace(/\s+/g, " ").trim();
    if (base === "") return base;
    try {
      const out = await this.parts.ports.llm.generate({
        messages: [
          { role: "system", content: SPEECH_REWRITE_SYSTEM },
          { role: "user", content: base },
        ],
        temperature: 0.3,
        maxTokens: Math.max(160, Math.ceil([...base].length * 1.2)),
        purpose: "speech",
      });
      this.parts.cost.record({
        kind: "reply",
        model: out.model,
        inputTokens: out.usage.inputTokens,
        outputTokens: out.usage.outputTokens,
      });
      const rewritten = out.text.trim().replace(/^["'“”]+|["'“”]+$/g, "");
      const limit = Math.ceil([...base].length * SPEECH_REWRITE_MAX_RATIO);
      if (rewritten === "" || [...rewritten].length > limit) {
        this.parts.deps.log.info(`朗读稿改写被守卫拦下（${[...rewritten].length} 字 > 上限 ${limit}），用原文`);
        return base;
      }
      return rewritten;
    } catch (err) {
      this.parts.deps.log.warn(`朗读稿改写失败，用原文：${(err as Error)?.message ?? String(err)}`);
      return base;
    }
  }

  /** 合成完成后把 pending 补成 ready；失败标 skipped（界面上是"语音没生成"，正文不受影响）。 */
  private async attachVoice(
    messageId: number,
    voice: { text: string; rate: number; volume: number; mood: SpeechMood; format: "mp3" | "wav" },
  ): Promise<MessageAttachment | undefined> {
    const { ports } = this.parts;
    try {
      const out = await ports.media.synthesize({
        text: voice.text,
        rate: voice.rate,
        volume: voice.volume,
        mood: voice.mood,
        format: voice.format,
      });
      ports.media.writeAttachment(messageId, out.attachment);
      ports.emit("event.message", this.getMessage(messageId));
      this.parts.deps.log.info(`语音已补上（消息 ${messageId}，${out.attachment.bytes}B，¥${out.costCny.toFixed(3)}）`);
      return out.attachment;
    } catch (err) {
      const reason = err instanceof AnterosError ? err.message : ((err as Error)?.message ?? String(err));
      this.parts.deps.log.warn(`语音合成失败（消息 ${messageId}）：${reason}`);
      ports.media.patchAttachment(messageId, { state: "skipped", error: reason });
      ports.emit("event.message", this.getMessage(messageId));
      return undefined;
    }
  }

  /**
   * 没听清的回复（文档 11.2）：不调模型，直接用本地句池回一句。
   * 理由很实在——模型在"音频里没有人声"这种情形上只会编，而这句话需要的是诚实。
   */
  private replyToUnheard(
    created: { messageId: number; turnId: number; epoch: number },
    conversation: string,
    reason: string,
  ): ChatReplyResult {
    const { deps, ports } = this.parts;
    const phrase = UNHEARD_PHRASES[created.messageId % UNHEARD_PHRASES.length] ?? "没听清，你再说一遍？";
    const now = Date.now();
    const inserted = deps.db.run(
      "INSERT INTO messages(agent_id, role, text, ts, turn_id, part_index, recalled, channel_id, delivery) VALUES (?, 'agent', ?, ?, ?, 0, 0, ?, 'sent')",
      [deps.agentId, phrase, now, created.turnId, conversation],
    );
    const message = this.getMessage(inserted.lastInsertRowid);
    ports.emit("event.message", message);
    deps.db.run(
      "UPDATE turns SET output = ?, first_token_ts = ?, delivered_ts = ?, outcome = 'delivered', ctx_snapshot = ? WHERE id = ?",
      [phrase, now, now, JSON.stringify({ voiceUnheard: reason }), created.turnId],
    );
    const relation = ports.mind.observeAgentTurn(phrase, now);
    this.emitRelation(relation);
    deps.log.info(`turn ${created.turnId}: 语音没听清（${reason}），用本地句子回应`);
    return { turnId: created.turnId, userMessage: this.getMessage(created.messageId), accepted: true };
  }

  private currentEpoch(): number {
    const row = this.parts.deps.db.get<{ epoch: number }>("SELECT epoch FROM agents WHERE id = ?", [this.parts.deps.agentId]);
    return row?.epoch ?? 0;
  }

  private emitRelation(relation: RelationState): void {
    // 直接发 RelationState 本身（和 rpc.ts 的 event.relation 声明一致）；
    // 以前多包了一层 { relation }，客户端拿到的 stage 就是 undefined，界面只能显示旧值。
    this.parts.ports.emit("event.relation", relation);
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
  sender_name: string | null;
  sender_id: string | null;
  attachment: string | null;
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
    senderName: row.sender_name ?? null,
    senderId: row.sender_id ?? null,
    attachment: parseAttachment(row.attachment),
  };
}

/** 坏 attachment 当没有：一条脏数据不该让整段历史打不开。 */
function parseAttachment(raw: string | null): MessageAttachment | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MessageAttachment;
    if (!parsed || parsed.kind !== "audio") return null;
    if (!Array.isArray(parsed.peaks)) parsed.peaks = [];
    if (typeof parsed.path !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, 30_000))));
}

export { ACTION_QUARANTINE_MS };
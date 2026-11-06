/**
 * 「留着没说出口的那句话」（v1.0.34）。
 *
 * 场景：它想用声音说一句，但觉得现在不是时候——对方还没回、或者话是回给下一句的。
 * 这时它用 `<voice wait>` 标出来：这一轮不打字也不出声，那句先存着；
 * 等对方回了，下一轮的提示里把这句话递到它面前，由它自己决定现在说不说。
 *
 * 三条约束：
 * - 不进聊天记录（用户不该看到一条幽灵消息），只存 settings 表的 JSON；
 * - 每条会话只有一条，新的覆盖旧的（人也会这样：话头一换，旧的那句就不提了）；
 * - 会老化：最多挂 3 轮或 30 分钟，超时就丢——话说晚了不如不说。
 */
import type { Db } from "../db/database.js";

/** 最多挂几轮（"轮"=每次装配上下文算一次）。 */
const HOLD_MAX_TURNS = 3;
/** 最多挂多久。 */
const HOLD_MAX_MS = 30 * 60_000;

export interface HeldVoice {
  text: string;
  turnId: number;
  ts: number;
  /** 已经被看到过几次（每轮到一次 +1，超过上限就丢） */
  seen: number;
  conversation: string;
}

interface StoredHeldVoice {
  text: string;
  turnId: number;
  ts: number;
  seen: number;
}

export class VoiceHoldStore {
  constructor(private readonly db: Db) {}

  private keyOf(conversation: string): string {
    return `voice.hold.${conversation}`;
  }

  /** 存一句"留着的话"（覆盖同一会话里旧的那句）。 */
  put(conversation: string, text: string, turnId: number, now: number): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const value: StoredHeldVoice = { text: trimmed, turnId, ts: now, seen: 0 };
    this.db.run("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
      this.keyOf(conversation),
      JSON.stringify(value),
    ]);
  }

  /**
   * 取出来看看（不算"看到"）：给管理面板看"它留着什么话"。
   * 过期的顺手清掉。
   */
  peek(conversation: string, now: number): HeldVoice | null {
    const held = this.read(conversation);
    if (held === null) return null;
    if (this.expired(held, now)) {
      this.clear(conversation);
      return null;
    }
    return { ...held, conversation };
  }

  /**
   * 到下一轮了：取出来递给模型，并记一次"看到"。
   * 超过轮次或时间上限就地丢掉，返回 null。
   */
  claim(conversation: string, now: number): HeldVoice | null {
    const held = this.read(conversation);
    if (held === null) return null;
    if (this.expired(held, now) || held.seen >= HOLD_MAX_TURNS) {
      this.clear(conversation);
      return null;
    }
    const next: StoredHeldVoice = { ...held, seen: held.seen + 1 };
    this.db.run("UPDATE settings SET value = ? WHERE key = ?", [JSON.stringify(next), this.keyOf(conversation)]);
    return { ...next, conversation };
  }

  clear(conversation: string): void {
    this.db.run("DELETE FROM settings WHERE key = ?", [this.keyOf(conversation)]);
  }

  /** 管理面板用：列出所有会话里留着的话（过期的顺手清掉）。 */
  list(now: number): HeldVoice[] {
    const rows = this.db.all<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key LIKE ?", [
      "voice.hold.%",
    ]);
    const items: HeldVoice[] = [];
    for (const row of rows) {
      const conversation = row.key.slice("voice.hold.".length);
      const held = this.peek(conversation, now);
      if (held !== null) items.push(held);
    }
    return items.sort((left, right) => right.ts - left.ts);
  }

  private read(conversation: string): StoredHeldVoice | null {
    const row = this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [this.keyOf(conversation)]);
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value) as Partial<StoredHeldVoice>;
      const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
      if (text.length === 0) return null;
      return {
        text,
        turnId: typeof parsed.turnId === "number" ? parsed.turnId : 0,
        ts: typeof parsed.ts === "number" ? parsed.ts : 0,
        seen: typeof parsed.seen === "number" ? parsed.seen : 0,
      };
    } catch {
      return null;
    }
  }

  private expired(held: StoredHeldVoice, now: number): boolean {
    if (held.ts === 0) return false;
    return now - held.ts > HOLD_MAX_MS;
  }
}
/**
 * 反模板（草案 4.6，规范 2 §9）。
 *
 * 为什么用字符 3-gram 而不是语义相似度：零成本、确定性、可单测；中文里
 * 相同的说法会共享大量 3-gram，换词但换结构的"洗稿"也能抓到大半。
 *
 * 两类拦截：
 *   1) 指纹：与最近 200 条自己的话相似度 > 0.78 → 打回重写；
 *   2) 结构黑名单：复述+评价、排比三段式、每段以"嗯"开头、连续两轮同句式。
 * 另：同一开场 30 天不复用；口癖只记录不启用（草案 4.6：真实重复 ≥3 次
 * 且用户不反感才可进口癖表，本版本没有"用户不反感"的可靠信号）。
 */
import type { Db } from "../db/database.js";

/** 参与指纹的字符：去掉标点/空白，只留实义字符。 */
const NOISE = /[\s\u3000。，、！？；：,.!?;:~～…—\-—"'“”‘’（）()《》【】\[\]「」『』]/g;

export function threeGramSet(text: string): Set<string> {
  const clean = text.replace(NOISE, "");
  const set = new Set<string>();
  for (let index = 0; index + 3 <= clean.length; index += 1) {
    set.add(clean.slice(index, index + 3));
  }
  return set;
}

/** Dice 系数：2|A∩B| / (|A|+|B|)，对长度差异比 Jaccard 稳。 */
export function threeGramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const setA = threeGramSet(a);
  const setB = threeGramSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let overlap = 0;
  for (const gram of setA) {
    if (setB.has(gram)) overlap += 1;
  }
  return (2 * overlap) / (setA.size + setB.size);
}

export interface SimilarityHit {
  max: number;
  matched: string | null;
}

export function similarityToRecent(text: string, recent: readonly string[]): SimilarityHit {
  let max = 0;
  let matched: string | null = null;
  for (const candidate of recent) {
    const score = threeGramSimilarity(text, candidate);
    if (score > max) {
      max = score;
      matched = candidate;
    }
  }
  return { max, matched };
}

/** 开场 = 去掉标点后的前 6 个字；同一开场 30 天不复用。 */
export function openingOf(text: string): string {
  return text.replace(NOISE, "").slice(0, 6);
}

function segmentsOf(text: string): string[] {
  return text
    .split(/[。！？!?\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

const PARALLEL = /^(.{2,8})[，,](.{2,8})[，,](.{2,8})[。！？!?]?$/;

/** 结构黑名单：返回命中的原因，null 表示干净。 */
export function structureIssue(text: string, previous: string | null): string | null {
  const segments = segmentsOf(text);
  if (segments.length >= 2 && segments.every((segment) => segment.startsWith("嗯"))) {
    return "每段都以「嗯」开头";
  }
  if (/(你说|你讲|你说过|你提到)[^。！？!?]{0,14}[，,]\s*(这|那|真|挺|确实|也太)/.test(text)) {
    return "复述+评价";
  }
  if (PARALLEL.test(text.trim())) {
    return "排比三段式";
  }
  if (previous !== null && segments.length > 0 && structureSignature(text) === structureSignature(previous) && text.length >= 8) {
    return "连续两轮同句式";
  }
  return null;
}

/** 句式指纹：每段的长度桶 + 句尾语气，够粗才抓得住"换词不换结构"。 */
export function structureSignature(text: string): string {
  const segments = segmentsOf(text);
  return segments
    .map((segment) => `${Math.min(6, Math.ceil(segment.length / 4))}${segment.endsWith("吧") ? "b" : segment.endsWith("吗") ? "m" : segment.endsWith("啊") ? "a" : ""}`)
    .join("|");
}

export interface TemplateCheck {
  rewrite: boolean;
  reasons: string[];
  maxSimilarity: number;
  openingReused: boolean;
}

export class AntiTemplateGuard {
  constructor(
    private readonly db: Db,
    private readonly agentId: number,
  ) {}

  /** 最近 N 条自己说过的话（召回失败也不影响主流程，按空处理）。 */
  recentReplies(limit = 200): string[] {
    return this.db
      .all<{ text: string }>("SELECT text FROM messages WHERE agent_id = ? AND role = 'agent' AND recalled = 0 ORDER BY id DESC LIMIT ?", [
        this.agentId,
        limit,
      ])
      .map((row) => row.text);
  }

  /** 30 天内用过的开场（只取每条消息的前 6 字）。 */
  recentOpenings(now: number, days = 30): string[] {
    return this.db
      .all<{ text: string }>("SELECT text FROM messages WHERE agent_id = ? AND role = 'agent' AND recalled = 0 AND ts >= ?", [
        this.agentId,
        now - days * 86_400_000,
      ])
      .map((row) => openingOf(row.text));
  }

  /**
   * 一次检查：是否要打回重写。threshold 默认 0.78（草案 4.6 / 规范 2 §9.1）。
   * 注意：只拦截"像自己说过的话"，不拦截"像人"，所以阈值定得高。
   */
  check(text: string, now: number, previous: string | null): TemplateCheck {
    const recent = this.recentReplies();
    const hit = similarityToRecent(text, recent);
    const opening = openingOf(text);
    const openingReused = opening.length >= 2 && this.recentOpenings(now).includes(opening);
    const reasons: string[] = [];
    if (hit.max > 0.78) reasons.push(`与近期回复相似度 ${hit.max.toFixed(2)}`);
    if (openingReused) reasons.push("开场 30 天内用过");
    const structural = structureIssue(text, previous);
    if (structural !== null) reasons.push(structural);
    return { rewrite: reasons.length > 0, reasons, maxSimilarity: hit.max, openingReused };
  }

  /**
   * 记录口癖素材：只记录、不启用。accepted 恒为 0（没有"用户不反感"的可靠
   * 信号，草案要求真实重复 ≥3 次且用户不反感才允许启用）。
   */
  record(text: string, now: number): void {
    const phrase = openingOf(text);
    if (phrase.length < 2) return;
    this.db.run(
      `INSERT INTO style_habits(agent_id, phrase, first_ts, last_ts, used_count, accepted)
       VALUES (?, ?, ?, ?, 1, 0)
       ON CONFLICT(agent_id, phrase) DO UPDATE SET last_ts = excluded.last_ts, used_count = style_habits.used_count + 1`,
      [this.agentId, phrase, now, now],
    );
  }
}

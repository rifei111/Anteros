/**
 * 分条与节奏（草案 4.1–4.3，规范 2 §6）。
 *
 * 口径（测试里固定）：
 *  - 1–3 条，每条 ≤25 字（长句按标点/语义切，硬切只在没标点时兜底）；
 *  - typing_ms = 字数 / (4~6 字/秒) × 人格系数（手速慢/快），不是固定值；
 *  - 条间 delay_after 用对数正态（median=delayMedianMs, sigma=delaySigma）再
 *    按在场调制；禁止任何固定延迟。
 *  - 外部通道（typing_is_real=false）最多 2 条：本层拿不到通道能力，按 burst
 *    与文字长度自然收敛，不在这里判通道（规范 1 §4）。
 */
import type { PersonaTraits, PresenceState } from "@anteros/shared";
import type { PlannedPart } from "../contracts.js";
import { Rng } from "../util/rng.js";

export const MAX_PART_CHARS = 25;
export const MAX_PARTS = 3;

/** 条间延迟按在场的区间（毫秒）；先采样再 clamp，保证"不是固定值"。 */
export const PRESENCE_DELAY_RANGE: Record<PresenceState, readonly [number, number]> = {
  phone_in_hand: [800, 2000],
  idle: [1200, 3000],
  busy: [4000, 15_000],
  sleep: [10_000, 60_000],
  away: [30_000, 300_000],
};

const SENTENCE_SPLIT = /[。！？!?；;\n]+/;
const CLAUSE_SPLIT = /[，,、：:]+/;

export function cleanReplyText(raw: string): string {
  return raw
    .replace(/\r/g, "")
    .replace(/^[「『"“]\s*/, "")
    .replace(/\s*[」』"”]$/, "")
    .replace(/[*#`>]+/g, "")
    .replace(/[ \t\u3000]+/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** 没有标点的长串按 25 字硬切（最后手段；有标点时优先在标点处切）。 */
export function hardWrap(text: string, size = MAX_PART_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const slice = rest.slice(0, size);
    const cutAt = Math.max(slice.lastIndexOf("，"), slice.lastIndexOf(","), slice.lastIndexOf(" "));
    if (cutAt >= size / 2) {
      chunks.push(rest.slice(0, cutAt).trim());
      rest = rest.slice(cutAt + 1).trim();
    } else {
      chunks.push(slice);
      rest = rest.slice(size);
    }
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks.filter((chunk) => chunk.length > 0);
}

/** 按标点切成"可以独立成条"的语义块，每块 ≤25 字。 */
export function semanticChunks(text: string): string[] {
  const sentences = text
    .split(SENTENCE_SPLIT)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const chunks: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= MAX_PART_CHARS) {
      chunks.push(sentence);
      continue;
    }
    const clauses = sentence
      .split(CLAUSE_SPLIT)
      .map((clause) => clause.trim())
      .filter((clause) => clause.length > 0);
    let buffer = "";
    for (const clause of clauses) {
      if (clause.length > MAX_PART_CHARS) {
        if (buffer.length > 0) chunks.push(buffer);
        buffer = "";
        chunks.push(...hardWrap(clause));
        continue;
      }
      if ((buffer + clause).length > MAX_PART_CHARS) {
        if (buffer.length > 0) chunks.push(buffer);
        buffer = clause;
      } else {
        buffer = buffer.length === 0 ? clause : `${buffer}，${clause}`;
      }
    }
    if (buffer.length > 0) chunks.push(buffer);
  }
  return chunks;
}

/** 条数上限：短回复就 1 条；长回复才允许 3 条（burst 与文字长度共同决定）。 */
export function maxPartsFor(textLength: number, burstMax: number): number {
  const burst = Math.min(MAX_PARTS, Math.max(1, Math.round(burstMax)));
  if (textLength <= 12) return 1;
  if (textLength <= 40) return Math.min(2, burst);
  return burst;
}

/** 把语义块装进 1–3 条，每条 ≤25 字。 */
export function splitIntoParts(raw: string, burstMax: number): string[] {
  const text = cleanReplyText(raw);
  if (text.length === 0) return [""];
  const limit = maxPartsFor(text.length, burstMax);
  const maxTotal = limit * MAX_PART_CHARS;
  // 超长兜底：1–3 条 × 25 字是硬上限，超出部分截断（总比丢格式强）
  const body = text.length > maxTotal ? text.slice(0, maxTotal) : text;
  const parts = packChunks(semanticChunks(body), limit, MAX_PART_CHARS);
  if (parts.length === 0) return [body];
  return parts;
}

/** 贪心装块，目标长度 = 总长/条数（≤25）；块太碎时均衡重切。 */
function packChunks(chunks: readonly string[], limit: number, size: number): string[] {
  if (chunks.length === 0) return [];
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const target = Math.min(size, Math.max(1, Math.ceil(total / limit)));
  const parts: string[] = [];
  for (const chunk of chunks) {
    const last = parts[parts.length - 1];
    if (last !== undefined && last.length + chunk.length <= target) {
      parts[parts.length - 1] = last + chunk;
    } else {
      parts.push(chunk);
    }
  }
  if (parts.length > limit) return balancedSlice(chunks.join(""), limit, size);
  return parts;
}

function balancedSlice(text: string, limit: number, size: number): string[] {
  const total = Math.min(text.length, limit * size);
  const target = Math.ceil(total / limit);
  const parts: string[] = [];
  for (let index = 0; index < total && parts.length < limit; index += target) {
    parts.push(text.slice(index, index + target));
  }
  return parts;
}

/** typing_ms = 字数 / (4~6 字/秒) × 人格手速系数。 */
export function typingMsFor(chars: number, traits: PersonaTraits, rng: Rng): number {
  const speed = rng.float(4, 6); // 字/秒
  const typistFactor = Math.min(1.3, Math.max(0.8, traits.delayMedianMs / 4500));
  const jitter = rng.float(0.9, 1.15);
  const ms = Math.round((Math.max(1, chars) / speed) * 1000 * typistFactor * jitter);
  return Math.max(300, ms);
}

/** 条间延迟：对数正态 + 在场区间，独立采样。 */
export function delayAfterMsFor(traits: PersonaTraits, presence: PresenceState, rng: Rng): number {
  const sampled = rng.logNormal(traits.delayMedianMs, traits.delaySigma);
  const [min, max] = PRESENCE_DELAY_RANGE[presence];
  return Math.round(Math.min(max, Math.max(min, sampled)));
}

export interface PlanPartsInput {
  traits: PersonaTraits;
  presence: PresenceState;
  rng: Rng;
}

/** 把模型输出切成 PlannedPart 序列（1–3 条，最后一条 delayAfterMs=0）。 */
export function planParts(raw: string, input: PlanPartsInput): PlannedPart[] {
  const texts = splitIntoParts(raw, input.traits.burstMax);
  return texts.map((text, index) => {
    const isLast = index === texts.length - 1;
    return {
      text,
      typingMs: typingMsFor(text.length, input.traits, input.rng),
      delayAfterMs: isLast ? 0 : delayAfterMsFor(input.traits, input.presence, input.rng),
    };
  });
}

/** 完整回复文本：落库用（分条是投递层的事，记忆里记整句）。 */
export function joinFullText(parts: readonly PlannedPart[]): string {
  return parts.map((part) => part.text).join("\n");
}

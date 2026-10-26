/**
 * 召回（规范 2 §4）：先粗排，再用 ACT-R 概率精排。
 *
 * 打分 = 来源可靠度 × 时间衰减（ACT-R 激活→概率）× 情绪强度 × 线索匹配。
 *
 * 为什么不引入分词库/向量库：单机闭环 M0–M2 不引原生依赖（node:sqlite 已够），
 * 中文用字符 bigram + 关键词命中做线索相似度，够用且完全可解释——每条召回都
 * 能说出"为什么是它"（`why`），这是回放与调试需要的。
 *
 * 四类记忆的衰减方式不同（草案 1.5 / 规范 1 §2.3）：
 *   episodic  —— 幂律衰减，靠 ACT-R 提取概率
 *   semantic  —— 不衰减，只信 confidence
 *   open_loop —— 不衰减，靠 urgency 与 last_touch 排
 *   persona   —— 不参与召回（L0 固定注入）
 */
import type { MemoryItem, MemorySearchResult, PersonaTraits } from "@anteros/shared";
import type { Db } from "../db/database.js";
import {
  baseLevel,
  emotionTerm,
  parseAccessLog,
  recallProbability,
} from "./actr.js";
import {
  episodicToItem,
  listCurrentSemantic,
  listOpenLoops,
  listRecentEpisodic,
  openLoopToItem,
  semanticToItem,
  sourceReliability,
  type EpisodicRow,
  type OpenLoopRow,
  type SemanticRow,
} from "./store.js";

/** 候选池大小：最近 400 条情节（规范 2 §4.1）。 */
export const DEFAULT_RECENT_EPISODIC = 400;
/** 默认返回条数：L4 召回预算 ≤800 tokens，8 条是上限内的典型值。 */
export const DEFAULT_TOP_K = 8;

export interface RecallInput {
  db: Db;
  agentId: number;
  /** 用户当前这句话；主动消息时可为空串 */
  text: string;
  now: number;
  mood?: { v: number; a: number };
  traits: PersonaTraits;
  topK?: number;
  recentLimit?: number;
}

export interface RetrievalResult extends MemorySearchResult {
  /** 一句话解释这次召回的依据（调试/回放用） */
  why: string;
  /** 是否识别出"你还记得…吗"这类显式回忆请求 */
  explicitRecall: boolean;
  candidateCount: number;
}

interface Scored {
  item: MemoryItem;
  score: number;
}

// ─────────────────────── 中文线索相似度（零依赖） ───────────────────────

/** 去掉空白与标点后取字符 bigram；单字文本退化为 unigram。 */
export function charBigrams(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
  const grams = new Set<string>();
  if (normalized.length === 0) return grams;
  if (normalized.length === 1) {
    grams.add(normalized);
    return grams;
  }
  for (let i = 0; i + 1 < normalized.length; i += 1) grams.add(normalized.slice(i, i + 2));
  return grams;
}

/** Dice 系数：2|A∩B| / (|A|+|B|)，对短句比 Jaccard 更宽容。 */
export function textSimilarity(a: string, b: string): number {
  const setA = charBigrams(a);
  const setB = charBigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let overlap = 0;
  for (const gram of setA) if (setB.has(gram)) overlap += 1;
  return (2 * overlap) / (setA.size + setB.size);
}

/** 关键词命中：记忆里的实体/数字出现在当前句子里就算线索命中。 */
function keywordScore(query: string, entities: readonly string[], text: string): number {
  if (query.length === 0) return 0;
  let hits = 0;
  for (const entity of entities) {
    if (entity.length >= 2 && query.includes(entity)) hits += 1;
  }
  // 数字与日期在中文里是强线索（"上周三""450 块"）
  const numbers = text.match(/\d{2,}/g) ?? [];
  for (const num of numbers.slice(0, 3)) if (query.includes(num)) hits += 1;
  if (hits === 0) return 0;
  return Math.min(1, 0.35 + hits * 0.2);
}

/** 显式回忆请求识别（规范 2 §4.4：识别"你还记得…吗"，pinned 就变成必答）。 */
export function detectExplicitRecall(text: string): boolean {
  return /(还记不记得|还记得|记不记得|你记得|上次|上回|之前说|我说过|以前提过|有没有跟你说)/.test(text);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// ─────────────────────── 各类记忆的打分 ───────────────────────

function scoreEpisodic(row: EpisodicRow, input: RecallInput): Scored {
  const timestamps = parseAccessLog(row.access_log);
  if (timestamps.length === 0) timestamps.push(row.t_start_ts);
  const d = input.traits.memoryD;
  const base = baseLevel(timestamps, input.now, d);
  const cue = clamp01(
    Math.max(textSimilarity(input.text, row.text), keywordScore(input.text, parseEntitiesSafe(row.entities), row.text)),
  );
  const emotion = row.emotion_v === null ? null : { v: row.emotion_v, a: row.emotion_a ?? 0.5 };

  // 线索与情绪也进 ACT-R 激活：A = B + ΣW·S + γ·emotion（草案 1.2）
  const cueTermValue = input.text.trim().length === 0 ? 0 : 0.3 + 0.7 * cue;
  const activationValue = base + emotionTerm(emotion, input.traits.emotionGain) + cueTermValue;
  const prob = recallProbability(activationValue, input.traits.memoryTau, input.traits.memoryS);
  // 主动消息（没有用户文本）时不靠线索，靠情绪与时间
  const cueFactor = input.text.trim().length === 0 ? 1 : 0.15 + 0.85 * cue;

  // 情绪强度：效价越高、唤醒越高越显眼（与"情绪一致性"一起决定是否容易想起）
  const consistency = input.mood && emotion && input.mood.v * emotion.v < 0 ? 0.85 : 1.12;
  const emotionFactor = (1 + 0.35 * Math.abs(emotion?.v ?? 0) * (0.5 + 0.5 * (emotion?.a ?? 0.5))) * consistency;

  const item = episodicToItem(row);
  item.activation = activationValue;
  item.recallProbability = prob;
  const score = sourceReliability(row.source) * prob * emotionFactor * cueFactor;
  return { item, score };
}

function parseEntitiesSafe(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function scoreSemantic(row: SemanticRow, input: RecallInput): Scored {
  const item = semanticToItem(row);
  const text = `${row.slot_key} ${typeof item.value === "string" ? item.value : JSON.stringify(item.value ?? "")}`;
  const cue = clamp01(Math.max(textSimilarity(input.text, text), input.text.includes(row.slot_key) ? 0.8 : 0));
  const cueFactor = input.text.trim().length === 0 ? 1 : 0.25 + 0.75 * cue;
  const importanceBoost = row.importance === "important" || row.importance === "redline" ? 1.15 : 1;
  // semantic 不衰减：只信来源可靠度 × confidence（草案 1.5）
  const score = sourceReliability("semantic") * row.confidence * importanceBoost * cueFactor;
  return { item, score };
}

function scoreOpenLoop(row: OpenLoopRow, input: RecallInput): Scored {
  const item = openLoopToItem(row);
  const cue = clamp01(textSimilarity(input.text, row.topic));
  const cueFactor = input.text.trim().length === 0 ? 1 : 0.3 + 0.7 * cue;
  // open loop 不衰减：它本来就"没完事"，越拖越该想起来
  const score = 0.9 * clamp01(row.urgency) * cueFactor;
  return { item, score };
}

// ─────────────────────── pinned 证据层 ───────────────────────

/**
 * 系统兜底注入的证据（草案 1.6）：redline（承诺/禁忌/说过的重要事）+ 未闭合话题
 * + 置信度最高的结构事实。它不强迫模型开口，但模型也"不许否认发生过"。
 */
export function collectPinned(db: Db, agentId: number, now: number, limit = 10): MemoryItem[] {
  const pinned: MemoryItem[] = [];
  const seen = new Set<string>();
  const push = (item: MemoryItem): void => {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    pinned.push(item);
  };

  // 1) redline 级情节与事实
  for (const row of listRecentEpisodic(db, agentId, DEFAULT_RECENT_EPISODIC)) {
    if (row.importance === "redline") push(episodicToItem(row));
  }
  for (const row of listCurrentSemantic(db, agentId)) {
    if (row.importance === "redline") push(semanticToItem(row));
  }
  // 2) 未闭合话题（含被临时钉住的）
  for (const row of listOpenLoops(db, agentId, true)) {
    if (row.pinned_until !== null && row.pinned_until > now) push(openLoopToItem(row));
  }
  for (const row of listOpenLoops(db, agentId, true)) {
    if (pinned.length >= limit) break;
    push(openLoopToItem(row));
  }
  // 3) 结构事实里置信度最高的若干条
  const facts = listCurrentSemantic(db, agentId)
    .filter((row) => row.confidence >= 0.85)
    .slice(0, 3)
    .map(semanticToItem);
  for (const fact of facts) {
    if (pinned.length >= limit) break;
    push(fact);
  }
  return pinned.slice(0, limit);
}

// ─────────────────────── 主召回 ───────────────────────

export function retrieve(input: RecallInput): RetrievalResult {
  const topK = input.topK ?? DEFAULT_TOP_K;
  const recentLimit = input.recentLimit ?? DEFAULT_RECENT_EPISODIC;
  const scored: Scored[] = [];

  for (const row of listRecentEpisodic(input.db, input.agentId, recentLimit)) scored.push(scoreEpisodic(row, input));
  for (const row of listCurrentSemantic(input.db, input.agentId)) scored.push(scoreSemantic(row, input));
  for (const row of listOpenLoops(input.db, input.agentId, true)) scored.push(scoreOpenLoop(row, input));

  scored.sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt);
  const items = scored.slice(0, topK).map((entry) => entry.item);
  const pinned = collectPinned(input.db, input.agentId, input.now);
  const explicitRecall = detectExplicitRecall(input.text);
  const top = items[0];
  const activationText = top?.recallProbability !== undefined ? `，最高概率 ${top.recallProbability.toFixed(2)}` : "";
  const why = explicitRecall
    ? `用户显式要求回忆：候选 ${scored.length} 条${activationText}，pinned 证据必给`
    : `候选 ${scored.length} 条（情节+结构事实+未闭合话题）${activationText}`;

  return { items, pinned, why, explicitRecall, candidateCount: scored.length };
}

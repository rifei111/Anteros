/**
 * 三级抽取漏斗（草案 1.7 / 规范 2 §5）：
 *   第一级 规则（约 70% 覆盖、零成本）—— 实体/数字/日期/否定/情绪词/承诺句式/未闭合话题
 *   第二级 插件（extras.plugin.extract，没有就跳过，见 service.ts）
 *   第三级 内联 LLM（只复制原文片段 + 槽位标签，禁止概括）
 *
 * 本文件只做"文本 → 候选"，不碰 SQLite；落库、去重、supersede 在 service.ts。
 * 刻意不引分词库：规则用正则 + 字符片段就够覆盖中文口语里的承诺/日期/喜好，
 * 引入分词只会换来不可解释的漏抽。
 */
import type { LlmPort, MemoryCandidate } from "../contracts.js";
import type { Importance } from "@anteros/shared";

/** 抽取管线能写的 kind：persona 是种子人格专属（规范 1 §1，禁止抽取写入）。 */
type CandidateKind = MemoryCandidate["kind"];

export interface RuleFact {
  slotKey: string;
  value: unknown;
  confidence: number;
}

export interface RuleLoop {
  topic: string;
  urgency: number;
}

export interface RuleExtraction {
  candidates: MemoryCandidate[];
  facts: RuleFact[];
  loops: RuleLoop[];
}

/** 情绪词表：用于抽取（不是表达模板）。val ∈ [-1,1]。 */
const EMOTION_WORDS: ReadonlyArray<readonly [string, number]> = [
  ["开心", 0.8], ["高兴", 0.7], ["喜欢", 0.6], ["爱", 0.7], ["舒服", 0.5], ["温暖", 0.5],
  ["感动", 0.7], ["期待", 0.6], ["兴奋", 0.9], ["轻松", 0.4], ["放心", 0.5], ["骄傲", 0.6],
  ["幸福", 0.9], ["爽", 0.7], ["满足", 0.5], ["安心", 0.5], ["惊喜", 0.8],
  ["难过", -0.8], ["伤心", -0.8], ["委屈", -0.7], ["生气", -0.8], ["烦", -0.6], ["焦虑", -0.7],
  ["害怕", -0.7], ["累", -0.5], ["孤独", -0.7], ["失望", -0.7], ["内疚", -0.6], ["羞愧", -0.6],
  ["崩溃", -0.9], ["气死", -0.9], ["烦死", -0.8], ["无聊", -0.3], ["心疼", -0.5], ["压力", -0.6],
  ["失眠", -0.6], ["痛", -0.6], ["哭", -0.7], ["难受", -0.8], ["糟糕", -0.7], ["后悔", -0.6],
];

/** 承诺句式（草案 1.7：承诺、强调、禁忌 → redline）。 */
const COMMITMENT_RE =
  /(我(?:会|一定|必须|保证|答应|承诺|发誓|说好)|答应你|保证|承诺|一定(?:要|会|去)|必须|绝对|说到做到|包在我身上|放心交给我)/;
/** 禁忌/禁区（用户明确不想提的） */
const TABOO_RE = /(别问|别提|不许提|不要提|不想聊|不能提|别说这个|禁忌|(?:不要|不许|不能)再?(?:说|提))/;
/** 重大否定：只收"绝对不/再也不"这种强否定，普通"不"不算 redline */
const STRONG_NEGATION_RE = /(绝对不|再也不|从来不|一点都不|绝不|根本不会?|永远不)/;
/** 未闭合话题 */
const OPEN_LOOP_RE = /(改天|下次|回头|还没|没弄完|没做完|没写完|再说|有空|等(?:我|你|他|她)[^，。！？!?]{0,8}再|找时间)/;
/** 强调词：情绪强度 + 重复 → important */
const EMPHASIS_RE = /(特别|真的|非常|超级|太|巨|贼|死|极了|爆|一定要|记住|很重要的)/;

/** 结构事实的正则：只认"我+谓词+宾语"这种明确的自我介绍句。 */
const FACT_PATTERNS: ReadonlyArray<{ re: RegExp; slotKey: (m: RegExpMatchArray) => string; value: (m: RegExpMatchArray) => unknown; confidence: number }> = [
  { re: /我(?:叫|名字叫|名字是)([\u4e00-\u9fa5A-Za-z0-9]{1,8})/, slotKey: () => "identity.name", value: (m) => m[1] ?? "", confidence: 0.7 },
  { re: /我(?:今年)?(\d{1,3})岁/, slotKey: () => "identity.age", value: (m) => Number(m[1]), confidence: 0.7 },
  { re: /我(?:住在|住|家在)([^，。！？!?；;\s]{1,12})/, slotKey: () => "life.residence", value: (m) => m[1] ?? "", confidence: 0.65 },
  { re: /我(?:在|做)([^，。！？!?；;\s]{1,12})(?:工作|上班)/, slotKey: () => "life.job", value: (m) => m[1] ?? "", confidence: 0.65 },
  { re: /我(?:的)?生日(?:是)?([0-9]{1,2}月[0-9]{1,2}[日号]?|[0-9]{4}-[0-9]{1,2}-[0-9]{1,2})/, slotKey: () => "life.birthday", value: (m) => m[1] ?? "", confidence: 0.7 },
  { re: /我(?:很|特别|超|最|挺)?(?:喜欢|爱|爱吃|爱喝)([^，。！？!?；;\s]{1,20})/, slotKey: () => "pref.like", value: (m) => m[1] ?? "", confidence: 0.65 },
  { re: /我(?:不太|不|非常|特别)?(?:讨厌|受不了|不喜欢)([^，。！？!?；;\s]{1,20})/, slotKey: () => "pref.dislike", value: (m) => m[1] ?? "", confidence: 0.65 },
  { re: /我(?:每天|通常|一般|习惯|总是)([^，。！？!?；;\s]{1,30})/, slotKey: () => "life.habit", value: (m) => m[1] ?? "", confidence: 0.6 },
];

/** 单值槽位：新值不同则 supersede 旧行；pref/habit 的槽位带值，天然多值。 */
export const SINGLE_VALUE_SLOTS: ReadonlySet<string> = new Set([
  "identity.name",
  "identity.age",
  "life.residence",
  "life.job",
  "life.birthday",
]);

/** 拆句：先按句末标点切，过长的再按逗号切（保证"原文片段"不会整段搬走）。 */
export function splitClauses(text: string): string[] {
  const rough = text
    .split(/(?<=[。！？!?；;\n])/u)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);
  const clauses: string[] = [];
  for (const piece of rough) {
    if (piece.length <= 60) {
      clauses.push(piece);
      continue;
    }
    for (const part of piece.split(/(?<=[，,])/u)) {
      const trimmed = part.trim();
      if (trimmed.length > 0) clauses.push(trimmed);
    }
  }
  return clauses;
}

/** 实体：引号内、英文词、@提及、"叫/名字"附近；不追求完整 NER，够检索即可。 */
export function extractEntities(text: string): string[] {
  const entities = new Set<string>();
  for (const match of text.matchAll(/[「『"“']([^」』"”']{2,12})[」』"”']/gu)) {
    if (match[1]) entities.add(match[1]);
  }
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_]{1,20}/g)) entities.add(match[0]);
  for (const match of text.matchAll(/(?:叫|名字是|昵称是)\s*([\u4e00-\u9fa5A-Za-z]{1,8})/g)) {
    if (match[1]) entities.add(match[1]);
  }
  return [...entities];
}

/** 情绪识别：词表加权 + 标点唤醒。返回 null 表示"没有可记录的情绪"。 */
export function detectEmotion(text: string): { v: number; a: number } | null {
  let sum = 0;
  let hits = 0;
  for (const [word, weight] of EMOTION_WORDS) {
    const count = text.split(word).length - 1;
    if (count > 0) {
      sum += weight * Math.min(count, 2);
      hits += count;
    }
  }
  const punctuation = (text.match(/[！!]/g)?.length ?? 0) + (text.match(/[？?]/g)?.length ?? 0) * 0.5;
  if (hits === 0) return null;
  const v = Math.max(-1, Math.min(1, sum));
  const a = Math.max(0, Math.min(1, 0.35 + punctuation * 0.12 + Math.abs(v) * 0.4));
  return { v, a };
}

function importanceFrom(text: string, factLike: boolean, emotion: { v: number; a: number } | null): Importance {
  if (COMMITMENT_RE.test(text) || TABOO_RE.test(text) || STRONG_NEGATION_RE.test(text)) return "redline";
  const emphasis = EMPHASIS_RE.test(text);
  const intensity = emotion === null ? 0 : Math.abs(emotion.v) * (0.5 + 0.5 * emotion.a);
  if (factLike || emphasis || intensity >= 0.55) return "important";
  return "detail";
}

/** 未闭合话题的归一化 topic：去掉开头的时间词，留下"事"。 */
function loopTopic(clause: string): string {
  return clause
    .replace(/^(?:嗯+|那个|就是|然后|所以)?\s*(?:改天|下次|回头|有空|找时间|等[^，。！？]{0,8}再)\s*/u, "")
    .replace(/[，。！？!?；;]+$/u, "")
    .slice(0, 40);
}

function normalizeForDedupe(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

function dedupeCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
  const kept: MemoryCandidate[] = [];
  const rank: Record<Importance, number> = { detail: 0, important: 1, redline: 2 };
  for (const candidate of candidates) {
    const key = normalizeForDedupe(candidate.text);
    if (key.length === 0) continue;
    const existing = kept.find((item) => {
      const other = normalizeForDedupe(item.text);
      return other === key || (other.length > 8 && key.length > 8 && (other.includes(key) || key.includes(other)));
    });
    if (existing === undefined) {
      kept.push(candidate);
      continue;
    }
    if (rank[candidate.importance] > rank[existing.importance] || candidate.confidence > existing.confidence) {
      existing.importance = rank[candidate.importance] > rank[existing.importance] ? candidate.importance : existing.importance;
      existing.confidence = Math.max(existing.confidence, candidate.confidence);
    }
  }
  return kept;
}

/** 第一级：规则抽取（纯函数，无副作用）。 */
export function extractRules(text: string): RuleExtraction {
  const candidates: MemoryCandidate[] = [];
  const facts: RuleFact[] = [];
  const loops: RuleLoop[] = [];

  for (const clause of splitClauses(text)) {
    const emotion = detectEmotion(clause);
    const entities = extractEntities(clause);

    // 1) 结构事实：先匹配 FACT_PATTERNS；命中的同时仍生成一条 semantic 候选
    let fact: RuleFact | null = null;
    for (const pattern of FACT_PATTERNS) {
      const match = clause.match(pattern.re);
      if (match === null) continue;
      const value = pattern.value(match);
      if (value === "" || value === undefined || (typeof value === "number" && Number.isNaN(value))) continue;
      const slotKey = pattern.slotKey(match);
      // pref/habit 用"槽位:值"做键：喜欢香菜和喜欢雨天是两条，互不覆盖
      const key = slotKey.startsWith("pref.") || slotKey === "life.habit" ? `${slotKey}:${String(value)}` : slotKey;
      fact = { slotKey: key, value, confidence: pattern.confidence };
      break;
    }

    const importance = importanceFrom(clause, fact !== null, emotion);
    const isLoop = OPEN_LOOP_RE.test(clause);

    if (fact !== null) {
      facts.push(fact);
      candidates.push({
        text: clause,
        kind: "semantic",
        slotKey: fact.slotKey,
        value: fact.value,
        importance,
        entities,
        ...(emotion === null ? {} : { emotion }),
        confidence: fact.confidence,
      });
    } else if (isLoop) {
      const topic = loopTopic(clause);
      loops.push({ topic: topic.length > 0 ? topic : clause, urgency: importance === "redline" ? 0.8 : 0.55 });
      candidates.push({
        text: clause,
        kind: "open_loop",
        importance,
        entities,
        ...(emotion === null ? {} : { emotion }),
        confidence: 0.7,
      });
    } else {
      if (clause.length < 4 && entities.length === 0) continue;
      candidates.push({
        text: clause,
        kind: "episodic",
        importance,
        entities,
        ...(emotion === null ? {} : { emotion }),
        confidence: 0.85,
      });
    }
  }

  return { candidates: dedupeCandidates(candidates), facts: dedupeFacts(facts), loops: dedupeLoops(loops) };
}

function dedupeFacts(facts: RuleFact[]): RuleFact[] {
  const bySlot = new Map<string, RuleFact>();
  for (const fact of facts) {
    const existing = bySlot.get(fact.slotKey);
    if (existing === undefined || fact.confidence > existing.confidence) bySlot.set(fact.slotKey, fact);
  }
  return [...bySlot.values()];
}

function dedupeLoops(loops: RuleLoop[]): RuleLoop[] {
  const byTopic = new Map<string, RuleLoop>();
  for (const loop of loops) {
    const key = normalizeForDedupe(loop.topic);
    if (key.length === 0) continue;
    const existing = byTopic.get(key);
    if (existing === undefined) byTopic.set(key, loop);
    else existing.urgency = Math.max(existing.urgency, loop.urgency);
  }
  return [...byTopic.values()];
}

// ─────────────────────── 第三级：内联 LLM ───────────────────────

interface LlmExtractionJson {
  memories?: Array<{ text?: unknown; kind?: unknown; importance?: unknown; slotKey?: unknown; value?: unknown }>;
  facts?: Array<{ slotKey?: unknown; value?: unknown; confidence?: unknown }>;
  open_loops?: unknown[];
}

const KINDS: ReadonlySet<string> = new Set<CandidateKind>(["episodic", "semantic", "open_loop"]);
const IMPORTANCES: ReadonlySet<string> = new Set<Importance>(["detail", "important", "redline"]);

export function parseLlmExtraction(raw: string, sourceText: string): RuleExtraction {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  let parsed: LlmExtractionJson;
  try {
    const value: unknown = JSON.parse(cleaned);
    if (typeof value !== "object" || value === null) return { candidates: [], facts: [], loops: [] };
    parsed = value as LlmExtractionJson;
  } catch {
    return { candidates: [], facts: [], loops: [] };
  }

  const candidates: MemoryCandidate[] = [];
  const facts: RuleFact[] = [];
  const loops: RuleLoop[] = [];

  for (const memory of parsed.memories ?? []) {
    const text = typeof memory.text === "string" ? memory.text.trim() : "";
    // 硬约束：模型只能复制原文，不能概括（草案 1.7）。不在原文里的直接丢弃。
    if (text.length === 0 || !sourceText.includes(text)) continue;
    const kind: CandidateKind =
      typeof memory.kind === "string" && KINDS.has(memory.kind) ? (memory.kind as CandidateKind) : "episodic";
    const importance =
      typeof memory.importance === "string" && IMPORTANCES.has(memory.importance)
        ? (memory.importance as Importance)
        : "detail";
    const emotion = detectEmotion(text);
    candidates.push({
      text,
      kind,
      importance,
      entities: extractEntities(text),
      ...(emotion === null ? {} : { emotion }),
      confidence: importance === "detail" ? 0.45 : 0.55,
      ...(kind === "semantic" && typeof memory.slotKey === "string" ? { slotKey: memory.slotKey } : {}),
      ...(kind === "semantic" && memory.value !== undefined ? { value: memory.value } : {}),
    });
    if (kind === "semantic" && typeof memory.slotKey === "string" && memory.value !== undefined) {
      facts.push({ slotKey: memory.slotKey, value: memory.value, confidence: 0.55 });
    }
    if (kind === "open_loop") {
      const topic = loopTopic(text);
      loops.push({ topic: topic.length > 0 ? topic : text, urgency: 0.5 });
    }
  }

  for (const fact of parsed.facts ?? []) {
    if (typeof fact.slotKey !== "string" || fact.slotKey.length === 0 || fact.value === undefined) continue;
    const key = fact.slotKey.startsWith("pref.") || fact.slotKey === "life.habit" ? `${fact.slotKey}:${String(fact.value)}` : fact.slotKey;
    const confidence = typeof fact.confidence === "number" ? Math.max(0.3, Math.min(0.8, fact.confidence)) : 0.55;
    facts.push({ slotKey: key, value: fact.value, confidence });
  }

  for (const topic of parsed.open_loops ?? []) {
    if (typeof topic !== "string") continue;
    const trimmed = topic.trim();
    if (trimmed.length === 0 || !sourceText.includes(trimmed)) continue;
    loops.push({ topic: loopTopic(trimmed) || trimmed, urgency: 0.5 });
  }

  return { candidates: dedupeCandidates(candidates), facts: dedupeFacts(facts), loops: dedupeLoops(loops) };
}

/**
 * 第三级：内联抽取。只对"规则没抽到东西"的文本跑——这是成本取舍：
 * 规则已覆盖约 70%（草案 1.7），全量再跑一遍 LLM 等于把每条闲聊都升级成付费调用。
 */
export async function llmExtract(llm: LlmPort, text: string): Promise<RuleExtraction> {
  if (!llm.isConfigured()) return { candidates: [], facts: [], loops: [] };
  const system = [
    "你是记忆抽取器。只输出一个 JSON 对象，不要解释、不要 markdown 代码块。",
    "规则：memories 里的 text 必须是原文中连续出现的一段（逐字复制，不许概括、不许改写）；",
    "无法逐字定位的信息不要输出。只抽取对长期关系有用的信息：事件、喜好、习惯、身份、承诺、未闭合话题。",
  ].join("\n");
  const user = [
    "原文：",
    text,
    "",
    "输出 JSON 结构：",
    '{"memories":[{"text":"原文片段","kind":"episodic|semantic|open_loop","importance":"detail|important|redline","slotKey":"可选","value":"可选"}],"facts":[{"slotKey":"如 pref.like:咖啡","value":"..."}],"open_loops":["原文片段"]}',
  ].join("\n");
  try {
    const result = await llm.generate({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      maxTokens: 600,
      json: true,
      purpose: "extract",
    });
    return parseLlmExtraction(result.text, text);
  } catch {
    // 抽取失败不能影响主流程：降级为"这一级没产出"
    return { candidates: [], facts: [], loops: [] };
  }
}

/** 合并三级结果：候选按文本去重，事实按槽位去重，话题按归一化文本去重。 */
export function mergeExtractions(sources: ReadonlyArray<RuleExtraction | null | undefined>): RuleExtraction {
  const all: RuleExtraction[] = [];
  for (const source of sources) if (source !== null && source !== undefined) all.push(source);
  return {
    candidates: dedupeCandidates(all.flatMap((item) => item.candidates)),
    facts: dedupeFacts(all.flatMap((item) => item.facts)),
    loops: dedupeLoops(all.flatMap((item) => item.loops)),
  };
}

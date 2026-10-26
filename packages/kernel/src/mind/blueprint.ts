/**
 * 人设文本 → 人格内核（草案 2 的参数投影 / 2.7 的 MBTI 步骤）。
 *
 * 两条路径，产出同一种草稿：
 *   1. 本地规则引擎（默认）：不花钱、离线可用、结果可复现。用户写的话里抠关键词，
 *      命中哪条就按那条给参数加减，命令行里能解释清"为什么是这个值"。
 *   2. 配了模型时：让模型按固定 JSON 结构推导，再用规则结果补缺、再用区间钳一遍。
 *      —— 模型只负责"读人设"，不许自己发明区间外的数字。
 *
 * 这里全部是纯函数（除了 compileWithLlm 需要 LlmPort），方便单测。
 */
import type {
  Persona,
  PersonaBlueprint,
  PersonaRationale,
  PersonaTraits,
} from "@anteros/shared";
import { DEFAULT_TRAITS } from "@anteros/shared";
import type { LlmPort } from "../contracts.js";
import { projectMbti } from "./traits.js";

/** 每个数值参数的合法区间：超出的值会被钳住并记进 clamped（草案 2.2）。 */
export const TRAIT_BOUNDS = {
  detailPref: { min: 0, max: 1 },
  warmth: { min: 0, max: 1 },
  initiative: { min: 0, max: 1 },
  humor: { min: 0, max: 1 },
  memoryD: { min: 0.3, max: 0.7 },
  memoryTau: { min: -6.5, max: -5.0 },
  memoryS: { min: 0.15, max: 0.4 },
  reconstructRho: { min: 0.1, max: 0.2 },
  emotionGain: { min: 1.0, max: 2.5 },
  delayMedianMs: { min: 1500, max: 12000 },
  delaySigma: { min: 0.3, max: 1.2 },
  burstMin: { min: 1, max: 3 },
  burstMax: { min: 1, max: 3 },
  typoRate: { min: 0, max: 0.1 },
} as const satisfies Record<string, { min: number; max: number }>;

export const TRAIT_LABELS: Record<string, string> = {
  detailPref: "细节敏感",
  warmth: "温度",
  initiative: "主动性",
  humor: "幽默",
  memoryD: "记忆衰减 d",
  memoryTau: "提取阈值 τ",
  memoryS: "回忆噪声 s",
  reconstructRho: "重构漂移 ρ",
  emotionGain: "情绪增益 γ",
  delayMedianMs: "打字延迟中位数",
  delaySigma: "延迟离散度 σ",
  burstMin: "最少条数",
  burstMax: "最多条数",
  typoRate: "错字率",
};

/** 一条规则：命中哪些词，给哪几个参数加多少，人话怎么说。 */
interface TraitRule {
  /** 正则（在中文原文上匹配） */
  pattern: RegExp;
  /** 命中的解释 */
  why: string;
  /** 对参数的增量（数值加法；memoryTau 这种负值区间直接给绝对值） */
  delta: Partial<PersonaTraits>;
}

const RULES: TraitRule[] = [
  {
    pattern: /记性(好|很好|特别好|不错)|过目不忘|记得住|细节控|记忆好/,
    why: "话里说了记性好 —— 衰减更慢、提取阈值更低、回忆噪声更小",
    delta: { memoryD: -0.12, memoryTau: -0.35, memoryS: -0.05, detailPref: 0.12 },
  },
  {
    pattern: /健忘|忘性(大|重)|记性(差|不好)|转头就忘|老是记不住/,
    why: "话里说了健忘 —— 衰减更快、阈值更高（要提示才想得起来）",
    delta: { memoryD: 0.12, memoryTau: 0.5, reconstructRho: 0.02 },
  },
  {
    pattern: /记混|记错|张冠李戴|大条|丢三落四/,
    why: "话里提过记混/大条 —— 重构漂移更大（会张冠李戴，但不瞎编事实）",
    delta: { reconstructRho: 0.035, typoRate: 0.004 },
  },
  {
    pattern: /情绪化|脾气(大|急|不好)|敏感|易怒|容易激动|爱生气|共情/,
    why: "情绪浓度高 —— 情绪增益 γ 上调，记得住感受",
    delta: { emotionGain: 0.45, warmth: 0.08 },
  },
  {
    pattern: /冷静|淡定|理性|情绪(稳定|平和)|不轻易/,
    why: "情绪淡 —— 情绪增益 γ 下调",
    delta: { emotionGain: -0.35 },
  },
  {
    pattern: /温柔|体贴|耐心|心软|照顾人|暖心/,
    why: "偏温柔 —— 温度上调",
    delta: { warmth: 0.22 },
  },
  {
    pattern: /冷淡|疏离|高冷|不热络|话不投机/,
    why: "偏冷淡 —— 温度下调、不主动热络",
    delta: { warmth: -0.18, initiative: -0.12 },
  },
  {
    pattern: /嘴硬|别扭|不承认|嘴硬心软/,
    why: "嘴硬心软 —— 表达上硬、底色不冷（温度不降，主动性略降）",
    delta: { initiative: -0.08, warmth: 0.05 },
  },
  {
    pattern: /主动|热情|话痨|爱聊|爱说话|自来熟/,
    why: "主动 —— 主动性上调",
    delta: { initiative: 0.25, warmth: 0.06 },
  },
  {
    pattern: /被动|慢热|不主动|怕生|内向/,
    why: "慢热 —— 主动性下调",
    delta: { initiative: -0.2 },
  },
  {
    pattern: /幽默|爱开玩笑|贫嘴|逗|段子/,
    why: "爱开玩笑 —— 幽默上调",
    delta: { humor: 0.25 },
  },
  {
    pattern: /严肃|一本正经|正经|不苟言笑/,
    why: "偏严肃 —— 幽默下调",
    delta: { humor: -0.2 },
  },
  {
    pattern: /细心|观察|注意细节|眼里有活|记得住别人随口/,
    why: "注意细节 —— 细节敏感上调",
    delta: { detailPref: 0.18 },
  },
  {
    pattern: /话少|寡言|惜字|不爱说话|沉默|两三句/,
    why: "话少 —— 一条一条说、句子短、气泡上限下调",
    delta: { burstMax: -1, burstMin: -0.4, delayMedianMs: 900 },
  },
  {
    pattern: /话多|健谈|说个没完|唠叨|爱发表情|语气词/,
    why: "话多 —— 气泡上限上调、句子可以长一点",
    delta: { burstMax: 0.8, delayMedianMs: -600 },
  },
  {
    pattern: /秒回|回得快|手机不离手|随时在线/,
    why: "回得快 —— 打字延迟中位数下调",
    delta: { delayMedianMs: -1800 },
  },
  {
    pattern: /回得慢|不常看手机|夜班|忙|倒时差|很少在线/,
    why: "回得慢/作息偏 —— 打字延迟中位数上调",
    delta: { delayMedianMs: 2200 },
  },
  {
    pattern: /马虎|手快|打错字|错别字|不太检查/,
    why: "手快马虎 —— 错字率上调",
    delta: { typoRate: 0.012 },
  },
  {
    pattern: /严谨|一丝不苟|字斟句酌|措辞讲究/,
    why: "措辞讲究 —— 错字率下调",
    delta: { typoRate: -0.008 },
  },
];

const CITY_PATTERN =
  /(北京|上海|广州|深圳|杭州|成都|重庆|长沙|西安|南京|武汉|苏州|天津|青岛|厦门|昆明|合肥|郑州|沈阳|大连|福州|南昌|济南|哈尔滨|长春|石家庄|太原|南宁|贵阳|兰州|海口|乌鲁木齐|呼和浩特|银川|西宁|拉萨|香港|澳门|台北|宁波|无锡|佛山|东莞|珠海|泉州|温州|常州|南通|徐州)/;

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function clampNumber(key: keyof typeof TRAIT_BOUNDS, value: number, clamped: string[]): number {
  const bounds = TRAIT_BOUNDS[key];
  if (!Number.isFinite(value)) return DEFAULT_TRAITS[key];
  const rounded = key === "delayMedianMs" ? Math.round(value) : Number(value.toFixed(3));
  if (rounded < bounds.min) {
    clamped.push(`${TRAIT_LABELS[key] ?? key} ${rounded} 低于下限 ${bounds.min}，按 ${bounds.min} 计`);
    return bounds.min;
  }
  if (rounded > bounds.max) {
    clamped.push(`${TRAIT_LABELS[key] ?? key} ${rounded} 高于上限 ${bounds.max}，按 ${bounds.max} 计`);
    return bounds.max;
  }
  return rounded;
}

/** 把一组 traits 钳进区间，同时保证 burstMin ≤ burstMax。 */
export function clampTraits(input: Partial<PersonaTraits>, clamped: string[] = []): PersonaTraits {
  const merged: PersonaTraits = { ...DEFAULT_TRAITS, ...input };
  const numericKeys = Object.keys(TRAIT_BOUNDS) as Array<keyof typeof TRAIT_BOUNDS>;
  for (const key of numericKeys) {
    merged[key] = clampNumber(key, Number(merged[key]), clamped);
  }
  if (merged.burstMin > merged.burstMax) {
    clamped.push("最少条数大于最多条数，已把最少条数压到最多条数");
    merged.burstMin = merged.burstMax;
  }
  return merged;
}

function splitPhrases(text: string): string[] {
  return text
    .split(/[。！？!?；;\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function unique(items: string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= limit) break;
  }
  return result;
}

function extractName(text: string): string | null {
  const match = /(?:名字|叫)[是：:\s]*([\u4e00-\u9fa5A-Za-z]{1,8})/.exec(text);
  if (match?.[1] === undefined) return null;
  const candidate = match[1].replace(/(?:，|,|。|的|是|今年|现在).*$/, "");
  return candidate.length > 0 && candidate.length <= 8 ? candidate : null;
}

function extractAge(text: string): number | null {
  const digit = /(\d{1,2})\s*(?:岁|周岁)/.exec(text);
  if (digit?.[1] !== undefined) {
    const age = Number(digit[1]);
    if (age >= 14 && age <= 60) return age;
  }
  const cn = /([一二两三四五六七八九十]{1,2})\s*(?:十)?\s*(?:岁|出头)/.exec(text);
  if (cn?.[1] !== undefined) {
    const raw = cn[1];
    if (raw === "十") return 10;
    const value = CN_NUM[raw[0] ?? ""];
    if (value !== undefined) return value * 10 > 60 ? value : value + 10;
  }
  return null;
}

function extractInterests(text: string): string[] {
  const found: string[] = [];
  const likePattern = /(?:喜欢|爱|常(?:常)?去|平时(?:爱|喜欢)?|迷上了|最近在)([^。！？!?；;，,]{2,20})/g;
  for (const match of text.matchAll(likePattern)) {
    const raw = match[1] ?? "";
    for (const piece of raw.split(/[、和跟与及]/)) {
      const item = piece.trim().replace(/^(?:吃|看|听|玩|做|喝|逛|养|读)/, "");
      if (item.length >= 2 && item.length <= 12) found.push(item);
    }
  }
  return unique(found, 8);
}

function extractHabits(text: string): string[] {
  const quoted = [...text.matchAll(/[“"「『]([^”"」』]{1,12})[”"」』]/g)].map((match) => (match[1] ?? "").trim());
  const says = [...text.matchAll(/口头禅(?:是|：|:)\s*([^。！？!?；;，,]{1,12})/g)].map((match) => (match[1] ?? "").trim());
  const cleaned = [...quoted, ...says]
    .map((item) => stripQuotes(item))
    .filter((item) => item.length > 0);
  return unique(cleaned, 6);
}

/** 同一个口头禅常被引号包两次（`"算了算了"`），入内核前统一去掉包裹的引号再去重。 */
function stripQuotes(text: string): string {
  return text.replace(/^[“"「『]+/, "").replace(/[”"」』]+$/, "").trim();
}

function extractValues(text: string): string[] {
  const values: string[] = [];
  for (const phrase of splitPhrases(text)) {
    if (/^(?:不|别|不许|从不|最怕|讨厌|受不了|看不惯)/.test(phrase)) continue;
    if (/(?:看重|在意|觉得.*重要|原则|底线|从不骗|守时|算数|答应)/.test(phrase) && phrase.length <= 24) {
      values.push(phrase);
    }
  }
  return unique(values, 5);
}

function extractTaboo(text: string): string[] {
  const taboo: string[] = [];
  for (const phrase of splitPhrases(text)) {
    if (/^(?:不|别|不许|讨厌|最怕|受不了|看不惯|拒绝)/.test(phrase) && phrase.length <= 24) {
      taboo.push(phrase);
    }
  }
  return unique(taboo, 5);
}

function speechFromText(text: string): Persona["speechStyle"] {
  const expressive = /[！!]|哈哈|呵呵|语气词|感叹|活泼|俏皮/.test(text);
  const concise = /话少|话不多|寡言|惜字|沉默|冷淡|两三句|简短|不太说话|不爱说话/.test(text);
  const chatty = /话多|健谈|唠叨|说个没完/.test(text);
  return {
    habits: [],
    punctuation: expressive ? "expressive" : concise ? "minimal" : "normal",
    sentenceLength: concise ? "short" : chatty ? "long" : "medium",
  };
}

/**
 * 规则引擎：把一段人设文本变成可解释的内核草稿。
 *
 * 只做"读用户写的话"，不做自由发挥：没写到的参数保持默认，并在 rationale 里
 * 标明"没有提到，用默认值"——用户看得见哪些是他写的、哪些是系统补的。
 */
export function deriveBlueprintFromText(text: string, current: Persona): PersonaBlueprint {
  const sourceText = text.trim().slice(0, 4000);
  const clamped: string[] = [];
  const warnings: string[] = [];
  const rationale: PersonaRationale[] = [];

  const traits: PersonaTraits = { ...current.traits };
  const hitKeys = new Set<keyof PersonaTraits>();

  for (const rule of RULES) {
    if (!rule.pattern.test(sourceText)) continue;
    for (const [key, delta] of Object.entries(rule.delta) as Array<[keyof PersonaTraits, number]>) {
      if (hitKeys.has(key)) continue;
      const value = Number(traits[key]) + delta;
      (traits as unknown as Record<string, number>)[key] = value;
      hitKeys.add(key);
    }
    rationale.push({
      key: "rules",
      label: rule.pattern.source.slice(0, 18),
      value: rule.why,
      why: rule.why,
    });
  }

  // MBTI 只做投影，不进 prompt（草案 2.7）
  const mbti = /\b([EI][SN][TF][JP])\b/i.exec(sourceText)?.[1]?.toUpperCase();
  if (mbti !== undefined) {
    Object.assign(traits, projectMbti(mbti), { mbti });
    hitKeys.add("mbti" as keyof PersonaTraits);
    rationale.push({ key: "mbti", label: "MBTI", value: mbti, why: `人设里写了 ${mbti}，按草案 2.7 只投影成参数先验，不进 prompt` });
  }

  const clampedTraits = clampTraits(traits, clamped);

  for (const key of Object.keys(TRAIT_BOUNDS) as Array<keyof typeof TRAIT_BOUNDS>) {
    if (!hitKeys.has(key)) continue;
    rationale.push({
      key,
      label: TRAIT_LABELS[key] ?? key,
      value: String(clampedTraits[key]),
      why: "命中人设关键词后按规则调整",
    });
  }

  const name = extractName(sourceText) ?? current.name;
  const city = CITY_PATTERN.exec(sourceText)?.[1] ?? current.city;
  const ageYears = extractAge(sourceText);
  const interests = extractInterests(sourceText);
  const speechStyle = speechFromText(sourceText);
  speechStyle.habits = extractHabits(sourceText);
  if (speechStyle.habits.length === 0) speechStyle.habits = current.speechStyle.habits.slice(0, 6);

  const values = extractValues(sourceText);
  const taboo = extractTaboo(sourceText);
  if (values.length === 0) warnings.push("没从人设里读出价值观，先沿用原设定；想让它成为行为准则就写一句「她在意…」");
  if (interests.length === 0) warnings.push("没读出具体兴趣；兴趣会影响主动分享的理由池，可以补一句「喜欢…」");
  if (sourceText.length < 12) warnings.push("人设太短，参数基本还是默认值——写得越具体，像得越具体");

  const background = sourceText.length > 0 ? sourceText : current.immutable.background;

  return {
    sourceText,
    engine: "rules",
    name,
    city,
    ageYears,
    interests: interests.length > 0 ? interests : current.interests,
    background,
    values: values.length > 0 ? values : current.immutable.values,
    habits: speechStyle.habits,
    speechStyle,
    traits: clampedTraits,
    rationale,
    clamped,
    warnings,
  };
}

/** 给模型的编译 prompt：只许读人设、按结构输出，不许自创区间外的数。 */
export function blueprintPrompt(text: string, current: Persona): { system: string; user: string } {
  const system = [
    "你在把人写的一段人设描述，翻译成一个聊天智能体的「人格参数」。",
    "规则：",
    "1. 只依据用户写的文字，不补充用户没写的事实；宁可留空也不要编。",
    "2. 所有数值必须落在给定区间内，越界会被系统钳住。",
    "3. 口头禅只能从原文里摘取（引号里的话），不许你生成。",
    "4. 只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。",
    "",
    "JSON 结构：",
    "{",
    '  "name": string, "city": string, "ageYears": number|null,',
    '  "background": string, "interests": string[], "values": string[], "habits": string[],',
    '  "punctuation": "minimal"|"normal"|"expressive", "sentenceLength": "short"|"medium"|"long",',
    '  "traits": {',
    '    "detailPref": 0-1, "warmth": 0-1, "initiative": 0-1, "humor": 0-1,',
    '    "memoryD": 0.3-0.7, "memoryTau": -6.5--5.0, "memoryS": 0.15-0.4,',
    '    "reconstructRho": 0.1-0.2, "emotionGain": 1.0-2.5,',
    '    "delayMedianMs": 1500-12000, "delaySigma": 0.3-1.2,',
    '    "burstMin": 1-3, "burstMax": 1-3, "typoRate": 0-0.1, "mbti": string|null',
    "  },",
    '  "rationale": [{"key": string, "label": string, "value": string, "why": string}]',
    "}",
    "",
    "参数含义：memoryD 越大越健忘；memoryTau 越接近 -5 越需要提示才想得起来；",
    "memoryS 越大回忆越随机；reconstructRho 越大越会记混细节；emotionGain 越大情绪越浓；",
    "delayMedianMs 是打字延迟中位数；burstMin/burstMax 是每次回复拆成几条。",
  ].join("\n");

  const user = [
    "用户写的人设：",
    text.trim().slice(0, 4000),
    "",
    `当前人格（没写到的部分可以沿用）：${JSON.stringify({ name: current.name, city: current.city, interests: current.interests })}`,
  ].join("\n");

  return { system, user };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? unique(value.filter((item): item is string => typeof item === "string"), limit)
    : [];
}

/** 解析模型输出：字段缺失/类型不对就落到规则结果上，绝不因为一处坏字段整体失败。 */
export function parseLlmBlueprint(raw: string, fallback: PersonaBlueprint, model: string): PersonaBlueprint {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { ...fallback, warnings: [...fallback.warnings, `模型输出不是 JSON（${model}），已退回本地规则`] };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = asRecord(JSON.parse(raw.slice(start, end + 1)) as unknown);
  } catch {
    return { ...fallback, warnings: [...fallback.warnings, `模型输出解析失败（${model}），已退回本地规则`] };
  }

  const clamped: string[] = [];
  const traitsRaw = asRecord(parsed["traits"]);
  const merged: Partial<PersonaTraits> = { ...fallback.traits };
  for (const key of Object.keys(TRAIT_BOUNDS) as Array<keyof typeof TRAIT_BOUNDS>) {
    const value = traitsRaw[key];
    if (typeof value === "number" && Number.isFinite(value)) merged[key] = value;
  }
  const mbtiRaw = traitsRaw["mbti"];
  if (typeof mbtiRaw === "string" && /^[EI][SN][TF][JP]$/i.test(mbtiRaw)) {
    Object.assign(merged, projectMbti(mbtiRaw.toUpperCase()), { mbti: mbtiRaw.toUpperCase() });
  } else if (mbtiRaw === null) {
    merged.mbti = null;
  }
  const traits = clampTraits(merged, clamped);

  const punctuationRaw = parsed["punctuation"];
  const lengthRaw = parsed["sentenceLength"];
  const punctuation =
    punctuationRaw === "minimal" || punctuationRaw === "normal" || punctuationRaw === "expressive"
      ? punctuationRaw
      : fallback.speechStyle.punctuation;
  const sentenceLength =
    lengthRaw === "short" || lengthRaw === "medium" || lengthRaw === "long" ? lengthRaw : fallback.speechStyle.sentenceLength;

  const habits = asStringArray(parsed["habits"], 6);
  const rationale: PersonaRationale[] = [];
  const rawRationale = parsed["rationale"];
  if (Array.isArray(rawRationale)) {
    for (const item of rawRationale.slice(0, 20)) {
      const record = asRecord(item);
      const key = record["key"];
      const label = record["label"];
      const value = record["value"];
      const why = record["why"];
      if (typeof key === "string" && typeof label === "string" && typeof value === "string" && typeof why === "string") {
        rationale.push({ key, label, value, why });
      }
    }
  }

  const ageRaw = parsed["ageYears"];
  const ageYears = typeof ageRaw === "number" && ageRaw >= 14 && ageRaw <= 60 ? Math.round(ageRaw) : fallback.ageYears;
  const backgroundRaw = parsed["background"];

  return {
    sourceText: fallback.sourceText,
    engine: "llm",
    name: typeof parsed["name"] === "string" && parsed["name"].length > 0 ? parsed["name"].slice(0, 24) : fallback.name,
    city: typeof parsed["city"] === "string" && parsed["city"].length > 0 ? parsed["city"].slice(0, 24) : fallback.city,
    ageYears,
    interests: asStringArray(parsed["interests"], 8).length > 0 ? asStringArray(parsed["interests"], 8) : fallback.interests,
    background: typeof backgroundRaw === "string" && backgroundRaw.length > 0 ? backgroundRaw.slice(0, 1200) : fallback.background,
    values: asStringArray(parsed["values"], 5).length > 0 ? asStringArray(parsed["values"], 5) : fallback.values,
    habits: habits.length > 0 ? habits : fallback.habits,
    speechStyle: { habits: habits.length > 0 ? habits : fallback.speechStyle.habits, punctuation, sentenceLength },
    traits,
    rationale: rationale.length > 0 ? rationale : fallback.rationale,
    clamped,
    warnings: fallback.warnings.filter((warning) => !warning.startsWith("模型输出")),
  };
}

/**
 * 编译入口：配了模型就走模型，失败了退回规则引擎；没配模型直接规则引擎。
 * 返回值里带 usage，调用方（App）负责记成本。
 */
export async function compileBlueprint(
  text: string,
  current: Persona,
  llm: LlmPort | null,
  log: { warn: (message: string) => void },
): Promise<{ blueprint: PersonaBlueprint; usage: { model: string; inputTokens: number; outputTokens: number } | null }> {
  const fallback = deriveBlueprintFromText(text, current);
  if (llm === null || !llm.isConfigured()) {
    return { blueprint: fallback, usage: null };
  }

  try {
    const prompt = blueprintPrompt(text, current);
    const result = await llm.generate({
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      temperature: 0.3,
      maxTokens: 900,
      json: true,
      purpose: "persona",
    });
    return {
      blueprint: parseLlmBlueprint(result.text, fallback, result.model),
      usage: { model: result.model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
    };
  } catch (error) {
    log.warn(`persona compile 调用模型失败，退回规则引擎：${error instanceof Error ? error.message : String(error)}`);
    return {
      blueprint: { ...fallback, warnings: [...fallback.warnings, "模型调用失败，这次是本地规则引擎算的"] },
      usage: null,
    };
  }
}

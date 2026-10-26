/**
 * core.memory-extract —— 规则版记忆抽取。
 *
 * 定位：便宜、可解释、无外部依赖的第一道筛子。把对话文本抽成**候选**记忆交给内核，
 * 由内核决定去重、合并、是否落库。本插件：
 * - 不写数据库（无此能力），尤其**不写人设记忆**（memory_persona 属于用户/内核）；
 * - 不调用任何模型；规则宁少勿滥，每条候选都带来源句与 confidence；
 * - 不编造：规则没命中就不产出候选，交给内核的兜底路径。
 *
 * 规则覆盖：时间、数字、人名、承诺句式、否定、情绪词、未闭合话题
 * （改天/下次/回头/还没/晚点/……）。
 */
import { createPlugin, fail } from "../_sdk/plugin-runtime.mjs";

const MAX_TEXT_CHARS = 4_000;
const MAX_CANDIDATE_CHARS = 500;

const TIME_WORDS = [
  "今天", "明天", "后天", "昨天", "前天", "本周", "这周", "下周", "上周", "本月", "下个月", "上个月",
  "今年", "明年", "去年", "周一", "周二", "周三", "周四", "周五", "周六", "周日", "周一", "周末",
  "星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日", "星期天",
  "早上", "上午", "中午", "下午", "晚上", "凌晨", "半夜", "刚才", "待会", "月底", "年底", "年初",
];
const TIME_PATTERNS = [
  /\d{1,2}月\d{1,2}[日号]/,
  /\d{1,2}[:：]\d{2}/,
  /\d{4}年/,
  /[前后]天/,
];

const COMMIT_PATTERNS = [
  /我(?:会|一定|保证|答应|尽量|争取|打算|准备|改天|下次|回头|以后|晚点|稍后)/,
  /(?:承诺|说好|约好|答应你|一言为定)/,
  /(?:改天|下次|回头|以后|晚点|稍后|等我|有空|找时间|再说|待会|还没|没来得及)/,
];
const OPEN_LOOP_RE = /(改天|下次|回头|以后|晚点|稍后|等我|有空|找时间|再说|待会|还没|没来得及|还没来得及)/;

const NEGATION_RE = /(不|没|别|从未|没有|不想|不会|不能|不再|从不)/;
const FACT_PATTERNS = [
  /我(?:是|住在|在|有|养了|在做|喜欢|不喜欢|讨厌|习惯|每天|通常|一般|生日|工作|职业|爱好|家人|朋友)/,
  /我的(?:生日|工作|职业|爱好|家人|朋友|名字|年龄|家乡)/,
  /(?:我今年|我今年|我昨天|我今天|我住在|我在)/,
];
const NUMBER_RE = /\d+(?:\.\d+)?\s*(?:分钟|小时|天|周|个?月|年|次|岁|块钱?|元|公里|千米|kg|公斤|斤|%|点|杯|份|个|本|部|首)/g;
const EVENT_VERB_RE = /(去|来|到|吃|喝|见|聊|买|卖|做|看|听|开|关|结束|开始|发生|参加|加班|出差|搬家|生病|住院|考试|面试|旅行|结婚|分手|出生|去世)/;
const CLAUSE_SPLIT_RE = /(?<=[。！？!?；;])\s*|\n+/;

const EMOTION_RULES = [
  { words: ["开心", "高兴", "愉快", "兴奋", "激动", "幸福", "满意", "欣慰"], v: 0.8, a: 0.6, label: "开心" },
  { words: ["难过", "伤心", "失落", "委屈", "想哭", "沮丧", "绝望"], v: -0.8, a: 0.3, label: "难过" },
  { words: ["生气", "愤怒", "火大", "烦躁", "恼火", "受不了"], v: -0.7, a: 0.8, label: "生气" },
  { words: ["害怕", "担心", "焦虑", "紧张", "不安", "恐慌"], v: -0.6, a: 0.7, label: "焦虑" },
  { words: ["累", "疲惫", "困", "乏力"], v: -0.4, a: -0.3, label: "疲惫" },
  { words: ["喜欢", "爱", "在意", "心疼", "想念"], v: 0.7, a: 0.4, label: "喜欢" },
];

const NAME_PATTERNS = [
  /(?:我叫|我的名字是|叫我)([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9]{0,9})/g,
  /(?:跟|和|对|给|向|陪)([\u4e00-\u9fa5]{2,3})(?:说|讲|聊|发|提到|约)/g,
  /@([A-Za-z0-9_\u4e00-\u9fa5-]{1,20})/g,
];

function normalize(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function splitClauses(text) {
  return text
    .split(CLAUSE_SPLIT_RE)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length >= 4 && clause.length <= MAX_CANDIDATE_CHARS);
}

function collectMatches(text, patterns) {
  const hits = [];
  for (const pattern of patterns) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const re = new RegExp(pattern.source, flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      hits.push(match[0]);
      if (match.index === re.lastIndex) re.lastIndex += 1; // 防零宽死循环
    }
  }
  return hits;
}

function extractEntities(text) {
  const entities = new Set();
  for (const pattern of NAME_PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const re = new RegExp(pattern.source, flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      const name = (match[1] ?? "").trim();
      // 过滤太像普通词的结果（"跟他说" 的 "他" 只有 1 字，已被 {2,3} 排除）
      if (name.length >= 2 && !["时候", "他们", "自己", "别人", "大家", "什么"].includes(name)) {
        entities.add(name);
      }
      if (match.index === re.lastIndex) re.lastIndex += 1;
    }
  }
  return [...entities].slice(0, 8);
}

function detectEmotion(text) {
  for (const rule of EMOTION_RULES) {
    const hit = rule.words.find((word) => text.includes(word));
    if (hit) return { v: rule.v, a: rule.a, label: rule.label };
  }
  return undefined;
}

function detectTime(text) {
  const word = TIME_WORDS.find((candidate) => text.includes(candidate));
  if (word) return word;
  for (const pattern of TIME_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return undefined;
}

function detectCommitment(text) {
  for (const pattern of COMMIT_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

function detectOpenLoop(text) {
  const match = text.match(OPEN_LOOP_RE);
  return match ? match[0] : undefined;
}

function detectNumbers(text) {
  const numbers = [];
  NUMBER_RE.lastIndex = 0;
  let match;
  while ((match = NUMBER_RE.exec(text)) !== null) {
    numbers.push(match[0].trim());
    if (match.index === NUMBER_RE.lastIndex) NUMBER_RE.lastIndex += 1;
  }
  return numbers;
}

function detectFact(text) {
  return FACT_PATTERNS.some((pattern) => pattern.test(text));
}

function clampConfidence(value) {
  return Math.round(Math.min(0.9, Math.max(0.3, value)) * 100) / 100;
}

/** 从单条文本里抽候选（纯函数，便于测试）。 */
function extractFromText(text, options = {}) {
  const minConfidence = options.minConfidence ?? 0.35;
  const maxCandidatesPerText = options.maxCandidatesPerText ?? 8;
  const candidates = [];
  const seen = new Set();

  const push = (candidate) => {
    const key = `${candidate.kind}|${candidate.text}`;
    if (seen.has(key)) return;
    if (candidate.confidence < minConfidence) return;
    if (candidates.length >= maxCandidatesPerText) return;
    seen.add(key);
    candidates.push(candidate);
  };

  for (const clause of splitClauses(text)) {
    const emotion = detectEmotion(clause);
    const time = detectTime(clause);
    const openLoop = detectOpenLoop(clause);
    const commitment = detectCommitment(clause);
    const numbers = detectNumbers(clause);
    const fact = detectFact(clause);
    const negated = NEGATION_RE.test(clause);
    const event = time && EVENT_VERB_RE.test(clause);
    const entities = extractEntities(clause);

    // 1) 未闭合话题 / 承诺：最高优先级，内核可以据此生成主动跟进。
    if (openLoop || commitment) {
      const slotKey = `open_loop:${openLoop ?? "promise"}:${entities[0] ?? "general"}`;
      push({
        text: clause,
        kind: "open_loop",
        slotKey,
        value: clause,
        importance: "important",
        entities,
        confidence: clampConfidence(openLoop ? 0.72 : 0.62),
        ...(emotion ? { emotion: { v: emotion.v, a: emotion.a } } : {}),
      });
      continue; // 一句话只产出最有价值的一类候选，避免重复
    }

    // 2) 有明确时间/情绪/事件 → 情节记忆
    if (event || (time && emotion)) {
      push({
        text: clause,
        kind: "episodic",
        importance: emotion || time === "今天" || time === "昨天" ? "important" : "detail",
        entities,
        confidence: clampConfidence(event ? 0.68 : 0.6),
        ...(emotion ? { emotion: { v: emotion.v, a: emotion.a } } : {}),
      });
      continue;
    }

    // 3) 结构事实（数字/自我陈述/否定）
    if (numbers.length > 0 || fact) {
      push({
        text: clause,
        kind: "semantic",
        importance: negated || numbers.length > 0 ? "important" : "detail",
        entities,
        confidence: clampConfidence(fact ? 0.62 : 0.55),
        ...(numbers.length > 0 ? { value: numbers.join("、") } : {}),
      });
      continue;
    }

    // 4) 纯情绪表达也值得记一笔（但只是 detail，不升级为事实）
    if (emotion) {
      push({
        text: clause,
        kind: "episodic",
        importance: "detail",
        entities,
        emotion: { v: emotion.v, a: emotion.a },
        confidence: 0.5,
      });
    }
    // 注意：没有命中任何规则 → 不产出候选。宁可漏，不可编。
  }

  return candidates;
}

function validateParams(params) {
  const texts = params?.texts;
  if (!Array.isArray(texts)) throw fail("EINVALID", "plugin.extract.memory 需要 texts 数组");
  if (texts.length > 500) throw fail("EINVALID", "单批 texts 不能超过 500 条");
  return texts.map((item, index) => {
    if (!item || typeof item !== "object") throw fail("EINVALID", `texts[${index}] 不是对象`);
    if (typeof item.id !== "string" || item.id.length === 0) throw fail("EINVALID", `texts[${index}].id 必须是非空字符串`);
    if (typeof item.text !== "string") throw fail("EINVALID", `texts[${index}].text 必须是字符串`);
    const text = item.text.slice(0, MAX_TEXT_CHARS);
    const ts = typeof item.ts === "number" && Number.isFinite(item.ts) ? item.ts : Date.now();
    return { id: item.id, text: normalize(text), ts };
  });
}

const runtime = createPlugin({
  id: "core.memory-extract",
  capabilities: ["extract.memory"],
  handlers: {
    "plugin.health.check": () => ({
      ok: true,
      status: "ok",
      message: "规则抽取可用（时间/数字/人名/承诺/否定/情绪/未闭合话题），只产出候选、不写库",
    }),
    "plugin.extract.memory": (params) => {
      const items = validateParams(params);
      const maxCandidates = 200;
      const candidates = [];
      for (const item of items) {
        for (const candidate of extractFromText(item.text)) {
          if (candidates.length >= maxCandidates) break;
          candidates.push(candidate);
        }
        if (candidates.length >= maxCandidates) break;
      }
      // 只返回候选；不包含任何写库动作，也不包含人设字段。
      return { candidates };
    },
  },
  onReady(_info, ctx) {
    ctx.log("规则记忆抽取就绪（不写库、不覆盖人设记忆）");
  },
});

// 导出纯函数供测试/调试；不影响运行时。
export const _test = { extractFromText, splitClauses, extractEntities, detectEmotion, detectTime };
export const stats = () => runtime.stats();

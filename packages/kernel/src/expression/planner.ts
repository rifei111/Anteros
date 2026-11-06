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
import { polishPunctuation } from "./punctuation.js";

export const MAX_PART_CHARS = 32;
// 条数上限：用户 2026-10-31 明确要求「上限 20 条」——3 条、6 条都会被长回复撑破。
// 每条仍 ≤32 字；条数按「这段字装得下几条」算，最多 20 条。
export const MAX_PARTS = 20;

/**
 * 延迟按在场的区间（毫秒，草案 4.3）：先按 presence 缩放对数正态中位数，再 clamp。
 * 说明：内核 turn 模型里"回复前的等待"被折叠进 typing + delay_after（chat.ts
 * 先 typing 再发下一条），所以 delay_after 同时承担"在场节奏"；取值区间用
 * 草案 4.3 的在场调制范围（phone 0.5–2s / idle 3–20s / busy 先短确认 /
 * away、sleep 1–60min），不是一个固定常量。
 */
export const PRESENCE_DELAY_RANGE: Record<PresenceState, readonly [number, number]> = {
  phone_in_hand: [500, 2000],
  idle: [3000, 20_000],
  busy: [800, 4000],
  sleep: [60_000, 3_600_000],
  away: [60_000, 3_600_000],
};

/** 在场对延迟中位数的缩放（手机在手最快；睡眠/不在最慢）。 */
export const PRESENCE_MEDIAN_FACTOR: Record<PresenceState, number> = {
  phone_in_hand: 0.3,
  idle: 1,
  busy: 0.25,
  sleep: 15,
  away: 12,
};

/** 切句保留标点：句号问号跟着前一句走，后面就不用再"猜"该补什么。 */
const SENTENCE_SPLIT = /(?<=[。！？!?；;])/;
/** 切完句号后，若紧跟收尾符号（引号/括号），别把它单独切成一条。 */
const TRAILING_CLOSERS = /^[”’）】」』》〉\])>]+$/;
const CLAUSE_SPLIT = /(?<=[，,、：:])/;

/**
 * 历史里我们给语音条加的前缀（「（我刚用语音说的）」这类）。
 * 模型会照抄——它看到什么就学什么——所以发出去之前必须剥掉：
 * 这句话是给它的标注，不是它要说的话。
 */
const VOICE_HISTORY_ECHO = /^[ \t\u3000]*[（(][^（）()\n]{0,14}用语音说[的过][）)][ \t\u3000]*/gm;

export function cleanReplyText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(VOICE_HISTORY_ECHO, "")
    .replace(/^[「『"“]\s*/, "")
    .replace(/\s*[」』"”]$/, "")
    .replace(/[*#`>]+/g, "")
    // 行首的项目符号/短横：模型常把每句话写成 "- 嗯" 这样
    .replace(/^[ \t\u3000]*[-–—•·]\s*/gm, "")
    .replace(/[ \t\u3000]+/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** 句尾语气词：在这些字后面断开，读起来最像正常换气。 */
const TAIL_PARTICLES = "呀嘛呢吧啊哦啦哈捏呗喔唉";

/** 句首连接词：切在它们前面，前后各自完整。 */
const HEAD_CONNECTORS = ["但是", "不过", "可是", "然后", "所以", "因为", "而且", "其实", "只是", "还有", "反正", "总之", "要不然", "还是说", "要是", "如果", "虽然", "而且"];

/**
 * 一段没有任何标点的长串切成长度 ≤ size 的几截。
 * 断点优先级：标点 → 语气词后 → 连接词前 → 不是数字/字母中间 → 硬切。
 * 注意：这里只负责"切在哪"，**不补任何标点**（补标点会把半句话读成结巴）。
 */
export function hardWrap(text: string, size = MAX_PART_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const cut = bestBreakPoint(rest, size);
    const head = rest.slice(0, cut).trim();
    if (head.length > 0) chunks.push(head);
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks.filter((chunk) => chunk.length > 0);
}

/** 在 [size/2, size] 里找一个最像"该停一下"的位置。 */
function bestBreakPoint(text: string, size: number): number {
  const floor = Math.max(4, Math.floor(size * 0.5));
  const window = text.slice(0, size);

  // ① 标点：最后一个标点之后就断开（标点留在前一段，读起来完整）
  for (let index = window.length - 1; index >= floor; index -= 1) {
    if (/[，。！？、；：,.!?;:~～…]/.test(window[index] ?? "")) return index + 1;
  }

  // ② 语气词之后
  for (let index = window.length - 1; index >= floor; index -= 1) {
    if (TAIL_PARTICLES.includes(window[index] ?? "")) return index + 1;
  }

  // ③ 连接词之前
  let connectorAt = -1;
  for (const connector of HEAD_CONNECTORS) {
    const at = window.lastIndexOf(connector);
    if (at >= floor && at > connectorAt) connectorAt = at;
  }
  if (connectorAt > 0) return connectorAt;

  // ④ 不要把英文单词或数字切成两半
  const alnum = /[A-Za-z0-9]/;
  for (let index = window.length; index > floor; index -= 1) {
    const before = window[index - 1] ?? "";
    const after = text[index] ?? "";
    if (alnum.test(before) && alnum.test(after)) continue;
    return index;
  }

  return size;
}

/** 按标点切成"可以独立成条"的语义块，每块 ≤25 字。 */
export function semanticChunks(text: string, size: number = MAX_PART_CHARS): string[] {
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
        chunks.push(...hardWrap(clause, size));
        continue;
      }
      const candidate = buffer.length === 0 ? clause : `${buffer}，${clause}`;
      if (candidate.length > MAX_PART_CHARS) {
        if (buffer.length > 0) chunks.push(buffer);
        buffer = clause;
      } else {
        buffer = candidate;
      }
    }
    if (buffer.length > 0) chunks.push(buffer);
  }
  return chunks;
}

/**
 * 条数上限：短回复 1 条；长回复按「装得下几条」算，最多 20 条。
 * burst 是性格上的话多话少（burst ≤ 1 表示明确只要一条，比如主动消息），不是硬天花板。
 */
export function maxPartsFor(textLength: number, burstMax: number): number {
  const burst = Math.min(MAX_PARTS, Math.max(1, Math.round(burstMax)));
  if (burst <= 1) return 1;
  if (textLength <= 12) return 1;
  if (textLength <= 40) return Math.min(2, burst);
  // 每条最多 MAX_PART_CHARS 字：长回复按装得下的条数切，别把六句话挤成三条。
  const byLength = Math.ceil(textLength / MAX_PART_CHARS);
  return Math.min(MAX_PARTS, Math.max(burst, byLength));
}

/** 把收尾符号（引号/括号）挂回前一条，别让「）」单独成一条。 */
export function attachTrailingClosers(chunks: string[]): string[] {
  const out: string[] = [];
  for (const chunk of chunks) {
    if (out.length > 0 && chunk.length > 0 && TRAILING_CLOSERS.test(chunk)) {
      out[out.length - 1] = `${out[out.length - 1] ?? ""}${chunk}`;
    } else if (chunk.length > 0) {
      out.push(chunk);
    }
  }
  return out;
}

/** 把语义块装进 1–20 条，每条 ≤32 字；只在块的接缝处合并，绝不切词。 */
export function splitIntoParts(raw: string, burstMax: number): string[] {
  const text = cleanReplyText(raw);
  if (text.length === 0) return [""];
  const size = MAX_PART_CHARS;
  const burst = Math.min(MAX_PARTS, Math.max(1, Math.round(burstMax)));
  // burst ≤ 1 = 明确只要一条（主动消息、某些人格）
  if (burst <= 1) return [polishPunctuation(text.replace(/\n+/g, " "))];
  // 硬上限：20 条 × 32 字，再长就截断（总比丢格式强）
  const maxTotal = MAX_PARTS * size;
  const body = text.length > maxTotal ? text.slice(0, maxTotal) : text;
  // 模型经常一行就是一句话（像人发消息那样）：先按行切，行内再按标点切。
  // 绝不把两行拼回一条——拼了就成了用户说的"气泡黏在一起"。
  const lines = body
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const chunks: string[] = [];
  for (const line of lines) chunks.push(...semanticChunks(line, size));
  const cleaned = attachTrailingClosers(chunks);
  if (cleaned.length === 0) return [polishPunctuation(body.replace(/\n+/g, " "))];
  // 只有超过 20 条才动手合并（那时宁可挤一点，也不能发二十几条出去）。
  const parts = cleaned.length > MAX_PARTS ? packToCount(cleaned, MAX_PARTS, size) : cleaned;
  // 语言策略（v1.0.12 回退）：只收拾重复标点与空白，绝不替模型补标点，
  // 否则分条切在半句上时会被补出一个句号，读起来像结巴。
  return parts.map((part) => polishPunctuation(part)).filter((part) => part.length > 0);
}

/**
 * 声音标记：模型自己用 `<voice>…</voice>` 圈出"这句想用声音说"。
 * 加一个 `wait`：`<voice wait>…</voice>` = "这句想用声音说，但现在不说，等对方回了我再说"。
 *
 * 为什么放在分条这一层：哪一句值得出声是模型的判断，不是档位的判断——
 * 档位（always/auto/off）只管"要不要发语音条"，圈哪一句归它自己。
 * 标签本身绝不能漏进发出去的文本，这里切完就扔。
 */
const VOICE_BLOCK = /<voice(\s+[^>]*)?>([\s\S]*?)<\/voice\s*>/gi;
/** 落单的 `<voice>` / `</voice>`（模型偶尔忘关）：当普通文字处理，标签丢掉。 */
const STRAY_VOICE_TAG = /<\/?voice(\s+[^>]*)?>/gi;

/** 一段原文 = 文字区间或语音区间，顺序与原稿一致。 */
interface VoiceSegment {
  text: string;
  voice: boolean;
  /** `<voice wait>`：这一轮先不发，留着等对方回了再说 */
  hold?: boolean;
}

/** 按 `<voice>…</voice>` 把原文切成交替的普通段/语音段（大小写不敏感、可跨行）。 */
function splitVoiceSegments(raw: string): VoiceSegment[] {
  const segments: VoiceSegment[] = [];
  const pushPlain = (text: string): void => {
    if (text.trim().length > 0) segments.push({ text, voice: false });
  };
  const source = typeof raw === "string" ? raw : "";
  let cursor = 0;
  for (const match of source.matchAll(VOICE_BLOCK)) {
    const at = match.index ?? 0;
    pushPlain(source.slice(cursor, at));
    const attrs = match[1] ?? "";
    const inner = match[2] ?? "";
    if (inner.trim().length > 0) {
      const hold = /\bwait\b/i.test(attrs);
      const segment: VoiceSegment = { text: inner, voice: true };
      if (hold) segment.hold = true;
      segments.push(segment);
    }
    cursor = at + match[0].length;
  }
  pushPlain(source.slice(cursor));
  return segments;
}

/**
 * 语音段切条：先按句切（一句一条），再兜底硬切，保证每条都是 voice 且 ≤32 字。
 * 口径与 `splitIntoParts` 一致（cleanReplyText + 只收拾标点、不补标点）。
 */
function voiceChunks(segment: string): string[] {
  const text = cleanReplyText(segment.replace(STRAY_VOICE_TAG, ""));
  if (text.length === 0) return [];
  const chunks: string[] = [];
  for (const line of text.split(/\n+/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    chunks.push(...semanticChunks(trimmed, MAX_PART_CHARS));
  }
  // 防御：semanticChunks 已经保证 ≤32，万一段落里混进了超长串也不丢字，只硬切。
  return chunks
    .flatMap((chunk) => (chunk.length <= MAX_PART_CHARS ? [chunk] : hardWrap(chunk, MAX_PART_CHARS)))
    .map((chunk) => polishPunctuation(chunk))
    .filter((chunk) => chunk.length > 0);
}

/**
 * 「不好意思发」「不想发语音」「只能打字」这类话，本身就是在拒绝用声音，
 * 要是再把同一句当成语音发出去，就变成"嘴上说不好意思、手上照发"——
 * 用户真机上抓到的自相矛盾（2026-11-04）。凡是这类句子一律压回文字。
 */
const VOICE_REFUSAL = /(不(?:太)?好意思|不太想|不想|不方便|不能|没法|只?能打字)[^。！？!?\n]{0,6}(发|录|说|开口)|语音[^。！？!?\n]{0,4}(不方便|发不了)|只能打字/;

/**
 * 分条（v1.0.29）：认识模型给的 `<voice>` 标记。
 *
 *  - 普通段照旧走 `splitIntoParts`（保留 burst 收敛、行/句/硬切的口径）；
 *  - 语音段走 `semanticChunks(cleanReplyText(...))`，一句一条，全部 `voice: true`；
 *  - 顺序与原文一致，标签绝不出现在 text 里；
 *  - 全空时回 `[{ text: "", voice: false }]`，跟 `splitIntoParts` 的兜底一致。
 */
export function splitIntoPartsWithVoice(
  raw: string,
  burstMax: number,
): Array<{ text: string; voice: boolean; hold?: boolean }> {
  const out: Array<{ text: string; voice: boolean; hold?: boolean }> = [];
  for (const segment of splitVoiceSegments(raw)) {
    if (segment.voice) {
      for (const text of voiceChunks(segment.text)) {
        // 自己刚说过"不好意思发语音"，这句就别出声了
        const voice = !VOICE_REFUSAL.test(text);
        const part: { text: string; voice: boolean; hold?: boolean } = { text, voice };
        // `<voice wait>`：这一轮不出声，留着下一轮由它自己决定
        if (voice && segment.hold === true) part.hold = true;
        out.push(part);
      }
      continue;
    }
    const plain = segment.text.replace(STRAY_VOICE_TAG, "");
    for (const text of splitIntoParts(plain, burstMax)) {
      if (text.length > 0) out.push({ text, voice: false });
    }
  }
  if (out.length === 0) return [{ text: "", voice: false }];
  return out;
}

/** 一句用声音说的话，最好别长过这个数（提示词里也是 25）。 */
const VOICE_SENTENCE_MAX_CHARS = 25;

/**
 * 「铺垫句」：说的是"我准备说了"而不是"我要说的内容"。
 *
 * 人说话是这样：先打字埋一句「不过先说好，别笑我」，真正的语音是**下一句**；
 * 或者干脆等对方回了再发。把铺垫本身当语音发出去，就成了"开口先交代一句废话"，
 * 一点都不像人（用户 2026-11-04 抓到的原样）。
 */
const VOICE_PREAMBLE =
  /(先说好|说好了|先声明|先讲好|别笑我|别嫌|别笑话|我酝酿|等我一下|我发一句|这就发|马上发|我录一段|我准备一下)/;

/** 这条是不是"准备开口"的铺垫（不含实际内容）。 */
export function isVoicePreamble(text: string): boolean {
  const trimmed = (text ?? "").trim();
  if (trimmed.length === 0) return false;
  return VOICE_PREAMBLE.test(trimmed);
}

/**
 * 把语音挪到它真正该落脚的位置。
 *
 * 规则（按人类对话逻辑）：铺垫句留文字，语音落在**后面第一句有内容的**那句上；
 * 如果铺垫后面没有别的话（也就是说完整句还没到、或者本来就该等对方回），
 * 这一轮就不发语音——宁可打字，也不让"先说好别笑我"变成一条语音。
 */
export function placeVoiceOnContent(
  parts: readonly { text: string }[],
  indexes: readonly number[],
): number[] {
  const placed: number[] = [];
  for (const index of indexes) {
    const part = parts[index];
    if (part === undefined) continue;
    if (!isVoicePreamble(part.text)) {
      if (!placed.includes(index)) placed.push(index);
      continue;
    }
    // 铺垫句本身不出声：往后找第一句真内容
    let moved = -1;
    for (let next = index + 1; next < parts.length; next += 1) {
      const candidate = (parts[next]?.text ?? "").trim();
      if (candidate.length === 0) continue;
      if (isVoicePreamble(candidate)) continue;
      moved = next;
      break;
    }
    if (moved >= 0 && !placed.includes(moved)) placed.push(moved);
    // 后面没内容（或者内容就是没说出口的）→ 这一轮不发声
  }
  return placed.sort((left, right) => left - right);
}

/**
 * 它没自己标 `<voice>` 时，挑一条最像「想用声音说」的：短、带情绪、结尾是语气词。
 *
 * 以前这里固定挑第一条，于是不管说什么都是第一句出声——哪怕第一句只是铺垫，
 * 真正该用声音说的是后面那句「那我试试看哦」。平手时挑靠后的：
 * 情绪落点通常在后面，不在开头。
 */
export function pickVoicePart(parts: readonly { text: string }[]): number {
  let bestIndex = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  parts.forEach((part, index) => {
    const text = (part.text ?? "").trim();
    if (text.length === 0) return;
    // 拒绝用声音的那句不参与挑选（否则会出现"嘴上说不好意思发、手上挑了它出声"）
    if (VOICE_REFUSAL.test(text)) return;
    // 铺垫句不当选：语音该落在后面那句真话上
    if (isVoicePreamble(text)) return;
    let score = 0;
    if (text.length <= VOICE_SENTENCE_MAX_CHARS) score += 3;
    else score -= Math.min(6, (text.length - VOICE_SENTENCE_MAX_CHARS) / 8);
    if (/[？！!?]/.test(text)) score += 2;
    if (/[…~～]/.test(text)) score += 1;
    const lastChar = text.replace(/[。！？…!?，,、\s]/g, "").slice(-1);
    if (lastChar !== "" && TAIL_PARTICLES.includes(lastChar)) score += 1;
    score += index * 0.01;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestIndex;
}

/**
 * 把语义块合并到"大约 target 条"。
 *
 * 以前的写法按平均长度去合并，块被塞不下时就退回按字硬切，
 * 于是出现「…差了点。晚 / 上可能就看个电影」这种从词中间劈开的条。
 * 现在只在块与块之间的接缝处合并：拼起来超长就各算一条，绝不切进词里。
 */
function packToCount(chunks: readonly string[], target: number, size: number): string[] {
  if (chunks.length === 0) return [];
  const wanted = Math.min(MAX_PARTS, Math.max(1, target));
  const parts: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index] ?? "";
    const last = parts[parts.length - 1];
    if (last === undefined) {
      parts.push(chunk);
      continue;
    }
    const remainingChunks = chunks.length - index;
    const remainingSlots = wanted - parts.length;
    const glue = /[，。！？、；：,.!?;:\s]$/.test(last) ? "" : "，";
    const merged = `${last}${glue}${chunk}`;
    // 只有当剩下的块比剩下的位置多（需要压缩条数）且拼起来不超长时才合并
    if (remainingChunks > remainingSlots && merged.length <= size) {
      parts[parts.length - 1] = merged;
    } else {
      parts.push(chunk);
    }
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

/** 延迟：对数正态（median 按在场缩放、sigma 来自人格）+ 在场区间，独立采样。 */
export function delayAfterMsFor(traits: PersonaTraits, presence: PresenceState, rng: Rng): number {
  const median = traits.delayMedianMs * PRESENCE_MEDIAN_FACTOR[presence];
  const sampled = rng.logNormal(median, traits.delaySigma);
  const [min, max] = PRESENCE_DELAY_RANGE[presence];
  return Math.round(Math.min(max, Math.max(min, sampled)));
}

export interface PlanPartsInput {
  traits: PersonaTraits;
  presence: PresenceState;
  rng: Rng;
}

/**
 * 把模型输出切成 PlannedPart 序列（1–3 条，最后一条 delayAfterMs=0）。
 *
 * `voice` 只在模型真的圈了 `<voice>` 的那条上写 true；其余条目不带这个键，
 * 让对象形状保持稳定（下游做 `part.voice === true` 判断即可）。
 */
export function planParts(raw: string, input: PlanPartsInput): PlannedPart[] {
  const chunks = splitIntoPartsWithVoice(raw, input.traits.burstMax);
  return chunks.map((chunk, index) => {
    const isLast = index === chunks.length - 1;
    const part: PlannedPart = {
      text: chunk.text,
      typingMs: typingMsFor(chunk.text.length, input.traits, input.rng),
      delayAfterMs: isLast ? 0 : delayAfterMsFor(input.traits, input.presence, input.rng),
    };
    if (chunk.voice) part.voice = true;
    if (chunk.hold === true) part.hold = true;
    return part;
  });
}

/** 完整回复文本：落库用（分条是投递层的事，记忆里记整句）。 */
export function joinFullText(parts: readonly PlannedPart[]): string {
  return parts.map((part) => part.text).join("\n");
}

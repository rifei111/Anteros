/**
 * 语音条：客户端与内核共用的纯函数与常量（docs/语音条.md）。
 *
 * 这里只放"两边必须算出同一个结果"的东西：
 * - 占位符：客户端乐观插入的临时气泡是靠 `item.text === message.text` 逐字相等才摘掉的，
 *   一个引号差（ASCII `"` vs U+2033）就是列表里两条气泡。所以模板只有这一份（文档第 2 节配套规则二）。
 * - 预算估算：界面不许自己算钱，内核也不许拍脑袋——同一份公式，两边都调它。
 * - 地址归一与魔数：插件与内核各用一半，拼错了就是 `/v1/v1/audio/speech`。
 */

/** 录音硬上限（客户端 60s、内核按它做范围检查，文档 7.5）。 */
export const AUDIO_DUR_MAX_MS = 60_000;
/** 时长范围检查的容差：客户端计时带几毫秒抖动，不能因此把一条正常语音判成脏数据。 */
export const AUDIO_DUR_TOLERANCE_MS = 2_000;
/** 单条语音体积硬上限（4MB 的 base64 约 5.3MB，安全落在 MAX_FRAME_BYTES 的 8MB 内，文档 7.5）。 */
export const AUDIO_MAX_BYTES = 4 * 1024 * 1024;
/** 波形格数：24 格是 80–240px 宽度下肉眼能分辨的上限（文档 9.3）。 */
export const VOICE_PEAK_BUCKETS = 24;
/** 中文口语约 4.5 字/秒；只用于预算预检，P−1 试听时用实测值校准（文档 10.6）。 */
export const SPEAK_CHARS_PER_SECOND = 4.5;
/** 朗读稿守卫上限：改写后超过原文 1.6 倍就弃用（文档 10.2）。预算预检要按它估上限。 */
export const SPEECH_REWRITE_MAX_RATIO = 1.6;
/** uploadId 的存活时间：15 分钟内没绑定到消息就进 GC（文档 5.2 / 7.6）。 */
export const MEDIA_UPLOAD_TTL_MS = 15 * 60_000;
/** 渲染层 Blob URL 的 LRU 条数（文档 9.3）。 */
export const VOICE_LRU_SIZE = 8;

/** U+2033 双撇号。别改成 ASCII 引号：这个字符参与"逐字相等"的比较。 */
const DURATION_MARK = "\u2033";

function secondsLabel(durMs: number | null | undefined): string | null {
  if (durMs === null || durMs === undefined || !Number.isFinite(durMs) || durMs <= 0) return null;
  const seconds = Math.max(1, Math.round(durMs / 1000));
  return `${seconds}${DURATION_MARK}`;
}

/** 自己录的语音的占位符（转写回来之前，或 ASR 彻底失败时的正文）。 */
export function voicePlaceholder(input: { durMs?: number | null } = {}): string {
  const label = secondsLabel(input.durMs);
  return label ? `[语音 ${label}]` : "[语音]";
}

/** 听不清时的占位符：正文里带一句"没听清"，和重试按钮一起出现（文档 11.2）。 */
export function voicePlaceholderUnclear(input: { durMs?: number | null } = {}): string {
  const label = secondsLabel(input.durMs);
  return label ? `[语音 ${label} 没听清]` : "[语音 没听清]";
}

/** 别人的语音（群友）：本期不转写、不读文件、不发给任何外部服务（文档 12.1）。 */
export function foreignVoicePlaceholder(input: { durMs?: number | null } = {}): string {
  const label = secondsLabel(input.durMs);
  return label ? `[语音 ${label} · 别人的]` : "[语音 · 别人的]";
}

/** 是不是我们自己生成的占位符（用于"这条语音还没转写"的判断，不参与逐字比较）。 */
export function isVoicePlaceholder(text: string): boolean {
  return text.startsWith("[语音");
}

/**
 * 预算预检：这一条朗读稿大概要花多少钱。
 * 公式见文档 10.6：按 4.5 字/秒、再除以语速倍率，向上取整到秒。
 */
export function estimateSpeakCostCny(
  text: string,
  pricePerSecondCny: number,
  rate = 1,
): number {
  if (!Number.isFinite(pricePerSecondCny) || pricePerSecondCny <= 0) return 0;
  const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const chars = [...text].filter((ch) => !/\s/.test(ch)).length;
  if (chars === 0) return 0;
  const seconds = Math.ceil(chars / SPEAK_CHARS_PER_SECOND / safeRate);
  return Math.round(seconds * pricePerSecondCny * 100) / 100;
}

/**
 * 预检用的**上限**：预检排在朗读稿改写之前，那一刻只有展示文本（文档 10.2 的顺序）。
 * 不乘 1.6 的话最多低估 60%，边界上照样会超——评审第四轮抓的就是这个口径错。
 */
export function estimateSpeakCostCeilingCny(
  text: string,
  pricePerSecondCny: number,
  rate = 1,
): number {
  const base = estimateSpeakCostCny(text, pricePerSecondCny, rate);
  if (base === 0) return 0;
  return Math.ceil(base * SPEECH_REWRITE_MAX_RATIO * 100) / 100;
}

/**
 * 按字计价的供应商（BreezeBlue：$30 / 100 万字）不做"秒"这一层，
 * 所以另开一套公式：非空白字符数直接乘单价。
 */
export function countSpeechChars(text: string): number {
  return [...text].filter((ch) => !/\s/.test(ch)).length;
}

export function estimateSpeakCostByCharsCny(text: string, pricePerMillionCharsCny: number): number {
  if (!Number.isFinite(pricePerMillionCharsCny) || pricePerMillionCharsCny <= 0) return 0;
  const chars = countSpeechChars(text);
  if (chars === 0) return 0;
  return Math.round((chars / 1_000_000) * pricePerMillionCharsCny * 100) / 100;
}

/** 按字计价的预检上限：同样乘朗读稿改写上限（10.6 的口径）。 */
export function estimateSpeakCostCeilingByCharsCny(text: string, pricePerMillionCharsCny: number): number {
  if (!Number.isFinite(pricePerMillionCharsCny) || pricePerMillionCharsCny <= 0) return 0;
  const chars = countSpeechChars(text);
  if (chars === 0) return 0;
  // 上限必须向上取整到"分"：先四舍五入再乘 1.6 会低估，边界上照样超预算。
  const exact = (chars / 1_000_000) * pricePerMillionCharsCny * SPEECH_REWRITE_MAX_RATIO;
  return Math.ceil(exact * 100) / 100;
}

/**
 * 供应商根地址归一：剥掉尾部斜杠与尾部 `/v1`，之后由插件拼 `/v1/audio/...`。
 * `https://api.deepseek.com/v1` 与 `https://api.deepseek.com/v1/` 都必须得到 `https://api.deepseek.com`。
 */
export function normalizeTtsBaseUrl(baseUrl: string): string {
  let base = baseUrl.trim();
  if (base === "") return "";
  base = base.replace(/\/+$/, "");
  base = base.replace(/\/v1$/i, "");
  return base.replace(/\/+$/, "");
}

export type AudioExt = "webm" | "ogg" | "mp3" | "wav";

/** mime → 落盘扩展名。不认识的一律 null（内核据此拒绝，文档 7.5 的白名单）。 */
export function audioExtForMime(mime: string): AudioExt | null {
  const m = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (m) {
    case "audio/webm":
      return "webm";
    case "audio/ogg":
      return "ogg";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return "wav";
    default:
      return null;
  }
}

/** 扩展名白名单（内核只放这几类落盘）。 */
export const AUDIO_EXTS: readonly AudioExt[] = ["webm", "ogg", "mp3", "wav"];

export function mimeForAudioExt(ext: AudioExt): string {
  switch (ext) {
    case "webm":
      return "audio/webm";
    case "ogg":
      return "audio/ogg";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
  }
}

function startsWithBytes(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * 魔数嗅探。v1 把 webm 的 `1A 45 DF A3` 误写成 `1A E3 DF A3`——
 * 这种错会让所有 webm 都被拒，而且报错指向错误的方向。
 */
export function sniffAudioMagic(bytes: Uint8Array): AudioExt | null {
  // EBML (webm/matroska)
  if (startsWithBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "webm";
  // OggS
  if (startsWithBytes(bytes, [0x4f, 0x67, 0x67, 0x53])) return "ogg";
  // ID3 tag
  if (startsWithBytes(bytes, [0x49, 0x44, 0x33])) return "mp3";
  // MPEG frame sync: FF Ex / FF Fx
  const second = bytes[1];
  if (second !== undefined && bytes[0] === 0xff && (second & 0xe0) === 0xe0) return "mp3";
  // RIFF....WAVE
  if (
    startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  ) {
    return "wav";
  }
  return null;
}

/** peaks 归一：只留 0–1 的有限数，最多 VOICE_PEAK_BUCKETS 个。脏数据不许进库也不许进 DOM。 */
export function normalizePeaks(peaks: unknown): number[] {
  if (!Array.isArray(peaks)) return [];
  const out: number[] = [];
  for (const raw of peaks) {
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(value)) continue;
    out.push(Math.min(1, Math.max(0, value)));
    if (out.length >= VOICE_PEAK_BUCKETS) break;
  }
  return out;
}

/** 时长范围检查：越界当 0（内核不猜、不拒绝整条消息，文档 7.5）。 */
export function normalizeDurationMs(durMs: unknown): number {
  if (typeof durMs !== "number" || !Number.isFinite(durMs) || durMs <= 0) return 0;
  if (durMs > AUDIO_DUR_MAX_MS + AUDIO_DUR_TOLERANCE_MS) return 0;
  return Math.round(durMs);
}
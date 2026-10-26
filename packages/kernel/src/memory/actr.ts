/**
 * ACT-R 激活与提取概率（草案 1.2）。
 *
 * 公式（时间单位是"秒"，这是草案算例的口径）：
 *   B_i = ln( Σ_j t_j^(-d) )                 t_j = 第 j 次成功回忆距今的秒数（至少含编码时刻）
 *   A_i = B_i + Σ_k W_k·S_ki + γ·emotion + ε  W_k 是线索权重，S_ki 是线索相似度
 *   P_i = 1 / (1 + exp(-(A_i - τ) / s))      τ 提取阈值，s 噪声
 *
 * 为什么用幂函数而不是指数衰减：幂律才会自然产生"间隔效应"——同一件事在 0/1/3 天
 * 各回忆一次，30 天后的激活明显高于只在 0 天记一次（草案 1.2 算例 -4.43 → -6.26）。
 *
 * 数据库里的时间戳一律是 UTC 毫秒，本文件在内部换算成秒，并给 1 秒平滑：
 * 刚编码的记忆 (now - t) = 0，若不平滑会得到 ln(0^-d) = +∞。
 */

/** 1 秒平滑：编码瞬间也要有有限激活值（此时 B_i = ln(1) = 0）。 */
export const ACTR_MIN_DELTA_SECONDS = 1;

/** 草案 1.2 算例用的默认参数，测试与默认 traits 都以它为准。 */
export const ACTR_DEFAULTS = {
  /** 衰减指数 d：0.3 记性好 … 0.7 健忘（规范 1 §2.2 记忆参数） */
  d: 0.5,
  /** 提取阈值 τ（负数；-6.5 更健忘 … -5.0 更好提取） */
  tau: -6.0,
  /** 噪声 s（越大越随机） */
  s: 0.4,
} as const;

/** 线索：权重 W_k 与相似度 S_ki 都归一到 [0,1]，便于跨线索比较。 */
export interface Cue {
  /** 线索权重 W_k */
  weight: number;
  /** 线索相似度 S_ki */
  similarity: number;
}

export interface ActivationInput {
  /** baseLevel 的输出 */
  base: number;
  /** 线索项 Σ W_k·S_ki */
  cues?: readonly Cue[];
  /** 当前情绪（情绪一致性：同情绪的记忆更容易被想起，草案 1.2） */
  emotion?: { v: number; a: number } | null;
  /** 情绪增益 γ，来自 traits.emotionGain */
  emotionGain?: number;
  /** 回忆噪声 ε（默认 0：保证可回放；需要时由调用方注入） */
  noise?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 基线激活 B_i = ln(Σ t_j^-d)。
 *
 * @param accessTimestamps 成功回忆时间戳（UTC ms）。调用方必须至少放入编码时刻；
 *   `access_log` 里保留最近 30 次，正是为了这个求和。
 * @param now 当前 UTC ms
 * @param d 衰减指数（traits.memoryD）
 */
export function baseLevel(accessTimestamps: readonly number[], now: number, d: number): number {
  if (accessTimestamps.length === 0) return Number.NEGATIVE_INFINITY;
  const decay = clamp(d, 0, 1);
  // d=0 时 t^-0 = 1，退化成一个普通计数（ln n），此时用 log(n) 避免浮点 pow 抖动
  if (decay === 0) return Math.log(accessTimestamps.length);
  let sum = 0;
  for (const ts of accessTimestamps) {
    const deltaSeconds = Math.max(ACTR_MIN_DELTA_SECONDS, (now - ts) / 1000);
    sum += Math.pow(deltaSeconds, -decay);
  }
  return sum > 0 ? Math.log(sum) : Number.NEGATIVE_INFINITY;
}

/**
 * 情绪项 γ·emotion：效价绝对值决定强度，唤醒度放大（高唤醒的坏情绪最难忘）。
 * 归一到 [0,1] 后再乘 γ，避免情绪项压过基线激活。
 */
export function emotionTerm(emotion: { v: number; a: number } | null | undefined, gain: number): number {
  if (!emotion) return 0;
  const v = clamp(Math.abs(emotion.v), 0, 1);
  const a = clamp(emotion.a, 0, 1);
  if (v === 0) return 0;
  return gain * v * (0.5 + 0.5 * a);
}

/** 线索项 Σ W_k·S_ki。 */
export function cueTerm(cues: readonly Cue[] | undefined): number {
  if (!cues || cues.length === 0) return 0;
  let sum = 0;
  for (const cue of cues) sum += clamp(cue.weight, 0, 1) * clamp(cue.similarity, 0, 1);
  return sum;
}

/** 总激活 A_i = B_i + 线索项 + 情绪项 + ε。 */
export function activation(input: ActivationInput): number {
  const gain = input.emotionGain ?? 1.2;
  return input.base + cueTerm(input.cues) + emotionTerm(input.emotion, gain) + (input.noise ?? 0);
}

/**
 * 提取概率 P = 1 / (1 + exp(-(A-τ)/s))。
 * s 下限 0.05，防止调用方传 0 造成 NaN。
 */
export function recallProbability(activationValue: number, tau: number, s: number): number {
  const sigma = Math.max(0.05, s);
  if (activationValue === Number.POSITIVE_INFINITY) return 1;
  if (activationValue === Number.NEGATIVE_INFINITY) return 0;
  const z = (activationValue - tau) / sigma;
  // 数值稳定写法：z 很大时 exp(-z) 溢出无意义，直接返回 1
  if (z >= 40) return 1;
  if (z <= -40) return 0;
  return 1 / (1 + Math.exp(-z));
}

/**
 * 一次成功回忆：把当前时间追加进 access_log（保留最近 30 次，草案/规范 1 §2.3）。
 * 返回新数组，调用方负责写库。
 */
export function appendAccessLog(accessLog: readonly number[], now: number, max = 30): number[] {
  const next = [...accessLog, now];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** 把 DB 里的 access_log（JSON 文本）解析成时间戳数组，容错坏数据。 */
export function parseAccessLog(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  } catch {
    return [];
  }
}

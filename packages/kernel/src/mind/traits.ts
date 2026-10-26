/**
 * 差异参数的先验采样（草案 2.5 / 规范 1 §2.2）。
 *
 * 为什么要采样而不是写死：个体差异是"像人"的来源之一（记性好坏、说话快慢、
 * 情绪反应强弱）。冷启动按先验采一次，之后只以 η≈1e-3 极慢塑形（草案 2.4），
 * 所以这里必须可复现：同一 persona 用固定 seed 重采样得到同一组参数，
 * 否则回放（规范 1 §5.3）就对不上当时的表达参数。
 *
 * 采样方式：以 DEFAULT_TRAITS 为中心的截断正态，落在规范 1 §2.2 的参数范围内。
 * 注意 burstMin 恒为 1、burstMax ∈ {2,3}，于是"分条 1~3 条"这条表达约束
 * 由人格参数直接决定（草案 4.1）。
 */
import type { PersonaTraits } from "@anteros/shared";
import { DEFAULT_TRAITS } from "@anteros/shared";
import { Rng } from "../util/rng.js";

/** 规范 1 §2.2 给的参数范围；超出即视为实现错误（测试会固定这些边界）。 */
export const TRAIT_RANGES = {
  detailPref: [0, 1],
  warmth: [0, 1],
  initiative: [0, 1],
  humor: [0, 1],
  memoryD: [0.35, 0.65],
  memoryTau: [-6.5, -5.0],
  memoryS: [0.15, 0.4],
  reconstructRho: [0.1, 0.2],
  emotionGain: [1.0, 2.5],
  delayMedianMs: [3000, 6000],
  delaySigma: [0.4, 0.9],
  burstMin: [1, 1],
  burstMax: [2, 3],
  typoRate: [0.005, 0.04],
} as const satisfies Record<string, readonly [number, number]>;

export type TraitRangeKey = keyof typeof TRAIT_RANGES;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 截断正态：以 prior 为中心、sd 为标准差，落在 [min,max]。 */
function truncatedNormal(rng: Rng, prior: number, sd: number, min: number, max: number, digits: number): number {
  return round(clamp(prior + rng.normal() * sd, min, max), digits);
}

/**
 * 按先验采样一组 traits。seed 由 persona 决定（如 `persona:<personaId>`），
 * 同 seed 必然同结果——这是回放与测试的前提。
 */
export function sampleTraits(seed: string | number): PersonaTraits {
  const rng = Rng.fromString(`traits:${String(seed)}`);
  const memoryD = truncatedNormal(rng, DEFAULT_TRAITS.memoryD, 0.06, 0.35, 0.65, 4);
  const memoryTau = truncatedNormal(rng, DEFAULT_TRAITS.memoryTau, 0.3, -6.5, -5.0, 3);
  const memoryS = truncatedNormal(rng, DEFAULT_TRAITS.memoryS - 0.1, 0.05, 0.15, 0.4, 4);
  const reconstructRho = truncatedNormal(rng, DEFAULT_TRAITS.reconstructRho, 0.02, 0.1, 0.2, 4);
  const emotionGain = truncatedNormal(rng, DEFAULT_TRAITS.emotionGain, 0.25, 1.0, 2.5, 3);
  const delayMedianMs = Math.round(truncatedNormal(rng, DEFAULT_TRAITS.delayMedianMs, 500, 3000, 6000, 0));
  const delaySigma = truncatedNormal(rng, DEFAULT_TRAITS.delaySigma, 0.08, 0.4, 0.9, 3);
  const burstMax = rng.bool(0.6) ? 3 : 2;
  return {
    detailPref: truncatedNormal(rng, DEFAULT_TRAITS.detailPref, 0.12, 0.35, 0.95, 4),
    warmth: truncatedNormal(rng, DEFAULT_TRAITS.warmth, 0.15, 0.2, 0.95, 4),
    initiative: truncatedNormal(rng, DEFAULT_TRAITS.initiative, 0.15, 0.1, 0.8, 4),
    humor: truncatedNormal(rng, DEFAULT_TRAITS.humor, 0.12, 0.05, 0.8, 4),
    memoryD,
    memoryTau,
    memoryS,
    reconstructRho,
    emotionGain,
    delayMedianMs,
    delaySigma,
    burstMin: 1,
    burstMax,
    typoRate: truncatedNormal(rng, DEFAULT_TRAITS.typoRate, 0.008, 0.005, 0.04, 4),
    // MBTI 只当人设标签先验，采样阶段一律不填（草案 2.7）
    mbti: null,
  };
}

/** 校验一组 traits 是否都落在规范范围内（测试与 updatePersona 用）。 */
export function validateTraits(traits: Partial<PersonaTraits>): string[] {
  const issues: string[] = [];
  for (const key of Object.keys(TRAIT_RANGES) as TraitRangeKey[]) {
    const value = traits[key];
    if (value === undefined || value === null) continue;
    const [min, max] = TRAIT_RANGES[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      issues.push(`${key}=${String(value)} 不在 [${min}, ${max}] 内`);
    }
  }
  if (traits.burstMin !== undefined && traits.burstMax !== undefined && traits.burstMin > traits.burstMax) {
    issues.push(`burstMin(${traits.burstMin}) 不能大于 burstMax(${traits.burstMax})`);
  }
  return issues;
}

/**
 * MBTI 只投影到 traits / 表达参数（草案 2.7：MBTI 只作先验，不进 prompt、不作口头禅）。
 *
 * 投影规则来自规范 2 §5.4：
 *   E/I → initiative ±0.1     S/N → detailPref（S 更具体，N 更概括）
 *   T/F → warmth ±0.1、emotionGain（F 情绪反应更强）
 *   J/P → 分条与延迟（J 更少更短、P 更多更长）
 * 返回的是 traits 增量，由调用方合并；mbti 本身只存进 traits.mbti 当标签。
 */
export function projectMbti(mbti: string): Partial<PersonaTraits> {
  const normalized = mbti.trim().toUpperCase();
  if (!/^[EI][SN][TF][JP]$/.test(normalized)) {
    throw new Error(`非法 MBTI 类型：${mbti}`);
  }
  const [ei, sn, tf, jp] = normalized.split("") as [string, string, string, string];
  const patch: Partial<PersonaTraits> = { mbti: normalized };
  patch.initiative = clamp(DEFAULT_TRAITS.initiative + (ei === "E" ? 0.1 : -0.1), 0.1, 0.8);
  patch.detailPref = clamp(DEFAULT_TRAITS.detailPref + (sn === "S" ? 0.2 : -0.1), 0.35, 0.95);
  patch.warmth = clamp(DEFAULT_TRAITS.warmth + (tf === "F" ? 0.1 : -0.1), 0.2, 0.95);
  patch.emotionGain = clamp(DEFAULT_TRAITS.emotionGain + (tf === "F" ? 0.3 : -0.2), 1.0, 2.5);
  patch.burstMax = clamp(DEFAULT_TRAITS.burstMax + (jp === "J" ? -1 : 0), 2, 3);
  patch.delayMedianMs = Math.round(clamp(DEFAULT_TRAITS.delayMedianMs + (jp === "J" ? -300 : 300), 3000, 6000));
  return patch;
}

/** 合并 traits 增量并夹到范围内（updatePersona / applyPreset 共用）。 */
export function mergeTraits(base: PersonaTraits, patch: Partial<PersonaTraits>): PersonaTraits {
  const merged: PersonaTraits = { ...base, ...patch };
  for (const key of Object.keys(TRAIT_RANGES) as TraitRangeKey[]) {
    const [min, max] = TRAIT_RANGES[key];
    merged[key] = round(clamp(merged[key], min, max), 4) as never;
  }
  if (merged.burstMin > merged.burstMax) merged.burstMin = merged.burstMax;
  return merged;
}

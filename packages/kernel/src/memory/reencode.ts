/**
 * 召回后的重构再编码（草案 1.4 / 规范 2 §3）：
 *
 * 人不是从数据库里"读取"记忆，而是每次想起都按当下情绪重建一遍，重建的结果
 * 会覆盖/叠加进原记忆。这里的实现刻意保守——**只新增一条带轻微情绪色彩的
 * re-encoding 情节，原文一行不删**（全存不删，遗忘 = 提取概率，草案 1.4）。
 *
 * ρ（reconstruct_rho，0.1–0.2）是"漂移概率"：ρ 越大，重建时越容易带上当前
 * 情绪。为了保证可回放，这里的采样全部由确定性种子驱动（Rng + itemId + 小时），
 * 同一个召回在回放里得到同一句改写。
 */
import type { Importance } from "@anteros/shared";
import { Rng } from "../util/rng.js";

/**
 * 按情绪给原文加一点点"此刻的滤镜"。
 *
 * 三条尾巴按效价分档——不是回复模板，而是记忆文本自身的叙述口吻；
 * 只在原文没有类似尾巴时加，避免反复重建叠成一串括号。
 */
const DRIFT_MARKERS: Record<"warm" | "heavy" | "faded", readonly string[]> = {
  warm: ["，现在想起来还挺暖的", "，当时其实挺开心的", "，细节都还记得"],
  heavy: ["，想起来还是有点堵", "，现在翻出来心里还是沉的", "，那会儿其实挺难受的"],
  faded: ["，细节有点模糊了", "，只记得个大概", "，具体怎么说的记不清了"],
};

const MARKER_RE = /(，[^，]{2,14}(?:暖|开心|堵|沉|难受|模糊|大概|记不清|还记得))$/u;

export interface ReencodeInput {
  agentId: number;
  itemId: number;
  text: string;
  importance: Importance;
  layer: "detail" | "fact";
  confidence: number;
  source: string;
  now: number;
  mood: { v: number; a: number };
  rho: number;
}

export interface ReencodedEpisode {
  text: string;
  emotion: { v: number; a: number };
  confidence: number;
}

/** 是否值得重建：ρ 太小且情绪不重时，重建就是纯噪声，直接跳过。 */
export function shouldReencode(rho: number, mood: { v: number; a: number }): boolean {
  const intensity = Math.abs(mood.v) * (0.5 + 0.5 * mood.a);
  return intensity >= 0.12 || rho >= 0.18;
}

/**
 * 生成重建后的文本。漂移程度由 ρ 与情绪强度决定：
 *   - ρ=0.1 时只可能在情绪很强时换措辞；
 *   - ρ=0.2 时中等情绪就会改写。
 */
export function reencodeText(input: {
  text: string;
  mood: { v: number; a: number };
  rho: number;
  seed: string;
}): string {
  if (MARKER_RE.test(input.text)) return input.text;
  const rng = Rng.fromString(input.seed);
  const intensity = Math.abs(input.mood.v) * (0.5 + 0.5 * input.mood.a);
  // 漂移阈值：ρ∈[0.1,0.2] 映射到 0.55–0.2，情绪越强越容易越过
  const threshold = 0.55 - input.rho * 1.75;
  if (rng.next() < threshold + (1 - intensity) * 0.5) return input.text;

  if (input.mood.v > 0.25) return `${input.text}${rng.pick(DRIFT_MARKERS.warm)}`;
  if (input.mood.v < -0.25) return `${input.text}${rng.pick(DRIFT_MARKERS.heavy)}`;
  return `${input.text}${rng.pick(DRIFT_MARKERS.faded)}`;
}

/** 由原行构造一条新的再编码情节（service 负责落库；原文保留）。 */
export function buildReencodedEpisode(input: ReencodeInput): ReencodedEpisode {
  const seed = `${input.agentId}:${input.itemId}:${Math.floor(input.now / 3_600_000)}`;
  return {
    text: reencodeText({ text: input.text, mood: input.mood, rho: input.rho, seed }),
    emotion: input.mood,
    // 重建过的记忆不如原记忆可信（这是"目击者效应"的方向，草案 1.4）
    confidence: Math.max(0.3, input.confidence * 0.92),
  };
}

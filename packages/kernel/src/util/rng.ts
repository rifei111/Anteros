/**
 * 可复现随机数：个体的"随机性格"必须能在回放时复现（规范 1 §5.3 要求
 * 任意一句能还原当时的装配输入，含当时采样的延迟与分条）。
 *
 * 用 mulberry32：足够均匀、实现短、状态可序列化进 turns.ctx_snapshot。
 */
export interface RngState {
  seed: number;
}

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  static fromString(input: string): Rng {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return new Rng(hash >>> 0);
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    if (max <= min) return min;
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))] as T;
  }

  /** Box-Muller 取标准正态，用于对数正态延迟（重尾的延迟才像人）。 */
  normal(): number {
    const u = Math.max(1e-9, this.next());
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  logNormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.normal());
  }

  snapshot(): RngState {
    return { seed: this.state };
  }
}
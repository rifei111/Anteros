/**
 * 每个「可对话对象」一条排队线。
 *
 * 为什么要排队：一条回复要打十来秒（打字节奏、模型、发到外部通道），这期间别人又说话了。
 * 直接并行会让同一个人的两句话被交叉作答，看上去像精神分裂；直接丢掉又会漏话。
 * 所以按会话键串行，超长才丢最老的，并把原因记下来给界面看（不静默）。
 */
import type { KernelDeps } from "../contracts.js";
import type { SettingsService } from "../settings.js";

export interface ConversationJob {
  /** 会话键：例如 channel:<id>；应用内主会话是 app */
  key: string;
  /** 界面上显示的名字，用于日志 */
  label: string;
  /** 具体要做的事（一般是走一遍对话编排，并把分条发回那个会话） */
  run: () => Promise<void>;
}

interface QueueItem {
  running: boolean;
  items: ConversationJob[];
  lastError: string | null;
  handled: number;
  dropped: number;
}

const DEFAULT_LIMIT = 20;

export class ConversationQueue {
  private readonly queues = new Map<string, QueueItem>();

  constructor(
    private readonly deps: KernelDeps,
    private readonly settings: SettingsService,
  ) {}

  private limit(): number {
    const value = this.settings.getJson<number>("chat.queueLimit", DEFAULT_LIMIT);
    const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_LIMIT;
    return Math.min(Math.max(parsed, 1), 100);
  }

  private bucket(key: string): QueueItem {
    let item = this.queues.get(key);
    if (!item) {
      item = { running: false, items: [], lastError: null, handled: 0, dropped: 0 };
      this.queues.set(key, item);
    }
    return item;
  }

  /** 排进队列；同一会话正在回复时不会插队，按先来后到。 */
  offer(job: ConversationJob): void {
    const bucket = this.bucket(job.key);
    bucket.items.push(job);
    const cap = this.limit();
    while (bucket.items.length > cap) {
      const dropped = bucket.items.shift();
      bucket.dropped += 1;
      bucket.lastError = `排队超过 ${cap} 条，最早的一条被丢掉了（${job.label}）`;
      this.deps.log.warn(`[queue] ${job.label} 队列超限，丢弃一条（累计 ${bucket.dropped}）`);
      void dropped;
    }
    this.drain(job.key);
  }

  private drain(key: string): void {
    const bucket = this.bucket(key);
    if (bucket.running) return;
    const next = bucket.items.shift();
    if (!next) return;
    bucket.running = true;
    void next
      .run()
      .then(() => {
        bucket.handled += 1;
        bucket.lastError = null;
      })
      .catch((error: unknown) => {
        bucket.lastError = error instanceof Error ? error.message : String(error);
        this.deps.log.warn(`[queue] ${next.label} 处理失败：${bucket.lastError}`);
      })
      .finally(() => {
        bucket.running = false;
        this.drain(key);
      });
  }

  /** 给通道状态用：这个会话还压着几条、最近一条为什么没处理。 */
  stats(key: string): { depth: number; lastError: string | null } {
    const bucket = this.queues.get(key);
    if (!bucket) return { depth: 0, lastError: null };
    return { depth: bucket.items.length, lastError: bucket.lastError };
  }

  totalDepth(): number {
    let total = 0;
    for (const bucket of this.queues.values()) total += bucket.items.length;
    return total;
  }

  /** 全部清空（整体重置数据时用）。 */
  clear(): void {
    for (const bucket of this.queues.values()) {
      bucket.items = [];
      bucket.lastError = null;
    }
  }
}
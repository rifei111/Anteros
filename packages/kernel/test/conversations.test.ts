import { describe, expect, it } from "vitest";
import { ConversationQueue } from "../src/services/conversations.js";
import type { KernelDeps } from "../src/contracts.js";
import type { SettingsService } from "../src/settings.js";

function makeQueue(limit = 20, warn?: (message: string) => void): ConversationQueue {
  const deps = {
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string) => warn?.(message),
      error: () => undefined,
    },
  } as unknown as KernelDeps;
  const settings = { getJson: () => limit } as unknown as SettingsService;
  return new ConversationQueue(deps, settings);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ConversationQueue", () => {
  it("同一个会话串行执行，先后顺序不乱", async () => {
    const queue = makeQueue();
    const order: string[] = [];
    queue.offer({
      key: "wechat:a",
      label: "A",
      run: async () => {
        order.push("first-start");
        await sleep(40);
        order.push("first-end");
      },
    });
    queue.offer({
      key: "wechat:a",
      label: "A",
      run: async () => {
        order.push("second");
      },
    });

    await sleep(120);
    // 第二条必须等第一条跑完；不允许交叉
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("不同会话之间互不阻塞", async () => {
    const queue = makeQueue();
    const order: string[] = [];
    queue.offer({
      key: "wechat:a",
      label: "A",
      run: async () => {
        await sleep(60);
        order.push("slow");
      },
    });
    queue.offer({
      key: "wechat:b",
      label: "B",
      run: async () => {
        order.push("fast");
      },
    });

    await sleep(120);
    expect(order).toEqual(["fast", "slow"]);
  });

  it("超过上限时丢最老的一条，并把原因记下来（不静默）", async () => {
    const queue = makeQueue(2);
    const ran: string[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    queue.offer({
      key: "wechat:g",
      label: "群",
      run: async () => {
        ran.push("running");
        await gate;
      },
    });
    // 正在跑的时候再排三条：只能留两条，最老的那条被丢
    for (const text of ["m1", "m2", "m3"]) {
      queue.offer({ key: "wechat:g", label: "群", run: async () => ran.push(text) });
    }

    const stats = queue.stats("wechat:g");
    expect(stats.depth).toBe(2);
    expect(stats.lastError).toContain("排队超过");

    release?.();
    await sleep(60);
    expect(ran).toEqual(["running", "m2", "m3"]);
    expect(queue.totalDepth()).toBe(0);
  });

  it("任务抛错会记日志，且不影响后续任务继续跑", async () => {
    const warnings: string[] = [];
    const queue = makeQueue(20, (message) => warnings.push(message));
    const done: string[] = [];
    queue.offer({
      key: "wechat:c",
      label: "C",
      run: async () => {
        throw new Error("模型挂了");
      },
    });
    queue.offer({
      key: "wechat:c",
      label: "C",
      run: async () => {
        done.push("next-ok");
      },
    });

    await sleep(60);
    expect(done).toEqual(["next-ok"]);
    // 失败必须留下痕迹（日志），成功之后状态字段可以恢复成"没问题"
    expect(warnings.join(" ")).toContain("模型挂了");
  });
});
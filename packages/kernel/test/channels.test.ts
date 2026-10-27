/**
 * 通道出站/入站服务测试：白名单一票否决、unknown 永不重试、30 秒去重、租约保底释放。
 *
 * 用假 PluginService（只实现 ChannelService 用到的接口 + 脚本化 call 返回值），
 * 不启动真实插件进程；真实进程/管道由 plugin-lifecycle.test.ts 覆盖。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelInfo, PluginInfo } from "@anteros/shared";
import { Db } from "../src/db/database.js";
import type { KernelDeps } from "../src/contracts.js";
import { ChannelService } from "../src/services/channels.js";
import type { PluginService } from "../src/services/plugins.js";
import type { HostPorts } from "../src/plugins/types.js";
import type { LogSink } from "../src/util/log.js";

const CH = "test.channel";

const silentLog: LogSink = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

type Reply = (params: Record<string, unknown>) => unknown;

class FakePlugins {
  readonly calls: Array<{ pluginId: string; method: string; params: unknown; opts: unknown }> = [];
  readonly events: Array<{ method: string; params: unknown }> = [];
  readonly replies = new Map<string, Reply>();
  ports: Partial<HostPorts> = {};
  channelsProvider: (() => ChannelInfo[]) | null = null;

  constructor(public infos: PluginInfo[]) {}

  list(): PluginInfo[] {
    return this.infos;
  }

  attachPorts(partial: Partial<HostPorts>): void {
    this.ports = { ...this.ports, ...partial };
  }

  attachChannelsProvider(provider: () => ChannelInfo[]): void {
    this.channelsProvider = provider;
  }

  emitEvent(method: string, params: unknown): void {
    this.events.push({ method, params });
  }

  async call(pluginId: string, method: string, params: unknown, opts?: unknown): Promise<unknown> {
    this.calls.push({ pluginId, method, params, opts });
    const handler = this.replies.get(method);
    if (!handler) throw new Error(`测试未脚本化该调用：${method}`);
    return handler((params ?? {}) as Record<string, unknown>);
  }

  async panicStop(): Promise<{ stopped: string[]; restored: boolean; message: string }> {
    return { stopped: [CH], restored: true, message: "已停用" };
  }

  countOf(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  methodsInOrder(): string[] {
    return this.calls.map((call) => call.method);
  }
}

interface Harness {
  service: ChannelService;
  plugins: FakePlugins;
  db: Db;
  deps: KernelDeps;
  setAllowlist: (list: string[]) => void;
  close: () => void;
}

function channelInfo(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: CH,
    name: "测试通道",
    version: "1.0.0",
    kernelApi: "1.0",
    kind: "channel",
    description: "通道服务测试用插件",
    riskLevel: "high",
    capabilities: ["channel.read", "channel.write", "channel.lease"],
    permissions: [],
    granted: ["channel.read", "channel.write", "channel.lease"],
    status: "running",
    enabled: true,
    config: {},
    // 通道插件用 health.attachments 报「真的接上了吗」，这里模拟一个已接上的通道。
    health: {
      ok: true,
      status: "ok",
      message: "healthy",
      checkedTs: Date.now(),
      attachments: { read: true, write: true },
    },
    issues: [],
    ...overrides,
  };
}

function createHarness(infos: PluginInfo[] = [channelInfo()]): Harness {
  const db = new Db(":memory:");
  db.migrate();
  const deps: KernelDeps = { db, log: silentLog, userId: 1, agentId: 1, tz: "Asia/Shanghai" };
  const plugins = new FakePlugins(infos);
  const service = new ChannelService(deps, plugins as unknown as PluginService);
  return {
    service,
    plugins,
    db,
    deps,
    setAllowlist: (list: string[]) => {
      db.run("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
        `channel.allowlist.${CH}`,
        JSON.stringify(list),
      ]);
    },
    close: () => {
      service.stop();
      db.close();
    },
  };
}

function scriptSent(h: Harness): void {
  h.plugins.replies.set("plugin.channel.lease.begin", () => ({ granted: true, leaseId: "lease-1", untilTs: Date.now() + 60_000 }));
  h.plugins.replies.set("plugin.channel.send", () => ({ status: "sent", remoteMsgId: "remote-1" }));
  h.plugins.replies.set("plugin.channel.lease.end", () => ({ released: true }));
}

const opened: Harness[] = [];

function openHarness(infos?: PluginInfo[]): Harness {
  const h = createHarness(infos);
  opened.push(h);
  return h;
}

afterEach(() => {
  for (const h of opened.splice(0)) h.close();
});

async function waitFor(check: () => boolean, timeoutMs = 1_500): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

describe("白名单：一票否决", () => {
  it("未配置白名单时默认全拒，不调用插件、落审计并发告警", async () => {
    const h = openHarness();
    await expect(h.service.sendNow({ pluginId: CH, target: "rel-1", text: "晚上好" })).rejects.toMatchObject({
      code: "EPERM",
    });

    expect(h.plugins.countOf("plugin.channel.send")).toBe(0);
    expect(h.db.all("SELECT * FROM messages")).toHaveLength(0);
    expect(h.db.all("SELECT * FROM audit_log WHERE action = 'channel.send.blocked'")).toHaveLength(1);
    expect(h.plugins.events.some((event) => event.method === "event.notify")).toBe(true);
    expect(h.service.allowlist(CH)).toEqual([]);
  });

  it("白名单为空数组同样全拒", async () => {
    const h = openHarness();
    h.setAllowlist([]);
    await expect(h.service.sendNow({ pluginId: CH, target: "rel-1", text: "早上好" })).rejects.toMatchObject({
      code: "EPERM",
    });
    expect(h.plugins.countOf("plugin.channel.send")).toBe(0);
  });

  it("目标不在白名单内被拒", async () => {
    const h = openHarness();
    h.setAllowlist(["rel-2"]);
    await expect(h.service.sendNow({ pluginId: CH, target: "rel-1", text: "中午好" })).rejects.toThrow(/不在通道/);
    expect(h.plugins.countOf("plugin.channel.send")).toBe(0);
  });
});

describe("出站 outbox：sent / failed / unknown", () => {
  it("unknown 只发一次、标记 unknown、告警，绝不自动重试", async () => {
    const h = openHarness();
    h.setAllowlist(["rel-1"]);
    h.plugins.replies.set("plugin.channel.lease.begin", () => ({ granted: true, leaseId: "lease-1" }));
    h.plugins.replies.set("plugin.channel.send", () => ({ status: "unknown", detail: "回读不一致" }));
    h.plugins.replies.set("plugin.channel.lease.end", () => ({ released: true }));

    const outcome = await h.service.sendNow({ pluginId: CH, target: "rel-1", text: "把门带上" });
    expect(outcome.delivery).toBe("unknown");
    expect(h.plugins.countOf("plugin.channel.send")).toBe(1);

    const rows = h.db.all<{ delivery: string }>("SELECT delivery FROM messages");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.delivery).toBe("unknown");

    expect(h.db.all("SELECT * FROM audit_log WHERE action = 'channel.send.unknown'")).toHaveLength(1);
    const notify = h.plugins.events.find((event) => event.method === "event.notify");
    expect(notify?.params).toMatchObject({ title: "发送结果不确定" });

    // 等一会儿，确认没有任何自动重试
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.plugins.countOf("plugin.channel.send")).toBe(1);
  });

  it("成功发送后回写 sent，并在 finally 释放租约", async () => {
    const h = openHarness();
    h.setAllowlist(["rel-1"]);
    scriptSent(h);

    const outcome = await h.service.sendNow({ pluginId: CH, target: "rel-1", text: "到了" });
    expect(outcome.delivery).toBe("sent");
    expect(h.plugins.methodsInOrder()).toEqual([
      "plugin.channel.lease.begin",
      "plugin.channel.send",
      "plugin.channel.lease.end",
    ]);
    expect(h.plugins.calls[2]?.params).toEqual({ leaseId: "lease-1" });

    const rows = h.db.all<{ delivery: string }>("SELECT delivery FROM messages");
    expect(rows[0]?.delivery).toBe("sent");
  });

  it("租约未授予时标 failed 且不调用发送", async () => {
    const h = openHarness();
    h.setAllowlist(["rel-1"]);
    h.plugins.replies.set("plugin.channel.lease.begin", () => ({ granted: false }));

    const outcome = await h.service.sendNow({ pluginId: CH, target: "rel-1", text: "先别发" });
    expect(outcome.delivery).toBe("failed");
    expect(h.plugins.countOf("plugin.channel.send")).toBe(0);
    expect(h.plugins.countOf("plugin.channel.lease.end")).toBe(0);
    const rows = h.db.all<{ delivery: string }>("SELECT delivery FROM messages");
    expect(rows[0]?.delivery).toBe("failed");
  });
});

describe("30 秒内同目标同文本去重", () => {
  it("第二次返回原 messageId，且只调用一次插件", async () => {
    const h = openHarness();
    h.setAllowlist(["rel-1"]);
    scriptSent(h);

    const first = await h.service.sendNow({ pluginId: CH, target: "rel-1", text: "晚安" });
    const second = await h.service.sendNow({ pluginId: CH, target: "rel-1", text: "晚安" });

    expect(second.messageId).toBe(first.messageId);
    expect(second.delivery).toBe("pending");
    expect(h.plugins.countOf("plugin.channel.send")).toBe(1);
    expect(h.db.all("SELECT * FROM messages")).toHaveLength(1);

    // 同文本不同目标不算重复
    h.plugins.replies.set("plugin.channel.lease.begin", () => ({ granted: true, leaseId: "lease-2" }));
    h.setAllowlist(["rel-1", "rel-2"]);
    const third = await h.service.sendNow({ pluginId: CH, target: "rel-2", text: "晚安" });
    expect(third.messageId).not.toBe(first.messageId);
    expect(h.plugins.countOf("plugin.channel.send")).toBe(2);
  });
});

describe("list()：内置 App 通道 + 能力推导", () => {
  it("内置 App 内通道永远可用，外部通道按 manifest 推导能力", () => {
    const h = openHarness([
      channelInfo(),
      channelInfo({ id: "test.readonly", name: "只读通道", riskLevel: "low", capabilities: ["channel.read"] }),
      channelInfo({ id: "test.off", name: "停用通道", enabled: false, status: "disabled" }),
    ]);

    const list = h.service.list();
    expect(list).toHaveLength(4);

    const app = list[0];
    expect(app?.pluginId).toBe("core.app-channel");
    expect(app?.kind).toBe("app");
    expect(app?.enabled).toBe(true);
    expect(app?.writeReady).toBe(true);
    expect(app?.capabilities.riskLevel).toBe("none");

    const external = list.find((item) => item.pluginId === CH);
    expect(external?.kind).toBe("external");
    expect(external?.capabilities.riskLevel).toBe("red");
    expect(external?.capabilities.writeIsDeterministic).toBe(true);
    expect(external?.capabilities.readCanBackfill).toBe(true);
    expect(external?.writeReady).toBe(true);

    const readonly = list.find((item) => item.pluginId === "test.readonly");
    expect(readonly?.capabilities.writeIsDeterministic).toBe(false);
    expect(readonly?.capabilities.riskLevel).toBe("none");
    expect(readonly?.writeReady).toBe(false);

    // 只声明了 channel.write、但插件自己没报 attachments.write（骨架尚未接上本体）：不算可写通道。
    const declaredOnly = channelInfo({
      id: "test.declared",
      name: "光声明没接上",
      health: { ok: true, status: "ok", message: "骨架已就绪，未接入", checkedTs: Date.now() },
    });
    const declaredList = openHarness([channelInfo(), declaredOnly]).service.list();
    const declared = declaredList.find((item) => item.pluginId === "test.declared");
    expect(declared?.capabilities.writeIsDeterministic).toBe(false);
    expect(declared?.writeReady).toBe(false);

    const off = list.find((item) => item.pluginId === "test.off");
    expect(off?.enabled).toBe(false);
    expect(off?.writeReady).toBe(false);

    expect(h.plugins.channelsProvider?.()).toHaveLength(4);
  });
});

describe("端口接线与入站轮询", () => {
  it("outbox 端口入队后异步发送；inbox 端口能取回用户消息", async () => {
    const h = openHarness();
    h.setAllowlist(["rel-1"]);
    scriptSent(h);

    const queued = await h.plugins.ports.outbox?.send({
      pluginId: CH,
      target: "rel-1",
      parts: ["第一行", "第二行"],
      deadlineTs: Date.now() + 60_000,
    });
    expect(queued).toMatchObject({ status: "queued" });
    expect(queued?.outboxId).toBeGreaterThan(0);
    const stored = h.db.get<{ text: string }>("SELECT text FROM messages WHERE id = ?", [queued?.outboxId]);
    expect(stored?.text).toBe("第一行\n第二行");
    await waitFor(() => h.db.get<{ delivery: string }>("SELECT delivery FROM messages WHERE id = ?", [queued?.outboxId])?.delivery === "sent");

    h.db.run(
      "INSERT INTO messages(agent_id, role, text, ts, channel_id, delivery) VALUES(?,?,?,?,?,?)",
      [1, "user", "你在吗", Date.now(), CH, "sent"],
    );
    const inbox = (await h.plugins.ports.inbox?.next({ channelId: CH, limit: 5, pluginId: CH })) as
      | Array<{ text: string; channelId: string }>
      | undefined;
    expect(inbox).toHaveLength(1);
    expect(inbox?.[0]).toMatchObject({ text: "你在吗", channelId: CH });
  });

  it("入站按水位去重，撤回只发 revoke.detected 不恢复原文", async () => {
    const h = openHarness();
    let payload: unknown[] = [
      { msgId: "m1", target: "rel-1", senderName: "对方", text: "在吗", ts: 1_000, direction: "in" },
    ];
    h.plugins.replies.set("plugin.channel.read_since", () => ({ messages: payload, hasMore: false, waterline: 1_000 }));

    await h.service.pollInbound();
    expect(h.plugins.countOf("plugin.channel.read_since")).toBe(1);
    expect(h.plugins.events.filter((event) => event.method === "event.message")).toHaveLength(1);
    const inbound = h.db.all<{ role: string; text: string; channel_id: string; delivery: string }>(
      "SELECT role, text, channel_id, delivery FROM messages",
    );
    expect(inbound).toEqual([{ role: "user", text: "在吗", channel_id: CH, delivery: "sent" }]);
    const waterline = h.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [
      `channel.waterline.${CH}`,
    ]);
    expect(waterline?.value).toBe("1000");

    // 同一 msgId 再轮询不会重复入库
    await h.service.pollInbound();
    expect(h.db.all("SELECT * FROM messages")).toHaveLength(1);
    expect(h.plugins.events.filter((event) => event.method === "event.message")).toHaveLength(1);

    // 撤回：只记事件
    payload = [{ msgId: "m2", target: "rel-1", senderName: "对方", text: "", ts: 2_000, direction: "in" }];
    await h.service.pollInbound();
    expect(h.plugins.events.filter((event) => event.method === "revoke.detected")).toHaveLength(1);
    expect(h.db.all("SELECT * FROM messages")).toHaveLength(1);
  });

  it("一键停用转发给宿主", async () => {
    const h = openHarness();
    const result = await h.service.panicStop();
    expect(result.stopped).toEqual([CH]);
    expect(result.restored).toBe(true);
  });
});

/**
 * 插件生命周期集成测试：Windows 命名管道真跑（node:net），假插件在 test/fixtures 里。
 *
 * 覆盖：握手成功→running、disable 后调用被拒、握手版本不符被断开且内核照常、
 * 未授权调用 EPERM、崩溃 1s/5s/30s 退避三次失败→disabled 且内核不退出。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Db } from "../src/db/database.js";
import type { KernelDeps } from "../src/contracts.js";
import { GrantStore } from "../src/plugins/grants.js";
import { PluginHost } from "../src/plugins/host.js";
import { PluginRegistry } from "../src/plugins/registry.js";
import { SecretStore } from "../src/plugins/secrets.js";
import type { HostPorts } from "../src/plugins/types.js";
import type { LogSink } from "../src/util/log.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-plugin.mjs", import.meta.url));

const silentLog: LogSink = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const stubPorts: HostPorts = {
  memory: {
    search: () => {
      throw new Error("测试未接线记忆端口");
    },
    remember: () => {
      throw new Error("测试未接线记忆端口");
    },
  },
  context: {
    assemble: () => {
      throw new Error("测试未接线上下文端口");
    },
  },
  outbox: {
    send: () => {
      throw new Error("测试未接线出站端口");
    },
  },
  inbox: {
    next: () => {
      throw new Error("测试未接线收件箱端口");
    },
  },
  consent: {
    check: () => ({ ok: true, consentVersion: "test" }),
  },
  audit: {
    log: () => undefined,
  },
  metrics: {
    emit: () => undefined,
  },
};

interface Harness {
  root: string;
  db: Db;
  host: PluginHost;
  events: Array<{ method: string; params: unknown }>;
  cleanup: () => Promise<void>;
}

function manifest(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `测试插件 ${id}`,
    version: "1.0.0",
    kernel_api: ">=1.0 <2.0",
    kind: "processor",
    description: "生命周期测试用假插件",
    entry: { command: "index.mjs", args: [] },
    capabilities: [],
    permissions: [],
    risk_level: "low",
    ...overrides,
  };
}

async function createHarness(
  entries: Array<{ manifest: Record<string, unknown>; mode?: "normal" | "crash" | "badapi" | "noauth" }>,
): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anteros-host-"));
  for (const entry of entries) {
    const pluginDir = path.join(root, String(entry.manifest.id));
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify(entry.manifest, null, 2), "utf8");
    fs.copyFileSync(FIXTURE, path.join(pluginDir, "index.mjs"));
    fs.writeFileSync(path.join(pluginDir, "mode.txt"), entry.mode ?? "normal", "utf8");
  }

  const db = new Db(":memory:");
  db.migrate();
  const deps: KernelDeps = { db, log: silentLog, userId: 1, agentId: 1, tz: "Asia/Shanghai" };
  const registry = new PluginRegistry(db, silentLog, { pluginsDir: root });
  registry.scan();
  const secrets = new SecretStore(root, { masterKey: null, log: silentLog });
  const grants = new GrantStore(db, () => undefined);
  const events: Array<{ method: string; params: unknown }> = [];

  const host = new PluginHost({
    deps,
    registry,
    secrets,
    grants,
    ports: stubPorts,
    emit: (method, params) => {
      events.push({ method, params });
    },
    log: silentLog,
    options: {
      pluginsDir: root,
      dataDir: root,
      handshakeTimeoutMs: 3_000,
      disableGraceMs: 400,
      crashBackoffMs: [10, 20, 30],
      autoRestart: true,
      grantOnEnable: false,
      heartbeatMs: 30_000,
      healthIntervalMs: 60_000,
    },
  });

  return {
    root,
    db,
    host,
    events,
    cleanup: async () => {
      await host.shutdown();
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function statusOf(harness: Harness, pluginId: string): string | undefined {
  return harness.host.list().find((info) => info.id === pluginId)?.status;
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

const harnesses: Harness[] = [];

async function harness(
  entries: Array<{ manifest: Record<string, unknown>; mode?: "normal" | "crash" | "badapi" | "noauth" }>,
): Promise<Harness> {
  const created = await createHarness(entries);
  harnesses.push(created);
  return created;
}

afterEach(async () => {
  for (const item of harnesses.splice(0)) await item.cleanup();
});

describe("插件宿主生命周期", () => {
  it("握手成功后 running；disable 后进程消失、调用被拒", async () => {
    const h = await harness([{ manifest: manifest("test.normal") }]);
    const info = await h.host.enable("test.normal");
    expect(info.status).toBe("running");
    expect(h.events.some((event) => event.method === "event.plugin")).toBe(true);

    await h.host.disable("test.normal");
    expect(statusOf(h, "test.normal")).toBe("disabled");
    await expect(h.host.call("test.normal", "plugin.health.check", {})).rejects.toThrow();
  }, 20_000);

  it("握手内核主版本不符时被断开，且内核不受影响（其它插件照常启用）", async () => {
    const h = await harness([
      { manifest: manifest("test.badapi"), mode: "badapi" },
      { manifest: manifest("test.good"), mode: "normal" },
    ]);
    await expect(h.host.enable("test.badapi")).rejects.toThrow();
    expect(statusOf(h, "test.badapi")).toBe("blocked");

    const good = await h.host.enable("test.good");
    expect(good.status).toBe("running");
    expect(statusOf(h, "test.good")).toBe("running");
  }, 20_000);

  it("未授权的能力调用返回 EPERM", async () => {
    const h = await harness([{ manifest: manifest("test.read", { capabilities: ["channel.read"] }) }]);
    await h.host.enable("test.read");
    await expect(
      h.host.call("test.read", "plugin.channel.read_since", { sinceTs: 0, limit: 10 }),
    ).rejects.toMatchObject({ code: "EPERM" });
  }, 20_000);

  it("崩溃后按退避重启，连续三次失败自动 disabled，内核继续存活", async () => {
    const h = await harness([{ manifest: manifest("test.crash"), mode: "crash" }]);
    await h.host.enable("test.crash");

    const disabled = await waitFor(() => statusOf(h, "test.crash") === "disabled", 12_000);
    expect(disabled).toBe(true);
    // 内核没被插件拖垮：还能正常列插件、发事件
    expect(h.host.list().length).toBe(1);
    expect(h.events.some((event) => event.method === "event.health")).toBe(true);
    const crashEvents = h.db.all<{ message: string }>(
      "SELECT message FROM plugin_events WHERE plugin_id = ? AND level = 'error'",
      ["test.crash"],
    );
    expect(crashEvents.length).toBeGreaterThanOrEqual(3);
  }, 25_000);
});

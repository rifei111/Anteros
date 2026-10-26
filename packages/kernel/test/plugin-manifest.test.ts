/**
 * manifest 校验与插件发现（规范 6 §4）：非法 manifest 必须被拒绝，且原因人类可读。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateManifest } from "@anteros/shared";
import { Db } from "../src/db/database.js";
import { PluginRegistry } from "../src/plugins/registry.js";
import type { LogSink } from "../src/util/log.js";

const silentLog: LogSink = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const tempDirs: string[] = [];
const dbs: Db[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anteros-manifest-"));
  tempDirs.push(dir);
  return dir;
}

function freshDb(): Db {
  const db = new Db(":memory:");
  db.migrate();
  dbs.push(db);
  return db;
}

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "test.manifest",
    name: "测试插件",
    version: "1.0.0",
    kernel_api: ">=1.0 <2.0",
    kind: "processor",
    description: "manifest 校验测试用",
    entry: { command: "index.mjs", args: [] },
    capabilities: [],
    permissions: [],
    risk_level: "low",
    ...overrides,
  };
}

function errorsText(result: ReturnType<typeof validateManifest>): string {
  return result.ok ? "" : result.errors.join("\n");
}

function writePlugin(dir: string, manifest: Record<string, unknown>): string {
  const pluginDir = path.join(dir, String(manifest.id ?? "plugin"));
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(path.join(pluginDir, "index.mjs"), "// fake entry\n", "utf8");
  return pluginDir;
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("validateManifest 拒绝非法 manifest", () => {
  it("缺少 kernel_api 时拒绝并给出可读原因", () => {
    const raw = baseManifest();
    delete raw.kernel_api;
    const result = validateManifest(raw, { kernelApiMajor: "1" });
    expect(result.ok).toBe(false);
    expect(errorsText(result)).toContain("kernel_api");
  });

  it("声明未知权限时整份拒绝", () => {
    const result = validateManifest(baseManifest({ permissions: ["totally.unknown:thing"] }), {
      kernelApiMajor: "1",
    });
    expect(result.ok).toBe(false);
    expect(errorsText(result)).toMatch(/权限/);
  });

  it("高危插件缺少 resources / healthcheck 时拒绝", () => {
    const result = validateManifest(baseManifest({ risk_level: "high" }), { kernelApiMajor: "1" });
    expect(result.ok).toBe(false);
    const text = errorsText(result);
    expect(text).toMatch(/resources|healthcheck/);
  });

  it("声明 channel.write 却未声明 channel.lease 时拒绝（写必须持租约）", () => {
    const result = validateManifest(
      baseManifest({ capabilities: ["channel.read", "channel.write"] }),
      { kernelApiMajor: "1" },
    );
    expect(result.ok).toBe(false);
    expect(errorsText(result)).toMatch(/lease|租约/);
  });
});

describe("PluginRegistry 发现插件", () => {
  it("无效 manifest 不入库，但 issues 可读", () => {
    const dir = tempDir();
    writePlugin(dir, { id: "bad.plugin", name: "坏插件" });
    const db = freshDb();
    const registry = new PluginRegistry(db, silentLog, { pluginsDir: dir });
    const scan = registry.scan();

    expect(scan.invalid.length).toBe(1);
    expect(scan.plugins.length).toBe(0);
    expect(scan.invalid[0]?.issues.join("\n")).toMatch(/kernel_api/);
    const rows = db.all<{ id: string }>("SELECT id FROM plugins");
    expect(rows).toHaveLength(0);
  });

  it("高危插件首次入库默认 disabled；同版本重扫保留用户 enabled/config", () => {
    const dir = tempDir();
    writePlugin(
      dir,
      baseManifest({
        id: "test.high",
        risk_level: "high",
        resources: { max_memory_mb: 256, call_timeout_ms: 10000 },
        healthcheck: { method: "plugin.health.check", interval_ms: 30000, timeout_ms: 5000 },
      }),
    );
    const db = freshDb();
    const registry = new PluginRegistry(db, silentLog, { pluginsDir: dir });
    registry.scan();

    interface PluginRow {
      id: string;
      enabled: number;
      status: string;
      config: string;
      version: string;
      last_error: string | null;
    }
    let row = db.get<PluginRow>("SELECT * FROM plugins WHERE id = ?", ["test.high"]);
    expect(row?.enabled).toBe(0);
    expect(row?.status).toBe("disabled");

    // 用户手动启用并改过配置
    db.run("UPDATE plugins SET enabled = 1, status = 'enabled', config = ? WHERE id = ?", [
      JSON.stringify({ mode: "user" }),
      "test.high",
    ]);
    registry.scan();
    row = db.get<PluginRow>("SELECT * FROM plugins WHERE id = ?", ["test.high"]);
    expect(row?.enabled).toBe(1);
    expect(row?.config).toBe(JSON.stringify({ mode: "user" }));

    // 版本变化：不做热升级，停用并等确认
    writePlugin(
      dir,
      baseManifest({
        id: "test.high",
        version: "1.1.0",
        risk_level: "high",
        resources: { max_memory_mb: 256, call_timeout_ms: 10000 },
        healthcheck: { method: "plugin.health.check", interval_ms: 30000, timeout_ms: 5000 },
      }),
    );
    registry.scan();
    row = db.get<PluginRow>("SELECT * FROM plugins WHERE id = ?", ["test.high"]);
    expect(row?.version).toBe("1.1.0");
    expect(row?.enabled).toBe(0);
    expect(row?.status).toBe("blocked");
    expect(row?.last_error ?? "").toMatch(/升级/);
  });

  it("真入口文件缺失写进 issues，但不影响其它插件", () => {
    const dir = tempDir();
    const pluginDir = writePlugin(dir, baseManifest({ id: "test.missing-entry", entry: { command: "nope.mjs", args: [] } }));
    fs.rmSync(path.join(pluginDir, "index.mjs"));
    const db = freshDb();
    const registry = new PluginRegistry(db, silentLog, { pluginsDir: dir });
    const scan = registry.scan();
    const found = scan.plugins.find((item) => item.manifest.id === "test.missing-entry");
    expect(found).toBeDefined();
    expect(found?.issues.join("\n")).toMatch(/入口文件不存在/);
  });
});

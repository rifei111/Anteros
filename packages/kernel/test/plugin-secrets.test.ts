/**
 * 二次确认 token 的动作归一 + 插件密钥录入（用户实测的两个 bug 的回归测试）。
 *
 * 1) 界面按 RPC 方法名申请 token（plugins.enable），插件宿主按规范里的短名消费（plugin.enable），
 *    两者必须能对上——否则高危插件永远启用不了。
 * 2) 插件声明了密钥却没有任何入口录入时，永远被判「缺少密钥」；录入后 `missingSecrets` 必须实时清空，
 *    且过期的告警文案不能继续挂在 `issues` 上。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Db } from "../src/db/database.js";
import { PluginRegistry } from "../src/plugins/registry.js";
import { SecretStore } from "../src/plugins/secrets.js";
import { loadOrCreateMasterKey } from "../src/util/crypto.js";
import { AuditService } from "../src/services/audit.js";
import { PermissionsService } from "../src/services/permissions.js";
import type { LogSink } from "../src/util/log.js";

const silentLog: LogSink = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const dbs: Db[] = [];
const dirs: string[] = [];

function freshDb(): Db {
  const db = new Db(":memory:");
  db.migrate();
  db.run(
    `INSERT INTO users(id, role, created_ts, tz) VALUES (1, 'owner', ?, 'Asia/Shanghai')`,
    [Date.now()],
  );
  dbs.push(db);
  return db;
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anteros-confirm-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("确认 token 的动作名归一", () => {
  it("界面用 plugins.enable 申请、宿主用 plugin.enable 消费，能对上", () => {
    const db = freshDb();
    const permissions = new PermissionsService(db, 1, new AuditService(db, 1));
    const created = permissions.createConfirm("plugins.enable", "core.llm-router");
    expect(() => permissions.consumeConfirm(created.token, "plugin.enable", "core.llm-router")).not.toThrow();
  });

  it("反向也成立：短名申请、方法名消费", () => {
    const db = freshDb();
    const permissions = new PermissionsService(db, 1, new AuditService(db, 1));
    const created = permissions.createConfirm("plugin.grant", "channel.wechat-replica");
    expect(() => permissions.consumeConfirm(created.token, "plugins.grant", "channel.wechat-replica")).not.toThrow();
  });

  it("真正不同的动作仍然拒绝（不能因为归一而放水）", () => {
    const db = freshDb();
    const permissions = new PermissionsService(db, 1, new AuditService(db, 1));
    const created = permissions.createConfirm("plugins.enable", "core.llm-router");
    expect(() => permissions.consumeConfirm(created.token, "plugins.grant", "core.llm-router")).toThrow(/不匹配/);
  });

  it("token 只能消费一次", () => {
    const db = freshDb();
    const permissions = new PermissionsService(db, 1, new AuditService(db, 1));
    const created = permissions.createConfirm("plugins.enable", "x");
    permissions.consumeConfirm(created.token, "plugin.enable", "x");
    expect(() => permissions.consumeConfirm(created.token, "plugin.enable", "x")).toThrow(/已使用/);
  });
});

describe("插件密钥", () => {
  it("录入后 has() 为真，删除后为假", () => {
    const dir = tempDir();
    const secrets = new SecretStore(dir, { masterKey: loadOrCreateMasterKey(dir), log: silentLog });
    expect(secrets.has("core.llm-router", "llm.api_key")).toBe(false);
    secrets.set("core.llm-router", "llm.api_key", "sk-test");
    expect(secrets.has("core.llm-router", "llm.api_key")).toBe(true);
    expect(secrets.get("core.llm-router", "llm.api_key")).toBe("sk-test");
    secrets.delete("core.llm-router", "llm.api_key");
    expect(secrets.has("core.llm-router", "llm.api_key")).toBe(false);
  });

  it("插件目录里的 manifest 声明了密钥，注册表能报出来", () => {
    const db = freshDb();
    const registry = new PluginRegistry(db, silentLog, { pluginsDir: path.resolve(process.cwd(), "plugins") });
    registry.scan();
    const router = registry.get("core.llm-router");
    expect(router?.manifest.secrets).toContain("llm.api_key");
    const media = registry.get("core.media");
    expect(media?.manifest.secrets).toContain("media.api_key");
  });
});

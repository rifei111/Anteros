import { SCHEMA_VERSION } from "../src/db/schema";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db/database";

const dirs: string[] = [];
function open(): Db {
  const dir = mkdtempSync(join(tmpdir(), "anteros-migrate-"));
  dirs.push(dir);
  return new Db(join(dir, "test.sqlite"));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("数据库迁移", () => {
  it("新建库直接到当前版本", () => {
    const db = open();
    db.migrate();
    const row = db.get<{ user_version: number }>("PRAGMA user_version");
    expect(row?.user_version).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("半途迁移过的库再次 migrate 不报 duplicate column", () => {
    const db = open();
    db.migrate();
    // 模拟：列已经手工补过，但版本号被改回 1（断电/手动修库都会这样）
    db.exec("PRAGMA user_version = 1");
    expect(() => db.migrate()).not.toThrow();
    const columns = db.all<{ name: string }>("PRAGMA table_info(messages)").map((column) => column.name);
    expect(columns).toContain("sender_name");
    expect(columns).toContain("sender_id");
    db.close();
  });

  it("老库（v1）迁移后补上发送者两列", () => {
    const db = open();
    db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER, role TEXT, text TEXT, ts INTEGER)");
    db.exec("PRAGMA user_version = 1");
    db.migrate();
    const columns = db.all<{ name: string }>("PRAGMA table_info(messages)").map((column) => column.name);
    expect(columns).toContain("sender_name");
    expect(columns).toContain("sender_id");
    db.close();
  });
});

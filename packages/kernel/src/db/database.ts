/**
 * SQLite 访问层（node:sqlite，同步 API 即可：内核是单进程单写入者）。
 *
 * 这一层只做三件事：连接、事务、参数归一化。业务语义一律留给 service 层
 * （规范 1 §0 硬约束 3：单一写入入口）。
 */
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
import { AnterosError, ERROR_CODES } from "@anteros/shared";

export type SqlValue = string | number | null | Uint8Array;
export type SqlParams = SqlValue[];

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export class Db {
  readonly path: string;
  private readonly handle: DatabaseSync;
  private txDepth = 0;

  constructor(path: string) {
    this.path = path;
    this.handle = new DatabaseSync(path);
    this.handle.exec("PRAGMA foreign_keys = ON;");
    this.handle.exec("PRAGMA busy_timeout = 5000;");
  }

  /** 建表 + 迁移到当前 schema 版本。可重复调用。 */
  migrate(): void {
    const row = this.get<{ user_version: number }>("PRAGMA user_version");
    const current = row?.user_version ?? 0;
    if (current === 0) {
      this.handle.exec(SCHEMA_SQL);
      this.handle.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
      return;
    }
    if (current > SCHEMA_VERSION) {
      throw new AnterosError(ERROR_CODES.EVERSION, `数据库版本 ${current} 高于内核支持的 ${SCHEMA_VERSION}，请升级应用`);
    }
    // 迁移只加列、两版删列（规范 1 §6.2）。
    if (current < 2) {
      // v1 → v2：群聊要显示是谁说的，messages 加两列。
      // 先查 PRAGMA 再 ALTER：库里可能已被手工补过列（或迁移中途断电），
      // 重复 ALTER 会报 duplicate column 让应用直接起不来——必须幂等。
      const columns = new Set(this.all<{ name: string }>("PRAGMA table_info(messages)").map((column) => column.name));
      if (!columns.has("sender_name")) this.handle.exec("ALTER TABLE messages ADD COLUMN sender_name TEXT");
      if (!columns.has("sender_id")) this.handle.exec("ALTER TABLE messages ADD COLUMN sender_id TEXT");
      this.handle.exec("PRAGMA user_version = 2;");
    }
  }

  get<T>(sql: string, params: SqlParams = []): T | undefined {
    const stmt = this.handle.prepare(sql);
    const row = stmt.get(...params);
    return row === undefined ? undefined : (row as T);
  }

  all<T>(sql: string, params: SqlParams = []): T[] {
    const stmt = this.handle.prepare(sql);
    return stmt.all(...params) as T[];
  }

  run(sql: string, params: SqlParams = []): RunResult {
    const stmt = this.handle.prepare(sql);
    const result = stmt.run(...params);
    return {
      changes: Number(result.changes ?? 0),
      lastInsertRowid: Number(result.lastInsertRowid ?? 0),
    };
  }

  exec(sql: string): void {
    this.handle.exec(sql);
  }

  /** 同步事务；嵌套时合并到最外层（SQLite 不支持真正嵌套事务）。 */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth += 1;
      try {
        return fn();
      } finally {
        this.txDepth -= 1;
      }
    }
    this.handle.exec("BEGIN IMMEDIATE");
    this.txDepth = 1;
    try {
      const result = fn();
      this.handle.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.handle.exec("ROLLBACK");
      } catch {
        /* ignore rollback failure */
      }
      throw err;
    } finally {
      this.txDepth = 0;
    }
  }

  getMeta(key: string): string | null {
    const row = this.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [key]);
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.run("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
      key,
      value,
    ]);
  }

  getJson<T>(key: string, fallback: T): T {
    const raw = this.getMeta(key);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  setJson(key: string, value: unknown): void {
    this.setMeta(key, JSON.stringify(value));
  }

  close(): void {
    try {
      this.handle.close();
    } catch {
      /* already closed */
    }
  }
}

/** 把布尔、undefined 之类 JS 值转成 SQLite 能接受的值，避免调用点到处写转换。 */
export function toSql(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}
/**
 * 审计日志（规范 1 §2.9）：追加写，不存消息原文，插件不得直接写。
 * owner-only 操作必须带 confirm_token（由 PermissionsService 校验后调这里落账）。
 */
import { randomHex, sha256Hex } from "../util/crypto.js";
import type { Db } from "../db/database.js";
import type { AuditEntry } from "@anteros/shared";

export type ActorRole = "owner" | "member" | "operator" | "system";

export class AuditService {
  constructor(
    private readonly db: Db,
    private readonly userId: number,
  ) {}

  log(
    action: string,
    options: {
      actorRole?: ActorRole;
      targetAgentId?: number | null;
      before?: unknown;
      after?: unknown;
      idemKey?: string;
    } = {},
  ): number {
    const idemKey = options.idemKey ?? `${action}:${Date.now()}:${randomHex(6)}`;
    const result = this.db.run(
      `INSERT INTO audit_log(actor_user_id, actor_role, action, target_agent_id, before, after, ts, ip_hash, idem_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        this.userId,
        options.actorRole ?? "system",
        action,
        options.targetAgentId ?? null,
        options.before === undefined ? null : JSON.stringify(options.before),
        options.after === undefined ? null : JSON.stringify(options.after),
        Date.now(),
        sha256Hex(`local:${this.userId}`).slice(0, 32),
        idemKey,
      ],
    );
    return result.lastInsertRowid;
  }

  list(limit = 100, beforeId?: number): AuditEntry[] {
    const rows = beforeId
      ? this.db.all<AuditRow>("SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?", [beforeId, limit])
      : this.db.all<AuditRow>("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", [limit]);
    return rows.map(toEntry);
  }
}

interface AuditRow {
  id: number;
  actor_role: ActorRole;
  action: string;
  target_agent_id: number | null;
  before: string | null;
  after: string | null;
  ts: number;
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    actorRole: row.actor_role,
    action: row.action,
    targetAgentId: row.target_agent_id,
    before: parseJson(row.before),
    after: parseJson(row.after),
    ts: row.ts,
  };
}
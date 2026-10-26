/**
 * 插件能力授权（规范 6 §3.2 / 草案 14.6）。
 *
 * 默认全拒：plugin_grants 里没有有效行就拒绝，抛 EPERM/EGRANT。
 * 授权变更必须写审计（通过注入的 audit 回调，生产环境接 AuditService）。
 */
import { AnterosError, ERROR_CODES } from "@anteros/shared";
import type { Db } from "../db/database.js";
import type { AuditFn } from "./types.js";

interface GrantRow {
  capability: string;
}

export class GrantStore {
  constructor(
    private readonly db: Db,
    private readonly audit?: AuditFn,
  ) {}

  /** 已生效的授权（撤销的 revoked_ts 非空，不算）。 */
  list(pluginId: string): string[] {
    return this.db
      .all<GrantRow>(
        "SELECT capability FROM plugin_grants WHERE plugin_id = ? AND revoked_ts IS NULL ORDER BY capability",
        [pluginId],
      )
      .map((row) => row.capability);
  }

  isGranted(pluginId: string, capability: string): boolean {
    const row = this.db.get<GrantRow>(
      "SELECT capability FROM plugin_grants WHERE plugin_id = ? AND capability = ? AND revoked_ts IS NULL",
      [pluginId, capability],
    );
    return row !== undefined;
  }

  /** 未授权即拒绝（默认全拒）。 */
  require(pluginId: string, capability: string): void {
    if (!this.isGranted(pluginId, capability)) {
      throw new AnterosError(ERROR_CODES.EPERM, `插件 ${pluginId} 未获授权：${capability}`, {
        hint: "默认全拒：需要用户在该插件详情里显式授权后才能调用",
      });
    }
  }

  grant(pluginId: string, capabilities: readonly string[]): string[] {
    const now = Date.now();
    for (const capability of capabilities) {
      this.db.run(
        `INSERT INTO plugin_grants(plugin_id, capability, granted_ts) VALUES (?, ?, ?)
         ON CONFLICT(plugin_id, capability) DO UPDATE SET granted_ts = excluded.granted_ts, revoked_ts = NULL`,
        [pluginId, capability, now],
      );
    }
    this.audit?.("plugin.grant", { pluginId, capabilities: [...capabilities] });
    return this.list(pluginId);
  }

  revoke(pluginId: string, capabilities: readonly string[]): string[] {
    const now = Date.now();
    for (const capability of capabilities) {
      this.db.run("UPDATE plugin_grants SET revoked_ts = ? WHERE plugin_id = ? AND capability = ?", [
        now,
        pluginId,
        capability,
      ]);
    }
    this.audit?.("plugin.revoke", { pluginId, capabilities: [...capabilities] });
    return this.list(pluginId);
  }

  /** 卸载插件时清空授权。 */
  clear(pluginId: string): void {
    this.db.run("DELETE FROM plugin_grants WHERE plugin_id = ?", [pluginId]);
  }
}

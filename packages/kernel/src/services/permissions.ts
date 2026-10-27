/**
 * 权限与二次确认（草案 2.9 / 规范 1 §2.9 硬约束）。
 *
 * - owner 是构建期配置的唯一本机用户；单机闭环里本机唯一用户即 owner，
 *   但角色仍然从 users.role 读，不用"是不是本机"隐式判断。
 * - 危险操作必须带一次性 confirm_token（60 秒，用掉即废）。
 * - 插件能力默认全拒，授权落在 plugin_grants。
 */
import { CONFIRM_TOKEN_TTL_MS, AnterosError, ERROR_CODES } from "@anteros/shared";
import type { OwnerStatus } from "@anteros/shared";
import type { Db } from "../db/database.js";
import { randomHex } from "../util/crypto.js";
import type { AuditService } from "./audit.js";

interface RoleRow {
  role: "owner" | "member" | "operator";
}

interface TokenRow {
  token: string;
  action: string;
  target: string | null;
  expires_ts: number;
  used: number;
}

/**
 * 把"同一件事的不同叫法"归一：界面按 RPC 方法名申请 token（plugins.enable），
 * 插件宿主内部按规范里的短名消费（plugin.enable）。两者语义相同，不该因此互相拒绝。
 */
function normalizeConfirmAction(action: string): string {
  const trimmed = action.trim().toLowerCase();
  if (trimmed.startsWith("plugins.")) return `plugin.${trimmed.slice("plugins.".length)}`;
  if (trimmed.startsWith("channels.")) return `channel.${trimmed.slice("channels.".length)}`;
  return trimmed;
}

export class PermissionsService {
  constructor(
    private readonly db: Db,
    private readonly userId: number,
    private readonly audit: AuditService,
  ) {}

  ownerStatus(): OwnerStatus {
    const row = this.db.get<RoleRow>("SELECT role FROM users WHERE id = ?", [this.userId]);
    const role = row?.role ?? "owner";
    return {
      isOwner: role === "owner",
      ownerWechatConfigured: Boolean(process.env.ANTEROS_OWNER_WECHAT_ID),
      role,
    };
  }

  assertOwner(action = "该操作"): void {
    if (!this.ownerStatus().isOwner) {
      throw new AnterosError(ERROR_CODES.EOWNER, `${action}只有 owner 可以做`, {
        hint: "owner 入口只在本人这台 Windows 客户端上开放",
      });
    }
  }

  /** 生成一次性确认 token；action 用英文短标识，target 是对象 id。 */
  createConfirm(action: string, target?: string): { token: string; expiresTs: number } {
    const token = randomHex(16);
    const expiresTs = Date.now() + CONFIRM_TOKEN_TTL_MS;
    this.db.run("INSERT INTO confirm_tokens(token, action, target, expires_ts, used) VALUES (?, ?, ?, ?, 0)", [
      token,
      action,
      target ?? null,
      expiresTs,
    ]);
    // 顺手清理过期 token，避免表无限增长
    this.db.run("DELETE FROM confirm_tokens WHERE expires_ts < ? OR used = 1", [Date.now() - 60_000]);
    return { token, expiresTs };
  }

  /** 校验并消费 token；不匹配/过期/已用都拒绝。 */
  consumeConfirm(token: string | undefined, action: string, target?: string): void {
    if (!token) {
      throw new AnterosError(ERROR_CODES.ECONFIRM, "这个操作需要二次确认", {
        hint: "界面会先弹确认框，确认后会带上一次性 token",
      });
    }
    const row = this.db.get<TokenRow>("SELECT * FROM confirm_tokens WHERE token = ?", [token]);
    if (!row) throw new AnterosError(ERROR_CODES.ECONFIRM, "确认 token 无效，请重新确认");
    if (row.used === 1) throw new AnterosError(ERROR_CODES.ECONFIRM, "确认 token 已使用过，请重新确认");
    if (row.expires_ts < Date.now()) throw new AnterosError(ERROR_CODES.ECONFIRM, "确认 token 已过期（60 秒），请重新确认");
    // 同一个动作在“界面（RPC 方法名）”和“宿主内部”可能叫法不同（plugins.enable / plugin.enable），
    // 只要指向同一件事就放行，别让用户为命名差异买单。
    if (row.action !== action && normalizeConfirmAction(row.action) !== normalizeConfirmAction(action)) {
      throw new AnterosError(ERROR_CODES.ECONFIRM, `确认 token 与操作不匹配（${row.action} ≠ ${action}）`, {
        hint: "重新点一次确认按钮即可；这是 token 与动作对不上，不是权限问题",
      });
    }
    if (target !== undefined && row.target !== null && row.target !== target) {
      throw new AnterosError(ERROR_CODES.ECONFIRM, "确认 token 与目标不匹配，请重新确认");
    }
    this.db.run("UPDATE confirm_tokens SET used = 1 WHERE token = ?", [token]);
    this.audit.log(`confirm:${action}`, { actorRole: "owner", after: { target: target ?? null } });
  }

  setRole(role: "owner" | "member" | "operator"): void {
    this.db.run("UPDATE users SET role = ? WHERE id = ?", [role, this.userId]);
    this.audit.log("user.set_role", { actorRole: "system", after: { role } });
  }

  /* ---------------- 插件能力授权 ---------------- */

  isGranted(pluginId: string, capability: string): boolean {
    const row = this.db.get<{ capability: string }>(
      "SELECT capability FROM plugin_grants WHERE plugin_id = ? AND capability = ? AND revoked_ts IS NULL",
      [pluginId, capability],
    );
    return row !== undefined;
  }

  grants(pluginId: string): string[] {
    return this.db
      .all<{ capability: string }>(
        "SELECT capability FROM plugin_grants WHERE plugin_id = ? AND revoked_ts IS NULL ORDER BY capability",
        [pluginId],
      )
      .map((row) => row.capability);
  }

  grant(pluginId: string, capabilities: string[]): string[] {
    const now = Date.now();
    for (const capability of capabilities) {
      this.db.run(
        `INSERT INTO plugin_grants(plugin_id, capability, granted_ts) VALUES (?, ?, ?)
         ON CONFLICT(plugin_id, capability) DO UPDATE SET granted_ts = excluded.granted_ts, revoked_ts = NULL`,
        [pluginId, capability, now],
      );
    }
    this.audit.log("plugin.grant", { actorRole: "owner", after: { pluginId, capabilities } });
    return this.grants(pluginId);
  }

  revoke(pluginId: string, capabilities: string[]): string[] {
    const now = Date.now();
    for (const capability of capabilities) {
      this.db.run("UPDATE plugin_grants SET revoked_ts = ? WHERE plugin_id = ? AND capability = ?", [now, pluginId, capability]);
    }
    this.audit.log("plugin.revoke", { actorRole: "owner", after: { pluginId, capabilities } });
    return this.grants(pluginId);
  }
}
/**
 * 声明闸（草案 14.14.5 / 规范 1 user_consents）。
 *
 * 红线：勾选前不进应用、无快速同意、不代勾、文案版本化（改文案即新版本需重勾）。
 * 单机形态下没有真实 IP，用安装 ID 的哈希填 ip_hash 字段，保留字段语义。
 */
import { CONSENT_DOC_VERSION, CONSENT_ITEMS, AnterosError, ERROR_CODES } from "@anteros/shared";
import type { ConsentStatus } from "@anteros/shared";
import type { Db } from "../db/database.js";
import { localIpHash } from "../util/crypto.js";

interface ConsentRow {
  id: number;
  doc_version: string;
  accepted_ts: number;
  channel: string;
  checked_ids: string;
  revoked_ts: number | null;
}

export class ConsentService {
  constructor(
    private readonly db: Db,
    private readonly userId: number,
    private readonly installId: string,
  ) {}

  /** 某通道的当前状态（默认只关心 App 内通道）。 */
  status(channel = "app"): ConsentStatus {
    const row = this.latest(channel);
    const accepted = row !== null && row.revoked_ts === null && row.doc_version === CONSENT_DOC_VERSION;
    return {
      docVersion: CONSENT_DOC_VERSION,
      accepted,
      acceptedTs: accepted ? row.accepted_ts : null,
      revokedTs: row?.revoked_ts ?? null,
      needsAccept: !accepted,
      items: CONSENT_ITEMS,
      checkedIds: accepted ? safeArray(row.checked_ids) : [],
    };
  }

  /** 逐条勾选后提交。必须覆盖全部 required 项，否则拒绝（不代勾）。 */
  accept(input: { docVersion: string; checkedIds: string[]; channel?: string }): ConsentStatus {
    const channel = input.channel ?? "app";
    if (input.docVersion !== CONSENT_DOC_VERSION) {
      throw new AnterosError(ERROR_CODES.EINVALID, "声明文案已更新，请重新阅读并勾选", {
        hint: `当前版本 ${CONSENT_DOC_VERSION}`,
      });
    }
    const required = CONSENT_ITEMS.filter((item) => item.required).map((item) => item.id);
    const checked = new Set(input.checkedIds);
    const missing = required.filter((id) => !checked.has(id));
    if (missing.length > 0) {
      throw new AnterosError(ERROR_CODES.EINVALID, `还有 ${missing.length} 条声明未勾选，不能进入应用`, {
        hint: `未勾选：${missing.join(", ")}`,
      });
    }
    const now = Date.now();
    this.db.run(
      `INSERT INTO user_consents(user_id, doc_version, accepted_ts, channel, ip_hash, checked_ids, revoked_ts)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(user_id, doc_version, channel) DO UPDATE SET
         accepted_ts = excluded.accepted_ts,
         checked_ids = excluded.checked_ids,
         revoked_ts = NULL`,
      [this.userId, CONSENT_DOC_VERSION, now, channel, localIpHash(this.installId), JSON.stringify(input.checkedIds)],
    );
    return this.status(channel);
  }

  /** 撤回：退出应用 / 停用通道 / 清镜像时调用，之后写调用一律 ECONSENT。 */
  revoke(channel = "app"): ConsentStatus {
    const row = this.latest(channel);
    if (row && row.revoked_ts === null) {
      this.db.run("UPDATE user_consents SET revoked_ts = ? WHERE id = ?", [Date.now(), row.id]);
    }
    return this.status(channel);
  }

  /** 写调用前的硬校验（规范 6 §10.4）。 */
  requireConsent(channel = "app"): void {
    const status = this.status(channel);
    if (!status.accepted) {
      throw new AnterosError(ERROR_CODES.ECONSENT, "需要先阅读并逐条同意《用户声明与风险告知》", {
        hint: "打开 Anteros 时会先显示声明闸，全部勾选后才能使用",
      });
    }
  }

  hasAccepted(channel = "app"): boolean {
    return this.status(channel).accepted;
  }

  private latest(channel: string): ConsentRow | null {
    const row = this.db.get<ConsentRow>(
      "SELECT * FROM user_consents WHERE user_id = ? AND channel = ? ORDER BY id DESC LIMIT 1",
      [this.userId, channel],
    );
    return row ?? null;
  }
}

function safeArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
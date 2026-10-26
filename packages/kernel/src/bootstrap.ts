/**
 * 启动引导：准备数据目录、迁移库、落单机闭环的种子数据。
 *
 * 单机形态（草案 14.15）：一个用户、一个 agent、一份 SQLite。没有账号体系，
 * 但 users/agents/owners 表照常存在，语义保留，将来上云不用重写状态层。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MONTHLY_BUDGET_CNY, DEFAULT_TRAITS } from "@anteros/shared";
import { Db } from "./db/database.js";
import { Logger } from "./util/log.js";
import { randomHex } from "./util/crypto.js";
import { AuditService } from "./services/audit.js";
import { ConsentService } from "./services/consent.js";
import { PermissionsService } from "./services/permissions.js";
import { CostService } from "./services/cost.js";
import { SettingsService } from "./settings.js";
import type { KernelDeps } from "./contracts.js";

export interface BootOptions {
  dataDir?: string;
  tz?: string;
  appVersion?: string;
  logLevel?: "debug" | "info" | "warn" | "error";
}

export interface Runtime {
  deps: KernelDeps;
  db: Db;
  logger: Logger;
  settings: SettingsService;
  audit: AuditService;
  consent: ConsentService;
  permissions: PermissionsService;
  cost: CostService;
  installId: string;
  dataDir: string;
  dirs: { media: string; exports: string; logs: string };
  close(): void;
}

export function resolveDataDir(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (process.env.ANTEROS_DATA_DIR) return path.resolve(process.env.ANTEROS_DATA_DIR);
  const appData = process.env.APPDATA;
  return appData ? path.join(appData, "Anteros") : path.join(os.homedir(), ".anteros");
}

export function resolveTz(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.ANTEROS_TZ) return process.env.ANTEROS_TZ;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  } catch {
    return "Asia/Shanghai";
  }
}

const DEFAULT_DRIVE_PARAMS: Record<string, { rate: number; decay: number; threshold: number }> = {
  loneliness: { rate: 0.06, decay: 0.02, threshold: 0.65 },
  boredom: { rate: 0.05, decay: 0.03, threshold: 0.7 },
  longing: { rate: 0.04, decay: 0.015, threshold: 0.6 },
  tension: { rate: 0.03, decay: 0.05, threshold: 0.7 },
  fatigue: { rate: 0.02, decay: 0.08, threshold: 0.75 },
  urge_to_share: { rate: 0.05, decay: 0.04, threshold: 0.6 },
  anxiety: { rate: 0.02, decay: 0.06, threshold: 0.8 },
};

export function bootstrap(options: BootOptions = {}): Runtime {
  const dataDir = resolveDataDir(options.dataDir);
  const tz = resolveTz(options.tz);
  const dirs = {
    media: path.join(dataDir, "media"),
    exports: path.join(dataDir, "exports"),
    logs: path.join(dataDir, "logs"),
  };
  fs.mkdirSync(dirs.media, { recursive: true });
  fs.mkdirSync(dirs.exports, { recursive: true });

  const logger = new Logger({ dataDir, level: options.logLevel ?? "info" });
  const log = logger.child("bootstrap");
  const db = new Db(path.join(dataDir, "anteros.sqlite"));
  db.migrate();
  log.info(`database ready: ${db.path} (schema v${db.getMeta("schema_version") ?? "1"})`);

  const now = Date.now();
  let installId = db.getMeta("install_id");
  if (!installId) {
    installId = randomHex(16);
    db.setMeta("install_id", installId);
  }
  db.setMeta("schema_version", "1");
  db.setMeta("app_version", options.appVersion ?? process.env.ANTEROS_APP_VERSION ?? "0.1.0");
  db.setMeta("installed_ts", db.getMeta("installed_ts") ?? String(now));

  const userId = seedUser(db, tz, now);
  const personaId = seedPersona(db, now);
  const agentId = seedAgent(db, userId, personaId, now);
  seedOwner(db, userId, now);
  seedAgentState(db, agentId, now);

  const settings = new SettingsService(db);
  // 首次启动写入默认预算，之后尊重用户设置
  if (!db.getMeta("budget_seeded")) {
    settings.set("plan.budgetCny", DEFAULT_MONTHLY_BUDGET_CNY);
    db.setMeta("budget_seeded", "1");
  }

  const audit = new AuditService(db, userId);
  const consent = new ConsentService(db, userId, installId);
  const permissions = new PermissionsService(db, userId, audit);
  const cost = new CostService(db, settings, agentId);

  const deps: KernelDeps = { db, log: logger.child("kernel"), userId, agentId, tz };

  return {
    deps,
    db,
    logger,
    settings,
    audit,
    consent,
    permissions,
    cost,
    installId,
    dataDir,
    dirs,
    close() {
      logger.close();
      db.close();
    },
  };
}

function seedUser(db: Db, tz: string, now: number): number {
  const existing = db.get<{ id: number }>("SELECT id FROM users ORDER BY id LIMIT 1");
  if (existing) return existing.id;
  const result = db.run("INSERT INTO users(tz, locale, created_ts, status, role) VALUES (?, ?, ?, 'active', 'owner')", [
    tz,
    "zh-CN",
    now,
  ]);
  return result.lastInsertRowid;
}

function seedPersona(db: Db, now: number): number {
  const existing = db.get<{ id: number }>("SELECT id FROM personas ORDER BY id LIMIT 1");
  if (existing) return existing.id;
  const birthTs = now - 22 * 365 * 24 * 3600 * 1000; // 年龄锚点：不可改
  const result = db.run(
    "INSERT INTO personas(name, birth_ts, city, traits, interests, immutable, speech_style) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      "小安",
      birthTs,
      "杭州",
      JSON.stringify(DEFAULT_TRAITS),
      JSON.stringify(["纪录片", "散步时听播客", "琢磨吃的"]),
      JSON.stringify({
        background: "在另一座城市生活，做一份普通的文字类工作。",
        values: ["不喜欢被当成客服", "在意对方有没有认真听"],
        taboo: ["被当成真人替身去骗人"],
      }),
      JSON.stringify({ habits: [], punctuation: "自然", sentenceLength: "偏短" }),
    ],
  );
  return result.lastInsertRowid;
}

function seedAgent(db: Db, userId: number, personaId: number, now: number): number {
  const existing = db.get<{ id: number }>("SELECT id FROM agents ORDER BY id LIMIT 1");
  if (existing) return existing.id;
  const result = db.run("INSERT INTO agents(user_id, persona_id, created_ts, epoch, state_version, mode) VALUES (?, ?, ?, 0, 0, 'standard')", [
    userId,
    personaId,
    now,
  ]);
  return result.lastInsertRowid;
}

function seedOwner(db: Db, userId: number, now: number): void {
  // 构建期绑定（草案 2.9）：这个外部账号 ID 只作为 owner 判定口径，内核不按通道名分支。
  const ownerExternalId = process.env.ANTEROS_OWNER_WECHAT_ID ?? "";
  if (!ownerExternalId) return;
  db.run(
    "INSERT INTO owners(user_id, wechat_id, build_id, bound_ts) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET wechat_id = excluded.wechat_id",
    [userId, ownerExternalId, process.env.ANTEROS_BUILD_ID ?? "local-dev", now],
  );
}

function seedAgentState(db: Db, agentId: number, now: number): void {
  db.run("INSERT OR IGNORE INTO relation_state(agent_id, stage, intimacy, trust, mode, since_ts, transition_log) VALUES (?, 'stranger', 0, 0.5, 'standard', ?, '[]')", [agentId, now]);
  db.run(
    `INSERT OR IGNORE INTO drives_state(agent_id, loneliness, boredom, longing, tension, fatigue, urge_to_share, anxiety, params, updated_ts)
     VALUES (?, 0.2, 0.2, 0.1, 0.05, 0.15, 0.25, 0.1, ?, ?)`,
    [agentId, JSON.stringify(DEFAULT_DRIVE_PARAMS), now],
  );
  db.run("INSERT OR IGNORE INTO presence_state(agent_id, state, since_ts, confidence, source) VALUES (?, 'idle', ?, 0.4, 'default')", [agentId, now]);
}
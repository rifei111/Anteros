/**
 * 重置与清空（数据栏）。
 *
 * 两件事必须分开看：
 *  - `resetMemory`：让"它忘掉你"。只删记忆行不够——聊天记录还在上下文里，
 *    模型照样能"记得"你说过的话，所以默认连对话历史一起清（可以保留）。
 *  - `resetData`：整体重置本机数据。密钥 / 运行环境 / 插件配置三样由调用方决定留不留，
 *    其余（记忆、对话、成本、审计、日程、关系、驱动、附件）一律回到初始态。
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { Db, SqlParams } from "../db/database.js";
import type { LogSink } from "../util/log.js";

/** 会被整体重置清空的"内容表"（配置与身份表不在其中）。 */
const CONTENT_TABLES = [
  "messages",
  "turns",
  "memory_episodic",
  "memory_semantic",
  "memory_open_loops",
  "narrative_slots",
  "style_habits",
  "action_queue",
  "cost_ledger",
  "hazard_samples",
  "idempotency",
  "confirm_tokens",
  "decision_ledger",
  "exposures",
  "device_feed",
  "life_calendar",
  "roster",
  "plugin_events",
  "audit_log",
];

/** 记忆重置要动的表（比整体重置窄：不碰成本、审计、日程）。 */
const MEMORY_TABLES = ["memory_episodic", "memory_semantic", "memory_open_loops", "narrative_slots", "style_habits"];

const KEEP_SETTINGS_PREFIXES = ["llm."];
const KEEP_SETTINGS_KEYS = ["plugins.feedUrl"];

export interface ResetOptions {
  keepApiKey: boolean;
  keepRuntime: boolean;
  keepPlugins: boolean;
}

export interface ResetResult {
  tables: Record<string, number>;
  removedDirs: string[];
  kept: string[];
  resetSettings: number;
}

export interface ResetMemoryResult {
  memories: number;
  openLoops: number;
  narrative: number;
  messages: number;
  turns: number;
}

export class ResetService {
  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    private readonly log: LogSink,
  ) {}

  /** 让"它忘掉你"：记忆 + 未闭合话题 + 叙事槽位 +（默认）对话历史。 */
  resetMemory(agentId: number, options: { keepChat?: boolean } = {}): ResetMemoryResult {
    const counts = this.countMemoryRows(agentId);
    for (const table of MEMORY_TABLES) {
      this.db.run(`DELETE FROM ${table} WHERE agent_id = ?`, [agentId]);
    }
    if (options.keepChat !== true) {
      this.db.run("DELETE FROM messages WHERE agent_id = ?", [agentId]);
      this.db.run("DELETE FROM turns WHERE agent_id = ?", [agentId]);
      // idempotency 表没有 agent_id（它按 event_id 去重，单机单实例）
      this.db.run("DELETE FROM idempotency");
    }
    this.removeContents(path.join(this.dataDir, "media"));
    this.log.info(
      `memory reset: memories=${counts.memories} loops=${counts.openLoops} narrative=${counts.narrative} messages=${counts.messages} turns=${counts.turns} keepChat=${options.keepChat === true}`,
    );
    return counts;
  }

  /** 整体重置：清空本机数据，按三个开关决定留哪些"可再生的东西"。 */
  resetData(agentId: number, options: ResetOptions): ResetResult {
    const tables: Record<string, number> = {};
    for (const table of CONTENT_TABLES) {
      const agentScoped = this.hasAgentColumn(table);
      const result = agentScoped
        ? this.db.run(`DELETE FROM ${table} WHERE agent_id = ?`, [agentId])
        : this.db.run(`DELETE FROM ${table}`);
      tables[table] = Number(result.changes);
    }

    // 关系 / 驱动 / 在场回到初始态（这三张表是单行状态，不能删掉）
    this.db.run(
      "UPDATE relation_state SET stage = 'stranger', intimacy = 0, trust = 0.5, mode = 'standard', since_ts = ?, last_transition_ts = NULL, transition_log = '[]' WHERE agent_id = ?",
      [Date.now(), agentId],
    );
    this.db.run(
      "UPDATE drives_state SET loneliness = 0, boredom = 0, longing = 0, tension = 0, fatigue = 0, urge_to_share = 0, anxiety = 0, updated_ts = ? WHERE agent_id = ?",
      [Date.now(), agentId],
    );
    this.db.run("UPDATE presence_state SET state = 'idle', since_ts = ?, confidence = 0.5, source = 'default' WHERE agent_id = ?", [
      Date.now(),
      agentId,
    ]);

    const kept: string[] = [];
    const removedDirs: string[] = [];
    const resetSettings = this.resetSettings(options, kept);

    if (!options.keepPlugins) {
      this.db.run("DELETE FROM plugin_grants");
      this.db.run("DELETE FROM plugins");
      removedDirs.push(...this.removeDirs([path.join(this.dataDir, "secrets"), path.join(this.dataDir, "plugin-data")]));
    }
    if (!options.keepApiKey && options.keepPlugins) {
      // 插件留着但密钥不要了：只清密钥库
      removedDirs.push(...this.removeDirs([path.join(this.dataDir, "secrets")]));
    }
    if (!options.keepRuntime) {
      removedDirs.push(
        ...this.removeDirs([path.join(this.dataDir, "plugin-runtime"), path.join(this.dataDir, "wechat-runtime")]),
      );
    }
    this.removeContents(path.join(this.dataDir, "media"));
    this.removeContents(path.join(this.dataDir, "exports"));

    this.log.info(
      `data reset: tables=${Object.values(tables).reduce((sum, value) => sum + value, 0)} rows, dirs=${removedDirs.length}, settings=${resetSettings}, keep=${kept.join(",") || "-"}`,
    );
    return { tables, removedDirs, kept, resetSettings };
  }

  /** 统计"将会忘掉多少"：界面在按下去之前先给人看数字。 */
  countMemoryRows(agentId: number): ResetMemoryResult {
    const count = (sql: string, params: SqlParams = [agentId]): number =>
      Number(this.db.get<{ count: number }>(sql, params)?.count ?? 0);
    return {
      memories:
        count("SELECT COUNT(*) AS count FROM memory_episodic WHERE agent_id = ? AND deleted_ts IS NULL") +
        count("SELECT COUNT(*) AS count FROM memory_semantic WHERE agent_id = ? AND deleted_ts IS NULL"),
      openLoops: count("SELECT COUNT(*) AS count FROM memory_open_loops WHERE agent_id = ?"),
      narrative: count("SELECT COUNT(*) AS count FROM narrative_slots WHERE agent_id = ?"),
      messages: count("SELECT COUNT(*) AS count FROM messages WHERE agent_id = ?"),
      turns: count("SELECT COUNT(*) AS count FROM turns WHERE agent_id = ?"),
    };
  }

  private resetSettings(options: ResetOptions, kept: string[]): number {
    const rows = this.db.all<{ key: string }>("SELECT key FROM settings");
    let removed = 0;
    for (const row of rows) {
      if (this.shouldKeepSetting(row.key, options, kept)) continue;
      this.db.run("DELETE FROM settings WHERE key = ?", [row.key]);
      removed += 1;
    }
    return removed;
  }

  private shouldKeepSetting(key: string, options: ResetOptions, kept: string[]): boolean {
    const keep = (label: string): true => {
      if (!kept.includes(label)) kept.push(label);
      return true;
    };
    if (key === "plugins.feedUrl") {
      return options.keepPlugins ? keep("插件") : false;
    }
    if (key.startsWith("wechat.")) {
      return options.keepRuntime ? keep("运行环境") : false;
    }
    if (key === "llm.apiKeyEnc") {
      return options.keepApiKey ? keep("密钥与模型") : false;
    }
    if (key.startsWith("llm.")) {
      // 模型地址/模型名跟着密钥一起留：只留半套配置比清空更容易让人困惑
      return options.keepApiKey ? keep("密钥与模型") : false;
    }
    if (key.startsWith("plan.") || key.startsWith("system.") || key.startsWith("life.")) return false;
    return KEEP_SETTINGS_KEYS.includes(key) ? true : KEEP_SETTINGS_PREFIXES.some(() => false);
  }

  private hasAgentColumn(table: string): boolean {
    const columns = this.db.all<{ name: string }>(`PRAGMA table_info(${table})`);
    return columns.some((column) => column.name === "agent_id");
  }

  private removeDirs(dirs: string[]): string[] {
    const removed: string[] = [];
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      try {
        rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      } catch (error) {
        this.log.warn(`reset: 删不掉目录 ${dir} — ${(error as Error).message}`);
      }
    }
    return removed;
  }

  /** 只清目录内容、保留目录本身（媒体/导出目录后面还要用）。 */
  private removeContents(dir: string): void {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
    for (const entry of readdirSync(dir)) {
      try {
        rmSync(path.join(dir, entry), { recursive: true, force: true });
      } catch (error) {
        this.log.warn(`reset: 删不掉 ${entry} — ${(error as Error).message}`);
      }
    }
  }
}
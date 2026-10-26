/**
 * 设置服务：所有可调项集中在这里，读写 settings 表（key/value JSON）。
 * 密钥永远不进这里——只存"已配置"的布尔与密文引用。
 */
import type { Db } from "./db/database.js";

export interface SettingsDefaults {
  "llm.baseUrl": string;
  "llm.model": string;
  "llm.temperature": number;
  "llm.maxTokens": number;
  "llm.providerId": string;
  "llm.priceInputPerM": number;
  "llm.priceOutputPerM": number;
  "plan.budgetCny": number;
  "plan.proactiveLevel": "off" | "low" | "normal" | "high";
  "life.allowOwnRoutine": boolean;
  "system.proactivePaused": boolean;
  "system.panicUntilTs": number;
}

export const DEFAULT_SETTINGS: SettingsDefaults = {
  "llm.baseUrl": "https://api.deepseek.com/v1",
  "llm.model": "deepseek-chat",
  "llm.temperature": 0.9,
  "llm.maxTokens": 400,
  "llm.providerId": "openai-compatible",
  // 人民币/百万 token，用于成本账本；DeepSeek 公开价约 2/8，可按实际改
  "llm.priceInputPerM": 2,
  "llm.priceOutputPerM": 8,
  "plan.budgetCny": 45,
  "plan.proactiveLevel": "normal",
  "life.allowOwnRoutine": false,
  "system.proactivePaused": false,
  "system.panicUntilTs": 0,
};

export class SettingsService {
  constructor(private readonly db: Db) {}

  get<K extends keyof SettingsDefaults>(key: K): SettingsDefaults[K] {
    const row = this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key]);
    if (!row) return DEFAULT_SETTINGS[key];
    try {
      return JSON.parse(row.value) as SettingsDefaults[K];
    } catch {
      return DEFAULT_SETTINGS[key];
    }
  }

  set<K extends keyof SettingsDefaults>(key: K, value: SettingsDefaults[K]): void {
    this.db.run("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
      key,
      JSON.stringify(value),
    ]);
  }

  /** 插件 / 通道白名单等动态键。 */
  getJson<T>(key: string, fallback: T): T {
    const row = this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key]);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  setJson(key: string, value: unknown): void {
    this.db.run("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
      key,
      JSON.stringify(value),
    ]);
  }
}
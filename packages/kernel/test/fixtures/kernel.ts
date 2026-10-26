/**
 * 测试用内核环境：内存 SQLite + 一个用户 / 一个 agent / 一份种子人格。
 *
 * 为什么不用 bootstrap()：bootstrap 会建 dataDir、写日志文件；单测只要"一个能跑
 * 的 deps"，用内存库 + 静默日志最干净（规范 1 §6 的测试口径）。
 */
import { DEFAULT_TRAITS } from "@anteros/shared";
import type { KernelDeps } from "../../src/contracts.js";
import { Db } from "../../src/db/database.js";
import { DRIVE_DEFAULTS } from "../../src/mind/drives.js";
import type { LogSink } from "../../src/util/log.js";

export const DAY = 86_400_000;

const silentLog: LogSink = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

export interface TestKernel {
  deps: KernelDeps;
  db: Db;
  /** 默认人格 id（种子人格，birth_ts 已按 23 岁回推） */
  personaId: number;
  close(): void;
}

/** 每个用例一个全新的内存库；不共享连接，避免用例间串数据。 */
export function makeKernel(tz = "Asia/Shanghai"): TestKernel {
  const db = new Db(":memory:");
  db.migrate();
  const now = Date.now();

  const userId = db.run("INSERT INTO users(tz, locale, created_ts, status, role) VALUES (?, 'zh-CN', ?, 'active', 'owner')", [tz, now])
    .lastInsertRowid;
  const personaId = db.run(
    "INSERT INTO personas(name, birth_ts, city, traits, interests, immutable, speech_style) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      "小满",
      now - 23 * 365 * DAY,
      "成都",
      JSON.stringify(DEFAULT_TRAITS),
      JSON.stringify(["雨天", "便利店的关东煮", "老电影"]),
      JSON.stringify({ background: "插画师，作息偏晚", values: [], taboo: [] }),
      JSON.stringify({ habits: [], punctuation: "minimal", sentenceLength: "short" }),
    ],
  ).lastInsertRowid;
  const agentId = db.run("INSERT INTO agents(user_id, persona_id, created_ts, epoch, state_version, mode) VALUES (?, ?, ?, 0, 0, 'standard')", [
    userId,
    personaId,
    now,
  ]).lastInsertRowid;

  // 与 bootstrap.seedAgentState 同口径（关系/动机/在场都先落默认行，读时不会另建）
  db.run("INSERT INTO relation_state(agent_id, stage, intimacy, trust, mode, since_ts, transition_log) VALUES (?, 'stranger', 0, 0.5, 'standard', ?, '[]')", [
    agentId,
    now - 365 * DAY,
  ]);
  db.run(
    `INSERT INTO drives_state(agent_id, loneliness, boredom, longing, tension, fatigue, urge_to_share, anxiety, params, updated_ts)
     VALUES (?, 0.2, 0.2, 0.1, 0.05, 0.15, 0.25, 0.1, ?, ?)`,
    [agentId, JSON.stringify(DRIVE_DEFAULTS), now],
  );
  db.run("INSERT INTO presence_state(agent_id, state, since_ts, confidence, source) VALUES (?, 'idle', ?, 0.4, 'default')", [agentId, now]);

  return {
    deps: { db, log: silentLog, userId, agentId, tz },
    db,
    personaId,
    close() {
      db.close();
    },
  };
}

/** 插一条消息（关系天数、在场、反模板都靠 messages 表推）。 */
export function insertMessage(db: Db, agentId: number, role: "user" | "agent", text: string, ts: number): number {
  return db.run(
    "INSERT INTO messages(agent_id, role, text, ts, part_index, recalled, channel_id, delivery) VALUES (?, ?, ?, ?, 0, 0, 'app', 'sent')",
    [agentId, role, text, ts],
  ).lastInsertRowid;
}

/** 由本地时间（Asia/Shanghai 默认）反推一个 UTC 毫秒时间戳，用来测"几点"逻辑。 */
export function localTs(ymd: string, hour: number, minute: number): number {
  const [year, month, day] = ymd.split("-").map(Number);
  // 上海无夏令时，直接 +08:00；测试只覆盖 Asia/Shanghai，其他时区用例自己算偏移。
  return Date.UTC(year as number, (month as number) - 1, day as number, hour - 8, minute, 0, 0);
}

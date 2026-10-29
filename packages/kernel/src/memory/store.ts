/**
 * 记忆表读写（规范 1 §2.3）：episodic / semantic / open_loops / persona / style_habits。
 *
 * 这个文件只做"SQL 与领域对象之间的翻译"，不做业务判断：
 * - 软删除一律写 `deleted_ts`，物理行不删（草案 1.4：全存不删，遗忘 = 提取概率）；
 * - semantic 的更新是"旧行 superseded_by 指向新行"，历史保留（可回溯它改过什么看法）；
 * - memory_persona 是种子人格的只读投影，抽取管线绝不许写——这里用显式断言把
 *   这条约束钉死在唯一写入口上，而不是靠调用方自觉（草案 1.4 四类记忆分治）。
 */
import type { Importance, MemoryItem, MemoryKind } from "@anteros/shared";
import type { Db, SqlValue } from "../db/database.js";
import { toSql } from "../db/database.js";
import { parseAccessLog } from "./actr.js";

export interface EpisodicRow {
  id: number;
  agent_id: number;
  channel_id: string;
  t_start_ts: number;
  t_end_ts: number | null;
  text: string;
  entities: string;
  emotion_v: number | null;
  emotion_a: number | null;
  salience: number;
  importance: Importance;
  layer: string;
  confidence: number;
  source: string;
  source_ref: string | null;
  access_log: string;
  last_access_ts: number | null;
  deleted_ts: number | null;
}

export interface SemanticRow {
  id: number;
  agent_id: number;
  slot_key: string;
  value: string;
  confidence: number;
  importance: Importance;
  evidence: string;
  created_ts: number;
  updated_ts: number;
  superseded_by: number | null;
  deleted_ts: number | null;
}

export interface OpenLoopRow {
  id: number;
  agent_id: number;
  topic: string;
  opened_ts: number;
  last_touch_ts: number;
  closed_ts: number | null;
  urgency: number;
  pinned_until: number | null;
  source_ref: number | null;
}

export interface PersonaMemoryRow {
  id: number;
  agent_id: number;
  slot_key: string;
  value: string;
  mutable: number;
}

export interface StyleHabitRow {
  agent_id: number;
  phrase: string;
  first_ts: number;
  last_ts: number;
  used_count: number;
  accepted: number;
}

export interface InsertEpisodicInput {
  agentId: number;
  /** 这条记忆属于哪条对话线（默认 app 主会话） */
  channelId?: string;
  tStartTs: number;
  tEndTs?: number | null;
  text: string;
  entities: string[];
  emotion?: { v: number; a: number } | null;
  salience: number;
  importance: Importance;
  layer: "detail" | "fact";
  confidence: number;
  source: string;
  sourceRef?: unknown;
  accessLog: number[];
  lastAccessTs?: number | null;
}

/** 记忆置信度来源表（规范 2 §2）：不同来源先验不同，检索时也当可靠度用。 */
export const SOURCE_CONFIDENCE: Record<string, number> = {
  user_said: 0.9,
  it_did: 0.85,
  world: 0.8,
  inference: 0.5,
  seed: 1.0,
  semantic: 0.9,
  conversation: 0.85,
};

/** 检索打分用的来源可靠度（0–1）。 */
export const SOURCE_RELIABILITY: Record<string, number> = {
  user_said: 1.0,
  it_did: 0.9,
  world: 0.85,
  inference: 0.5,
  seed: 1.0,
  semantic: 0.95,
  conversation: 0.9,
};

export function sourceConfidence(source: string): number {
  return SOURCE_CONFIDENCE[source] ?? 0.7;
}

export function sourceReliability(source: string): number {
  return SOURCE_RELIABILITY[source] ?? 0.7;
}

function parseJsonArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseEntities(raw: string | null | undefined): string[] {
  return parseJsonArray(raw).filter((item): item is string => typeof item === "string");
}

// ───────────────────────────── episodic ─────────────────────────────

export function insertEpisodic(db: Db, input: InsertEpisodicInput): number {
  const result = db.run(
    `INSERT INTO memory_episodic
       (agent_id, channel_id, t_start_ts, t_end_ts, text, entities, emotion_v, emotion_a, salience,
        importance, layer, confidence, source, source_ref, access_log, last_access_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      toSql(input.agentId),
      toSql(input.channelId ?? "app"),
      toSql(input.tStartTs),
      toSql(input.tEndTs ?? null),
      toSql(input.text),
      toSql(input.entities),
      toSql(input.emotion?.v ?? null),
      toSql(input.emotion?.a ?? null),
      toSql(input.salience),
      toSql(input.importance),
      toSql(input.layer),
      toSql(input.confidence),
      toSql(input.source),
      toSql(input.sourceRef ?? null),
      toSql(input.accessLog),
      toSql(input.lastAccessTs ?? null),
    ],
  );
  return result.lastInsertRowid;
}

export function getEpisodicRow(db: Db, id: number): EpisodicRow | undefined {
  return db.get<EpisodicRow>("SELECT * FROM memory_episodic WHERE id = ? AND deleted_ts IS NULL", [id]);
}

export function listRecentEpisodic(
  db: Db,
  agentId: number,
  limit: number,
  channelId?: string,
): EpisodicRow[] {
  const scoped = (channelId ?? "").trim();
  if (scoped.length > 0) {
    return db.all<EpisodicRow>(
      "SELECT * FROM memory_episodic WHERE agent_id = ? AND channel_id = ? AND deleted_ts IS NULL ORDER BY t_start_ts DESC, id DESC LIMIT ?",
      [agentId, scoped, limit],
    );
  }
  return db.all<EpisodicRow>(
    "SELECT * FROM memory_episodic WHERE agent_id = ? AND deleted_ts IS NULL ORDER BY t_start_ts DESC, id DESC LIMIT ?",
    [agentId, limit],
  );
}

export function listEpisodicByIds(db: Db, agentId: number, ids: number[]): EpisodicRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return db.all<EpisodicRow>(
    `SELECT * FROM memory_episodic WHERE agent_id = ? AND deleted_ts IS NULL AND id IN (${placeholders})`,
    [agentId, ...ids],
  );
}

export function updateEpisodicAccess(db: Db, id: number, lastAccessTs: number, accessLog: number[]): void {
  db.run("UPDATE memory_episodic SET last_access_ts = ?, access_log = ? WHERE id = ?", [
    toSql(lastAccessTs),
    toSql(accessLog),
    id,
  ]);
}

export function softDeleteEpisodic(db: Db, id: number, now: number): boolean {
  const result = db.run("UPDATE memory_episodic SET deleted_ts = ? WHERE id = ? AND deleted_ts IS NULL", [now, id]);
  return result.changes > 0;
}

export function softDeleteAllEpisodic(db: Db, agentId: number, now: number): number {
  return db.run("UPDATE memory_episodic SET deleted_ts = ? WHERE agent_id = ? AND deleted_ts IS NULL", [now, agentId]).changes;
}

export function countEpisodic(db: Db, agentId: number): number {
  return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_episodic WHERE agent_id = ? AND deleted_ts IS NULL", [agentId])?.n ?? 0;
}

export function episodicToItem(row: EpisodicRow): MemoryItem {
  const accessLog = parseAccessLog(row.access_log);
  const item: MemoryItem = {
    id: row.id,
    kind: "episodic",
    text: row.text,
    importance: row.importance,
    confidence: row.confidence,
    salience: row.salience,
    entities: parseEntities(row.entities),
    source: row.source,
    createdAt: row.t_start_ts,
    lastAccessTs: row.last_access_ts,
    accessCount: accessLog.length,
  };
  if (row.deleted_ts !== null) item.deletedTs = row.deleted_ts;
  item.channelId = row.channel_id;
  return item;
}

// ───────────────────────────── semantic ─────────────────────────────

export interface InsertSemanticInput {
  agentId: number;
  slotKey: string;
  value: unknown;
  confidence: number;
  importance: Importance;
  evidence: unknown[];
  now: number;
}

export function insertSemantic(db: Db, input: InsertSemanticInput): number {
  const result = db.run(
    `INSERT INTO memory_semantic (agent_id, slot_key, value, confidence, importance, evidence, created_ts, updated_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      toSql(input.agentId),
      toSql(input.slotKey),
      toSql(input.value),
      toSql(input.confidence),
      toSql(input.importance),
      toSql(input.evidence),
      toSql(input.now),
      toSql(input.now),
    ],
  );
  return result.lastInsertRowid;
}

export function getCurrentSemanticRow(db: Db, agentId: number, slotKey: string): SemanticRow | undefined {
  return db.get<SemanticRow>(
    "SELECT * FROM memory_semantic WHERE agent_id = ? AND slot_key = ? AND superseded_by IS NULL AND deleted_ts IS NULL",
    [agentId, slotKey],
  );
}

export function getSemanticRow(db: Db, id: number): SemanticRow | undefined {
  return db.get<SemanticRow>("SELECT * FROM memory_semantic WHERE id = ? AND deleted_ts IS NULL", [id]);
}

export function listCurrentSemantic(db: Db, agentId: number): SemanticRow[] {
  return db.all<SemanticRow>(
    "SELECT * FROM memory_semantic WHERE agent_id = ? AND superseded_by IS NULL AND deleted_ts IS NULL ORDER BY updated_ts DESC, id DESC",
    [agentId],
  );
}

/** 旧行标记被新行取代（规范 1 §2.3：semantic 更新走 superseded_by，不原地改）。 */
export function supersedeSemanticRow(db: Db, oldId: number, newId: number, now: number): void {
  db.run("UPDATE memory_semantic SET superseded_by = ?, updated_ts = ? WHERE id = ?", [newId, now, oldId]);
}

/** 同一槽位证据累积：置信度合并、updated_ts 刷新（不新建行）。 */
export function touchSemanticRow(db: Db, id: number, confidence: number, evidence: unknown[], now: number): void {
  db.run("UPDATE memory_semantic SET confidence = ?, evidence = ?, updated_ts = ? WHERE id = ?", [
    toSql(confidence),
    toSql(evidence),
    toSql(now),
    id,
  ]);
}

export function softDeleteSemantic(db: Db, id: number, now: number): boolean {
  const result = db.run("UPDATE memory_semantic SET deleted_ts = ? WHERE id = ? AND deleted_ts IS NULL", [now, id]);
  return result.changes > 0;
}

export function softDeleteAllSemantic(db: Db, agentId: number, now: number): number {
  return db.run("UPDATE memory_semantic SET deleted_ts = ? WHERE agent_id = ? AND deleted_ts IS NULL", [now, agentId]).changes;
}

export function countSemantic(db: Db, agentId: number): number {
  return (
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM memory_semantic WHERE agent_id = ? AND superseded_by IS NULL AND deleted_ts IS NULL",
      [agentId],
    )?.n ?? 0
  );
}

export function semanticToItem(row: SemanticRow): MemoryItem {
  const item: MemoryItem = {
    id: row.id,
    kind: "semantic",
    slotKey: row.slot_key,
    value: safeParse(row.value),
    importance: row.importance,
    confidence: row.confidence,
    salience: Math.max(0.3, Math.min(1, row.confidence)),
    entities: [],
    source: "semantic",
    createdAt: row.created_ts,
    lastAccessTs: row.updated_ts,
    accessCount: 1,
  };
  if (row.deleted_ts !== null) item.deletedTs = row.deleted_ts;
  return item;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

// ───────────────────────────── open loops ─────────────────────────────

export interface InsertOpenLoopInput {
  agentId: number;
  topic: string;
  now: number;
  urgency: number;
  sourceRef?: number | null;
  pinnedUntil?: number | null;
}

export function insertOpenLoop(db: Db, input: InsertOpenLoopInput): number {
  const result = db.run(
    `INSERT INTO memory_open_loops (agent_id, topic, opened_ts, last_touch_ts, urgency, pinned_until, source_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      toSql(input.agentId),
      toSql(input.topic),
      toSql(input.now),
      toSql(input.now),
      toSql(input.urgency),
      toSql(input.pinnedUntil ?? null),
      toSql(input.sourceRef ?? null),
    ],
  );
  return result.lastInsertRowid;
}

export function findOpenLoopByTopic(db: Db, agentId: number, topic: string): OpenLoopRow | undefined {
  return db.get<OpenLoopRow>(
    "SELECT * FROM memory_open_loops WHERE agent_id = ? AND topic = ? AND closed_ts IS NULL ORDER BY id DESC LIMIT 1",
    [agentId, topic],
  );
}

export function getOpenLoopRow(db: Db, id: number): OpenLoopRow | undefined {
  return db.get<OpenLoopRow>("SELECT * FROM memory_open_loops WHERE id = ?", [id]);
}

export function listOpenLoops(db: Db, agentId: number, openOnly: boolean): OpenLoopRow[] {
  const sql = openOnly
    ? "SELECT * FROM memory_open_loops WHERE agent_id = ? AND closed_ts IS NULL ORDER BY urgency DESC, last_touch_ts DESC"
    : "SELECT * FROM memory_open_loops WHERE agent_id = ? ORDER BY opened_ts DESC";
  return db.all<OpenLoopRow>(sql, [agentId]);
}

export function touchOpenLoop(db: Db, id: number, now: number, urgency?: number): void {
  if (urgency === undefined) {
    db.run("UPDATE memory_open_loops SET last_touch_ts = ? WHERE id = ?", [now, id]);
    return;
  }
  db.run("UPDATE memory_open_loops SET last_touch_ts = ?, urgency = ? WHERE id = ?", [now, toSql(urgency), id]);
}

export function closeOpenLoop(db: Db, id: number, now: number): boolean {
  const result = db.run("UPDATE memory_open_loops SET closed_ts = ? WHERE id = ? AND closed_ts IS NULL", [now, id]);
  return result.changes > 0;
}

export function closeAllOpenLoops(db: Db, agentId: number, now: number): number {
  return db.run("UPDATE memory_open_loops SET closed_ts = ? WHERE agent_id = ? AND closed_ts IS NULL", [now, agentId]).changes;
}

export function countOpenLoops(db: Db, agentId: number): number {
  return (
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_open_loops WHERE agent_id = ? AND closed_ts IS NULL", [agentId])?.n ?? 0
  );
}

export function openLoopToItem(row: OpenLoopRow): MemoryItem {
  return {
    id: row.id,
    kind: "open_loop",
    topic: row.topic,
    text: row.topic,
    importance: "important",
    confidence: 0.9,
    salience: row.urgency,
    entities: [],
    source: "conversation",
    createdAt: row.opened_ts,
    lastAccessTs: row.last_touch_ts,
    accessCount: 1,
    open: row.closed_ts === null,
    urgency: row.urgency,
  };
}

// ───────────────────────────── persona (seed-only) ─────────────────────────────

export class PersonaMemoryWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonaMemoryWriteError";
  }
}

/**
 * 写 memory_persona。**只允许种子人格（mutable=0）写入**。
 *
 * 为什么在 store 里抛错而不是只写注释：抽取管线、插件、记忆编辑都不该改人格；
 * 把断言放在唯一写入口上，任何越权调用都会立刻炸掉（草案 1.4 / 规范 1 §2.3）。
 */
export function insertPersonaMemory(db: Db, agentId: number, slotKey: string, value: unknown, mutable = 0): number {
  if (mutable !== 0) {
    throw new PersonaMemoryWriteError(`memory_persona 只允许种子人格写入（mutable=0），拒绝 mutable=${mutable} 的写入`);
  }
  db.run(
    `INSERT INTO memory_persona (agent_id, slot_key, value, mutable) VALUES (?, ?, ?, 0)
     ON CONFLICT(agent_id, slot_key) DO UPDATE SET value = excluded.value, mutable = 0`,
    [toSql(agentId), toSql(slotKey), toSql(value)],
  );
  return db.get<{ id: number }>("SELECT id FROM memory_persona WHERE agent_id = ? AND slot_key = ?", [agentId, slotKey])?.id ?? 0;
}

export function listPersonaMemory(db: Db, agentId: number): PersonaMemoryRow[] {
  return db.all<PersonaMemoryRow>("SELECT * FROM memory_persona WHERE agent_id = ? ORDER BY slot_key", [agentId]);
}

export function hasPersonaMemory(db: Db, agentId: number): boolean {
  return (
    (db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_persona WHERE agent_id = ?", [agentId])?.n ?? 0) > 0
  );
}

export function personaMemoryToItem(row: PersonaMemoryRow): MemoryItem {
  return {
    id: row.id,
    kind: "persona",
    slotKey: row.slot_key,
    value: safeParse(row.value),
    importance: "redline",
    confidence: 1,
    salience: 1,
    entities: [],
    source: "seed",
    createdAt: 0,
    lastAccessTs: null,
    accessCount: 0,
  };
}

// ───────────────────────────── style habits ─────────────────────────────

export function upsertStyleHabit(db: Db, agentId: number, phrase: string, now: number, accepted = false): void {
  db.run(
    `INSERT INTO style_habits (agent_id, phrase, first_ts, last_ts, used_count, accepted) VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(agent_id, phrase) DO UPDATE SET last_ts = excluded.last_ts, used_count = used_count + 1, accepted = MAX(accepted, excluded.accepted)`,
    [toSql(agentId), toSql(phrase), toSql(now), toSql(now), toSql(accepted)],
  );
}

export function listStyleHabits(db: Db, agentId: number): StyleHabitRow[] {
  return db.all<StyleHabitRow>("SELECT * FROM style_habits WHERE agent_id = ? ORDER BY used_count DESC", [agentId]);
}

// ───────────────────────────── unified views ─────────────────────────────

export interface ListQuery {
  agentId: number;
  kind?: MemoryKind;
  importance?: Importance;
  limit: number;
  offset: number;
}

/** 统一记忆列表（UI 用）：四类表各自分页，再按时间归并。 */
export function listMemory(db: Db, query: ListQuery): { items: MemoryItem[]; total: number } {
  const items: MemoryItem[] = [];
  const wants = (kind: MemoryKind): boolean => query.kind === undefined || query.kind === kind;
  if (wants("episodic")) {
    for (const row of listRecentEpisodic(db, query.agentId, 1000)) {
      if (query.importance !== undefined && row.importance !== query.importance) continue;
      items.push(episodicToItem(row));
    }
  }
  if (wants("semantic")) {
    for (const row of listCurrentSemantic(db, query.agentId)) {
      if (query.importance !== undefined && row.importance !== query.importance) continue;
      items.push(semanticToItem(row));
    }
  }
  if (wants("open_loop")) {
    for (const row of listOpenLoops(db, query.agentId, false)) items.push(openLoopToItem(row));
  }
  if (wants("persona")) {
    for (const row of listPersonaMemory(db, query.agentId)) items.push(personaMemoryToItem(row));
  }
  if (query.importance !== undefined) {
    // open_loop / persona 的 importance 是推导出来的，上面已按表过滤；这里再兜一层
    const filtered = items.filter((item) => item.importance === query.importance);
    return { items: filtered.slice(query.offset, query.offset + query.limit), total: filtered.length };
  }
  items.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  return { items: items.slice(query.offset, query.offset + query.limit), total: items.length };
}

/** 按 id 在四类表里找（单机闭环下 id 分表自增，允许碰撞；按 episodic→semantic→loop→persona 顺序取第一个）。 */
export function getMemoryItem(db: Db, agentId: number, id: number): MemoryItem | null {
  const episodic = getEpisodicRow(db, id);
  if (episodic && episodic.agent_id === agentId) return episodicToItem(episodic);
  const semantic = getSemanticRow(db, id);
  if (semantic && semantic.agent_id === agentId) return semanticToItem(semantic);
  const loop = getOpenLoopRow(db, id);
  if (loop && loop.agent_id === agentId) return openLoopToItem(loop);
  const persona = db.get<PersonaMemoryRow>("SELECT * FROM memory_persona WHERE id = ? AND agent_id = ?", [id, agentId]);
  if (persona) return personaMemoryToItem(persona);
  return null;
}

export function softDeleteMemory(db: Db, agentId: number, id: number, now: number): boolean {
  const episodic = getEpisodicRow(db, id);
  if (episodic && episodic.agent_id === agentId) return softDeleteEpisodic(db, id, now);
  const semantic = getSemanticRow(db, id);
  if (semantic && semantic.agent_id === agentId) return softDeleteSemantic(db, id, now);
  const loop = getOpenLoopRow(db, id);
  if (loop && loop.agent_id === agentId) return closeOpenLoop(db, id, now);
  return false;
}

export function softDeleteAllMemory(db: Db, agentId: number, now: number): number {
  return db.tx(() => {
    const episodic = softDeleteAllEpisodic(db, agentId, now);
    const semantic = softDeleteAllSemantic(db, agentId, now);
    const loops = closeAllOpenLoops(db, agentId, now);
    // memory_persona 是种子人格（L0 的来源），删了人格就没了，故不在清理范围内
    return episodic + semantic + loops;
  });
}

/** 把参数数组包成 SQL 占位符用的列表（小工具，避免各处手写 map）。 */
export function sqlList(values: readonly SqlValue[]): SqlValue[] {
  return [...values];
}

/**
 * MemoryService：MemoryPort 的门面实现（草案 1 章 / 规范 2 §2–§5）。
 *
 * 只做编排，不重复实现算法：
 *   - 打分/召回 → retrieval.ts（ACT-R 激活 × 来源可靠度 × 情绪 × 线索）
 *   - 规则/插件/LLM 抽取 → extraction.ts（三级漏斗）
 *   - 重建再编码 → reencode.ts
 *   - 表读写 → store.ts（唯一写入口，persona 写入在那里被断言拒绝）
 *
 * 时间一律 UTC 毫秒；所有 SQL 参数走 toSql（见 store.ts）。
 */
import type { Importance, MemoryItem, MemorySearchResult, PersonaTraits } from "@anteros/shared";
import { DEFAULT_TRAITS } from "@anteros/shared";
import type { Db } from "../db/database.js";
import type { KernelDeps, LlmPort, MemoryCandidate, MemoryPort, RecallQuery } from "../contracts.js";
import { appendAccessLog, parseAccessLog } from "./actr.js";
import { extractRules, llmExtract, mergeExtractions, type RuleExtraction } from "./extraction.js";
import { collectPinned, retrieve } from "./retrieval.js";
import { buildReencodedEpisode, shouldReencode } from "./reencode.js";
import {
  closeAllOpenLoops,
  closeOpenLoop,
  countEpisodic,
  countOpenLoops,
  countSemantic,
  findOpenLoopByTopic,
  getEpisodicRow,
  getMemoryItem,
  getOpenLoopRow,
  insertEpisodic,
  insertOpenLoop,
  insertSemantic,
  listMemory,
  listOpenLoops,
  listPersonaMemory,
  softDeleteAllEpisodic,
  softDeleteAllSemantic,
  softDeleteMemory,
  sourceConfidence,
  supersedeSemanticRow,
  touchOpenLoop,
  touchSemanticRow,
  updateEpisodicAccess,
} from "./store.js";

/** 第二级抽取：插件注入的 extractor（没有就跳过）。 */
export interface MemoryPluginExtractor {
  extract(texts: string[]): Promise<MemoryCandidate[]> | null;
}

export interface MemoryServiceExtras {
  plugin?: MemoryPluginExtractor;
}

/** 抽取候选在运行期可能被插件塞进 persona——这个 kind 永远不许由抽取管线写。 */
function assertNotPersona(kind: string): void {
  if (kind === "persona") {
    throw new Error("抽取管线禁止写 memory_persona（规范 1 §2.3：种子人格只读，四类记忆分治）");
  }
}

/** 记忆的参数来自人格 traits：ACT-R 的 d/τ/s 与 γ 都是个体差异（规范 1 §2.2）。 */
function readTraits(db: Db, agentId: number): PersonaTraits {
  const row = db.get<{ traits: string }>(
    "SELECT p.traits AS traits FROM agents a JOIN personas p ON p.id = a.persona_id WHERE a.id = ?",
    [agentId],
  );
  if (row === undefined) return { ...DEFAULT_TRAITS };
  try {
    const parsed: unknown = JSON.parse(row.traits);
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_TRAITS };
    return { ...DEFAULT_TRAITS, ...(parsed as Partial<PersonaTraits>) };
  } catch {
    return { ...DEFAULT_TRAITS };
  }
}

function salienceOf(importance: Importance, emotion: { v: number; a: number } | undefined): number {
  const base = importance === "redline" ? 0.9 : importance === "important" ? 0.6 : 0.35;
  const boost = emotion === undefined ? 0 : Math.abs(emotion.v) * (0.5 + 0.5 * emotion.a) * 0.3;
  return Math.min(1, base + boost);
}

export class MemoryService implements MemoryPort {
  private readonly db: Db;

  constructor(
    private readonly deps: KernelDeps,
    private readonly llm: LlmPort | null = null,
    private readonly extras: MemoryServiceExtras = {},
  ) {
    this.db = deps.db;
  }

  /* ───────────────────────────── 召回 ───────────────────────────── */

  recall(query: RecallQuery): MemorySearchResult {
    const traits = readTraits(this.db, query.agentId);
    const result = retrieve({
      db: this.db,
      agentId: query.agentId,
      text: query.text,
      now: query.now,
      mood: query.mood,
      traits,
      topK: query.topK,
    });

    // 成功回忆会抬高后续的可提取性（ACT-R 的间隔效应就来自 access_log 累积）
    for (const item of result.items) {
      if (item.kind !== "episodic") continue;
      const row = getEpisodicRow(this.db, item.id);
      if (row === undefined) continue;
      const log = appendAccessLog(parseAccessLog(row.access_log), query.now, 30);
      updateEpisodicAccess(this.db, row.id, query.now, log);
    }

    // 重构再编码：只在情绪足够强/ρ 足够大时发生，且只动最靠前的一条情节
    const mood = query.mood ?? { v: 0, a: 0 };
    const top = result.items.find((item) => item.kind === "episodic");
    if (top !== undefined && shouldReencode(traits.reconstructRho, mood)) {
      this.reencode(query.agentId, top.id, mood, query.now);
    }

    return { items: result.items, pinned: result.pinned };
  }

  /* ───────────────────────────── 写入 ───────────────────────────── */

  rememberEpisode(input: Parameters<MemoryPort["rememberEpisode"]>[0]): number {
    return this.insertEpisode({
      agentId: input.agentId,
      text: input.text,
      now: input.now,
      importance: input.importance ?? "detail",
      entities: input.entities ?? [],
      emotion: input.emotion,
      source: input.source ?? "user_said",
      sourceRef: input.sourceRef,
      layer: input.layer ?? "detail",
      confidence: input.confidence,
    });
  }

  private insertEpisode(input: {
    agentId: number;
    text: string;
    now: number;
    importance: Importance;
    entities: string[];
    emotion?: { v: number; a: number };
    source: string;
    sourceRef?: unknown;
    layer: "detail" | "fact";
    confidence?: number;
  }): number {
    return insertEpisodic(this.db, {
      agentId: input.agentId,
      tStartTs: input.now,
      tEndTs: input.now,
      text: input.text,
      entities: input.entities,
      emotion: input.emotion ?? null,
      salience: salienceOf(input.importance, input.emotion),
      importance: input.importance,
      layer: input.layer,
      confidence: input.confidence ?? sourceConfidence(input.source),
      source: input.source,
      sourceRef: input.sourceRef,
      // 编码时刻是第一个访问时间戳：B_i = ln(Σ t_j^-d) 里"至少含编码时刻"
      accessLog: [input.now],
      lastAccessTs: input.now,
    });
  }

  upsertSemantic(input: Parameters<MemoryPort["upsertSemantic"]>[0]): number {
    const existing = this.db.get<{ id: number; value: string; evidence: string; confidence: number }>(
      "SELECT id, value, evidence, confidence FROM memory_semantic WHERE agent_id = ? AND slot_key = ? AND superseded_by IS NULL AND deleted_ts IS NULL",
      [input.agentId, input.slotKey],
    );

    if (existing === undefined) {
      return insertSemantic(this.db, {
        agentId: input.agentId,
        slotKey: input.slotKey,
        value: input.value,
        confidence: input.confidence,
        importance: input.importance ?? "important",
        evidence: input.evidence === undefined ? [] : [input.evidence],
        now: input.now,
      });
    }

    if (existing.value === JSON.stringify(input.value)) {
      // 同槽同值 → 证据累积，不新建行（规范 1 §2.3）
      let evidence: unknown[] = [];
      try {
        const parsed: unknown = JSON.parse(existing.evidence);
        if (Array.isArray(parsed)) evidence = parsed;
      } catch {
        evidence = [];
      }
      if (input.evidence !== undefined) evidence.push(input.evidence);
      touchSemanticRow(this.db, existing.id, Math.max(existing.confidence, input.confidence), evidence.slice(-20), input.now);
      return existing.id;
    }

    // 值变了 → 旧行 superseded_by 指向新行，历史保留（可回溯"它改过什么看法"）
    // 注意：schema 的唯一索引是「当前行」部分索引，插新行前必须先把旧行移出当前集，
    // 否则 (agent_id, slot_key) 撞唯一约束；所以先占位（-1）再回填真实新行 id。
    return this.db.tx(() => {
      this.db.run("UPDATE memory_semantic SET superseded_by = -1 WHERE id = ?", [existing.id]);
      const newId = insertSemantic(this.db, {
        agentId: input.agentId,
        slotKey: input.slotKey,
        value: input.value,
        confidence: input.confidence,
        importance: input.importance ?? "important",
        evidence: input.evidence === undefined ? [] : [input.evidence],
        now: input.now,
      });
      supersedeSemanticRow(this.db, existing.id, newId, input.now);
      return newId;
    });
  }

  openLoop(input: Parameters<MemoryPort["openLoop"]>[0]): number {
    const existing = findOpenLoopByTopic(this.db, input.agentId, input.topic);
    if (existing !== undefined) {
      touchOpenLoop(this.db, existing.id, input.now, Math.max(existing.urgency, input.urgency ?? 0.5));
      return existing.id;
    }
    return insertOpenLoop(this.db, {
      agentId: input.agentId,
      topic: input.topic,
      now: input.now,
      urgency: input.urgency ?? 0.5,
      sourceRef: input.sourceRef ?? null,
    });
  }

  closeLoop(agentId: number, loopId: number, now: number): void {
    const row = getOpenLoopRow(this.db, loopId);
    if (row === undefined || row.agent_id !== agentId) return;
    closeOpenLoop(this.db, loopId, now);
  }

  touchOpenLoops(agentId: number, now: number): number {
    const loops = listOpenLoops(this.db, agentId, true);
    for (const loop of loops) {
      // 拖得越久越该被想起来：每天 +0.03，封顶 0.95（草案 5.2 未闭合话题燃料）
      const ageDays = Math.max(0, (now - loop.opened_ts) / 86_400_000);
      const urgency = Math.min(0.95, loop.urgency + 0.03 * Math.min(ageDays, 10));
      touchOpenLoop(this.db, loop.id, now, urgency);
    }
    return loops.length;
  }

  /* ───────────────────── 抽取：规则 → 插件 → LLM ───────────────────── */

  async extract(agentId: number, texts: Array<{ id: number; text: string; ts: number }>, now: number): Promise<number> {
    let written = 0;
    for (const item of texts) {
      const trimmed = item.text.trim();
      if (trimmed.length === 0) continue;

      // 第一级：规则（零成本、约 70% 覆盖，草案 1.7）
      const rules: RuleExtraction = extractRules(trimmed);

      // 第二级：插件（可选，失败就跳过；插件也写不了 persona）
      let plugin: RuleExtraction | null = null;
      const extractor = this.extras.plugin;
      if (extractor !== undefined) {
        try {
          const candidates = await extractor.extract([trimmed]);
          if (candidates !== null) {
            for (const candidate of candidates) assertNotPersona(candidate.kind);
            plugin = { candidates, facts: [], loops: [] };
          }
        } catch (err) {
          this.deps.log.debug(`memory plugin extract skipped: ${(err as Error).message}`);
        }
      }

      // 第三级：内联 LLM（未配置 / 失败一律降级，绝不抛）
      let viaLlm: RuleExtraction | null = null;
      if (this.llm !== null && this.llm.isConfigured()) {
        try {
          viaLlm = await llmExtract(this.llm, trimmed);
        } catch (err) {
          this.deps.log.debug(`memory llm extract degraded: ${(err as Error).message}`);
        }
      }

      const merged = mergeExtractions([rules, plugin, viaLlm]);
      written += this.persistExtraction(agentId, item.id, trimmed, item.ts, merged);
    }
    return written;
  }

  /** 落库（去重后）：episodic / semantic / open_loop 三类；persona 一律拒绝。 */
  private persistExtraction(agentId: number, messageId: number, text: string, ts: number, merged: RuleExtraction): number {
    let written = 0;
    this.db.tx(() => {
      for (const candidate of merged.candidates) {
        // 运行期硬闸：插件/模型给什么都不能碰种子人格（规范 1 §2.3）
        assertNotPersona(candidate.kind as string);
        const sourceRef = { messageId };

        if (candidate.kind === "semantic" && typeof candidate.slotKey === "string") {
          this.upsertSemantic({
            agentId,
            slotKey: candidate.slotKey,
            value: candidate.value,
            confidence: candidate.confidence,
            importance: candidate.importance,
            evidence: sourceRef,
            now: ts,
          });
          written += 1;
          continue;
        }

        if (candidate.kind === "open_loop") {
          const topic = candidate.slotKey ?? candidate.text.slice(0, 40);
          this.openLoop({ agentId, topic, now: ts, urgency: candidate.importance === "redline" ? 0.8 : 0.55, sourceRef: messageId });
          written += 1;
          continue;
        }

        // 同一句话不重复落库（重试/重复抽取都会走到这里）
        const duplicate = this.db.get<{ id: number }>(
          "SELECT id FROM memory_episodic WHERE agent_id = ? AND text = ? AND deleted_ts IS NULL AND t_start_ts > ? LIMIT 1",
          [agentId, candidate.text, ts - 86_400_000],
        );
        if (duplicate !== undefined) continue;

        this.insertEpisode({
          agentId,
          text: candidate.text,
          now: ts,
          importance: candidate.importance,
          entities: candidate.entities,
          emotion: candidate.emotion,
          source: "user_said",
          sourceRef,
          layer: "detail",
          confidence: candidate.confidence,
        });
        written += 1;
      }

      // 结构事实：identity/life/pref 槽位，冲突走 supersede
      for (const fact of merged.facts) {
        this.upsertSemantic({
          agentId,
          slotKey: fact.slotKey,
          value: fact.value,
          confidence: Math.max(0.4, Math.min(0.95, fact.confidence)),
          importance: fact.slotKey.startsWith("identity.") || fact.slotKey.startsWith("life.") ? "important" : "detail",
          evidence: { messageId, text: text.slice(0, 60) },
          now: ts,
        });
        written += 1;
      }

      for (const loop of merged.loops) {
        this.openLoop({ agentId, topic: loop.topic, now: ts, urgency: loop.urgency, sourceRef: messageId });
        written += 1;
      }
    });
    return written;
  }

  /* ───────────────────────────── 查询/维护 ───────────────────────────── */

  list(input: Parameters<MemoryPort["list"]>[0]): { items: MemoryItem[]; total: number } {
    return listMemory(this.db, input);
  }

  get(agentId: number, id: number): MemoryItem | null {
    return getMemoryItem(this.db, agentId, id);
  }

  softDelete(agentId: number, id: number, now: number): boolean {
    return softDeleteMemory(this.db, agentId, id, now);
  }

  deleteAll(agentId: number, now: number): number {
    return this.db.tx(() => {
      const episodic = softDeleteAllEpisodic(this.db, agentId, now);
      const semantic = softDeleteAllSemantic(this.db, agentId, now);
      // open_loops / persona 没有 deleted_ts：话题一律闭环、种子人格保留
      // （种子人格不是"用户记忆"，清记忆不该把人格设定一起清掉）
      const loops = closeAllOpenLoops(this.db, agentId, now);
      return episodic + semantic + loops;
    });
  }

  stats(agentId: number): { episodic: number; semantic: number; openLoops: number; persona: number; pinned: number; total: number } {
    const episodic = countEpisodic(this.db, agentId);
    const semantic = countSemantic(this.db, agentId);
    const openLoops = countOpenLoops(this.db, agentId);
    const persona = listPersonaMemory(this.db, agentId).length;
    const pinned = this.pinnedEvidence(agentId, Date.now()).length;
    return { episodic, semantic, openLoops, persona, pinned, total: episodic + semantic + openLoops + persona };
  }

  pinnedEvidence(agentId: number, now: number): MemoryItem[] {
    return collectPinned(this.db, agentId, now);
  }

  reencode(agentId: number, itemId: number, mood: { v: number; a: number }, now: number): void {
    const row = getEpisodicRow(this.db, itemId);
    if (row === undefined || row.agent_id !== agentId) return;
    const traits = readTraits(this.db, agentId);
    const rebuilt = buildReencodedEpisode({
      agentId,
      itemId: row.id,
      text: row.text,
      importance: row.importance,
      layer: row.layer === "fact" ? "fact" : "detail",
      confidence: row.confidence,
      source: row.source,
      now,
      mood,
      rho: traits.reconstructRho,
    });
    if (rebuilt.text === row.text) return;
    this.insertEpisode({
      agentId,
      text: rebuilt.text,
      now,
      importance: row.importance,
      entities: [],
      emotion: rebuilt.emotion,
      source: "inference",
      sourceRef: { reencodedFrom: row.id },
      layer: row.layer === "fact" ? "fact" : "detail",
      confidence: rebuilt.confidence,
    });
  }
}

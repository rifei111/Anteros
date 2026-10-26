/**
 * MindService：MindPort 的门面（人格 / 关系 / 世界 / 动机 / 叙事 / 主动候选）。
 *
 * 只是组装，不含算法；每个子模块都可以单独单测：
 *   persona.ts 人格与预设 · relation.ts 状态机 · presence.ts 在场 ·
 *   world.ts 世界时钟与慢变量 · drives.ts 动机演化 · narrative.ts 槽位 ·
 *   actions.ts 主动由头
 */
import type {
  ActionItem,
  AgentMode,
  DriveState,
  MemoryItem,
  Persona,
  PresenceState,
  RelationState,
  WorldState,
} from "@anteros/shared";
import type { KernelDeps, MemoryPort, MindPort } from "../contracts.js";
import { buildCandidates, recentUserMemories } from "./actions.js";
import { DrivesService } from "./drives.js";
import { NarrativeService } from "./narrative.js";
import { PersonaService } from "./persona.js";
import { PresenceService } from "./presence.js";
import { RelationService } from "./relation.js";
import { WorldService } from "./world.js";

export class MindService implements MindPort {
  private readonly persona: PersonaService;
  private readonly relation: RelationService;
  private readonly presence: PresenceService;
  private readonly world: WorldService;
  private readonly drives: DrivesService;
  private readonly narrative: NarrativeService;

  constructor(
    private readonly deps: KernelDeps,
    private readonly memory: MemoryPort,
  ) {
    this.persona = new PersonaService(deps);
    this.relation = new RelationService(deps);
    this.presence = new PresenceService(deps);
    this.world = new WorldService(deps, this.persona, this.presence);
    this.drives = new DrivesService(deps);
    this.narrative = new NarrativeService(deps);
  }

  /* ───────────────────────────── 人格 ───────────────────────────── */

  getPersona(): Persona {
    return this.persona.get();
  }

  updatePersona(patch: Partial<Persona>): Persona {
    return this.persona.update(patch);
  }

  listPresets(): Array<{ id: string; name: string; summary: string; persona: Omit<Persona, "id" | "birthTs"> }> {
    return this.persona.listPresets();
  }

  applyPreset(presetId: string): Persona {
    return this.persona.applyPreset(presetId);
  }

  /* ───────────────────────────── 关系 ───────────────────────────── */

  getRelation(): RelationState {
    return this.relation.get();
  }

  observeUserTurn(text: string, now: number): RelationState {
    return this.relation.observeUserTurn(text, now);
  }

  observeAgentTurn(text: string, now: number): RelationState {
    return this.relation.observeAgentTurn(text, now);
  }

  setMode(mode: AgentMode): RelationState {
    return this.relation.setMode(mode);
  }

  /* ───────────────────────────── 世界 ───────────────────────────── */

  getWorld(now: number): WorldState {
    return this.world.get(now).world;
  }

  tickWorld(now: number): WorldState {
    return this.world.tick(now).world;
  }

  getPresence(now: number): PresenceState {
    return this.world.get(now).world.presence;
  }

  touchPresence(state: PresenceState, source: "behavior" | "calendar" | "default"): void {
    this.presence.touch(state, source, Date.now());
  }

  /* ───────────────────────────── 动机 ───────────────────────────── */

  getDrives(): DriveState {
    return this.drives.get();
  }

  tickDrives(now: number): DriveState {
    return this.drives.tick(now);
  }

  /* ───────────────────────────── 叙事 ───────────────────────────── */

  getNarrative(): Array<{ slotKey: string; value: unknown; prose: string | null; updatedTs: number }> {
    return this.narrative.get();
  }

  refreshNarrative(now: number): void {
    const world = this.world.get(now).world;
    const openLoops = this.openLoops();
    this.narrative.refresh({
      now,
      tz: this.deps.tz,
      persona: this.persona.get(),
      relation: this.relation.get(),
      world,
      drives: this.drives.get(),
      openLoops,
    });
  }

  /* ─────────────────────── 主动候选（四类 + 冲动） ─────────────────────── */

  candidateActions(now: number): ActionItem[] {
    const world = this.world.get(now).world;
    const drives = this.drives.get();
    const relation = this.relation.get();
    return buildCandidates({
      now,
      persona: this.persona.get(),
      relation,
      world,
      drives,
      crossed: this.drives.crossedThresholds(drives),
      openLoops: this.openLoops(),
      recentUserMemories: recentUserMemories(this.deps.db, this.deps.agentId, now),
      db: this.deps.db,
      agentId: this.deps.agentId,
      tz: this.deps.tz,
    });
  }

  private openLoops(): MemoryItem[] {
    return this.memory.list({ agentId: this.deps.agentId, kind: "open_loop", limit: 20, offset: 0 }).items;
  }

  /** 表达层写 narrative prose 时用（不在 MindPort 上，是内核内部协作）。 */
  writeNarrativeProse(slotKey: string, prose: string, now: number): void {
    this.narrative.writeProse(slotKey, prose, now);
  }
}

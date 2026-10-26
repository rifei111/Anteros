/**
 * ExpressionService：ExpressionPort 的门面。
 *
 * 职责边界：只做"装配上下文 → 调模型 → 分条/节奏 → 反模板"，不写库、不投递
 * （投递是 services/chat 的事，内核端口只被调用）。模型未配置/调用失败时
 * 明确降级，不假装正常（草案 0.4 / 规范 2 §9.4）。
 */
import type {
  ExpressionPort,
  KernelDeps,
  LlmMessage,
  LlmPort,
  MemoryPort,
  MindPort,
  PromptBundle,
  ReplyPlan,
} from "../contracts.js";
import { SettingsService } from "../settings.js";
import { Rng } from "../util/rng.js";
import { AntiTemplateGuard } from "./antitemplate.js";
import { planParts, joinFullText, type PlanPartsInput } from "./planner.js";
import { PromptAssembler, type AssembleInput } from "./prompt.js";

/** 模型未配置/调用失败时的降级文案：只说明系统状态，不扮演人格。 */
const DEGRADED_UNCONFIGURED = "（模型还没配置，我现在说不了话。去设置里填一下模型接口和 Key，填完我就能回你。）";
const DEGRADED_FAILED = "（模型这次没连上，等下再试一下。）";

export class ExpressionService implements ExpressionPort {
  private readonly assembler: PromptAssembler;
  private readonly anti: AntiTemplateGuard;

  constructor(
    private readonly deps: KernelDeps,
    private readonly mind: MindPort,
    private readonly memory: MemoryPort,
    private readonly llm: LlmPort,
  ) {
    this.assembler = new PromptAssembler(deps, mind, memory);
    this.anti = new AntiTemplateGuard(deps.db, deps.agentId);
  }

  async assemble(input: { agentId: number; userText: string; trigger: string; now: number }): Promise<PromptBundle> {
    const assembleInput: AssembleInput = {
      agentId: input.agentId,
      userText: input.userText,
      trigger: input.trigger,
      now: input.now,
    };
    return this.assembler.assemble(assembleInput);
  }

  async planReply(input: {
    agentId: number;
    userText: string;
    trigger: "reply" | "proactive" | "impulse";
    now: number;
    reason?: string;
    actionId?: number;
  }): Promise<ReplyPlan> {
    const bundle = await this.assemble({ agentId: input.agentId, userText: input.userText, trigger: input.trigger, now: input.now });
    const settings = new SettingsService(this.deps.db);
    const persona = this.mind.getPersona();
    const presence = bundle.world.presence;
    const seed = `${this.deps.agentId}:${input.now}:${input.trigger}:${settings.get("llm.model")}`;
    const rng = Rng.fromString(seed);
    const planInput: PlanPartsInput = { traits: persona.traits, presence, rng };

    const ctxSnapshot = {
      memoryIds: bundle.evidence.map((item) => item.id),
      pinnedIds: bundle.pinned.map((item) => item.id),
      slots: bundle.slots,
      relation: { stage: bundle.relation.stage, mode: bundle.relation.mode },
      presence,
      prompt: bundle.system,
      seed,
      trigger: input.trigger,
      reason: input.reason ?? null,
    };

    if (!this.llm.isConfigured()) {
      return this.degraded(bundle, planInput, DEGRADED_UNCONFIGURED, "unconfigured", ctxSnapshot);
    }

    let system = bundle.system;
    if (input.trigger === "proactive" || input.trigger === "impulse") {
      const reasonLine =
        input.reason !== undefined && input.reason.length > 0 ? `\n\n【这次开口的由头】${input.reason}（别解释这个由头，直接说）` : "";
      system += reasonLine;
    }

    let text = "";
    let model = "";
    let usage = { inputTokens: 0, outputTokens: 0 };
    let failReason: string | null = null;
    let rewriteReasons: string[] = [];
    const previous = this.anti.recentReplies(1)[0] ?? null;
    // 最多 3 次：首写 + 2 次重写；仍不过就换更短的分条（草案 4.6）
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const messages: LlmMessage[] = [{ role: "system", content: system }, ...bundle.messages];
      if (attempt > 0) {
        system = `${bundle.system}\n\n【重写要求】这次的表达不要和最近说过的话重复，换一个说法，并且更短。`;
      }
      try {
        const result = await this.llm.generate({
          messages,
          temperature: settings.get("llm.temperature"),
          maxTokens: settings.get("llm.maxTokens"),
          purpose: input.trigger === "reply" ? "reply" : "proactive",
        });
        text = result.text;
        model = result.model;
        usage = result.usage;
        const check = this.anti.check(text, input.now, previous);
        rewriteReasons = check.reasons;
        if (!check.rewrite) break;
      } catch (err) {
        failReason = err instanceof Error ? err.message : String(err);
        break;
      }
    }

    if (failReason !== null || text.length === 0) {
      return this.degraded(bundle, planInput, DEGRADED_FAILED, "failed", { ...ctxSnapshot, error: failReason });
    }

    const stillDuplicated = rewriteReasons.length > 0;
    const parts = stillDuplicated
      ? planParts(text, { ...planInput, traits: { ...persona.traits, burstMax: 1 } })
      : planParts(text, planInput);
    const finalParts = stillDuplicated ? parts.slice(0, 1) : parts;
    this.anti.record(text, input.now);

    return {
      parts: finalParts,
      fullText: joinFullText(finalParts),
      prompt: bundle.system,
      model,
      usage,
      ctxSnapshot: { ...ctxSnapshot, rewriteReasons },
    };
  }

  /** 降级：明确告知系统状态，仍按做人味节奏分条（不静默、不假装正常）。 */
  private degraded(
    bundle: PromptBundle,
    planInput: PlanPartsInput,
    text: string,
    reason: "unconfigured" | "failed",
    ctxSnapshot: unknown,
  ): ReplyPlan {
    const parts = planParts(text, planInput);
    return {
      parts,
      fullText: joinFullText(parts),
      prompt: bundle.system,
      model: reason === "unconfigured" ? "unconfigured" : "unavailable",
      usage: { inputTokens: 0, outputTokens: 0 },
      ctxSnapshot,
    };
  }
}

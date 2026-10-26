/**
 * 成本账本（草案 8 章）：每条用户消息边际成本 ≤ 普通聊天 2 倍；
 * 月度预算是 owner 也不能越过的硬项，超了直接拒绝调用。
 */
import { AnterosError, ERROR_CODES } from "@anteros/shared";
import type { CostEntry, CostSummary } from "@anteros/shared";
import type { Db } from "../db/database.js";
import type { SettingsService } from "../settings.js";

export type CostKind = "reply" | "proactive" | "impulse" | "extract" | "world" | "embedding";

interface CostRow {
  id: number;
  ts: number;
  kind: CostKind;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_cny: number;
}

export class CostService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly agentId: number,
  ) {}

  record(input: { kind: CostKind; model: string; inputTokens: number; outputTokens: number; ts?: number }): CostEntry {
    const ts = input.ts ?? Date.now();
    const priceIn = this.settings.get("llm.priceInputPerM");
    const priceOut = this.settings.get("llm.priceOutputPerM");
    const cost = (input.inputTokens / 1_000_000) * priceIn + (input.outputTokens / 1_000_000) * priceOut;
    const result = this.db.run(
      "INSERT INTO cost_ledger(agent_id, ts, kind, model, input_tokens, output_tokens, cost_cny) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [this.agentId, ts, input.kind, input.model, input.inputTokens, input.outputTokens, Number(cost.toFixed(6))],
    );
    return {
      id: result.lastInsertRowid,
      ts,
      kind: input.kind,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      costCny: Number(cost.toFixed(6)),
    };
  }

  /** 预算闸：超预算直接 EBLOCKED，不允许"先花再说"。 */
  checkBudget(): void {
    const budget = this.settings.get("plan.budgetCny");
    const month = this.monthCny();
    if (month >= budget) {
      throw new AnterosError(ERROR_CODES.EBLOCKED, `本月已花费 ¥${month.toFixed(2)}，达到预算上限 ¥${budget.toFixed(2)}`, {
        hint: "在 设置 → 成本 里调整月度预算，或等下月额度重置（成本上限是硬项）",
      });
    }
  }

  summary(): CostSummary {
    const now = Date.now();
    const startOfDay = (() => {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    })();
    const startOfMonth = (() => {
      const d = new Date(now);
      d.setDate(1);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    })();
    const sum = (from: number): number => {
      const row = this.db.get<{ total: number | null }>(
        "SELECT SUM(cost_cny) AS total FROM cost_ledger WHERE agent_id = ? AND ts >= ?",
        [this.agentId, from],
      );
      return Number(row?.total ?? 0);
    };
    const byModel = this.db.all<{ model: string; calls: number; input: number; output: number; cost: number }>(
      `SELECT model, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cost_cny) AS cost
       FROM cost_ledger WHERE agent_id = ? AND ts >= ? GROUP BY model ORDER BY cost DESC`,
      [this.agentId, startOfMonth],
    );
    const recent = this.db.all<CostRow>("SELECT * FROM cost_ledger WHERE agent_id = ? ORDER BY id DESC LIMIT 20", [
      this.agentId,
    ]);
    const turnRow = this.db.get<{ turns: number }>(
      "SELECT COUNT(*) AS turns FROM turns WHERE agent_id = ? AND trigger = 'reply'",
      [this.agentId],
    );
    const turns = Number(turnRow?.turns ?? 0);
    const monthCny = sum(startOfMonth);
    return {
      currency: "CNY",
      todayCny: Number(sum(startOfDay).toFixed(4)),
      monthCny: Number(monthCny.toFixed(4)),
      totalCny: Number(sum(0).toFixed(4)),
      monthlyBudgetCny: this.settings.get("plan.budgetCny"),
      turnCount: turns,
      byModel: byModel.map((row) => ({
        model: row.model,
        calls: Number(row.calls ?? 0),
        inputTokens: Number(row.input ?? 0),
        outputTokens: Number(row.output ?? 0),
        costCny: Number(Number(row.cost ?? 0).toFixed(4)),
      })),
      avgCostPerTurnCny: turns > 0 ? Number((monthCny / turns).toFixed(4)) : 0,
      recent: recent.map((row) => ({
        id: row.id,
        ts: row.ts,
        kind: row.kind,
        model: row.model,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        costCny: Number(row.cost_cny),
      })),
    };
  }

  setBudget(cny: number): CostSummary {
    if (!Number.isFinite(cny) || cny < 0) {
      throw new AnterosError(ERROR_CODES.EINVALID, "预算必须是非负数");
    }
    this.settings.set("plan.budgetCny", cny);
    return this.summary();
  }

  private monthCny(): number {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    const row = this.db.get<{ total: number | null }>(
      "SELECT SUM(cost_cny) AS total FROM cost_ledger WHERE agent_id = ? AND ts >= ?",
      [this.agentId, d.getTime()],
    );
    return Number(row?.total ?? 0);
  }
}
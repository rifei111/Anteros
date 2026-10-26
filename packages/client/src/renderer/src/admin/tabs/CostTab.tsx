import type { CostEntry } from "@anteros/shared";
import { useEffect, useState } from "react";
import { formatCny, formatClock, formatDateTime, formatPercent } from "../../lib/format";
import { invoke } from "../../lib/kernel";
import { pushToast, setState, useAppState } from "../../lib/store";
import { LoadingLine, Section, reportError, useLoad } from "../helpers";

const COST_KIND_LABEL: Record<string, string> = {
  reply: "回复",
  proactive: "主动消息",
  impulse: "冲动",
  extract: "记忆抽取",
  world: "世界状态",
  embedding: "向量化",
};

function budgetRatio(monthCny: number, budget: number): number {
  if (budget <= 0) return 0;
  return Math.min(1, Math.max(0, monthCny / budget));
}

/**
 * 成本看板：今日 / 本月 / 预算 / 每轮均价 + 按模型拆分 + 最近调用。
 * 预算可改；超预算由内核硬拦截，界面只负责显示真实数字。
 */
export function CostTab() {
  const state = useAppState();
  const loaded = useLoad(() => invoke("cost.summary", {}), []);
  const cost = loaded.data ?? state.cost;
  const [budgetText, setBudgetText] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (typeof cost?.monthlyBudgetCny === "number") setBudgetText(cost.monthlyBudgetCny.toFixed(2));
  }, [cost?.monthlyBudgetCny]);

  const saveBudget = async (): Promise<void> => {
    const value = Number(budgetText);
    if (!Number.isFinite(value) || value < 0) {
      pushToast("error", "预算不是合法数字", "填一个大于等于 0 的数，单位是元。");
      return;
    }
    setSaving(true);
    try {
      const next = await invoke("cost.setBudget", { monthlyCny: value });
      setState({ cost: next });
      pushToast("success", "预算已保存", `月度上限 ${formatCny(next.monthlyBudgetCny)}`);
    } catch (error) {
      reportError(error);
    } finally {
      setSaving(false);
    }
  };

  const recent: CostEntry[] = cost?.recent ?? [];

  return (
    <div className="panel-stack">
      <Section
        title="本月成本"
        hint="所有模型调用都记在这里，主动消息、记忆抽取也算。"
        action={
          <button className="btn btn-ghost" onClick={() => loaded.reload()}>
            刷新
          </button>
        }
      >
        <LoadingLine loading={loaded.loading} error={loaded.error} />
        {cost ? (
          <>
            <div className="stat-grid">
              <div className="stat-card">
                <div className="stat-value">{formatCny(cost.todayCny)}</div>
                <div className="stat-label">今日</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{formatCny(cost.monthCny)}</div>
                <div className="stat-label">本月</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{formatCny(cost.monthlyBudgetCny)}</div>
                <div className="stat-label">月度预算</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{formatCny(cost.avgCostPerTurnCny)}</div>
                <div className="stat-label">每轮均价</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{cost.turnCount}</div>
                <div className="stat-label">本月轮数</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{formatCny(cost.totalCny)}</div>
                <div className="stat-label">累计</div>
              </div>
            </div>
            <div className="meter-row">
              <span className="meter-label">预算使用</span>
              <div className="meter">
                <div
                  className={`meter-fill ${budgetRatio(cost.monthCny, cost.monthlyBudgetCny) >= 0.9 ? "alt" : ""}`}
                  style={{ width: `${budgetRatio(cost.monthCny, cost.monthlyBudgetCny) * 100}%` }}
                />
              </div>
              <span className="meter-value">{formatPercent(budgetRatio(cost.monthCny, cost.monthlyBudgetCny))}</span>
            </div>
          </>
        ) : (
          <div className="empty-note">还没读到成本数据。</div>
        )}
      </Section>

      <Section title="预算" hint="到上限后内核会直接拒绝调用，不会先花再报。">
        <div className="filter-row">
          <input
            className="input"
            inputMode="decimal"
            value={budgetText}
            onChange={(event) => setBudgetText(event.target.value)}
            aria-label="月度预算（元）"
          />
          <span className="muted">元 / 月</span>
          <button className="btn btn-primary" onClick={() => void saveBudget()} disabled={saving}>
            {saving ? "保存中…" : "保存预算"}
          </button>
        </div>
      </Section>

      <Section title="按模型" hint="哪个模型烧的钱，一目了然。">
        {cost && cost.byModel.length > 0 ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>模型</th>
                <th>调用</th>
                <th>输入 tokens</th>
                <th>输出 tokens</th>
                <th>费用</th>
              </tr>
            </thead>
            <tbody>
              {cost.byModel.map((row) => (
                <tr key={row.model}>
                  <td className="mono">{row.model}</td>
                  <td>{row.calls}</td>
                  <td>{row.inputTokens}</td>
                  <td>{row.outputTokens}</td>
                  <td>{formatCny(row.costCny)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-note">还没有模型调用记录。</div>
        )}
      </Section>

      <Section title="最近调用" hint="费用由内核记账，带四位小数不四舍五入到元。">
        {recent.length > 0 ? (
          <ul className="log-list">
            {recent.map((entry) => (
              <li key={entry.id} className="log-line">
                <span className="log-time mono">{formatClock(entry.ts)}</span>
                <span className="log-source mono">{COST_KIND_LABEL[entry.kind] ?? entry.kind}</span>
                <span className="log-message mono">
                  {entry.model} · in {entry.inputTokens} / out {entry.outputTokens}
                </span>
                <span className="log-cost mono">{formatCny(entry.costCny)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty-note">还没有调用。</div>
        )}
        {cost ? (
          <p className="muted">
            数据更新时间约 {formatDateTime(Date.now())}（来自最近一次 cost.summary）
          </p>
        ) : null}
      </Section>
    </div>
  );
}

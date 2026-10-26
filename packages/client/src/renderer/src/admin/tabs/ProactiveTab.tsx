import { useState } from "react";
import { formatDateTime, formatPercent } from "../../lib/format";
import { invoke } from "../../lib/kernel";
import { ACTION_REASON_LABEL, ACTION_STATE_LABEL, DRIVE_LABEL, labelOf } from "../../lib/labels";
import { pushToast, useAppState } from "../../lib/store";
import { LoadingLine, Section, reportError, useLoad } from "../helpers";

/** 与 KernelApi proactive.setFrequency 的 level 联合类型一致。 */
type FrequencyLevel = "off" | "low" | "normal" | "high";

const FREQ_OPTIONS: ReadonlyArray<{ id: FrequencyLevel; label: string; hint: string }> = [
  { id: "off", label: "关闭", hint: "不主动发消息，只在被叫到时回应" },
  { id: "low", label: "低", hint: "一天最多一两次，挑真正值得说的" },
  { id: "normal", label: "中", hint: "默认档位：有理由才开口" },
  { id: "high", label: "高", hint: "更容易想起你，但不会刷屏" },
];

const DRIVE_KEYS = ["loneliness", "boredom", "longing", "tension", "fatigue", "urgeToShare", "anxiety"] as const;

function payloadSummary(payload: unknown): string {
  if (payload === null || payload === undefined) return "—";
  if (typeof payload === "string") return payload;
  try {
    const text = JSON.stringify(payload);
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  } catch {
    return "（无法显示）";
  }
}

/**
 * 主动消息面板：待发 / 最近动作 / 频率档位。
 * 档位以后端返回为准；没读到之前不显示假档位。
 */
export function ProactiveTab() {
  const state = useAppState();
  const loaded = useLoad(() => invoke("proactive.list", {}), []);
  const [saving, setSaving] = useState<FrequencyLevel | null>(null);
  const [level, setLevel] = useState<FrequencyLevel | null>(null);
  const drives = state.drives;

  const setFrequency = async (next: FrequencyLevel): Promise<void> => {
    setSaving(next);
    try {
      const result = await invoke("proactive.setFrequency", { level: next });
      setLevel(result.level as FrequencyLevel);
      pushToast("success", "频率已更新", `当前档位：${result.level}`);
    } catch (error) {
      reportError(error);
    } finally {
      setSaving(null);
    }
  };

  const pending = loaded.data?.pending ?? [];
  const recent = loaded.data?.recent ?? [];

  return (
    <div className="panel-stack">
      <Section
        title="频率档位"
        hint={level === null ? "档位以内核确认为准；切换后这里会显示真实返回值。" : `当前档位：${level}`}
        action={
          <button className="btn btn-ghost" onClick={() => loaded.reload()}>
            刷新
          </button>
        }
      >
        <div className="segmented wrap">
          {FREQ_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`seg-btn ${level === option.id ? "active" : ""}`}
              title={option.hint}
              disabled={saving !== null}
              onClick={() => void setFrequency(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <ul className="bullet-list muted">
          {FREQ_OPTIONS.map((option) => (
            <li key={`${option.id}-hint`}>
              <strong>{option.label}</strong>：{option.hint}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="内部驱动" hint="驱动值来自内核，影响「想不想开口」；不是给你调的表盘。">
        {drives ? (
          <>
            <div className="meter-grid">
              {DRIVE_KEYS.map((key) => {
                const value = drives[key];
                return (
                  <div key={key} className="meter-row">
                    <span className="meter-label">{labelOf(DRIVE_LABEL, key)}</span>
                    <div className="meter">
                      <div
                        className="meter-fill"
                        style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
                      />
                    </div>
                    <span className="meter-value">{formatPercent(value)}</span>
                  </div>
                );
              })}
            </div>
            <p className="muted">更新于 {formatDateTime(drives.updatedTs)}</p>
          </>
        ) : (
          <div className="empty-note">还没收到驱动状态。</div>
        )}
      </Section>

      <Section title="待发动作" hint={`${pending.length} 条在队列里；到点才能发，不会提前。`}>
        <LoadingLine loading={loaded.loading} error={loaded.error} />
        {pending.length > 0 ? (
          <ul className="action-list">
            {pending.map((action) => (
              <li key={action.id} className="action-item">
                <div className="action-head">
                  <span className="badge badge-warn">{labelOf(ACTION_STATE_LABEL, action.state)}</span>
                  <span className="action-kind mono">{action.kind}</span>
                  <span className="action-reason muted">{labelOf(ACTION_REASON_LABEL, action.reason)}</span>
                </div>
                <div className="action-body">{payloadSummary(action.payload)}</div>
                <div className="action-meta muted">
                  截止 {formatDateTime(action.deadlineTs)} · TTL {Math.round(action.ttlMs / 1000)}s
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty-note">现在没有排队的动作。</div>
        )}
      </Section>

      <Section title="最近动作" hint="发过 / 被拦下 / 过期，都如实记在这里。">
        {recent.length > 0 ? (
          <ul className="action-list">
            {recent.map((action) => (
              <li key={action.id} className="action-item">
                <div className="action-head">
                  <span className="badge badge-muted">{labelOf(ACTION_STATE_LABEL, action.state)}</span>
                  <span className="action-kind mono">{action.kind}</span>
                  <span className="action-reason muted">{labelOf(ACTION_REASON_LABEL, action.reason)}</span>
                </div>
                <div className="action-body">{payloadSummary(action.payload)}</div>
                <div className="action-meta muted">创建于 {formatDateTime(action.createdTs)}</div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty-note">还没有历史动作。</div>
        )}
      </Section>

      <Section title="成本提示" hint="主动消息也会花钱，计入成本看板。">
        <p className="prose muted">
          主动消息走的是同一条模型链路，每次发送会计入月度成本；预算用尽后内核会直接拦截，不会偷偷发。
        </p>
        <p className="muted">
          今日 {state.cost ? `¥${state.cost.todayCny.toFixed(2)}` : "—"} · 本月{" "}
          {state.cost ? `¥${state.cost.monthCny.toFixed(2)}` : "—"}
        </p>
      </Section>
    </div>
  );
}

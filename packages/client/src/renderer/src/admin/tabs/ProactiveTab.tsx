import { useState } from "react";
import { refreshSnapshot } from "../../lib/app";
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
  const wechat = useLoad(() => invoke("channels.wechat.status", {}), []);
  const [relayBusy, setRelayBusy] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyText, setVerifyText] = useState<string | null>(null);
  const [saving, setSaving] = useState<FrequencyLevel | null>(null);
  // 初始值取快照里的档位：面板关掉再打开也要能看见当前档位，而不是一片空
  const [level, setLevel] = useState<FrequencyLevel | null>(state.proactive?.level ?? null);
  const [ticking, setTicking] = useState(false);
  const [tickResult, setTickResult] = useState<{ queued: boolean; message: string } | null>(null);
  const [force, setForce] = useState(false);
  const drives = state.drives;
  const summary = state.proactive;

  const setFrequency = async (next: FrequencyLevel): Promise<void> => {
    setSaving(next);
    try {
      const result = await invoke("proactive.setFrequency", { level: next });
      setLevel(result.level as FrequencyLevel);
      await refreshSnapshot();
      pushToast("success", "频率已更新", `当前档位：${result.level}`);
    } catch (error) {
      reportError(error);
    } finally {
      setSaving(null);
    }
  };

  const toggleRelay = async (enabled: boolean): Promise<void> => {
    setRelayBusy(true);
    try {
      await invoke("channels.wechat.setRelay", { enabled });
      wechat.reload();
      await refreshSnapshot();
      pushToast("success", enabled ? "主动消息会同步到微信" : "主动消息只发在应用里", "");
    } catch (error) {
      reportError(error);
    } finally {
      setRelayBusy(false);
    }
  };

  /** 真发一条自检消息，验证「主动消息 → 微信」这条线。 */
  const verifyRelay = async (): Promise<void> => {
    setVerifyBusy(true);
    try {
      const result = await invoke("proactive.verifyRelay", { text: "【自检】主动消息通路检查：你在微信里看到这句，就说明这条线通了。" });
      setVerifyText(result.message);
      wechat.reload();
      if (result.ok) {
        pushToast("success", "已发到微信", "去那个会话里看看有没有收到");
      } else {
        pushToast("warn", "没发出去", result.message);
      }
    } catch (error) {
      reportError(error);
    } finally {
      setVerifyBusy(false);
    }
  };

  /** 立刻跑一次判定：验证驱动、闸门和出口是不是真的在工作。 */
  const tickNow = async (): Promise<void> => {
    setTicking(true);
    try {
      const result = await invoke("proactive.tick", { force });
      setTickResult({
        queued: result.queued,
        message: result.queued
          ? `已排入队列（#${result.actionId}），理由：${result.reason ?? "—"}`
          : result.blockedBy ?? "没有被拦，但也没有理由开口",
      });
      loaded.reload();
    } catch (error) {
      reportError(error);
    } finally {
      setTicking(false);
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

      <Section
        title="现在想不想说话"
        hint="手动跑一次判定：看得见驱动、闸门和出口到底通没通，不用等到点。"
        action={
          <div className="row-actions">
            <label className="check-inline">
              <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />
              忽略闸门（只看驱动）
            </label>
            <button className="btn" disabled={ticking} onClick={() => void tickNow()}>
              {ticking ? "正在判定…" : "立即检查一次"}
            </button>
          </div>
        }
      >
        {summary ? (
          <ul className="kv-list">
            <li>
              <span>档位</span>
              <strong>{summary.level}</strong>（间隔 {summary.intervalMinutes} 分钟，每天最多 {summary.dailyCap} 条）
            </li>
            <li>
              <span>今天已发</span>
              <strong>{summary.sentToday}</strong> 条
              {summary.lastDeliveredTs ? `，上次 ${formatDateTime(summary.lastDeliveredTs)}` : ""}
            </li>
            <li>
              <span>静默时段</span>
              <strong>
                {summary.quietFromHour}:00 – {summary.quietToHour}:00
              </strong>
              {summary.paused ? "（当前已暂停）" : ""}
            </li>
            <li>
              <span>发到哪</span>
              <strong>
                {summary.relayToExternal
                  ? summary.externalReady
                    ? "同步到外部通道"
                    : "想同步外部通道，但通道没就绪"
                  : "只发在应用里"}
              </strong>
            </li>
          </ul>
        ) : (
          <p className="prose muted">内核还没给出主动消息状态。</p>
        )}
        {tickResult ? (
          <p className={tickResult.queued ? "prose ok-note" : "prose muted"}>{tickResult.message}</p>
        ) : null}

        <div className="kv-list-block">
          <label className="check-inline">
            <input
              type="checkbox"
              checked={wechat.data?.relayProactive === true}
              disabled={relayBusy}
              onChange={(event) => void toggleRelay(event.target.checked)}
            />
            主动消息同时发到微信会话
          </label>
          <p className="field-hint">
            {wechat.data?.state === "ready"
              ? "通道现在是通的；勾上以后，主动消息会在应用里出现之后，再发一份到那个会话。"
              : "通道现在没就绪：勾上也不会发出去，先在「通道」页把它开起来。"}
          </p>
          <button className="btn" disabled={verifyBusy} onClick={() => void verifyRelay()}>
            {verifyBusy ? "正在发送…" : "验证一次：主动消息 → 微信"}
          </button>
          {verifyText ? <p className="prose muted">{verifyText}</p> : null}
        </div>
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

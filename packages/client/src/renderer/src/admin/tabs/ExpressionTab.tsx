import type { AgentMode } from "@anteros/shared";
import { useState } from "react";
import { Modal, useConfirm } from "../../components/Modal";
import { formatDateTime, formatPercent } from "../../lib/format";
import { invoke } from "../../lib/kernel";
import { RELATION_STAGE_LABEL, labelOf } from "../../lib/labels";
import { pushToast, setState, useAppState } from "../../lib/store";
import { LoadingLine, Section, reportError, requestToken, useLoad } from "../helpers";

const MODE_LABEL: Record<AgentMode, string> = {
  standard: "标准模式（默认）",
  full_human: "完全体模式（高风险，默认关闭）",
};

/**
 * 表达面板：关系阶段 + 完全体开关。
 * 完全体默认关闭，开启要经过风险页 + 二次确认 + confirm.token；关闭随时可点。
 */
export function ExpressionTab() {
  const state = useAppState();
  const relation = state.relation;
  const ledger = useLoad(() => invoke("relation.ledger", { limit: 20 }), []);
  const confirm = useConfirm();
  const [riskOpen, setRiskOpen] = useState(false);
  const [riskChecked, setRiskChecked] = useState(false);
  const [busy, setBusy] = useState(false);

  const currentMode: AgentMode = relation?.mode ?? "standard";

  const switchMode = async (mode: AgentMode): Promise<void> => {
    setBusy(true);
    try {
      const token = await requestToken("relation.setMode");
      const next = await invoke("relation.setMode", { mode, confirmToken: token });
      setState({ relation: next });
      pushToast(
        "success",
        mode === "full_human" ? "已开启完全体模式" : "已切回标准模式",
        mode === "full_human" ? "它会更像一个真人；随时可以关。" : "已恢复默认边界。",
      );
      setRiskOpen(false);
      setRiskChecked(false);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const confirmEnable = async (): Promise<void> => {
    if (!riskChecked) return;
    const agreed = await confirm.ask({
      title: "确认开启完全体模式？",
      body: (
        <div>
          <p>完全体会放宽表达边界：更长的沉默、更主观的判断、更像真人的语气。</p>
          <p className="danger-text">
            它仍然不是真人，也可能出错；一旦让你不舒服，随时点关闭。这个开关会写审计日志。
          </p>
        </div>
      ),
      confirmLabel: "开启",
      danger: true,
    });
    if (!agreed) return;
    await switchMode("full_human");
  };

  const disableFull = async (): Promise<void> => {
    const agreed = await confirm.ask({
      title: "关闭完全体模式？",
      body: <p>关闭是随时可做的，不需要理由。</p>,
      confirmLabel: "关闭",
      danger: false,
    });
    if (!agreed) return;
    await switchMode("standard");
  };

  if (!relation) {
    return (
      <div className="panel-stack">
        <LoadingLine loading error={null} />
        <div className="empty-note">还没读取到关系状态：内核可能还在启动。</div>
      </div>
    );
  }

  return (
    <div className="panel-stack">
      {confirm.node}

      <Section title="关系阶段" hint="阶段由真实互动推进，不点按钮直接改。">
        <div className="relation-card">
          <div className="relation-stage">{labelOf(RELATION_STAGE_LABEL, relation.stage)}</div>
          <div className="relation-meta muted">
            自 {formatDateTime(relation.sinceTs)}
            {relation.lastTransitionTs ? ` · 最近变化 ${formatDateTime(relation.lastTransitionTs)}` : ""}
          </div>
          <div className="meter-row">
            <span className="meter-label">亲密度</span>
            <div className="meter">
              <div className="meter-fill" style={{ width: `${Math.max(0, Math.min(1, relation.intimacy)) * 100}%` }} />
            </div>
            <span className="meter-value">{formatPercent(relation.intimacy)}</span>
          </div>
          <div className="meter-row">
            <span className="meter-label">信任</span>
            <div className="meter">
              <div className="meter-fill alt" style={{ width: `${Math.max(0, Math.min(1, relation.trust)) * 100}%` }} />
            </div>
            <span className="meter-value">{formatPercent(relation.trust)}</span>
          </div>
        </div>

        {relation.transitionLog.length > 0 ? (
          <ul className="bullet-list muted">
            {relation.transitionLog
              .slice(-8)
              .reverse()
              .map((entry, index) => (
                <li key={`${entry.ts}-${index}`}>
                  {labelOf(RELATION_STAGE_LABEL, entry.from)} → {labelOf(RELATION_STAGE_LABEL, entry.to)}
                  （{entry.trigger}）· {formatDateTime(entry.ts)}
                </li>
              ))}
          </ul>
        ) : null}
      </Section>

      <Section title="完全体模式" hint="默认关闭。开启要读风险页并二次确认。">
        <div className={`mode-box ${currentMode === "full_human" ? "full" : ""}`}>
          <div className="mode-head">
            <div>
              <div className="mode-title">{MODE_LABEL[currentMode]}</div>
              <div className="muted">
                {currentMode === "full_human"
                  ? "现在更放开：它会保留更多主观判断，也更少自我解释。"
                  : "现在更克制：有边界、有自我说明，遇到不确定会说不知道。"}
              </div>
            </div>
            {currentMode === "full_human" ? (
              <button className="btn btn-lg" onClick={() => void disableFull()} disabled={busy}>
                关闭完全体
              </button>
            ) : (
              <button className="btn btn-danger btn-lg" onClick={() => setRiskOpen(true)} disabled={busy}>
                开启完全体…
              </button>
            )}
          </div>
          <ul className="bullet-list muted">
            <li>完全体不等于真人：不虚构事实，不假装在线，不假装已读。</li>
            <li>「关闭」永远只有一个按钮，不需要理由，不需要确认 token 之外的等待。</li>
          </ul>
        </div>
      </Section>

      <Section
        title="关系台账"
        hint="记录每次「它选了什么、放弃了什么」。这是它的边界记录，不是给你的报表。"
        action={<button className="btn btn-ghost" onClick={() => ledger.reload()}>刷新</button>}
      >
        <LoadingLine loading={ledger.loading} error={ledger.error} />
        {ledger.data && ledger.data.entries.length > 0 ? (
          <ul className="ledger-list">
            {ledger.data.entries.map((entry) => (
              <li key={entry.id} className="ledger-item">
                <div className="ledger-meta muted">{formatDateTime(entry.ts)}</div>
                <div className="ledger-situation">{entry.situation}</div>
                <div className="ledger-choice">选择：{entry.chosen}</div>
                <div className="ledger-giveup">放弃：{entry.givenUp}</div>
                {entry.userReaction ? <div className="ledger-reaction">你的反应：{entry.userReaction}</div> : null}
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty-note">还没有值得记账的关系选择。</div>
        )}
      </Section>

      {riskOpen ? (
        <Modal
          title="开启完全体模式前，请先读这几条"
          onClose={() => {
            setRiskOpen(false);
            setRiskChecked(false);
          }}
          wide
          footer={
            <>
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setRiskOpen(false);
                  setRiskChecked(false);
                }}
              >
                先不开
              </button>
              <button className="btn btn-danger" onClick={() => void confirmEnable()} disabled={!riskChecked || busy}>
                我已理解，继续
              </button>
            </>
          }
        >
          <ul className="bullet-list danger-list">
            <li>完全体会让它更像真人，也更容易让你忘记它不是真人。这本身就是风险。</li>
            <li>它仍然可能说错话、记错事；重要的事不要只问它，也不要靠它做决定。</li>
            <li>完全体不会解除红线：不冒充真人身份骗你，不做危机干预，不越法律与平台边界。</li>
            <li>开启与关闭都会写入本机审计日志；关闭随时可做，不需要理由。</li>
          </ul>
          <label className="consent-item">
            <input
              type="checkbox"
              className="consent-checkbox"
              checked={riskChecked}
              onChange={(event) => setRiskChecked(event.target.checked)}
            />
            <span className="consent-item-body">
              <span className="consent-item-title">我已读完并理解以上风险</span>
              <span className="consent-item-text">不勾选就不会进入下一步。</span>
            </span>
          </label>
        </Modal>
      ) : null}
    </div>
  );
}

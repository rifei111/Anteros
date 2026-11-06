import { useMemo, useState } from "react";
import { acceptConsent, quitApplication } from "../lib/app";
import { useAppState } from "../lib/store";

/**
 * 声明闸（v2 哑光纸）：逐条勾选九条，全勾才可进入；没有「一键同意」；
 * 底部永远有「我不接受，退出」。文案来自内核的版本化 items，不在前端硬编码。
 *
 * 版式：1004 宽卡片、两列（左 1–4 / 右 5–9）、17px 复选、底栏九段进度。
 * 这样九条能在一屏内读完，而不是让第 5 条卡在滚动边界上。
 */
const LEFT_COUNT = 4;

export function ConsentGate() {
  const state = useAppState();
  const consent = state.consent;
  const items = consent?.items ?? [];
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [quitting, setQuitting] = useState(false);

  const allChecked = items.length > 0 && items.every((item) => checked.has(item.id));
  const requiredIds = useMemo(() => items.map((item) => item.id), [items]);
  const left = items.slice(0, LEFT_COUNT);
  const right = items.slice(LEFT_COUNT);

  const toggle = (id: string): void => {
    setChecked((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async (): Promise<void> => {
    if (!allChecked || submitting) return;
    setSubmitting(true);
    try {
      await acceptConsent(requiredIds.filter((id) => checked.has(id)));
    } finally {
      setSubmitting(false);
    }
  };

  const quit = async (): Promise<void> => {
    setQuitting(true);
    await quitApplication();
  };

  const renderItem = (item: (typeof items)[number], index: number) => (
    <label className={`consent-item ${checked.has(item.id) ? "checked" : ""}`} key={item.id}>
      <input
        type="checkbox"
        checked={checked.has(item.id)}
        onChange={() => toggle(item.id)}
        aria-label={item.title}
      />
      <span className="consent-item-body">
        <span className="consent-item-title">
          <span className="consent-num">{String(index + 1).padStart(2, "0")}</span>
          {item.title}
        </span>
        <span className="consent-item-text">{item.body}</span>
      </span>
    </label>
  );

  return (
    <div className="center-screen consent-screen">
      <div className="consent-card">
        <header className="consent-head">
          <h1>进入前，请逐条读完这九条</h1>
          <p>
            你现在要在这台电脑上运行一个拟人智能体。它说话像真人，但它不是真人；它的记忆、人格、密钥都只存在本机。
          </p>
          {consent ? (
            <div className="consent-ver">声明版本 {consent.docVersion} · 逐条勾选，没有一键同意</div>
          ) : null}
        </header>

        <div className="consent-cols">
          {left.length > 0 ? (
            <div className="consent-col">{left.map((item, index) => renderItem(item, index))}</div>
          ) : null}
          {right.length > 0 ? (
            <div className="consent-col">
              {right.map((item, index) => renderItem(item, index + LEFT_COUNT))}
            </div>
          ) : null}
          {items.length === 0 ? <div className="empty-note">正在从内核读取声明文案…</div> : null}
        </div>

        {state.consentError ? <div className="inline-error">{state.consentError}</div> : null}

        <footer className="consent-foot">
          <div className="consent-progress" aria-hidden="true">
            <span className="consent-segs">
              {items.map((item) => (
                <i key={item.id} className={checked.has(item.id) ? "on" : ""} />
              ))}
            </span>
            <span className="consent-count">
              已勾选 {checked.size} / {items.length}
            </span>
          </div>
          <div className="consent-actions">
            <button className="btn btn-ghost" onClick={() => void quit()} disabled={quitting}>
              {quitting ? "正在退出…" : "我不接受，退出"}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void submit()}
              disabled={!allChecked || submitting}
            >
              {submitting ? "正在记录…" : "进入"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
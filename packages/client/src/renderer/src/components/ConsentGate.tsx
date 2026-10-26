import { useMemo, useState } from "react";
import { acceptConsent, quitApplication } from "../lib/app";
import { useAppState } from "../lib/store";

/**
 * 声明闸（草案 14.14.5）：逐条勾选九条，全勾才可进入；没有「一键同意」；
 * 底部永远有「我不接受，退出」。文案来自内核的版本化 items，不在前端硬编码。
 */
export function ConsentGate() {
  const state = useAppState();
  const consent = state.consent;
  const items = consent?.items ?? [];
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [quitting, setQuitting] = useState(false);

  const allChecked = items.length > 0 && items.every((item) => checked.has(item.id));
  const requiredIds = useMemo(() => items.map((item) => item.id), [items]);

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

  return (
    <div className="center-screen">
      <div className="consent-card">
        <header className="consent-head">
          <h1>进入前，请逐条读完这九条</h1>
          <p>
            你现在要在这台电脑上运行一个拟人智能体。它说话像真人，但它不是真人；它的记忆、人格、密钥都只存在本机。
            {consent ? ` 声明版本 ${consent.docVersion}。` : ""}
          </p>
        </header>

        <div className="consent-list">
          {items.map((item, index) => (
            <label className={`consent-item ${checked.has(item.id) ? "checked" : ""}`} key={item.id}>
              <input
                type="checkbox"
                checked={checked.has(item.id)}
                onChange={() => toggle(item.id)}
                aria-label={item.title}
              />
              <div className="consent-item-body">
                <div className="consent-item-title">
                  <span className="consent-index">{index + 1}</span>
                  {item.title}
                </div>
                <div className="consent-item-text">{item.body}</div>
              </div>
            </label>
          ))}
          {items.length === 0 ? <div className="empty-note">正在从内核读取声明文案…</div> : null}
        </div>

        {state.consentError ? <div className="inline-error">{state.consentError}</div> : null}

        <footer className="consent-foot">
          <div className="consent-progress">
            已勾选 {checked.size} / {items.length}
            {allChecked ? "" : "（必须全部勾选才能进入）"}
          </div>
          <div className="consent-actions">
            <button className="btn btn-ghost" onClick={() => void quit()} disabled={quitting}>
              {quitting ? "正在退出…" : "我不接受，退出"}
            </button>
            <button className="btn btn-primary" onClick={() => void submit()} disabled={!allChecked || submitting}>
              {submitting ? "正在记录…" : "进入"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

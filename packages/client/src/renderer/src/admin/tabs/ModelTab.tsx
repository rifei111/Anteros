import { useEffect, useState } from "react";
import { invoke } from "../../lib/kernel";
import { pushToast, setState, useAppState } from "../../lib/store";
import { LoadingLine, Section, reportError, useLoad } from "../helpers";

/**
 * 模型面板：显示真实连接状态；配置一律只写不回显，保存后只显示「已配置」。
 * 没有「测试成功」的假动画——测试就是重新读一次内核状态。
 */
export function ModelTab() {
  const state = useAppState();
  const loaded = useLoad(() => invoke("llm.status", {}), []);
  const status = loaded.data ?? state.llm;
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [temperature, setTemperature] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (status?.model) setModel(status.model);
  }, [status?.model]);

  const save = async (): Promise<void> => {
    if (baseUrl.trim().length === 0 || model.trim().length === 0) {
      pushToast("error", "Base URL 和模型名都要填", "不需要改的时候留空即可。");
      return;
    }
    setSaving(true);
    try {
      const params: {
        baseUrl: string;
        model: string;
        apiKey?: string;
        temperature?: number;
        maxTokens?: number;
      } = { baseUrl: baseUrl.trim(), model: model.trim() };
      if (apiKey.trim().length > 0) params.apiKey = apiKey.trim();
      const tempValue = Number(temperature);
      if (temperature.trim().length > 0 && Number.isFinite(tempValue)) params.temperature = tempValue;
      const maxValue = Number(maxTokens);
      if (maxTokens.trim().length > 0 && Number.isFinite(maxValue)) params.maxTokens = Math.round(maxValue);
      const result = await invoke("llm.configure", params);
      setState({ llm: result.status });
      setApiKey("");
      pushToast(
        result.status.online ? "success" : "warn",
        result.status.online ? "已配置并连通" : "已保存，但还没连通",
        result.status.online ? null : (result.status.lastError ?? "检查 Base URL / 模型名 / 密钥后重试。"),
      );
      loaded.reload();
    } catch (error) {
      reportError(error);
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async (): Promise<void> => {
    setTesting(true);
    try {
      const next = await invoke("llm.status", {});
      setState({ llm: next });
      if (next.online) {
        pushToast("success", "连接正常", `${next.providerName} · ${next.model}`);
      } else {
        pushToast("error", "连接不通", next.lastError ?? "内核没有拿到有效响应。");
      }
    } catch (error) {
      reportError(error);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="panel-stack">
      {status && !status.online ? (
        <div className="banner banner-warn">
          <div>
            <div className="banner-title">模型未接通：回复会退回本地回声（演示模式）</div>
            <div className="banner-detail">
              {status.lastError ?? "没配置 Base URL / 模型 / 密钥，或服务不可达。"}
              {status.degradedLocalEcho ? " 现在所有回复都由本机生成，不产生云端调用。" : ""}
            </div>
          </div>
        </div>
      ) : null}

      <Section
        title="当前模型"
        hint="状态来自内核，密钥与地址只在本机，界面不回显。"
        action={
          <button className="btn btn-ghost" onClick={() => loaded.reload()}>
            刷新
          </button>
        }
      >
        <LoadingLine loading={loaded.loading} error={loaded.error} />
        {status ? (
          <dl className="kv-grid">
            <dt>服务</dt>
            <dd>
              {status.providerName} <span className="mono muted">（{status.providerId}）</span>
            </dd>
            <dt>模型</dt>
            <dd className="mono">{status.model}</dd>
            <dt>连接状态</dt>
            <dd>
              <span className={`badge ${status.online ? "badge-ok" : "badge-warn"}`}>
                {status.online ? "在线（真实心跳）" : "未接通"}
              </span>
            </dd>
            <dt>密钥</dt>
            <dd>已配置（只写不回显；要换就重新填一次）</dd>
            <dt>本地回声降级</dt>
            <dd>{status.degradedLocalEcho ? "是（当前回复不走向云端）" : "否"}</dd>
            {status.lastError ? (
              <>
                <dt>最近错误</dt>
                <dd className="danger-text">{status.lastError}</dd>
              </>
            ) : null}
          </dl>
        ) : (
          <div className="empty-note">还没读到模型状态。</div>
        )}
        <div className="row-actions">
          <button className="btn" onClick={() => void testConnection()} disabled={testing}>
            {testing ? "测试中…" : "测试连接"}
          </button>
        </div>
      </Section>

      <Section title="配置模型" hint="改模型时请一起填 Base URL——内核出于安全不回显旧地址。">
        <div className="field">
          <label className="field-label" htmlFor="model-baseurl">
            Base URL
          </label>
          <input
            id="model-baseurl"
            className="input mono"
            placeholder="例如 https://api.example.com/v1"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="model-name">
            模型名
          </label>
          <input
            id="model-name"
            className="input mono"
            placeholder="例如 deepseek-chat"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="model-key">
            API Key（留空表示不修改）
          </label>
          <input
            id="model-key"
            className="input mono"
            type="password"
            placeholder="sk-…（写进去就不再回显）"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="new-password"
          />
        </div>
        <div className="field-row">
          <div className="field">
            <label className="field-label" htmlFor="model-temp">
              temperature（可选）
            </label>
            <input
              id="model-temp"
              className="input mono"
              inputMode="decimal"
              placeholder="0.8"
              value={temperature}
              onChange={(event) => setTemperature(event.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="model-maxtokens">
              maxTokens（可选）
            </label>
            <input
              id="model-maxtokens"
              className="input mono"
              inputMode="numeric"
              placeholder="1024"
              value={maxTokens}
              onChange={(event) => setMaxTokens(event.target.value)}
            />
          </div>
        </div>
        <div className="row-actions">
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
            {saving ? "保存中…" : "保存配置"}
          </button>
          <span className="muted">保存后只显示「已配置」；密钥不会出现在任何界面或日志里。</span>
        </div>
      </Section>
    </div>
  );
}

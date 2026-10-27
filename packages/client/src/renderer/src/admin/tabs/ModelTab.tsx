import { useEffect, useMemo, useRef, useState } from "react";
import { LLM_PRESETS, type LlmPreset, type LlmProbeResult, type PluginInfo } from "@anteros/shared";
import { invoke } from "../../lib/kernel";
import { pushToast, setState, useAppState } from "../../lib/store";
import { LoadingLine, Section, reportError, requestToken, useLoad } from "../helpers";

/**
 * 模型页：服务商预设 → 地址/密钥/模型 → 真探测 → 保存。
 *
 * 三条原则：
 * 1. 「在线」必须是真连上过（llm.test 发真请求），不是"填了就算在线"；
 * 2. 密钥只写不回显，界面永远只显示"已保存"；
 * 3. 同一份配置也写进 core.llm-router 的插件配置——用户只在这里配一次，
 *    不再去插件页签抄 Base URL 和模型名。
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
  const [presetId, setPresetId] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<LlmProbeResult | null>(null);
  const [routerBusy, setRouterBusy] = useState(false);
  const [formInit, setFormInit] = useState(false);
  const routerRetry = useRef(0);

  // 首次拿到状态后填一次表单；之后用户改过就不再覆盖（否则打字会被状态刷新打断）
  useEffect(() => {
    if (formInit || !status) return;
    const sameModel = LLM_PRESETS.find((preset) => preset.model.length > 0 && preset.model === status.model);
    setBaseUrl(status.baseUrl && status.baseUrl.length > 0 ? status.baseUrl : (sameModel?.baseUrl ?? ""));
    setModel(status.model ?? "");
    if (typeof status.temperature === "number") setTemperature(String(status.temperature));
    if (typeof status.maxTokens === "number") setMaxTokens(String(status.maxTokens));
    setFormInit(true);
  }, [status, formInit]);

  // 内核的插件是 ready 之后才开始拉起的：首屏可能还读不到路由插件，隔一会儿补读两次
  useEffect(() => {
    if (status?.router != null || routerRetry.current >= 3) return;
    const timer = setTimeout(() => {
      routerRetry.current += 1;
      loaded.reload();
    }, 1_500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.router]);

  const activePreset = useMemo(
    () =>
      LLM_PRESETS.find(
        (preset) => preset.baseUrl.length > 0 && normalize(preset.baseUrl) === normalize(baseUrl),
      ) ?? null,
    [baseUrl],
  );

  const applyPreset = (preset: LlmPreset): void => {
    setPresetId(preset.id);
    if (preset.baseUrl.length > 0) setBaseUrl(preset.baseUrl);
    if (preset.model.length > 0) setModel(preset.model);
    setProbe(null);
  };

  const probeOnce = async (fromForm: boolean): Promise<void> => {
    setProbing(true);
    try {
      const params: { baseUrl?: string; apiKey?: string; model?: string } = {};
      if (fromForm) {
        if (baseUrl.trim().length > 0) params.baseUrl = baseUrl.trim();
        if (model.trim().length > 0) params.model = model.trim();
        if (apiKey.trim().length > 0) params.apiKey = apiKey.trim();
      }
      const result = await invoke("llm.test", params);
      setProbe(result);
      pushToast(
        result.ok ? "success" : "error",
        result.ok ? "连接通过" : "连接不通",
        result.message,
      );
    } catch (error) {
      reportError(error);
    } finally {
      setProbing(false);
    }
  };

  const save = async (): Promise<void> => {
    if (baseUrl.trim().length === 0 || model.trim().length === 0) {
      pushToast("error", "Base URL 和模型名都要填", "先选一个服务商，或者手动填地址与模型名。");
      return;
    }
    setSaving(true);
    try {
      const params: {
        baseUrl: string;
        model: string;
        providerId?: string;
        apiKey?: string;
        temperature?: number;
        maxTokens?: number;
      } = { baseUrl: baseUrl.trim(), model: model.trim() };
      if (presetId.length > 0) params.providerId = presetId;
      if (apiKey.trim().length > 0) params.apiKey = apiKey.trim();
      const tempValue = Number(temperature);
      if (temperature.trim().length > 0 && Number.isFinite(tempValue)) params.temperature = tempValue;
      const maxValue = Number(maxTokens);
      if (maxTokens.trim().length > 0 && Number.isFinite(maxValue)) params.maxTokens = Math.round(maxValue);
      const result = await invoke("llm.configure", params);
      setState({ llm: result.status });
      setApiKey("");
      pushToast(
        "success",
        "已保存并应用",
        "同一份配置已同步给 LLM 路由插件（如果装了的话）。建议再点一次「测试连接」确认真的通。",
      );
      loaded.reload();
    } catch (error) {
      reportError(error);
    } finally {
      setSaving(false);
    }
  };

  /** 路由插件：授权（要 token）+ 启用，一步到位，省得在插件页签里点三次 */
  const enableRouter = async (): Promise<void> => {
    const router = status?.router;
    if (!router) return;
    setRouterBusy(true);
    try {
      if (!router.grantedAll) {
        const token = await requestToken("plugins.grant", router.id);
        await invoke("plugins.grant", { id: router.id, permissions: router.missingGrants, confirmToken: token });
      }
      const plugin = await invoke("plugins.enable", { id: router.id });
      applyRouter(plugin);
      pushToast(
        plugin.enabled ? "success" : "warn",
        plugin.enabled ? "路由插件已启用" : "路由插件仍被拦住",
        plugin.enabled ? null : plugin.issues.join("；"),
      );
      loaded.reload();
    } catch (error) {
      reportError(error);
    } finally {
      setRouterBusy(false);
    }
  };

  const disableRouter = async (): Promise<void> => {
    const router = status?.router;
    if (!router) return;
    setRouterBusy(true);
    try {
      const plugin = await invoke("plugins.disable", { id: router.id });
      applyRouter(plugin);
      pushToast("success", "路由插件已停用", "回复会走内核内置的兜底客户端。");
      loaded.reload();
    } catch (error) {
      reportError(error);
    } finally {
      setRouterBusy(false);
    }
  };

  /** 插件状态回到 llm.status.router 上，省一次整页刷新 */
  const applyRouter = (plugin: PluginInfo): void => {
    const current = status;
    if (!current) return;
    const missingGrants = plugin.grantable.filter((item) => !plugin.granted.includes(item));
    setState({
      llm: {
        ...current,
        router: {
          id: plugin.id,
          enabled: plugin.enabled,
          status: plugin.status,
          grantedAll: missingGrants.length === 0,
          missingGrants,
          missingSecrets: plugin.missingSecrets,
          issues: plugin.issues,
          config: plugin.config,
        },
      },
    });
  };

  const router = status?.router ?? null;
  const models = probe?.models ?? [];

  return (
    <div className="panel-stack">
      {status && !status.online ? (
        <div className="banner banner-warn">
          <div>
            <div className="banner-title">还没接通模型：现在的回复来自本机回声（演示模式）</div>
            <div className="banner-detail">
              {status.lastError ?? "选一个服务商、填密钥、点「测试连接」确认通了，再保存。"}
              {status.degradedLocalEcho ? " 不接通也能玩：所有回复都在本机生成，不产生云端调用。" : ""}
            </div>
          </div>
        </div>
      ) : null}

      <Section
        title="当前模型"
        hint="状态来自内核；密钥只存在本机加密库，任何界面都不回显。"
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
            <dd className="mono">{status.model || "—"}</dd>
            <dt>Base URL</dt>
            <dd className="mono">{status.baseUrl || "—"}</dd>
            <dt>密钥</dt>
            <dd>{status.hasKey ? "已保存（只写不回显）" : "未配置"}</dd>
            <dt>连接状态</dt>
            <dd>
              <span className={`badge ${status.online ? "badge-ok" : "badge-warn"}`}>
                {status.online ? "已配置" : "未接通"}
              </span>
              {probe ? (
                <span className={`badge ${probe.ok ? "badge-ok" : "badge-warn"}`} style={{ marginLeft: 8 }}>
                  {probe.ok ? `真连上了 · ${probe.latencyMs}ms` : "真探测没通过"}
                </span>
              ) : null}
            </dd>
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
          <button className="btn" onClick={() => void probeOnce(false)} disabled={probing}>
            {probing ? "测试中…" : "用已保存的配置测试"}
          </button>
          <span className="muted">会用已保存的地址与密钥真发一次请求，不改任何配置。</span>
        </div>
      </Section>

      <Section title="选择服务" hint="都是 OpenAI 兼容协议；选一个就会把地址和默认模型填进下面的表单。">
        <div className="chip-wrap">
          {LLM_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`chip chip-button${activePreset?.id === preset.id ? " chip-active" : ""}`}
              onClick={() => applyPreset(preset)}
              title={preset.consoleUrl ? `密钥申请：${preset.consoleUrl}` : (preset.note ?? "")}
            >
              {preset.label}
            </button>
          ))}
        </div>
        {activePreset?.note ? <p className="prose muted">{activePreset.note}</p> : null}
        {activePreset?.consoleUrl ? (
          <p className="prose muted">
            密钥申请地址（手动复制）：<span className="mono">{activePreset.consoleUrl}</span>
          </p>
        ) : null}
      </Section>

      <Section title="配置" hint="改哪项填哪项；密钥留空表示不改。保存后会同步给路由插件。">
        <div className="field">
          <label className="field-label" htmlFor="model-baseurl">
            Base URL
          </label>
          <input
            id="model-baseurl"
            className="input mono"
            placeholder="https://api.deepseek.com/v1"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="model-name">
            模型名
          </label>
          <div className="row-actions">
            <input
              id="model-name"
              className="input mono"
              placeholder="deepseek-chat"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <button className="btn" onClick={() => void probeOnce(true)} disabled={probing}>
              {probing ? "拉取中…" : "拉取模型列表"}
            </button>
          </div>
          {models.length > 0 ? (
            <div className="chip-wrap" style={{ marginTop: 8 }}>
              {models.slice(0, 40).map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`chip chip-button${name === model ? " chip-active" : ""}`}
                  onClick={() => setModel(name)}
                >
                  {name}
                </button>
              ))}
              {models.length > 40 ? <span className="muted">…共 {models.length} 个</span> : null}
            </div>
          ) : null}
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
        {probe ? (
          <div className={`banner ${probe.ok ? "banner-info" : "banner-warn"}`}>
            <div>
              <div className="banner-title">
                {probe.ok ? "探测通过" : "探测没通过"} · {probe.via === "models" ? "/models" : probe.via === "chat" ? "对话请求" : "—"}
                {probe.httpStatus ? ` · HTTP ${probe.httpStatus}` : ""} · {probe.latencyMs}ms
              </div>
              <div className="banner-detail">{probe.message}</div>
            </div>
          </div>
        ) : null}
        <div className="row-actions">
          <button className="btn" onClick={() => void probeOnce(true)} disabled={probing}>
            {probing ? "测试中…" : "用表单里的值测试"}
          </button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
            {saving ? "保存中…" : "保存并应用"}
          </button>
          <span className="muted">密钥不会出现在任何界面、日志或审计里；审计只记「改了哪项」。</span>
        </div>
      </Section>

      <Section
        title="插件里的模型服务"
        hint="LLM 路由插件是可选的代理层：想让内核的请求走你自己的服务时启用它。它的地址与模型跟上面是同一份。"
      >
        {router === null ? (
          <div className="empty-note">
            没发现 core.llm-router 插件（打包版应自带；开发期检查 <span className="mono">plugins/</span> 目录）。
            没有它也能用：内核自带兜底客户端。
          </div>
        ) : (
          <>
            <dl className="kv-grid">
              <dt>插件</dt>
              <dd className="mono">{router.id}</dd>
              <dt>状态</dt>
              <dd>
                <span className={`badge ${router.enabled ? "badge-ok" : "badge-warn"}`}>
                  {router.enabled ? "已启用" : "未启用"}
                </span>
                <span className="mono muted" style={{ marginLeft: 8 }}>
                  {router.status}
                </span>
              </dd>
              <dt>授权</dt>
              <dd>
                {router.grantedAll ? "已齐" : `还差 ${router.missingGrants.length} 项：${router.missingGrants.join("、")}`}
              </dd>
              <dt>密钥</dt>
              <dd>
                {router.missingSecrets.length === 0
                  ? "已录入（在上面填 API Key 保存时会自动同步）"
                  : `缺：${router.missingSecrets.join("、")}`}
              </dd>
              <dt>它读到的地址</dt>
              <dd className="mono">
                {String(router.config.baseUrl ?? "—")} · {String(router.config.model ?? "—")}
              </dd>
              {router.issues.length > 0 ? (
                <>
                  <dt>提示</dt>
                  <dd className="danger-text">{router.issues.join("；")}</dd>
                </>
              ) : null}
            </dl>
            <div className="row-actions">
              {router.enabled ? (
                <button className="btn" onClick={() => void disableRouter()} disabled={routerBusy}>
                  {routerBusy ? "处理中…" : "停用路由插件"}
                </button>
              ) : (
                <button className="btn btn-primary" onClick={() => void enableRouter()} disabled={routerBusy}>
                  {routerBusy ? "处理中…" : router.grantedAll ? "启用路由插件" : "授权并启用"}
                </button>
              )}
              <span className="muted">
                授权与密钥都由内核校验；停用后对话照常，只是不走这个插件。更细的项见「插件」页签。
              </span>
            </div>
          </>
        )}
      </Section>
    </div>
  );
}

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

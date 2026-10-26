import type { PluginInfo } from "@anteros/shared";
import { useState } from "react";
import { Modal, useConfirm } from "../../components/Modal";
import { invoke } from "../../lib/kernel";
import { PLUGIN_STATUS_LABEL, RISK_LABEL, labelOf } from "../../lib/labels";
import { pushToast, useAppState } from "../../lib/store";
import { PLUGIN_KIND_LABEL, LoadingLine, Section, describePermission, reportError, requestToken, useLoad } from "../helpers";

function riskClass(risk: PluginInfo["riskLevel"]): string {
  switch (risk) {
    case "low":
      return "badge badge-ok";
    case "medium":
      return "badge badge-warn";
    case "high":
      return "badge badge-danger";
  }
}

function statusClass(status: PluginInfo["status"]): string {
  switch (status) {
    case "running":
    case "enabled":
      return "badge badge-ok";
    case "degraded":
      return "badge badge-warn";
    case "blocked":
    case "crashed":
    case "invalid":
      return "badge badge-danger";
    case "disabled":
      return "badge badge-muted";
  }
}

const RISK_ORDER: Record<PluginInfo["riskLevel"], number> = { high: 0, medium: 1, low: 2 };

/**
 * 插件面板：列表 → 启用/停用 / 逐项授权 / 改配置 / 重启。
 * 高危插件的启用与授权必须二次确认 + confirm.token；默认关闭的会显式标注。
 */
export function PluginsTab() {
  const state = useAppState();
  const loaded = useLoad(() => invoke("plugins.list", {}), []);
  const confirm = useConfirm();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [grantTarget, setGrantTarget] = useState<PluginInfo | null>(null);
  const [grantSelected, setGrantSelected] = useState<string[]>([]);
  const [configTarget, setConfigTarget] = useState<PluginInfo | null>(null);
  const [configText, setConfigText] = useState("");

  const isOwner = state.owner?.isOwner ?? false;
  const plugins = (loaded.data ?? []).slice().sort((left, right) => {
    const risk = RISK_ORDER[left.riskLevel] - RISK_ORDER[right.riskLevel];
    return risk !== 0 ? risk : left.name.localeCompare(right.name);
  });

  const run = async (id: string, action: () => Promise<void>): Promise<void> => {
    setBusyId(id);
    try {
      await action();
      loaded.reload();
    } catch (error) {
      reportError(error);
    } finally {
      setBusyId(null);
    }
  };

  const toggleEnabled = (plugin: PluginInfo): void => {
    void run(plugin.id, async () => {
      if (!plugin.enabled) {
        let token: string | undefined;
        if (plugin.riskLevel === "high") {
          const agreed = await confirm.ask({
            title: `启用高风险插件「${plugin.name}」？`,
            body: (
              <div>
                <p>它的声明能力：</p>
                <ul className="bullet-list">
                  {plugin.permissions.map((permission) => (
                    <li key={permission}>{describePermission(permission)}</li>
                  ))}
                </ul>
                <p className="danger-text">启用后它会作为独立子进程运行，能碰到的就是上面这些。</p>
              </div>
            ),
            confirmLabel: "启用",
            danger: true,
          });
          if (!agreed) return;
          token = await requestToken("plugins.enable", plugin.id);
        }
        await invoke("plugins.enable", token === undefined ? { id: plugin.id } : { id: plugin.id, confirmToken: token });
        pushToast("success", "插件已启用", plugin.name);
        return;
      }
      await invoke("plugins.disable", { id: plugin.id });
      pushToast("success", "插件已停用", plugin.name);
    });
  };

  const openGrant = (plugin: PluginInfo): void => {
    const missing = plugin.permissions.filter((permission) => !plugin.granted.includes(permission));
    setGrantTarget(plugin);
    setGrantSelected(missing);
  };

  const submitGrant = async (): Promise<void> => {
    const plugin = grantTarget;
    if (!plugin) return;
    if (grantSelected.length === 0) {
      pushToast("warn", "没有选中任何权限", "至少勾一项，或者取消。");
      return;
    }
    setBusyId(plugin.id);
    try {
      let token: string | undefined;
      if (plugin.riskLevel === "high") {
        const agreed = await confirm.ask({
          title: "授权高风险能力？",
          body: (
            <div>
              <p>即将授予「{plugin.name}」：</p>
              <ul className="bullet-list">
                {grantSelected.map((permission) => (
                  <li key={permission}>{describePermission(permission)}</li>
                ))}
              </ul>
              <p className="danger-text">授权写在本机，不写在插件里；随时可以逐项撤销。</p>
            </div>
          ),
          confirmLabel: "授权",
          danger: true,
        });
        if (!agreed) return;
        token = await requestToken("plugins.grant", plugin.id);
      }
      const params =
        token === undefined
          ? { id: plugin.id, permissions: grantSelected }
          : { id: plugin.id, permissions: grantSelected, confirmToken: token };
      await invoke("plugins.grant", params);
      pushToast("success", "已授权", plugin.name);
      setGrantTarget(null);
      loaded.reload();
    } catch (error) {
      reportError(error);
    } finally {
      setBusyId(null);
    }
  };

  const openConfig = (plugin: PluginInfo): void => {
    setConfigTarget(plugin);
    setConfigText(JSON.stringify(plugin.config, null, 2));
  };

  const submitConfig = async (): Promise<void> => {
    const plugin = configTarget;
    if (!plugin) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(configText) as unknown;
    } catch {
      pushToast("error", "配置不是合法 JSON", "改完再保存；不会写坏插件配置。");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      pushToast("error", "配置必须是 JSON 对象", "用 { } 包起来的键值对。");
      return;
    }
    setBusyId(plugin.id);
    try {
      await invoke("plugins.config.put", { id: plugin.id, config: parsed as Record<string, unknown> });
      pushToast("success", "配置已保存", plugin.name);
      setConfigTarget(null);
      loaded.reload();
    } catch (error) {
      reportError(error);
    } finally {
      setBusyId(null);
    }
  };

  const restart = (plugin: PluginInfo): void => {
    void run(plugin.id, async () => {
      await invoke("plugins.restart", { id: plugin.id });
      pushToast("success", "已重启", plugin.name);
    });
  };

  return (
    <div className="panel-stack">
      {confirm.node}

      <Section
        title="插件"
        hint="插件是三层里的最外层：能读写什么，由本机逐项授权，看不到的就碰不到。"
        action={<button className="btn btn-ghost" onClick={() => loaded.reload()}>刷新</button>}
      >
        <LoadingLine loading={loaded.loading} error={loaded.error} />

        {!isOwner ? <div className="banner banner-info">只有 owner 能改插件；这里是只读视图。</div> : null}

        <table className="data-table">
          <thead>
            <tr>
              <th>插件</th>
              <th>风险</th>
              <th>状态</th>
              <th>能力</th>
              <th>权限</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {plugins.map((plugin) => {
              const busy = busyId === plugin.id;
              const riskColor = riskClass(plugin.riskLevel);
              const defaultOff = !plugin.enabled && plugin.riskLevel !== "low";
              return (
                <tr key={plugin.id}>
                  <td>
                    <div className="table-strong">{plugin.name}</div>
                    <div className="table-sub mono">
                      {plugin.id} · v{plugin.version} · {PLUGIN_KIND_LABEL[plugin.kind] ?? plugin.kind}
                    </div>
                    <div className="table-sub">{plugin.description}</div>
                    {plugin.issues.length > 0 ? (
                      <div className="table-sub danger-text">{plugin.issues.join("；")}</div>
                    ) : null}
                  </td>
                  <td>
                    <span className={riskColor}>{RISK_LABEL[plugin.riskLevel] ?? plugin.riskLevel}</span>
                  </td>
                  <td>
                    <span className={statusClass(plugin.status)}>
                      {labelOf(PLUGIN_STATUS_LABEL, plugin.status)}
                    </span>
                    {defaultOff ? <div className="table-sub muted">默认关闭</div> : null}
                    {plugin.health && !plugin.health.ok ? (
                      <div className="table-sub danger-text">{plugin.health.message}</div>
                    ) : null}
                  </td>
                  <td>
                    <div className="chip-wrap">
                      {plugin.capabilities.map((capability) => (
                        <span key={capability} className="chip" title={describePermission(capability)}>
                          {capability}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <div className="chip-wrap">
                      {plugin.permissions.map((permission) => {
                        const granted = plugin.granted.includes(permission);
                        return (
                          <span
                            key={permission}
                            className={`chip ${granted ? "chip-ok" : "chip-muted"}`}
                            title={describePermission(permission)}
                          >
                            {granted ? "✓ " : "✗ "}
                            {permission}
                          </span>
                        );
                      })}
                    </div>
                  </td>
                  <td>
                    <div className="row-actions column">
                      <button className="btn btn-sm" disabled={busy || !isOwner} onClick={() => toggleEnabled(plugin)}>
                        {plugin.enabled ? "停用" : "启用"}
                      </button>
                      <button
                        className="btn btn-sm"
                        disabled={busy || !isOwner}
                        onClick={() => openGrant(plugin)}
                      >
                        授权
                      </button>
                      <button className="btn btn-sm" disabled={busy || !isOwner} onClick={() => openConfig(plugin)}>
                        配置
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        disabled={busy || !isOwner || !plugin.enabled}
                        onClick={() => restart(plugin)}
                      >
                        重启
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {plugins.length === 0 && !loaded.loading ? (
          <div className="empty-note">没有发现插件：plugins/ 目录是空的，或者内核还没扫到。</div>
        ) : null}
      </Section>

      <Section title="说明" hint="授权与停用都会进审计日志。">
        <ul className="bullet-list">
          <li>插件默认关闭；高危插件（medium / high）启用前必须二次确认。</li>
          <li>权限是逐项的：只读消息 ≠ 能代发消息 ≠ 能占用写租约。</li>
          <li>插件崩溃会被隔离并标成 crashed，不会拖垮内核。</li>
        </ul>
      </Section>

      {grantTarget ? (
        <Modal
          title={`授权「${grantTarget.name}」`}
          onClose={() => setGrantTarget(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setGrantTarget(null)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => void submitGrant()} disabled={busyId === grantTarget.id}>
                确认授权
              </button>
            </>
          }
        >
          <p className="prose muted">只勾你真愿意让它碰的。没勾的权限它运行时会被拦截。</p>
          <ul className="bullet-list">
            {grantTarget.permissions.map((permission) => (
              <li key={permission}>
                <label className="consent-item">
                  <input
                    type="checkbox"
                    className="consent-checkbox"
                    checked={grantSelected.includes(permission)}
                    onChange={(event) =>
                      setGrantSelected((previous) =>
                        event.target.checked
                          ? [...previous, permission]
                          : previous.filter((item) => item !== permission),
                      )
                    }
                  />
                  <span className="consent-item-body">
                    <span className="consent-item-title mono">{permission}</span>
                    <span className="consent-item-text">{describePermission(permission)}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </Modal>
      ) : null}

      {configTarget ? (
        <Modal
          title={`配置「${configTarget.name}」`}
          onClose={() => setConfigTarget(null)}
          wide
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setConfigTarget(null)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void submitConfig()}
                disabled={busyId === configTarget.id}
              >
                保存配置
              </button>
            </>
          }
        >
          <p className="prose muted">JSON 对象，原样写进插件配置。写错不会影响别的插件。</p>
          <textarea
            className="textarea mono"
            rows={16}
            value={configText}
            onChange={(event) => setConfigText(event.target.value)}
          />
        </Modal>
      ) : null}
    </div>
  );
}

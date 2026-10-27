import type { PluginInfo } from "@anteros/shared";
import { Fragment, useEffect, useState } from "react";
import { Modal, useConfirm } from "../../components/Modal";
import { humanizeError } from "../../lib/errors";
import { invoke, normalizeError } from "../../lib/kernel";
import { PLUGIN_STATUS_LABEL, RISK_LABEL, labelOf } from "../../lib/labels";
import { applyPluginRuntime, pushToast, useAppState } from "../../lib/store";
import { PluginRuntimePanel } from "../PluginRuntime";
import { PLUGIN_KIND_LABEL, LoadingLine, Section, describePermission, reportError, requestToken, useLoad } from "../helpers";

/** 与内核 `host.ts` 的 HIGH_RISK_PERMISSION 同一组前缀：授权弹窗里这些项要标红。 */
const HIGH_RISK_PATTERN = /^(proc\.|secrets\.read:|fs\.write:|ui\.foreground$)/;

function isHighRisk(item: string): boolean {
  return HIGH_RISK_PATTERN.test(item);
}

/** 授权清单 = 能力 ∪ 权限（`channel.lease` 是能力，只授 permissions 的话通道永远启用不了）。 */
function grantableOf(plugin: PluginInfo): string[] {
  return plugin.grantable.length > 0 ? plugin.grantable : plugin.permissions;
}

function missingGrantsOf(plugin: PluginInfo): string[] {
  return grantableOf(plugin).filter((item) => !plugin.granted.includes(item));
}

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
 * 与内核 `HIGH_RISK_PERMISSION` 保持一致：勾到这些项就要一次性确认 token。
 * 别用 riskLevel 代替它——中风险插件声明了 secrets.read 一样要确认。
 */
const HIGH_RISK_ITEM = /^(proc\.|secrets\.read:|fs\.write:|ui\.foreground$)/;

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
  const [secretTarget, setSecretTarget] = useState<PluginInfo | null>(null);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});

  const isOwner = state.owner?.isOwner ?? false;
  const plugins = (loaded.data ?? []).slice().sort((left, right) => {
    const risk = RISK_ORDER[left.riskLevel] - RISK_ORDER[right.riskLevel];
    return risk !== 0 ? risk : left.name.localeCompare(right.name);
  });

  /**
   * 运行环境状态不随 plugins.list 返回（内核按插件单独查）：进面板时给每个
   * runtimeEnv 插件补一次 status，之后由 `event.runtime` 持续推进。
   */
  const [runtimeErrors, setRuntimeErrors] = useState<Record<string, string>>({});
  const runtimeIds = plugins
    .filter((plugin) => plugin.runtimeEnv)
    .map((plugin) => plugin.id)
    .join("|");

  const loadRuntimeStatus = (id: string): void => {
    void invoke("plugins.runtime.status", { id })
      .then((status) => {
        applyPluginRuntime(status);
        setRuntimeErrors((previous) => {
          if (previous[id] === undefined) return previous;
          const next = { ...previous };
          delete next[id];
          return next;
        });
      })
      .catch((error: unknown) => {
        const human = humanizeError(error);
        setRuntimeErrors((previous) => ({
          ...previous,
          [id]: human.hint ? `${human.title}（${human.hint}）` : human.title,
        }));
      });
  };

  useEffect(() => {
    const ids = runtimeIds.length === 0 ? [] : runtimeIds.split("|");
    for (const id of ids) loadRuntimeStatus(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeIds]);

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
    if (!plugin.enabled && plugin.missingSecrets.length > 0) {
      // 缺密钥时直接启用只会被内核拦下来，先把人引到录入入口
      pushToast("warn", "还缺密钥", `${plugin.name} 需要先录入：${plugin.missingSecrets.join("、")}`);
      openSecret(plugin);
      return;
    }
    if (!plugin.enabled) {
      const missing = missingGrantsOf(plugin);
      if (missing.length > 0) {
        // 内核启用闸：通道写能力缺 channel.lease 会被永久拦死；先把授权入口递到眼前
        pushToast("warn", `还差 ${missing.length} 项授权`, `${plugin.name}：${missing.join("、")}`);
        openGrant(plugin);
        return;
      }
    }
    void run(plugin.id, async () => {
      if (!plugin.enabled) {
        let token: string | undefined;
        if (plugin.enableNeedsConfirm) {
          const agreed = await confirm.ask({
            title: `启用高风险插件「${plugin.name}」？`,
            body: (
              <div>
                <p>它已授权的声明能力：</p>
                <ul className="bullet-list">
                  {grantableOf(plugin).map((item) => (
                    <li key={item}>{describePermission(item)}</li>
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
    const options = plugin.grantable.length > 0 ? plugin.grantable : plugin.permissions;
    const missing = options.filter((item) => !plugin.granted.includes(item));
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
      // 授权闸看的是「这一批勾选项里有没有高危项」，不是插件整体风险等级：
      // 中风险的 core.llm-router 勾了 secrets.read:llm.api_key 就必须带 token。
      if (grantSelected.some((item) => HIGH_RISK_ITEM.test(item))) {
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
      setGrantTarget(null);
      pushToast("success", "已授权", plugin.name);
      loaded.reload();
      if (!plugin.enabled) {
        // 点「授权」的真实目的通常是让它跑起来：授权成功后自动试一次启用。
        // 高风险插件的启用还要一次独立确认（内核 ECONFIRM）——这里不替用户按确认，
        // 失败就把内核原话抛出来，点「启用」走原有二次确认流程即可。
        try {
          await invoke("plugins.enable", { id: plugin.id });
          pushToast("success", "插件已启用", plugin.name);
        } catch (error) {
          const normalized = normalizeError(error);
          pushToast("error", normalized.message, normalized.hint);
        }
        loaded.reload();
      }
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

  const openSecret = (plugin: PluginInfo): void => {
    setSecretValues({});
    setSecretTarget(plugin);
  };

  const submitSecret = async (): Promise<void> => {
    const plugin = secretTarget;
    if (!plugin) return;
    const entries = Object.entries(secretValues).filter(([, value]) => value.trim().length > 0);
    if (entries.length === 0) {
      pushToast("warn", "还没填任何密钥", "至少填一项再保存。");
      return;
    }
    setBusyId(plugin.id);
    try {
      for (const [name, value] of entries) {
        await invoke("plugins.secret.put", { id: plugin.id, name, value: value.trim() });
      }
      pushToast("success", "密钥已存入本机", `${plugin.name} · ${entries.map(([name]) => name).join("、")}`);
      setSecretTarget(null);
      setSecretValues({});
      loaded.reload();
    } catch (error) {
      reportError(error);
    } finally {
      setBusyId(null);
    }
  };

  const removeSecret = async (plugin: PluginInfo, name: string): Promise<void> => {
    const agreed = await confirm.ask({
      title: `清除密钥「${name}」？`,
      body: (
        <p>
          清除后「{plugin.name}」会重新变成缺密钥，启用会被内核拦下；要用的时候得重新录入。
        </p>
      ),
      confirmLabel: "清除",
      danger: true,
    });
    if (!agreed) return;
    void run(plugin.id, async () => {
      await invoke("plugins.secret.delete", { id: plugin.id, name });
      pushToast("success", "密钥已删除", `${plugin.name} · ${name}`);
    });
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
              const missingGrants = missingGrantsOf(plugin);
              // 状态还没取到也按「缺运行环境」处理：runtimeEnv 插件没装环境本来就不能启用
              const runtimeStatus = state.pluginRuntime[plugin.id] ?? null;
              const runtimeMissing =
                plugin.runtimeEnv && (runtimeStatus === null || runtimeStatus.installed === null);
              return (
                <Fragment key={plugin.id}>
                  <tr>
                    <td>
                      <div className="table-strong">{plugin.name}</div>
                      <div className="table-sub mono">
                        {plugin.id} · v{plugin.version} · {PLUGIN_KIND_LABEL[plugin.kind] ?? plugin.kind}
                      </div>
                      <div className="table-sub">{plugin.description}</div>
                      {plugin.issues.length > 0 ? (
                        <div className="table-sub danger-text">{plugin.issues.join("；")}</div>
                      ) : null}
                      {plugin.missingSecrets.length > 0 ? (
                        <div className="table-sub danger-text">
                          缺密钥：{plugin.missingSecrets.join("、")}（录入后才能启用）
                        </div>
                      ) : plugin.secrets.length > 0 ? (
                        <div className="table-sub muted">密钥已录入：{plugin.secrets.join("、")}</div>
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
                        <button
                          className="btn btn-sm"
                          disabled={
                            busy ||
                            !isOwner ||
                            (!plugin.enabled && (missingGrants.length > 0 || runtimeMissing))
                          }
                          title={
                            !plugin.enabled && runtimeMissing
                              ? "这个插件要先下载运行环境才能启用"
                              : !plugin.enabled && missingGrants.length > 0
                                ? `还差 ${missingGrants.length} 项授权：${missingGrants.join("、")}`
                                : undefined
                          }
                          onClick={() => toggleEnabled(plugin)}
                        >
                          {plugin.enabled ? "停用" : runtimeMissing ? "先下载运行环境" : "启用"}
                        </button>
                        {!plugin.enabled && missingGrants.length > 0 ? (
                          <div className="table-sub muted">先授权 {missingGrants.length} 项能力</div>
                        ) : null}
                        <button
                          className={`btn btn-sm${!plugin.enabled && missingGrants.length > 0 ? " btn-primary" : ""}`}
                          disabled={busy || !isOwner}
                          onClick={() => openGrant(plugin)}
                        >
                          授权
                        </button>
                        {plugin.secrets.length > 0 ? (
                          <button
                            className={`btn btn-sm${plugin.missingSecrets.length > 0 ? " btn-primary" : ""}`}
                            disabled={busy || !isOwner}
                            onClick={() => openSecret(plugin)}
                          >
                            {plugin.missingSecrets.length > 0 ? "录入密钥" : "密钥"}
                          </button>
                        ) : null}
                        <button
                          className="btn btn-sm"
                          disabled={busy || !isOwner}
                          onClick={() => openConfig(plugin)}
                        >
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
                  {plugin.runtimeEnv ? (
                    <tr className="plugin-runtime-row">
                      <td colSpan={6}>
                        <PluginRuntimePanel
                          plugin={plugin}
                          status={runtimeStatus}
                          loadError={runtimeErrors[plugin.id] ?? null}
                          canEdit={isOwner}
                          onReloadStatus={() => loadRuntimeStatus(plugin.id)}
                          onPluginsChanged={() => loaded.reload()}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
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
          <p className="danger-text">
            标红的项会让它碰进程内存、密钥、磁盘写入或前台窗口——这些不是聊天必需项，按需勾选。
          </p>
          <ul className="bullet-list">
            {grantableOf(grantTarget).map((item) => {
              const risky = isHighRisk(item);
              return (
                <li key={item}>
                  <label className="consent-item">
                    <input
                      type="checkbox"
                      className="consent-checkbox"
                      checked={grantSelected.includes(item)}
                      onChange={(event) =>
                        setGrantSelected((previous) =>
                          event.target.checked
                            ? [...previous, item]
                            : previous.filter((permission) => permission !== item),
                        )
                      }
                    />
                    <span className="consent-item-body">
                      <span className={`consent-item-title mono${risky ? " danger-text" : ""}`}>{item}</span>
                      <span className={`consent-item-text${risky ? " danger-text" : ""}`}>
                        {risky ? `⚠ 高危：${describePermission(item)}` : describePermission(item)}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
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

      {secretTarget ? (
        <Modal
          title={`密钥「${secretTarget.name}」`}
          onClose={() => setSecretTarget(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setSecretTarget(null)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void submitSecret()}
                disabled={busyId === secretTarget.id}
              >
                存到本机
              </button>
            </>
          }
        >
          <p className="prose muted">
            密钥只写在本机（DPAPI 加密落盘），不写进插件代码、不进日志、不出这台电脑。
          </p>
          <ul className="bullet-list">
            {secretTarget.secrets.map((name) => {
              const filled = !secretTarget.missingSecrets.includes(name) && secretValues[name] === undefined;
              return (
                <li key={name}>
                  <div className="field">
                    <div className="field-label mono">
                      {name}
                      {filled ? <span className="muted">（已录入，留空则不改）</span> : null}
                    </div>
                    <input
                      className="input mono"
                      type="password"
                      autoComplete="off"
                      placeholder={filled ? "••••••（留空不改）" : "粘贴密钥"}
                      value={secretValues[name] ?? ""}
                      onChange={(event) =>
                        setSecretValues((previous) => ({ ...previous, [name]: event.target.value }))
                      }
                    />
                    {filled ? (
                      <button className="btn btn-sm btn-ghost" onClick={() => void removeSecret(secretTarget, name)}>
                        删掉这条密钥
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * 插件运行环境卡片：下载 / 检查更新 / 增量升级 / 卸载 / 改更新源。
 *
 * 状态只有一个真源：store 里的 `pluginRuntime`（`event.runtime` 推送进度与结果，
 * `plugins.runtime.*` 的返回值也写回同一处）。这里只做展示与发请求，不自己造进度。
 */

import type { PluginInfo, PluginRuntimeStatus } from "@anteros/shared";
import { useState } from "react";
import { useConfirm } from "../components/Modal";
import { humanizeError } from "../lib/errors";
import { formatBytes, formatDateTime } from "../lib/format";
import { invoke } from "../lib/kernel";
import { applyPluginRuntime, pushToast, setRuntimeFeedUrl } from "../lib/store";
import { describePermission, requestToken } from "./helpers";

type RuntimeAction = "check" | "install" | "uninstall" | "prepare";

/** 与内核侧校验一致：更新源只接受 https / file，不合法连请求都不发。 */
const FEED_URL_PATTERN = /^(https:\/\/|file:\/\/)/i;

function messageOf(error: unknown): string {
  const human = humanizeError(error);
  return human.hint ? `${human.title}（${human.hint}）` : human.title;
}

/** 进度百分比：内核给 0–100；缺值或非法值一律按不确定态处理。 */
function percentOf(status: PluginRuntimeStatus | null): number | null {
  const progress = status?.progress ?? null;
  if (progress === null || !Number.isFinite(progress.percent)) return null;
  return Math.max(0, Math.min(100, Math.round(progress.percent)));
}

function busyText(status: PluginRuntimeStatus | null, pending: RuntimeAction | null): string {
  if (status !== null) {
    if (status.busy === "checking") return "正在检查更新…";
    if (status.busy === "downloading") {
      const percent = percentOf(status);
      return percent === null ? "正在下载…" : `正在下载 ${percent}%`;
    }
    if (status.busy === "applying") return "正在解压并切换…";
  }
  // 请求刚发出去、内核事件还没到：先按动作给一句，避免按钮点了像没反应
  if (pending === "check") return "正在检查更新…";
  if (pending === "install") return "正在准备下载…";
  if (pending === "uninstall") return "正在卸载…";
  if (pending === "prepare") return "正在准备（下载 → 授权 → 启用）…";
  return "";
}

/** 细进度条：知道百分比就按百分比，不知道就画不确定态。 */
function RuntimeProgress({ status, pending }: { status: PluginRuntimeStatus | null; pending: RuntimeAction | null }) {
  const percent = percentOf(status);
  return (
    <div className="plugin-runtime-progress">
      <div className="plugin-runtime-meter">
        <div
          className={`plugin-runtime-meter-fill${percent === null ? " indeterminate" : ""}`}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      <div className="plugin-runtime-progress-text">{busyText(status, pending)}</div>
    </div>
  );
}

export interface PluginRuntimePanelProps {
  plugin: PluginInfo;
  status: PluginRuntimeStatus | null;
  /** 读取 status 本身失败时的内核原话（方法不存在 / 内核未就绪等） */
  loadError: string | null;
  canEdit: boolean;
  onReloadStatus: () => void;
  /** 授权/启用之后要让插件列表重拉一次（enabled/status 变了） */
  onPluginsChanged: () => void;
}

/**
 * 一块「运行环境」：未安装给下载入口，已安装给版本信息 + 检查更新 / 更新 / 卸载。
 * 所有操作失败都把内核返回的中文错误显示在卡片里，不带 alert。
 */
export function PluginRuntimePanel({
  plugin,
  status,
  loadError,
  canEdit,
  onReloadStatus,
  onPluginsChanged,
}: PluginRuntimePanelProps) {
  const confirm = useConfirm();
  const [pending, setPending] = useState<RuntimeAction | null>(null);
  const [actionError, setActionError] = useState<{ action: RuntimeAction; message: string } | null>(null);
  const [feedOpen, setFeedOpen] = useState(false);
  const [feedDraft, setFeedDraft] = useState("");
  const [feedSaving, setFeedSaving] = useState(false);
  const [feedHint, setFeedHint] = useState<string | null>(null);

  const installed = status?.installed ?? null;
  const available = status?.available ?? null;
  const updateAvailable = status?.updateAvailable === true && available !== null;
  const active = pending !== null || (status !== null && status.busy !== "idle");
  const locked = !canEdit || active;

  const run = async (action: RuntimeAction): Promise<void> => {
    if (active) return;
    setPending(action);
    setActionError(null);
    try {
      const next =
        action === "check"
          ? await invoke("plugins.runtime.check", { id: plugin.id })
          : action === "install"
            ? await invoke("plugins.runtime.install", { id: plugin.id })
            : await invoke("plugins.runtime.uninstall", { id: plugin.id });
      applyPluginRuntime(next);
      if (action === "uninstall") {
        pushToast("success", "运行环境已卸载", plugin.name);
      } else if (action === "install") {
        pushToast(
          "success",
          next.installed === null ? "运行环境已就绪" : `已安装 v${next.installed.version}`,
          plugin.name,
        );
      } else if (next.updateAvailable && next.available !== null) {
        pushToast("info", "有新版本可用", `${plugin.name} · v${next.available.version}`);
      } else {
        pushToast("success", "已是最新", plugin.name);
      }
    } catch (error) {
      setActionError({ action, message: messageOf(error) });
    } finally {
      setPending(null);
    }
  };

  const uninstall = async (): Promise<void> => {
    if (installed === null) return;
    const agreed = await confirm.ask({
      title: `卸载「${plugin.name}」的运行环境？`,
      body: (
        <div>
          <p>会删掉本机已安装的 v{installed.version}，插件会因此无法启用；要用的时候可以再下载。</p>
          <p className="muted">只删运行环境目录，不碰插件本身和你的聊天数据。</p>
        </div>
      ),
      confirmLabel: "卸载",
      danger: true,
    });
    if (!agreed) return;
    await run("uninstall");
  };

  /** 这个插件还缺哪些授权（manifest 声明的 grantable 里没授的）。 */
  const missingGrants = (): string[] => {
    const options = plugin.grantable.length > 0 ? plugin.grantable : plugin.permissions;
    return options.filter((item) => !plugin.granted.includes(item));
  };

  /**
   * 「下载并启用」：一次点击把三件事串起来 —— 装运行环境 → 补齐授权 → 启用插件。
   *
   * 为什么串在一起：单独装运行环境之后，插件仍然是 disabled / blocked，
   * 用户看到的是「下载完了但插件没就绪」。这里的顺序是硬的：先有运行环境，
   * 启用闸才不拦；先授权，通道写能力才放行；最后才拉起进程。
   *
   * 授权与启用都要 confirm.token（高危），所以整条链只用这一个确认框兜底，
   * 但确认框里会把「将授予哪些能力」逐条列出来 —— 不能变成静默授权。
   */
  const prepareAndEnable = async (): Promise<void> => {
    if (active) return;
    const missing = missingGrants();
    const needsRuntime = installed === null;
    const agreed = await confirm.ask({
      title: needsRuntime ? `下载运行环境并启用「${plugin.name}」？` : `授权并启用「${plugin.name}」？`,
      body: (
        <div>
          {needsRuntime ? (
            <p>
              会先下载这个插件需要的外部运行环境（Anteros 不内置），校验通过后落到本机数据目录，然后启用插件。
            </p>
          ) : null}
          {missing.length > 0 ? (
            <>
              <p>将授予它这些能力（随时可以逐项撤销）：</p>
              <ul className="bullet-list">
                {missing.map((item) => (
                  <li key={item}>{describePermission(item)}</li>
                ))}
              </ul>
            </>
          ) : null}
          <p>启用后插件会作为独立子进程运行。它此刻只是「骨架就绪」，还没有接入微信本体，收发消息仍会被拒绝。</p>
          <p className="muted">不会注入、不会改第三方程序、不会读取微信进程内存。</p>
        </div>
      ),
      confirmLabel: needsRuntime ? "下载并启用" : "授权并启用",
      danger: true,
    });
    if (!agreed) return;

    setPending("prepare");
    setActionError(null);
    try {
      if (needsRuntime) {
        const next = await invoke("plugins.runtime.install", { id: plugin.id });
        applyPluginRuntime(next);
      }
      if (missing.length > 0) {
        const grantToken = await requestToken("plugins.grant", plugin.id);
        await invoke(
          "plugins.grant",
          grantToken === undefined
            ? { id: plugin.id, permissions: missing }
            : { id: plugin.id, permissions: missing, confirmToken: grantToken },
        );
      }
      const enableToken = await requestToken("plugins.enable", plugin.id);
      await invoke(
        "plugins.enable",
        enableToken === undefined ? { id: plugin.id } : { id: plugin.id, confirmToken: enableToken },
      );
      pushToast(
        "success",
        needsRuntime ? "运行环境已就绪，插件已启用" : "插件已启用",
        `${plugin.name} · 适配器骨架在跑，但还没有接入微信本体`,
      );
      onPluginsChanged();
      onReloadStatus();
    } catch (error) {
      setActionError({ action: "prepare", message: messageOf(error) });
    } finally {
      setPending(null);
    }
  };

  const toggleFeed = (): void => {
    if (feedOpen) {
      setFeedOpen(false);
      return;
    }
    setFeedDraft(status?.feedUrl ?? "");
    setFeedHint(null);
    setFeedOpen(true);
  };

  const saveFeed = async (): Promise<void> => {
    const url = feedDraft.trim();
    if (!FEED_URL_PATTERN.test(url)) {
      setFeedHint("更新源要以 https:// 或 file:// 开头，这条没有发出去。");
      return;
    }
    setFeedHint(null);
    setFeedSaving(true);
    try {
      const result = await invoke("plugins.runtime.feed", { url });
      setRuntimeFeedUrl(result.url);
      setFeedDraft(result.url);
      pushToast("success", "更新源已保存", result.url);
    } catch (error) {
      setFeedHint(messageOf(error));
    } finally {
      setFeedSaving(false);
    }
  };

  // 卡片里的错误：优先显示动作失败的原话，其次显示内核 status 里带的 error
  const shownError = actionError?.message ?? status?.error ?? null;
  const retryAction: RuntimeAction =
    actionError?.action ?? (installed === null ? "install" : updateAvailable ? "install" : "check");

  return (
    <div className="plugin-runtime">
      {confirm.node}

      <div className="plugin-runtime-head">
        <span className="plugin-runtime-title">运行环境</span>
        {status !== null ? (
          <span className="plugin-runtime-hint">
            {status.lastCheckTs === null ? "还没检查过更新" : `上次检查：${formatDateTime(status.lastCheckTs)}`}
          </span>
        ) : null}
      </div>

      {loadError !== null ? (
        <div className="plugin-runtime-error">
          <span>{loadError}</span>
          <button className="btn btn-sm btn-ghost" onClick={onReloadStatus}>
            重试
          </button>
        </div>
      ) : status === null ? (
        <div className="plugin-runtime-hint">正在读取运行环境状态…</div>
      ) : (
        <>
          {installed === null ? (
            <>
              <div className="plugin-runtime-hint">
                这个插件需要一份外部运行环境，Anteros 不内置。点下面的按钮会一次做完：下载 → 校验 → 授权 → 启用。
              </div>
              <div className="plugin-runtime-actions">
                <button
                  className="btn btn-sm btn-primary"
                  disabled={locked}
                  onClick={() => void prepareAndEnable()}
                >
                  下载运行环境并启用
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={locked}
                  onClick={() => void run("install")}
                  title="只下载，不授权也不启用"
                >
                  只下载
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="plugin-runtime-meta">
                {[
                  `已安装 v${installed.version}`,
                  formatBytes(installed.size),
                  `${installed.fileCount} 个文件`,
                  installed.mode === "delta" ? "增量安装" : "整包安装",
                  formatDateTime(installed.installedTs),
                ].join(" · ")}
              </div>
              <div className="plugin-runtime-path mono" title={installed.path}>
                {installed.path}
              </div>
              {!plugin.enabled ? (
                <div className="plugin-runtime-ready">
                  <span>
                    运行环境已就绪，但插件还没启用 —— 现在就启用它会拉起适配器骨架（仍然不会连接微信本体）。
                  </span>
                  <button className="btn btn-sm btn-primary" disabled={locked} onClick={() => void prepareAndEnable()}>
                    授权并启用
                  </button>
                </div>
              ) : null}
              {updateAvailable && available !== null ? (
                <div className="plugin-runtime-update">
                  可更新到 v{available.version}（约 {formatBytes(available.size)}）
                </div>
              ) : null}
              <div className="plugin-runtime-actions">
                <button className="btn btn-sm" disabled={locked} onClick={() => void run("check")}>
                  检查更新
                </button>
                {updateAvailable ? (
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={locked}
                    onClick={() => void run("install")}
                  >
                    更新
                  </button>
                ) : null}
                <button
                  className="btn btn-sm btn-danger-ghost"
                  disabled={locked}
                  onClick={() => void uninstall()}
                >
                  卸载
                </button>
              </div>
            </>
          )}

          {active ? <RuntimeProgress status={status} pending={pending} /> : null}

          {shownError !== null ? (
            <div className="plugin-runtime-error">
              <span>{shownError}</span>
              <button
                className="btn btn-sm btn-ghost"
                disabled={locked}
                onClick={() => {
                  setActionError(null);
                  if (retryAction === "prepare") void prepareAndEnable();
                  else void run(retryAction);
                }}
              >
                重试
              </button>
            </div>
          ) : null}

          <div className="plugin-runtime-feed">
            <div className="plugin-runtime-feed-head">
              <button className="plugin-runtime-feed-toggle" onClick={toggleFeed}>
                {feedOpen ? "收起更新源" : "更新源"}
              </button>
              {!feedOpen ? (
                <span className="plugin-runtime-hint mono plugin-runtime-feed-current" title={status.feedUrl}>
                  {status.feedUrl.length > 0 ? status.feedUrl : "未设置"}
                </span>
              ) : null}
            </div>
            {feedOpen ? (
              <>
                <div className="plugin-runtime-path mono" title={status.feedUrl}>
                  当前更新源：{status.feedUrl.length > 0 ? status.feedUrl : "未设置"}
                </div>
                <div className="plugin-runtime-feed-row">
                  <input
                    className="input mono"
                    value={feedDraft}
                    placeholder="https://example.com/feed.json 或 file:///"
                    disabled={!canEdit || feedSaving}
                    onChange={(event) => setFeedDraft(event.target.value)}
                  />
                  <button
                    className="btn btn-sm"
                    disabled={!canEdit || feedSaving}
                    onClick={() => void saveFeed()}
                  >
                    {feedSaving ? "保存中…" : "保存更新源"}
                  </button>
                </div>
                {feedHint !== null ? <div className="plugin-runtime-hint danger-text">{feedHint}</div> : null}
              </>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

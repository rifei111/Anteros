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

type RuntimeAction = "check" | "install" | "uninstall";

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
              <div className="plugin-runtime-hint">这个插件需要一份外部运行环境，Anteros 不内置。</div>
              <div className="plugin-runtime-actions">
                <button
                  className="btn btn-sm btn-primary"
                  disabled={locked}
                  onClick={() => void run("install")}
                >
                  下载运行环境
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
                  void run(retryAction);
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

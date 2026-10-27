import { useState } from "react";
import { formatBytes, formatDateTime } from "../../lib/format";
import { pushToast, useAppState } from "../../lib/store";

import type { UpdateStatusView } from "../../../../common/protocol";
import { Section } from "../helpers";

/**
 * 更新面板：软件整体的应用内增量更新。
 *
 * 数据全部来自主进程（electron-updater），这里只负责显示与触发：
 * - 检查更新 → 有新版显示版本号与说明
 * - 下载（带进度与速度）→ 下载完出现「重启并安装」
 * - 出错给红字 +「重试」
 *
 * 明确不做：静默安装、偷偷下载。下载与重启都要用户点。
 */

const STATE_TEXT: Record<UpdateStatusView["state"], string> = {
  idle: "还没有检查过",
  checking: "正在检查更新…",
  available: "发现新版本",
  "not-available": "已经是最新版本",
  downloading: "正在下载",
  downloaded: "下载完成，可以安装了",
  error: "出错了",
};

function speedText(bytesPerSecond?: number): string | null {
  if (!bytesPerSecond || bytesPerSecond <= 0) return null;
  return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
}

export function UpdateTab() {
  const state = useAppState();
  const [busy, setBusy] = useState<"check" | "download" | "install" | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const status = state.updateStatus;
  const updates = window.anteros?.updates;

  const call = async (kind: "check" | "download" | "install"): Promise<void> => {
    if (!updates) {
      pushToast("warn", "这个运行环境不支持应用内更新", "只有打包后的桌面客户端能检查更新。");
      return;
    }
    setBusy(kind);
    setLocalError(null);
    try {
      if (kind === "check") {
        const next = await updates.check();
        if (next?.state === "not-available") pushToast("success", "已经是最新版本", `${next.currentVersion} 就是当前版本。`);
        if (next?.state === "available") pushToast("info", `发现新版本 ${next.version ?? ""}`, "点「下载」开始增量更新。");
        if (next?.state === "error") setLocalError(next.message ?? "检查更新失败");
      } else if (kind === "download") {
        const next = await updates.download();
        if (next?.state === "error") setLocalError(next.message ?? "下载失败");
      } else {
        const next = await updates.install();
        if (next?.state === "error") setLocalError(next.message ?? "安装失败");
      }
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const checking = busy === "check" || status?.state === "checking";
  const downloading = busy === "download" || status?.state === "downloading";
  const downloaded = status?.state === "downloaded";
  const percent = Math.max(0, Math.min(100, status?.percent ?? 0));

  return (
    <div className="panel-stack">
      <Section
        title="当前版本"
        hint="更新走 GitHub Releases 的增量包：只下变化的部分，装完还是这台电脑上的记忆与人格。"
        action={
          <button className="btn btn-primary" onClick={() => void call("check")} disabled={checking || downloading || !updates}>
            {checking ? "正在检查…" : "检查更新"}
          </button>
        }
      >
        <dl className="kv-grid">
          <dt>客户端版本</dt>
          <dd className="mono">{state.appVersion || status?.currentVersion || "—"}</dd>
          <dt>状态</dt>
          <dd>{status ? STATE_TEXT[status.state] : "（还没拿到状态）"}</dd>
          <dt>上次检查</dt>
          <dd>{status?.checkedTs ? formatDateTime(status.checkedTs) : "—"}</dd>
          {status?.version ? (
            <>
              <dt>最新版本</dt>
              <dd className="mono">{status.version}</dd>
            </>
          ) : null}
          {status?.total ? (
            <>
              <dt>安装包大小</dt>
              <dd>{formatBytes(status.total)}</dd>
            </>
          ) : null}
        </dl>
        {!updates ? (
          <p className="prose muted">
            当前是开发模式（没有打包），更新能力不可用：这是预期行为，不是坏了。
          </p>
        ) : null}
      </Section>

      {status?.state === "available" || downloading || downloaded ? (
        <Section
          title={downloaded ? "下载完成" : "下载更新"}
          hint={downloaded ? "安装会关闭客户端，装完自动打开新版本。" : "下载完不会自动安装，要不要装由你决定。"}
          action={
            downloaded ? (
              <button className="btn btn-primary" onClick={() => void call("install")} disabled={busy === "install"}>
                {busy === "install" ? "正在重启…" : "重启并安装"}
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => void call("download")} disabled={downloading}>
                {downloading ? "正在下载…" : "下载"}
              </button>
            )
          }
        >
          {downloading ? (
            <div className="update-progress">
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${percent}%` }} />
              </div>
              <div className="update-progress-meta">
                <span>{percent.toFixed(0)}%</span>
                {speedText(status?.bytesPerSecond) ? <span>{speedText(status?.bytesPerSecond)}</span> : null}
                {status?.total ? <span>{formatBytes(status.total)}</span> : null}
              </div>
            </div>
          ) : null}
          {status?.releaseNotes ? <pre className="update-notes">{status.releaseNotes}</pre> : null}
        </Section>
      ) : null}

      {localError || (status?.state === "error" && status.message) ? (
        <Section title="出错了" hint="更新出错不会影响现在能用的版本。">
          <div className="danger-box">
            <p className="prose danger-text">{localError ?? status?.message}</p>
            <button className="btn" onClick={() => void call("check")} disabled={checking}>
              重试
            </button>
          </div>
        </Section>
      ) : null}

      <Section title="说明" hint="这些行为是刻意设计的，不是没做完。">
        <ul className="plain-list">
          <li>不自动下载、不静默安装：发现新版本也要你点「下载」「重启并安装」。</li>
          <li>
            只走正式发布（GitHub Releases 的 latest.yml）。预发布版本不参与检查，避免半夜被塞一个半成品。
          </li>
          <li>
            增量更新靠 NSIS 的 blockmap 复用本地已有文件；如果差分包拼不出来，会自动回退整包下载，但不会跳过 sha512
            校验。
          </li>
          <li>
            内核、插件、记忆都在本机数据目录里，升级客户端不会动它们；插件运行环境的更新是另一套（插件页里那套）。
          </li>
        </ul>
      </Section>
    </div>
  );
}
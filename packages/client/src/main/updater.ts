/**
 * 应用内更新（electron-updater）。
 *
 * 为什么放在主进程：更新要下载安装包、校验 sha512、退出应用换版本，这些只有主进程能做；
 * 渲染层只需要「看到状态 + 点按钮」。
 *
 * 三种运行方式：
 * 1. 打包后的正式版：读 `resources/app-update.yml`（由 electron-builder 的 publish 配置生成），
 *    走 GitHub Releases 的 latest.yml + *.exe.blockmap 做整包/差分下载。
 * 2. 自检/联调：设 `ANTEROS_UPDATE_FEED=<latest.yml 所在目录 URL>`，主进程改用 generic 源，
 *    并打开 `forceDevUpdateConfig`，这样未打包的 electron 也能检查更新（只用于验证链路）。
 * 3. 开发模式且没设 feed：直接回一句人话「开发模式下不检查更新」，不假装成功。
 *
 * 明确不做的：静默自动安装（autoDownload 关闭，必须用户点下载与重启安装）、
 * 预发布版本（allowPrerelease 关闭）。
 */

import { app } from "electron";
import { autoUpdater, type UpdateInfo } from "electron-updater";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateStatus {
  state: UpdateState;
  /** 当前应用的版本（app.getVersion()）。 */
  currentVersion: string;
  /** 发现的新版本号。 */
  version?: string;
  /** 更新说明（来自 latest.yml / Release 描述）。 */
  releaseNotes?: string;
  /** 下载进度 0–100。 */
  percent?: number;
  /** 下载速度（字节/秒）。 */
  bytesPerSecond?: number;
  /** 安装包总大小（字节）。 */
  total?: number;
  /** 出错时给人看的一句话。 */
  message?: string;
  /** 上次检查完成的时间戳（毫秒）。 */
  checkedTs?: number;
  /** 是否处于「正在下载」。 */
  busy?: boolean;
}

export interface UpdaterOptions {
  /** 状态变化回调：主进程负责把它转发到渲染进程。 */
  onStatus: (status: UpdateStatus) => void;
  /** 允许在未打包模式下检查更新（只给自检用，靠 ANTEROS_UPDATE_FEED 触发）。 */
  feedUrl?: string | null;
  /** electron-updater 的内部日志落盘路径（差分下载为什么退回整包，答案都在这里）。 */
  logFile?: string | null;
}

function normalizeReleaseNotes(info: UpdateInfo): string | undefined {
  const notes = info.releaseNotes;
  if (typeof notes === "string") return notes.trim() || undefined;
  if (Array.isArray(notes)) {
    const merged = notes
      .map((item) => (typeof item?.note === "string" ? item.note.trim() : ""))
      .filter((text) => text.length > 0)
      .join("\n\n");
    return merged.length > 0 ? merged : undefined;
  }
  return undefined;
}

/** 把 electron-updater 抛出来的英文错误翻成能看懂的中文（保留原文尾部，便于排查）。 */
function humanError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  if (lower.includes("net::err_internet_disconnected") || lower.includes("enotfound")) {
    return `连不上更新服务器：检查网络或代理后再试。（原始信息：${raw}）`;
  }
  if (lower.includes("404") || lower.includes("cannot find latest")) {
    return `更新源上没有找到 latest.yml：可能还没发布新版本，或发布配置里的仓库不对。（原始信息：${raw}）`;
  }
  if (lower.includes("sha512") || lower.includes("checksum") || lower.includes("digest")) {
    return `下载的安装包校验失败，已丢弃：可能被网络中间人改过或断点续传出错，请重试。（原始信息：${raw}）`;
  }
  if (lower.includes("code signature") || lower.includes("not signed")) {
    return `安装包签名校验没过：这个包不是官方发布的，已停止安装。（原始信息：${raw}）`;
  }
  return raw;
}

export class AppUpdater {
  private readonly options: UpdaterOptions;
  private status: UpdateStatus;
  private checking = false;
  private downloading = false;
  /** 真实检查过一次才允许下载，防止界面上的按钮在没有 info 时被点。 */
  private available = false;

  constructor(options: UpdaterOptions) {
    this.options = options;
    this.status = {
      state: "idle",
      currentVersion: app.getVersion(),
    };
  }

  /** 只做一次：接线事件、设开关、必要时改更新源。可以在 whenReady 之后调用。 */
  init(): void {
    const logFile = this.options.logFile;
    if (logFile) {
      const write = (level: string, message?: unknown): void => {
        try {
          mkdirSync(dirname(logFile), { recursive: true });
          const text = typeof message === "string" ? message : JSON.stringify(message);
          appendFileSync(logFile, `${new Date().toISOString()} [${level}] ${text ?? ""}\n`, "utf8");
        } catch {
          // 日志写不进去不能影响更新本身
        }
      };
      autoUpdater.logger = {
        info: (message?: unknown) => write("info", message),
        warn: (message?: unknown) => write("warn", message),
        error: (message?: unknown) => write("error", message),
        debug: (message?: unknown) => write("debug", message),
      };
    }

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.autoRunAppAfterInstall = true;

    if (this.options.feedUrl) {
      // 联调用：generic 源 + 允许未打包环境检查，避免为了验证链路去改系统里的安装版
      autoUpdater.forceDevUpdateConfig = true;
      autoUpdater.setFeedURL({ provider: "generic", url: this.options.feedUrl });
      // 增量（差量）下载要拿"旧版本安装包的 blockmap"。generic 源里新旧版本放同一个目录，
      // 所以把旧 blockmap 的基地址也指到这个目录，别让它去新版本目录里瞎找。
      autoUpdater.previousBlockmapBaseUrlOverride = this.options.feedUrl;
    } else {
      // 正式发布：每个版本一个 tag（v0.5.0、v0.6.0…），旧 blockmap 在旧版本的 release 里，
      // 不指过去就只能整包下载（能用，但白下 100MB）。
      autoUpdater.previousBlockmapBaseUrlOverride = `https://github.com/rifei111/Anteros/releases/download/v${app.getVersion()}/`;
    }

    autoUpdater.on("checking-for-update", () => {
      this.update({ state: "checking", message: undefined });
    });
    autoUpdater.on("update-available", (info: UpdateInfo) => {
      this.available = true;
      this.update({
        state: "available",
        version: info.version,
        releaseNotes: normalizeReleaseNotes(info),
        checkedTs: Date.now(),
        message: undefined,
        percent: 0,
      });
    });
    autoUpdater.on("update-not-available", (info: UpdateInfo) => {
      this.available = false;
      this.update({
        state: "not-available",
        version: info?.version,
        checkedTs: Date.now(),
        message: undefined,
      });
    });
    autoUpdater.on("download-progress", (progress) => {
      this.update({
        state: "downloading",
        percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
        bytesPerSecond: Number(progress.bytesPerSecond) || 0,
        total: Number(progress.total) || undefined,
      });
    });
    autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
      this.downloading = false;
      this.update({
        state: "downloaded",
        version: info.version,
        percent: 100,
        message: undefined,
      });
    });
    autoUpdater.on("error", (error) => {
      this.checking = false;
      this.downloading = false;
      this.update({ state: "error", message: humanError(error) });
    });
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  /** 检查更新。返回最新状态，方便 ipc 调用方直接回给界面。 */
  async check(): Promise<UpdateStatus> {
    if (this.checking) return this.getStatus();
    if (!app.isPackaged && !this.options.feedUrl) {
      this.update({
        state: "error",
        message: "开发模式下不检查更新：需要打包后的应用（或设置 ANTEROS_UPDATE_FEED 指向一个更新源）。",
      });
      return this.getStatus();
    }
    this.checking = true;
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.update({ state: "error", message: humanError(error) });
    } finally {
      this.checking = false;
    }
    return this.getStatus();
  }

  /** 下载已经发现的更新（autoDownload 关闭，所以必须显式调用）。 */
  async download(): Promise<UpdateStatus> {
    if (this.downloading) return this.getStatus();
    if (!this.available) {
      this.update({ state: "error", message: "还没有可下载的新版本：先点「检查更新」。" });
      return this.getStatus();
    }
    this.downloading = true;
    this.update({ state: "downloading", percent: 0, message: undefined });
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.downloading = false;
      this.update({ state: "error", message: humanError(error) });
    }
    return this.getStatus();
  }

  /** 退出并安装。只有下载完成后才有效，否则给一句人话。 */
  install(): UpdateStatus {
    if (this.status.state !== "downloaded") {
      this.update({ state: "error", message: "还没有下载完更新包：先点「下载」，下载完成后才能重启安装。" });
      return this.getStatus();
    }
    // isSilent=false：让用户看到安装窗口；isForceRunAfter=true：装完自动打开新版本
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return this.getStatus();
  }

  private update(patch: Partial<UpdateStatus>): void {
    this.status = {
      ...this.status,
      ...patch,
      currentVersion: app.getVersion(),
      busy: patch.state === "checking" || patch.state === "downloading",
    };
    if (patch.state !== "downloading") {
      // 下载进度之外的状态切换不该残留上一次的速度/百分比
      if (patch.percent === undefined && (patch.state === "available" || patch.state === "not-available")) {
        this.status.percent = 0;
      }
    }
    try {
      this.options.onStatus(this.getStatus());
    } catch (error) {
      console.warn("[anteros] 转发更新状态失败：", error);
    }
  }
}

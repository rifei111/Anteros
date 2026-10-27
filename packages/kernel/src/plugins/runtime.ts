/**
 * 插件运行环境管理器（v0.5）。
 *
 * 为什么单独抽出来：有些插件（典型是外部通道适配器）不是"一个 js 文件"，
 * 而是一份用户自己信任的第三方运行环境。规范 6 §9 的红线是"Anteros 不自带、
 * 不内置任何绕过手段"，所以这里只做四件事：
 *
 *   1. 从**用户可改的更新源**拉清单（feed.json）；
 *   2. 下载 → 校验 sha256 → 解包 → 原子切换（校验不过一律不落地）；
 *   3. 升级时按文件清单做**增量**：只下 sha256 变了的文件；
 *   4. 卸载干净（整目录删掉，不留指针）。
 *
 * 它不执行、不加载、不注入任何东西——装完只是把文件放到
 * `<dataDir>/plugin-runtime/<插件 id>/<版本>/` 下，怎么用由插件自己决定。
 */
import { createHash } from "node:crypto";
import { promises as fs, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { AnterosError, ERROR_CODES } from "@anteros/shared";
import type { PluginRuntimeInstall, PluginRuntimePackage, PluginRuntimeStatus } from "@anteros/shared";
import type { LogSink } from "../util/log.js";

/** 更新源清单的格式（schema 1）。 */
export interface PluginRuntimeFeed {
  schema?: number;
  updatedTs?: number;
  packages?: Record<string, PluginRuntimePackage>;
}

export interface PluginRuntimeManagerOptions {
  /** 放运行环境的目录，通常是 <dataDir>/plugin-runtime */
  rootDir: string;
  log: LogSink;
  /** 事件出口：进度/完成都从这走（app 转成 event.runtime 推给客户端） */
  emit?: (status: PluginRuntimeStatus) => void;
  /** 已保存的更新源；为空用默认值 */
  feedUrl?: string | null;
  /** 测试注入 */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export const DEFAULT_RUNTIME_FEED =
  "https://github.com/rifei111/Anteros/releases/download/runtime-feed-v1/feed.json";

const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const FEED_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const FEED_CACHE_MS = 5 * 60_000;
const INSTALL_FILE = "install.json";

interface CachedPackage {
  package: PluginRuntimePackage;
  fetchedTs: number;
}

interface MutableState {
  pluginId: string;
  busy: PluginRuntimeStatus["busy"];
  progress: PluginRuntimeStatus["progress"];
  error: string | null;
  available: PluginRuntimeStatus["available"];
  lastCheckTs: number | null;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 版本比较只看数字段，够用（运行环境用 semver-ish 的 x.y.z）。 */
function compareVersion(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value
      .split(/[.+-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** 路径安全：解包/按文件下载都不许跳出目标目录。 */
function safeRelativePath(raw: string): string {
  const normalized = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.length === 0) throw new Error("包里有空文件名");
  if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`包里有绝对路径，已拒绝：${raw}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".." || part === "")) {
    throw new Error(`包里有越界路径，已拒绝：${raw}`);
  }
  return normalized;
}

/**
 * 最小 tar 解析（ustar）：只接受普通文件与目录，符号链接/硬链接/设备一律跳过。
 * 返回 [{ path, data?, isDir }]，path 已做越界检查。
 */
export function untar(buffer: Buffer): Array<{ path: string; data: Buffer | null }> {
  const entries: Array<{ path: string; data: Buffer | null }> = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const readString = (start: number, length: number): string => {
      const slice = header.subarray(start, start + length);
      const end = slice.indexOf(0);
      return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8").trim();
    };

    const name = readString(0, 100);
    const prefix = readString(345, 155);
    const sizeField = readString(124, 12);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const fullName = prefix.length > 0 ? `${prefix}/${name}` : name;
    const size = Number.parseInt(sizeField, 8) || 0;

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) throw new Error("包被截断：tar 头声明的长度超出实际内容");
    const data = buffer.subarray(dataStart, dataEnd);
    const padded = Math.ceil(size / 512) * 512;

    if (fullName.length > 0) {
      if (typeflag === "5" || fullName.endsWith("/")) {
        entries.push({ path: safeRelativePath(fullName), data: null });
      } else if (typeflag === "0" || typeflag === "\0") {
        entries.push({ path: safeRelativePath(fullName), data: Buffer.from(data) });
      }
      // 其它类型（符号链接 '2'、硬链接 '1'、字符设备…）一律不落盘。
    }
    offset = dataStart + padded;
  }
  return entries;
}

export function extractTarGz(archive: Buffer): Array<{ path: string; data: Buffer | null }> {
  return untar(gunzipSync(archive));
}

export class PluginRuntimeManager {
  private readonly rootDir: string;
  private readonly log: LogSink;
  private readonly emit: ((status: PluginRuntimeStatus) => void) | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private feedUrl: string;
  private feedCache: { feed: PluginRuntimeFeed; fetchedTs: number } | null = null;
  private readonly states = new Map<string, MutableState>();
  private readonly inflight = new Map<string, Promise<PluginRuntimeStatus>>();

  constructor(options: PluginRuntimeManagerOptions) {
    this.rootDir = options.rootDir;
    this.log = options.log;
    this.emit = options.emit;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch);
    this.now = options.now ?? (() => Date.now());
    const saved = typeof options.feedUrl === "string" ? options.feedUrl.trim() : "";
    this.feedUrl = saved.length > 0 ? saved : DEFAULT_RUNTIME_FEED;
  }

  /* ------------------------------ 更新源 ------------------------------ */

  getFeedUrl(): string {
    return this.feedUrl;
  }

  setFeedUrl(url: string): string {
    const trimmed = url.trim();
    if (trimmed.length === 0) {
      this.feedUrl = DEFAULT_RUNTIME_FEED;
      this.feedCache = null;
      return this.feedUrl;
    }
    assertFeedUrl(trimmed);
    this.feedUrl = trimmed;
    this.feedCache = null;
    return this.feedUrl;
  }

  async fetchFeed(force = false): Promise<PluginRuntimeFeed> {
    const cached = this.feedCache;
    if (!force && cached !== null && this.now() - cached.fetchedTs < FEED_CACHE_MS) return cached.feed;

    const feed = await this.requestJson<PluginRuntimeFeed>(this.feedUrl, FEED_TIMEOUT_MS);
    if (feed === null || typeof feed !== "object") {
      throw new AnterosError(ERROR_CODES.EINVALID, `更新源返回的不是清单对象：${this.feedUrl}`);
    }
    if (feed.schema !== undefined && feed.schema !== 1) {
      throw new AnterosError(
        ERROR_CODES.EINVALID,
        `更新源清单版本不支持（schema=${String(feed.schema)}）：这个客户端只认 schema 1`,
      );
    }
    if (feed.packages === undefined || typeof feed.packages !== "object") {
      throw new AnterosError(ERROR_CODES.EINVALID, "更新源清单里没有 packages 字段");
    }
    this.feedCache = { feed, fetchedTs: this.now() };
    return feed;
  }

  /* ------------------------------ 状态 ------------------------------ */

  status(pluginId: string): PluginRuntimeStatus {
    const state = this.stateOf(pluginId);
    const installed = this.readInstalledSync(pluginId);
    const available =
      state.available ??
      (() => {
        const cached = this.feedCache?.feed.packages?.[pluginId];
        if (cached === undefined) return null;
        return {
          version: cached.version,
          size: cached.archive?.size ?? sumSize(cached.files),
          ...(cached.notes === undefined ? {} : { notes: cached.notes }),
          ...(cached.releasedTs === undefined ? {} : { releasedTs: cached.releasedTs }),
        };
      })();
    return {
      pluginId,
      feedUrl: this.feedUrl,
      installed,
      available,
      updateAvailable:
        available !== null &&
        (installed === null || compareVersion(available.version, installed.version) > 0),
      lastCheckTs: state.lastCheckTs,
      busy: state.busy,
      progress: state.progress,
      error: state.error,
    };
  }

  /* ------------------------------ 检查 ------------------------------ */

  async check(pluginId: string): Promise<PluginRuntimeStatus> {
    return this.guard(pluginId, "checking", async () => {
      const feed = await this.fetchFeed(true);
      const pkg = feed.packages?.[pluginId];
      const state = this.stateOf(pluginId);
      if (pkg === undefined) {
        state.available = null;
        state.lastCheckTs = this.now();
        throw new AnterosError(
          ERROR_CODES.ENOTFOUND,
          `更新源里没有 ${pluginId} 的运行环境（是不是还没发布，或者更新源填错了？）`,
        );
      }
      assertPackage(pkg);
      state.available = {
        version: pkg.version,
        size: pkg.archive?.size ?? sumSize(pkg.files),
        ...(pkg.notes === undefined ? {} : { notes: pkg.notes }),
        ...(pkg.releasedTs === undefined ? {} : { releasedTs: pkg.releasedTs }),
      };
      state.lastCheckTs = this.now();
      return this.status(pluginId);
    });
  }

  /* ------------------------------ 安装 / 升级 ------------------------------ */

  async install(pluginId: string): Promise<PluginRuntimeStatus> {
    return this.guard(pluginId, "downloading", async () => {
      const feed = await this.fetchFeed(false);
      const pkg = feed.packages?.[pluginId];
      if (pkg === undefined) {
        throw new AnterosError(
          ERROR_CODES.ENOTFOUND,
          `更新源里没有 ${pluginId} 的运行环境。先检查更新源，或者确认这个插件是否发布了运行环境。`,
        );
      }
      assertPackage(pkg);
      const state = this.stateOf(pluginId);
      state.available = {
        version: pkg.version,
        size: pkg.archive?.size ?? sumSize(pkg.files),
        ...(pkg.notes === undefined ? {} : { notes: pkg.notes }),
        ...(pkg.releasedTs === undefined ? {} : { releasedTs: pkg.releasedTs }),
      };
      state.lastCheckTs = this.now();

      const installed = this.readInstalledSync(pluginId);
      if (installed !== null && compareVersion(installed.version, pkg.version) === 0) {
        this.log.info?.(`运行环境已是最新：${pluginId} v${pkg.version}`);
        return this.status(pluginId);
      }

      const canDelta =
        installed !== null && (pkg.files?.length ?? 0) > 0 && typeof pkg.filesBaseUrl === "string";
      if (canDelta) {
        try {
          await this.applyDelta(pluginId, pkg, installed, state);
          return this.status(pluginId);
        } catch (error) {
          this.log.warn(`增量更新失败，回退整包：${pluginId}：${describe(error)}`);
        }
      }
      await this.applyArchive(pluginId, pkg, state);
      return this.status(pluginId);
    });
  }

  async uninstall(pluginId: string): Promise<PluginRuntimeStatus> {
    const dir = this.pluginDir(pluginId);
    await fs.rm(dir, { recursive: true, force: true });
    const state = this.stateOf(pluginId);
    state.error = null;
    state.available = null;
    this.log.info?.(`已卸载运行环境：${pluginId}`);
    this.emitStatus(pluginId);
    return this.status(pluginId);
  }

  /* ------------------------------ 内部实现 ------------------------------ */

  private async applyArchive(pluginId: string, pkg: PluginRuntimePackage, state: MutableState): Promise<void> {
    const archive = pkg.archive;
    if (archive === undefined) {
      throw new AnterosError(
        ERROR_CODES.EINVALID,
        "这个运行环境既没有整包地址、也没有按文件的清单，装不了。请检查更新源里的配置。",
      );
    }
    assertFeedUrl(archive.url);
    const bytes = await this.download(archive.url, archive.size, state);
    state.busy = "applying";
    state.progress = { phase: "verify", percent: 100, bytes: bytes.length, totalBytes: bytes.length };
    this.emitStatus(pluginId);

    const actual = sha256(bytes);
    if (actual !== archive.sha256.toLowerCase()) {
      throw new AnterosError(
        ERROR_CODES.EINVALID,
        `包校验失败：算出来的 sha256 和清单不一致（可能是下载被截断或替换了）。已丢弃，没有安装。`,
        { detail: `期望 ${archive.sha256}，实际 ${actual}` },
      );
    }

    if (archive.format !== "tar.gz") {
      throw new AnterosError(ERROR_CODES.EINVALID, `暂不支持 ${archive.format} 格式的运行环境包`);
    }
    let entries: Array<{ path: string; data: Buffer | null }>;
    try {
      entries = extractTarGz(bytes);
    } catch (error) {
      if (error instanceof AnterosError) throw error;
      throw new AnterosError(ERROR_CODES.EINVALID, `包解压失败：${describe(error)}`);
    }

    state.progress = { phase: "extract", percent: 100, bytes: bytes.length, totalBytes: bytes.length };
    this.emitStatus(pluginId);

    const versionDir = path.join(this.pluginDir(pluginId), pkg.version);
    const tempDir = `${versionDir}.tmp-${this.now()}`;
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(tempDir, { recursive: true });
    try {
      const files = await writeEntries(tempDir, entries);
      await fs.writeFile(
        path.join(tempDir, INSTALL_FILE),
        JSON.stringify(
          {
            pluginId,
            version: pkg.version,
            mode: "archive",
            source: archive.url,
            installedTs: this.now(),
            entry: pkg.entry ?? null,
            files,
          } satisfies Record<string, unknown>,
          null,
          2,
        ),
        "utf8",
      );
      await this.swapIn(pluginId, tempDir, versionDir);
    } catch (error) {
      await fs.rm(tempDir, { recursive: true, force: true });
      if (error instanceof AnterosError) throw error;
      throw new AnterosError(ERROR_CODES.EIO, `安装运行环境失败：${describe(error)}`);
    }
    this.log.info?.(`运行环境已安装：${pluginId} v${pkg.version}（整包）`);
  }

  private async applyDelta(
    pluginId: string,
    pkg: PluginRuntimePackage,
    installed: PluginRuntimeInstall,
    state: MutableState,
  ): Promise<void> {
    const files = pkg.files ?? [];
    const baseUrl = pkg.filesBaseUrl as string;
    const versionDir = path.join(this.pluginDir(pluginId), pkg.version);
    const tempDir = `${versionDir}.tmp-${this.now()}`;
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(tempDir, { recursive: true });

    let downloaded = 0;
    let reused = 0;
    let bytesDone = 0;
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0) || 1;
    try {
      for (const file of files) {
        const relative = safeRelativePath(file.path);
        const localPath = path.join(installed.path, relative);
        const localBytes = await fs.readFile(localPath).catch(() => null);
        if (localBytes !== null && sha256(localBytes) === file.sha256.toLowerCase()) {
          await writeFileSafe(tempDir, relative, localBytes);
          reused += 1;
          bytesDone += file.size;
          continue;
        }
        const url = `${baseUrl.replace(/\/+$/, "")}/${file.sha256.toLowerCase()}`;
        const bytes = await this.download(url, file.size, state, bytesDone, totalBytes);
        const actual = sha256(bytes);
        if (actual !== file.sha256.toLowerCase()) {
          throw new AnterosError(ERROR_CODES.EINVALID, `增量文件校验失败：${relative}（已丢弃本次更新）`);
        }
        await writeFileSafe(tempDir, relative, bytes);
        downloaded += 1;
        bytesDone += bytes.length;
        state.progress = {
          phase: "download",
          percent: Math.min(99, Math.round((bytesDone / totalBytes) * 100)),
          bytes: bytesDone,
          totalBytes,
        };
        this.emitStatus(pluginId);
      }

      state.busy = "applying";
      state.progress = { phase: "apply", percent: 100, bytes: totalBytes, totalBytes };
      this.emitStatus(pluginId);

      await fs.writeFile(
        path.join(tempDir, INSTALL_FILE),
        JSON.stringify(
          {
            pluginId,
            version: pkg.version,
            mode: "delta",
            source: baseUrl,
            installedTs: this.now(),
            entry: pkg.entry ?? null,
            files: files.map((file) => ({ path: file.path, sha256: file.sha256, size: file.size })),
            downloadedFiles: downloaded,
            reusedFiles: reused,
          } satisfies Record<string, unknown>,
          null,
          2,
        ),
        "utf8",
      );
      await this.swapIn(pluginId, tempDir, versionDir);
      this.log.info?.(
        `运行环境已升级：${pluginId} v${installed.version} → v${pkg.version}（增量：下载 ${downloaded} 个文件，复用 ${reused} 个）`,
      );
    } catch (error) {
      await fs.rm(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  /** 原子切换：先把新目录写成 <version>.tmp-*，校验通过后删旧目录、改名。 */
  private async swapIn(pluginId: string, tempDir: string, versionDir: string): Promise<void> {
    const pluginDir = this.pluginDir(pluginId);
    await fs.mkdir(pluginDir, { recursive: true });
    const previous = await fs.readdir(pluginDir).catch(() => [] as string[]);
    await fs.rm(versionDir, { recursive: true, force: true });
    await fs.rename(tempDir, versionDir);
    // 旧版本目录收尾（失败只告警，不影响已经成功的新版本）
    for (const entry of previous) {
      if (entry.startsWith(path.basename(versionDir))) continue;
      if (!isVersionDirName(entry)) continue;
      await fs.rm(path.join(pluginDir, entry), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async download(
    url: string,
    expectedSize: number | undefined,
    state: MutableState,
    bytesDone = 0,
    totalBytes = 0,
  ): Promise<Buffer> {
    assertFeedUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      state.busy = "downloading";
      this.emitStatus(state.pluginId);
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        throw new AnterosError(
          ERROR_CODES.EBLOCKED,
          `下载失败：HTTP ${response.status}。可能更新源不可达或者地址过期了。`,
        );
      }
      const length = Number(response.headers.get("content-length") ?? 0);
      const total = expectedSize ?? (Number.isFinite(length) && length > 0 ? length : 0);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_PACKAGE_BYTES) {
        throw new AnterosError(ERROR_CODES.EINVALID, `包太大（${humanSize(buffer.length)}），超过上限，已拒绝。`);
      }
      if (expectedSize !== undefined && buffer.length !== expectedSize) {
        throw new AnterosError(
          ERROR_CODES.EINVALID,
          `下载不完整：清单写的是 ${humanSize(expectedSize)}，实际收到 ${humanSize(buffer.length)}。没有安装。`,
        );
      }
      const done = bytesDone + buffer.length;
      const grandTotal = bytesDone + (total > 0 ? total : buffer.length);
      state.progress = {
        phase: "download",
        percent: grandTotal > 0 ? Math.min(99, Math.round((done / grandTotal) * 100)) : 50,
        bytes: done,
        totalBytes: grandTotal,
      };
      this.emitStatus(state.pluginId ?? "");
      return buffer;
    } catch (error) {
      if (error instanceof AnterosError) throw error;
      if ((error as { name?: string }).name === "AbortError") {
        throw new AnterosError(ERROR_CODES.ETIMEOUT, "下载超时：更新源太久没响应，检查网络或换个更新源。");
      }
      throw new AnterosError(ERROR_CODES.EBLOCKED, `下载失败：${describe(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async requestJson<T>(url: string, timeoutMs: number): Promise<T | null> {
    assertFeedUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        throw new AnterosError(
          ERROR_CODES.EBLOCKED,
          `取更新源失败：HTTP ${response.status}（${url}）。检查地址是否可访问。`,
        );
      }
      const text = await response.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new AnterosError(ERROR_CODES.EINVALID, `更新源返回的不是合法 JSON：${url}`);
      }
    } catch (error) {
      if (error instanceof AnterosError) throw error;
      if ((error as { name?: string }).name === "AbortError") {
        throw new AnterosError(ERROR_CODES.ETIMEOUT, `取更新源超时：${url}`);
      }
      throw new AnterosError(ERROR_CODES.EBLOCKED, `连不上更新源：${describe(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 串行化：同一个插件的安装只允许跑一次，重复点击直接返回进行中的那个。 */
  private guard(
    pluginId: string,
    busy: PluginRuntimeStatus["busy"],
    task: () => Promise<PluginRuntimeStatus>,
  ): Promise<PluginRuntimeStatus> {
    const running = this.inflight.get(pluginId);
    if (running !== undefined) return running;

    const state = this.stateOf(pluginId);
    state.busy = busy;
    state.error = null;
    state.progress = null;
    this.emitStatus(pluginId);

    const promise = task()
      .then(() => {
        state.busy = "idle";
        state.progress = null;
        state.error = null;
        this.emitStatus(pluginId);
        // 注意：不能把 task 内部算出来的 status 直接返回——那是「忙」的时候拍的快照，
        // 界面会一直停在进度条上。这里重算一次，拿到的才是收尾后的真实状态。
        return this.status(pluginId);
      })
      .catch((error: unknown) => {
        state.busy = "idle";
        state.progress = null;
        state.error = describe(error);
        this.emitStatus(pluginId);
        throw error;
      })
      .finally(() => {
        this.inflight.delete(pluginId);
      });
    this.inflight.set(pluginId, promise);
    return promise;
  }

  private stateOf(pluginId: string): MutableState {
    const existing = this.states.get(pluginId);
    if (existing !== undefined) return existing;
    const created: MutableState = {
      pluginId,
      busy: "idle",
      progress: null,
      error: null,
      available: null,
      lastCheckTs: null,
    };
    this.states.set(pluginId, created);
    return created;
  }

  private emitStatus(pluginId: string): void {
    if (this.emit === undefined || pluginId.length === 0) return;
    try {
      this.emit(this.status(pluginId));
    } catch (error) {
      this.log.warn(`推送运行环境状态失败：${describe(error)}`);
    }
  }

  private pluginDir(pluginId: string): string {
    return path.join(this.rootDir, pluginId.replace(/[^a-z0-9.-]/gi, "_"));
  }

  private readInstalledSync(pluginId: string): PluginRuntimeInstall | null {
    const pluginDir = this.pluginDir(pluginId);
    let versions: string[];
    try {
      versions = readdirSyncSafe(pluginDir).filter((entry) => isVersionDirName(entry));
    } catch {
      return null;
    }
    if (versions.length === 0) return null;
    versions.sort((left, right) => compareVersion(right, left));
    const latest = versions[0];
    if (latest === undefined) return null;
    const dir = path.join(pluginDir, latest);
    const installFile = path.join(dir, INSTALL_FILE);
    try {
      // 同步读，避免 status() 变成 async（RPC 层到处都在同步取值）
      const raw = readFileSyncSafe(installFile);
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as {
        version?: string;
        mode?: string;
        source?: string;
        installedTs?: number;
        files?: Array<{ size?: number }>;
      };
      const files = Array.isArray(parsed.files) ? parsed.files : [];
      return {
        version: typeof parsed.version === "string" ? parsed.version : latest,
        path: dir,
        size: files.reduce((sum, file) => sum + (typeof file.size === "number" ? file.size : 0), 0),
        fileCount: files.length,
        installedTs: typeof parsed.installedTs === "number" ? parsed.installedTs : 0,
        mode: parsed.mode === "delta" ? "delta" : "archive",
        source: typeof parsed.source === "string" ? parsed.source : "",
      };
    } catch {
      return null;
    }
  }
}

/* ------------------------------ 工具函数 ------------------------------ */

function readdirSyncSafe(dir: string): string[] {
  return readdirSync(dir);
}

function readFileSyncSafe(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function isVersionDirName(name: string): boolean {
  return /^\d+\.\d+\.\d+/.test(name) && !name.includes(".tmp-");
}

function sumSize(files: PluginRuntimePackage["files"]): number {
  return (files ?? []).reduce((sum, file) => sum + (typeof file.size === "number" ? file.size : 0), 0);
}

function describe(error: unknown): string {
  if (error instanceof AnterosError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function assertFeedUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AnterosError(ERROR_CODES.EINVALID, `更新源地址不是合法 URL：${url}`);
  }
  if (!["https:", "http:", "file:"].includes(parsed.protocol)) {
    throw new AnterosError(ERROR_CODES.EINVALID, `更新源只支持 https / http / file：${url}`);
  }
}

function assertPackage(pkg: PluginRuntimePackage): void {
  if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+/.test(pkg.version)) {
    throw new AnterosError(ERROR_CODES.EINVALID, `清单里的版本号不合法：${String(pkg.version)}`);
  }
  if (pkg.archive !== undefined && typeof pkg.archive.sha256 !== "string") {
    throw new AnterosError(ERROR_CODES.EINVALID, "清单里整包缺少 sha256，不能安装（校验不了的东西不装）。");
  }
}

async function writeEntries(
  rootDir: string,
  entries: Array<{ path: string; data: Buffer | null }>,
): Promise<Array<{ path: string; sha256: string; size: number }>> {
  const written: Array<{ path: string; sha256: string; size: number }> = [];
  for (const entry of entries) {
    if (entry.data === null) {
      await fs.mkdir(path.join(rootDir, entry.path), { recursive: true });
      continue;
    }
    await writeFileSafe(rootDir, entry.path, entry.data);
    written.push({ path: entry.path, sha256: sha256(entry.data), size: entry.data.length });
  }
  return written;
}

async function writeFileSafe(rootDir: string, relative: string, data: Buffer): Promise<void> {
  const target = path.join(rootDir, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
}

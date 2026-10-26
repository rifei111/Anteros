/**
 * 插件发现与注册（规范 6 §4.1：discover → validate → register）。
 *
 * 扫描插件目录 → 读 plugin.json → validateManifest → 幂等写 plugins 表。
 * 不覆盖用户已有的 enabled/config/授权；版本变化不做热升级，停用等用户确认。
 */
import fs from "node:fs";
import path from "node:path";
import {
  KERNEL_API_VERSION,
  kernelApiMajor,
  validateManifest,
  type ParsedPluginManifest,
  type PluginRisk,
} from "@anteros/shared";
import type { Db } from "../db/database.js";
import type { LogSink } from "../util/log.js";
import type { InvalidPluginInfo, PluginDirInfo } from "./types.js";

interface PluginDbRow {
  id: string;
  version: string;
  enabled: number;
  status: string;
}

export interface RegistryScanResult {
  plugins: PluginDirInfo[];
  invalid: InvalidPluginInfo[];
  /** 数据库里有、磁盘上已不存在（可能被手动删除）的插件 id。 */
  missing: string[];
}

/** 不是插件的目录（SDK、占位目录）。 */
const IGNORED_DIRS = new Set(["node_modules", "_sdk", ".git", "dist"]);

export class PluginRegistry {
  private result: RegistryScanResult = { plugins: [], invalid: [], missing: [] };

  constructor(
    private readonly db: Db,
    private readonly log: LogSink,
    private readonly options: { pluginsDir: string; production?: boolean },
  ) {}

  get pluginsDir(): string {
    return this.options.pluginsDir;
  }

  get production(): boolean {
    return this.options.production === true;
  }

  /** 磁盘扫描 + 校验 + 入库。可重复调用（幂等）。 */
  scan(): RegistryScanResult {
    const plugins: PluginDirInfo[] = [];
    const invalid: InvalidPluginInfo[] = [];

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(this.options.pluginsDir, { withFileTypes: true });
    } catch (error) {
      this.log.warn(`插件目录不可读：${this.options.pluginsDir}（${errorText(error)}）`);
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
      const dir = path.join(this.options.pluginsDir, entry.name);
      const manifestFile = path.join(dir, "plugin.json");
      if (!fs.existsSync(manifestFile)) {
        this.log.debug(`跳过无 plugin.json 的目录：${entry.name}`);
        continue;
      }
      const parsed = this.loadOne(dir, manifestFile);
      if (parsed.ok) plugins.push(parsed.info);
      else invalid.push(parsed.invalid);
    }

    plugins.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    invalid.sort((a, b) => a.id.localeCompare(b.id));

    for (const info of plugins) this.upsert(info);
    for (const bad of invalid) this.recordInvalid(bad);

    const seen = new Set([...plugins.map((p) => p.manifest.id), ...invalid.map((p) => p.id)]);
    const missing = this.db
      .all<{ id: string }>("SELECT id FROM plugins")
      .map((row) => row.id)
      .filter((id) => !seen.has(id));

    this.result = { plugins, invalid, missing };
    for (const id of missing) this.log.warn(`插件 ${id} 在磁盘上已不存在（保留其数据与授权，不自动删除）`);
    this.log.info(
      `插件发现完成：有效 ${plugins.length}，无效 ${invalid.length}，缺失 ${missing.length}（目录 ${this.options.pluginsDir}）`,
    );
    return this.result;
  }

  get(id: string): PluginDirInfo | undefined {
    return this.result.plugins.find((info) => info.manifest.id === id);
  }

  list(): PluginDirInfo[] {
    return this.result.plugins;
  }

  invalid(): InvalidPluginInfo[] {
    return this.result.invalid;
  }

  missing(): string[] {
    return this.result.missing;
  }

  entryPath(id: string): string | null {
    return this.get(id)?.entryPath ?? null;
  }

  private loadOne(
    dir: string,
    manifestFile: string,
  ): { ok: true; info: PluginDirInfo } | { ok: false; invalid: InvalidPluginInfo } {
    const dirName = path.basename(dir);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as unknown;
    } catch (error) {
      return {
        ok: false,
        invalid: {
          id: dirName,
          dir,
          issues: [`plugin.json 不是合法 JSON：${errorText(error)}`],
        },
      };
    }

    const validation = validateManifest(raw, {
      kernelApiMajor: kernelApiMajor(KERNEL_API_VERSION) ?? "1",
      production: this.options.production,
    });
    if (!validation.ok) {
      const rawId = rawRecord(raw)?.id;
      return {
        ok: false,
        invalid: {
          id: typeof rawId === "string" && rawId.length > 0 ? rawId : dirName,
          dir,
          issues: sanitizeIssues(validation.errors),
        },
      };
    }

    const manifest = validation.manifest;
    const issues: string[] = [...validation.warnings];
    const command = manifest.entry.command;
    const entryPath = path.isAbsolute(command) ? command : path.resolve(dir, command);
    if (!fs.existsSync(entryPath)) {
      issues.push(`入口文件不存在：${path.relative(dir, entryPath) || entryPath}`);
    }
    if (manifest.secrets.length > 0) {
      issues.push(`需要 ${manifest.secrets.length} 项密钥（未配置会导致 blocked）：${manifest.secrets.join("、")}`);
    }
    return { ok: true, info: { manifest, dir, entryPath, issues } };
  }

  private upsert(info: PluginDirInfo): void {
    const { manifest } = info;
    const existing = this.db.get<PluginDbRow>("SELECT id, version, enabled, status FROM plugins WHERE id = ?", [
      manifest.id,
    ]);
    const capabilities = JSON.stringify(manifest.capabilities);
    const permissions = JSON.stringify(manifest.permissions);
    const issues = JSON.stringify(info.issues);

    if (existing === undefined) {
      const enabled = this.initialEnabled(info);
      this.db.run(
        `INSERT INTO plugins(id, version, kernel_api, kind, capabilities, permissions, risk_level, enabled, config, status, issues)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', 'disabled', ?)`,
        [
          manifest.id,
          manifest.version,
          manifest.kernelApi,
          manifest.kind,
          capabilities,
          permissions,
          manifest.riskLevel,
          enabled,
          issues,
        ],
      );
      this.log.info(`注册插件 ${manifest.id}@${manifest.version}（${manifest.kind}，默认${enabled === 1 ? "启用" : "停用"}）`);
      return;
    }

    if (existing.version !== manifest.version) {
      // 规范 6 §6：不允许悄悄热升级。先停用，等用户确认后再启用。
      const wasEnabled = existing.enabled === 1;
      this.db.run(
        `UPDATE plugins SET version = ?, kernel_api = ?, kind = ?, capabilities = ?, permissions = ?,
           risk_level = ?, issues = ?, enabled = 0, status = 'blocked', health = NULL,
           last_error = ?
         WHERE id = ?`,
        [
          manifest.version,
          manifest.kernelApi,
          manifest.kind,
          capabilities,
          permissions,
          manifest.riskLevel,
          issues,
          `插件已从 ${existing.version} 升级到 ${manifest.version}，已停用并等待用户确认（不做热升级）`,
          manifest.id,
        ],
      );
      this.writeEvent(
        manifest.id,
        "warn",
        `版本变化 ${existing.version} → ${manifest.version}：${wasEnabled ? "已自动停用，" : ""}等待用户确认后重新启用`,
      );
      return;
    }

    // 同版本：刷新描述性字段，保留用户状态（enabled/config/授权/health/last_error）。
    this.db.run(
      `UPDATE plugins SET kernel_api = ?, kind = ?, capabilities = ?, permissions = ?, risk_level = ?, issues = ?
       WHERE id = ?`,
      [manifest.kernelApi, manifest.kind, capabilities, permissions, manifest.riskLevel, issues, manifest.id],
    );
  }

  /** 首次入库的 enabled 初值：优先读原始 plugin.json 的 enabled，缺省 risk=high 停用、其它启用。 */
  private initialEnabled(info: PluginDirInfo): number {
    const raw = safeReadJson(path.join(info.dir, "plugin.json"));
    if (typeof raw?.enabled === "boolean") return raw.enabled ? 1 : 0;
    return info.manifest.riskLevel === "high" ? 0 : 1;
  }

  private recordInvalid(bad: InvalidPluginInfo): void {
    this.log.warn(`插件无效 ${bad.id}：${bad.issues.join("；")}`);
    this.writeEvent(bad.id, "error", `插件校验未通过：${bad.issues.join("；")}`);
  }

  private writeEvent(pluginId: string, level: "debug" | "info" | "warn" | "error", message: string): void {
    try {
      this.db.run("INSERT INTO plugin_events(plugin_id, ts, level, message) VALUES (?, ?, ?, ?)", [
        pluginId,
        Date.now(),
        level,
        message.slice(0, 2000),
      ]);
    } catch {
      /* 事件表写失败不影响发现流程 */
    }
  }
}

function rawRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeReadJson(file: string): Record<string, unknown> | null {
  try {
    return rawRecord(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
  } catch {
    return null;
  }
}

function sanitizeIssues(errors: readonly string[]): string[] {
  return errors.map((error) => error.trim()).filter((error) => error.length > 0);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 风险等级 → 是否属于写类插件（供 canEnable 判断）。 */
export function isChannelPlugin(manifest: ParsedPluginManifest): boolean {
  return manifest.kind === "channel";
}

export function riskOf(manifest: ParsedPluginManifest): PluginRisk {
  return manifest.riskLevel;
}

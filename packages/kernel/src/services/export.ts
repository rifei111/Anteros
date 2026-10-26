/**
 * 数据导出 / 导入（草案 14.15 单机闭环的"搬得走"义务）。
 *
 * 导出：把所有业务表导成 JSON + 媒体目录（base64）+ 头部元信息，gzip 成一个文件，
 *       落在 <dataDir>/exports/。**不含任何密钥文件、不含 master key**。
 * 导入：校验魔数与版本 → 备份当前库到 exports/*.bak → 事务内清库重灌 → 替换媒体目录。
 *       导入失败时事务回滚、数据库保持原样；备份文件留给用户手动恢复。
 *
 * 审计由 app 层写（见 app.ts 的 export.bundle / import.bundle 处理），这里不重复写。
 */
import fs from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { AnterosError, ERROR_CODES, EXPORT_DIR_NAME, KERNEL_API_VERSION, KERNEL_VERSION, kernelApiMajor } from "@anteros/shared";
import { SCHEMA_SQL } from "../db/schema.js";
import type { KernelDeps } from "../contracts.js";
import type { SqlValue } from "../db/database.js";

const BUNDLE_MAGIC = "ANTEROS-BUNDLE-1";
const BUNDLE_VERSION = "1.0";
const MEDIA_DIR_NAME = "media";
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

type BundleValue = string | number | null | { bytes: string };

interface BundleMedia {
  path: string;
  size: number;
  /** base64；超过 MAX_MEDIA_BYTES 时为 null（清单里仍记录，导出时告警）。 */
  data: string | null;
}

interface BundleFile {
  magic: typeof BUNDLE_MAGIC;
  bundleVersion: string;
  kernelVersion: string;
  kernelApi: string;
  createdTs: number;
  tables: Record<string, Array<Record<string, BundleValue>>>;
  media: BundleMedia[];
  counts: { tables: number; rows: number; media: number };
  /** 显式声明：不含密钥。 */
  secretsExcluded: true;
}

export interface ImportBundleResult {
  tables: string[];
  rows: number;
  media: number;
}

export interface ExportServiceOptions {
  dataDir: string;
}

function errorText(error: unknown): string {
  if (error instanceof AnterosError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 从 SCHEMA_SQL 提取当前版本的业务表清单（顺序即建表顺序）。 */
export function schemaTables(): string[] {
  const names: string[] = [];
  const re = /CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(SCHEMA_SQL)) !== null) {
    const name = match[1];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

function toBundleValue(value: unknown): BundleValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString("base64") };
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return Number(value);
  throw new AnterosError(ERROR_CODES.EIO, `导出时遇到不支持的数据类型：${typeof value}`);
}

function fromBundleValue(value: BundleValue, sqlType: string): SqlValue {
  if (value === null) return null;
  if (typeof value === "object") {
    return new Uint8Array(Buffer.from(value.bytes, "base64"));
  }
  if (sqlType === "BLOB" && typeof value === "string") return new Uint8Array(Buffer.from(value, "base64"));
  return value;
}

export class ExportService {
  private readonly deps: KernelDeps;
  private readonly dataDir: string;
  private readonly exportsDir: string;
  private readonly mediaDir: string;

  constructor(deps: KernelDeps, options: ExportServiceOptions) {
    this.deps = deps;
    this.dataDir = path.resolve(options.dataDir);
    this.exportsDir = path.join(this.dataDir, EXPORT_DIR_NAME);
    this.mediaDir = path.join(this.dataDir, MEDIA_DIR_NAME);
  }

  get dataDirectory(): string {
    return this.dataDir;
  }

  // ── 导出 ─────────────────────────────────────────────────────────

  async exportBundle(): Promise<string> {
    fs.mkdirSync(this.exportsDir, { recursive: true });

    const tables: Record<string, Array<Record<string, BundleValue>>> = {};
    let totalRows = 0;
    for (const table of schemaTables()) {
      const rows = this.deps.db.all<Record<string, SqlValue>>(`SELECT * FROM "${table}"`);
      const encoded = rows.map((row) => {
        const encodedRow: Record<string, BundleValue> = {};
        for (const [key, value] of Object.entries(row)) encodedRow[key] = toBundleValue(value);
        return encodedRow;
      });
      tables[table] = encoded;
      totalRows += encoded.length;
    }

    const media = this.collectMedia();
    const bundle: BundleFile = {
      magic: BUNDLE_MAGIC,
      bundleVersion: BUNDLE_VERSION,
      kernelVersion: KERNEL_VERSION,
      kernelApi: KERNEL_API_VERSION,
      createdTs: Date.now(),
      tables,
      media,
      counts: { tables: Object.keys(tables).length, rows: totalRows, media: media.length },
      secretsExcluded: true,
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destFile = path.join(this.exportsDir, `anteros-bundle-${stamp}.json.gz`);
    const payload = gzipSync(Buffer.from(JSON.stringify(bundle), "utf8"), { level: 9 });
    fs.writeFileSync(destFile, payload);
    this.deps.log.info(
      `已导出数据备份：${destFile}（${tables.length} 张表 / ${totalRows} 行 / ${media.length} 个媒体文件）`,
    );
    return destFile;
  }

  private collectMedia(): BundleMedia[] {
    if (!fs.existsSync(this.mediaDir)) return [];
    const result: BundleMedia[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const size = fs.statSync(full).size;
        const relative = path.relative(this.mediaDir, full).split(path.sep).join("/");
        if (size > MAX_MEDIA_BYTES) {
          this.deps.log.warn(`媒体文件过大，仅导出清单不导出内容：${relative}（${size} 字节）`);
          result.push({ path: relative, size, data: null });
          continue;
        }
        result.push({ path: relative, size, data: fs.readFileSync(full).toString("base64") });
      }
    };
    walk(this.mediaDir);
    return result;
  }

  // ── 导入 ─────────────────────────────────────────────────────────

  async importBundle(srcFile: string): Promise<ImportBundleResult> {
    const source = this.readBundle(srcFile);
    const tables = schemaTables();
    const unknown = Object.keys(source.tables).filter((table) => !tables.includes(table));
    if (unknown.length > 0) this.deps.log.warn(`备份中有当前内核不认识的表，将被忽略：${unknown.join("、")}`);

    // 1) 先落媒体到临时目录：数据库事务失败时删掉，不影响现有媒体。
    const stageDir = path.join(this.dataDir, `.media-import-${Date.now()}`);
    let mediaWritten = 0;
    try {
      mediaWritten = this.stageMedia(source.media, stageDir);
    } catch (error) {
      this.removeDir(stageDir);
      throw new AnterosError(ERROR_CODES.EIO, `恢复媒体文件失败：${errorText(error)}`);
    }

    // 2) 备份当前数据库（内存库跳过）。
    const backupPath = this.backupDatabase();
    if (backupPath !== null) this.deps.log.info(`导入前已备份当前数据库：${backupPath}`);

    // 3) 事务内清库重灌：失败自动回滚，数据库保持导入前状态。
    let importedRows = 0;
    try {
      this.importTables(source.tables, tables);
      importedRows = this.countRows(source.tables, tables);
    } catch (error) {
      this.removeDir(stageDir);
      const backupHint = backupPath === null ? "" : `；导入前备份在 ${backupPath}`;
      throw new AnterosError(ERROR_CODES.EIO, `导入失败，数据库已回滚：${errorText(error)}${backupHint}`);
    }

    // 4) 数据库提交成功后再替换媒体目录（失败不回滚数据库，但会保留临时目录供排查）。
    try {
      this.swapMediaDir(stageDir);
    } catch (error) {
      this.deps.log.warn(`媒体目录替换失败（数据库已导入成功）：${errorText(error)}；临时目录：${stageDir}`);
    }

    this.deps.log.info(`已导入数据备份：${srcFile}（${tables.length} 张表 / ${importedRows} 行 / ${mediaWritten} 个媒体文件）`);
    return {
      tables: tables.filter((table) => Array.isArray(source.tables[table])),
      rows: importedRows,
      media: mediaWritten,
    };
  }

  private readBundle(srcFile: string): BundleFile {
    if (typeof srcFile !== "string" || srcFile.trim().length === 0) {
      throw new AnterosError(ERROR_CODES.EINVALID, "请指定要导入的备份文件路径");
    }
    const resolved = path.resolve(srcFile);
    if (!fs.existsSync(resolved)) {
      throw new AnterosError(ERROR_CODES.ENOTFOUND, `备份文件不存在：${resolved}`);
    }
    let parsed: unknown;
    try {
      const raw = gunzipSync(fs.readFileSync(resolved)).toString("utf8");
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new AnterosError(ERROR_CODES.EINVALID, `备份文件已损坏或不是 gzip JSON：${errorText(error)}`);
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new AnterosError(ERROR_CODES.EINVALID, "备份文件内容不是有效的 Anteros 备份");
    }
    const bundle = parsed as Partial<BundleFile>;
    if (bundle.magic !== BUNDLE_MAGIC) {
      throw new AnterosError(ERROR_CODES.EINVALID, "不是 Anteros 备份文件（缺少 ANTEROS-BUNDLE-1 标识）");
    }
    const versionOk =
      typeof bundle.bundleVersion === "string" && bundle.bundleVersion.split(".")[0] === BUNDLE_VERSION.split(".")[0];
    if (!versionOk) {
      throw new AnterosError(
        ERROR_CODES.EVERSION,
        `备份格式版本不支持：${String(bundle.bundleVersion)}（当前支持 ${BUNDLE_VERSION}）`,
      );
    }
    if (typeof bundle.kernelApi !== "string" || kernelApiMajor(bundle.kernelApi) !== kernelApiMajor(KERNEL_API_VERSION)) {
      throw new AnterosError(
        ERROR_CODES.EVERSION,
        `备份来自内核 ${String(bundle.kernelApi)}，当前内核 ${KERNEL_API_VERSION}，主版本不一致不能直接导入`,
      );
    }
    if (bundle.tables === null || typeof bundle.tables !== "object") {
      throw new AnterosError(ERROR_CODES.EINVALID, "备份文件缺少数据表内容");
    }
    return {
      magic: BUNDLE_MAGIC,
      bundleVersion: bundle.bundleVersion ?? BUNDLE_VERSION,
      kernelVersion: bundle.kernelVersion ?? KERNEL_VERSION,
      kernelApi: bundle.kernelApi,
      createdTs: typeof bundle.createdTs === "number" ? bundle.createdTs : 0,
      tables: bundle.tables as BundleFile["tables"],
      media: Array.isArray(bundle.media) ? bundle.media : [],
      counts: bundle.counts ?? { tables: 0, rows: 0, media: 0 },
      secretsExcluded: true,
    };
  }

  private stageMedia(media: readonly BundleMedia[], stageDir: string): number {
    this.removeDir(stageDir);
    if (media.length === 0) return 0;
    fs.mkdirSync(stageDir, { recursive: true });
    let written = 0;
    for (const item of media) {
      if (item === null || typeof item !== "object") continue;
      const relative = typeof item.path === "string" ? item.path.replace(/\\/g, "/") : "";
      if (relative.length === 0) continue;
      const normalized = path.posix.normalize(relative);
      if (normalized.startsWith("..") || path.posix.isAbsolute(normalized)) {
        this.deps.log.warn(`跳过非法媒体路径：${relative}`);
        continue;
      }
      if (typeof item.data !== "string") continue;
      const dest = path.join(stageDir, ...normalized.split("/"));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(item.data, "base64"));
      written += 1;
    }
    return written;
  }

  private swapMediaDir(stageDir: string): void {
    if (!fs.existsSync(stageDir)) return;
    const backupMedia = `${this.mediaDir}.old-${Date.now()}`;
    if (fs.existsSync(this.mediaDir)) fs.renameSync(this.mediaDir, backupMedia);
    fs.renameSync(stageDir, this.mediaDir);
    this.removeDir(backupMedia);
  }

  private backupDatabase(): string | null {
    const dbPath = this.deps.db.path;
    if (!dbPath || dbPath === ":memory:") return null;
    try {
      this.deps.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (error) {
      this.deps.log.warn(`导入前 checkpoint WAL 失败：${errorText(error)}`);
    }
    fs.mkdirSync(this.exportsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(this.exportsDir, `anteros-db-before-import-${stamp}.bak`);
    fs.copyFileSync(dbPath, dest);
    return dest;
  }

  private importTables(
    source: Record<string, Array<Record<string, BundleValue>>>,
    tables: readonly string[],
  ): void {
    const columnsCache = new Map<string, Map<string, string>>();
    const columnsOf = (table: string): Map<string, string> => {
      const cached = columnsCache.get(table);
      if (cached) return cached;
      const info = this.deps.db.all<{ name: string; type: string }>(`PRAGMA table_info("${table}")`);
      const map = new Map<string, string>();
      for (const column of info) map.set(column.name, (column.type || "").toUpperCase());
      columnsCache.set(table, map);
      return map;
    };

    this.deps.db.exec("PRAGMA foreign_keys = OFF");
    try {
      this.deps.db.tx(() => {
        for (const table of tables) {
          this.deps.db.exec(`DELETE FROM "${table}"`);
        }
        for (const table of tables) {
          const rows = source[table];
          if (!Array.isArray(rows)) continue;
          const columns = columnsOf(table);
          for (const row of rows) {
            if (row === null || typeof row !== "object") continue;
            const keys = Object.keys(row).filter((key) => columns.has(key));
            if (keys.length === 0) continue;
            const placeholders = keys.map(() => "?").join(",");
            const values = keys.map((key) => fromBundleValue(row[key] as BundleValue, columns.get(key) ?? ""));
            this.deps.db.run(`INSERT INTO "${table}"(${keys.map((key) => `"${key}"`).join(",")}) VALUES(${placeholders})`, values);
          }
        }
      });
    } finally {
      this.deps.db.exec("PRAGMA foreign_keys = ON");
    }
  }

  private countRows(
    source: Record<string, Array<Record<string, BundleValue>>>,
    tables: readonly string[],
  ): number {
    let count = 0;
    for (const table of tables) {
      const rows = source[table];
      if (Array.isArray(rows)) count += rows.length;
    }
    return count;
  }

  private removeDir(dir: string): void {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      this.deps.log.warn(`清理目录失败（${dir}）：${errorText(error)}`);
    }
  }
}

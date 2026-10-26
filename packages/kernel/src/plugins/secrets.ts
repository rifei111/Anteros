/**
 * 插件密钥库（规范 6 §11.2 / 草案 14.6 ④）。
 *
 * 务实折中，不夸大：单机单用户威胁模型下，用「用户数据目录内的 32 字节 master key
 * + AES-256-GCM」代替 DPAPI。防的是数据文件被顺手拷走/云盘同步与日志泄漏；
 * 不防拥有本机管理员权限的攻击者。明文密钥绝不落盘、绝不进日志、绝不回传客户端；
 * 只在 spawn 插件时经环境变量注入，且要求 manifest 声明 + 显式授权。
 */
import fs from "node:fs";
import path from "node:path";
import { AnterosError, ERROR_CODES } from "@anteros/shared";
import { decryptString, encryptString } from "../util/crypto.js";
import type { SourceLogger } from "../util/log.js";

const SAFE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

function assertSafe(kind: "pluginId" | "name", value: string): void {
  if (!SAFE_NAME.test(value) || value === "." || value === "..") {
    throw new AnterosError(ERROR_CODES.EINVALID, `非法的密钥${kind === "pluginId" ? "插件 id" : "名称"}：${value}`);
  }
}

/** 环境变量名：secrets 里写 wechat.token → 插件进程读到 ANTEROS_SECRET_WECHAT_TOKEN。 */
export function secretEnvName(name: string): string {
  return `ANTEROS_SECRET_${name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
}

export class SecretStore {
  private readonly root: string;
  private readonly key: Buffer | null;
  private readonly log: SourceLogger | null;
  private readonly cache = new Map<string, string>();

  /**
   * @param dataDir 用户数据目录（密钥文件在 dataDir/secrets/ 下）
   * @param masterKey 32 字节密钥材料；null 表示本会话无密钥（只读，写入直接拒绝）
   */
  constructor(dataDir: string, options: { masterKey?: Buffer | null; log?: SourceLogger } = {}) {
    this.root = path.join(dataDir, "secrets");
    this.key = options.masterKey ?? null;
    this.log = options.log ?? null;
    if (this.key === null) {
      this.log?.warn("未提供 master key：插件密钥库只读，无法写入新密钥");
    }
  }

  get(key: string): string | null;
  get(pluginId: string, name: string): string | null;
  get(pluginIdOrKey: string, name?: string): string | null {
    const cacheKey = name === undefined ? pluginIdOrKey : `${pluginIdOrKey}\u0000${name}`;
    if (name === undefined) return this.readRawCache(cacheKey);
    assertSafe("pluginId", pluginIdOrKey);
    assertSafe("name", name);
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;
    if (this.key === null) {
      this.log?.warn(`读取插件密钥失败（无 master key）：${pluginIdOrKey}/${name}`);
      return null;
    }
    const file = this.fileFor(pluginIdOrKey, name);
    let payload: string;
    try {
      payload = fs.readFileSync(file, "utf8").trim();
    } catch {
      return null;
    }
    try {
      const value = decryptString(this.key, payload);
      this.cache.set(cacheKey, value);
      return value;
    } catch {
      this.log?.warn(`插件密钥解密失败：${pluginIdOrKey}/${name}（master key 可能已更换）`);
      return null;
    }
  }

  /** 兼容单参数读法：get("pluginId/name")。 */
  private readRawCache(key: string): string | null {
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    const slash = key.indexOf("/");
    if (slash <= 0) return null;
    return this.get(key.slice(0, slash), key.slice(slash + 1));
  }

  set(pluginId: string, name: string, value: string): void {
    assertSafe("pluginId", pluginId);
    assertSafe("name", name);
    if (this.key === null) {
      throw new AnterosError(ERROR_CODES.EIO, "未配置本机 master key，无法保存插件密钥", {
        hint: "内核启动时应生成 ANTEROS_MASTER_KEY 并只注入子进程环境",
      });
    }
    const file = this.fileFor(pluginId, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, encryptString(this.key, value), { encoding: "utf8", mode: 0o600 });
    this.cache.delete(`${pluginId}\u0000${name}`);
    this.cache.delete(`${pluginId}/${name}`);
  }

  delete(pluginId: string, name: string): boolean {
    assertSafe("pluginId", pluginId);
    assertSafe("name", name);
    this.cache.delete(`${pluginId}\u0000${name}`);
    this.cache.delete(`${pluginId}/${name}`);
    try {
      fs.unlinkSync(this.fileFor(pluginId, name));
      return true;
    } catch {
      return false;
    }
  }

  has(pluginId: string, name: string): boolean {
    assertSafe("pluginId", pluginId);
    assertSafe("name", name);
    return fs.existsSync(this.fileFor(pluginId, name));
  }

  /** 列出某插件已存的密钥名（只有名字，没有值）。 */
  list(pluginId: string): string[] {
    assertSafe("pluginId", pluginId);
    const dir = this.dirFor(pluginId);
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".bin"))
        .map((entry) => entry.name.slice(0, -4))
        .sort();
    } catch {
      return [];
    }
  }

  /** 卸载插件时清掉它的密钥目录。 */
  removePlugin(pluginId: string): void {
    assertSafe("pluginId", pluginId);
    try {
      fs.rmSync(this.dirFor(pluginId), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${pluginId}\u0000`) || key.startsWith(`${pluginId}/`)) this.cache.delete(key);
    }
  }

  /** spawn 注入：只注入 manifest 声明且已存在的密钥。 */
  envFor(pluginId: string, names: readonly string[]): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of names) {
      const value = this.get(pluginId, name);
      if (value !== null) env[secretEnvName(name)] = value;
    }
    return env;
  }

  private dirFor(pluginId: string): string {
    return path.join(this.root, pluginId);
  }

  private fileFor(pluginId: string, name: string): string {
    return path.join(this.dirFor(pluginId), `${name}.bin`);
  }
}

/**
 * 本机密钥材料与对称加密。
 *
 * 威胁模型（单机、单用户）：防的是"数据文件被顺手拷走/云盘同步"与"日志泄漏"，
 * 不防拥有本机管理员权限的攻击者。真正的 DPAPI 需要原生扩展，v0.1 用
 * 「用户数据目录里的 master key + AES-256-GCM」：密钥文件只在当前 Windows 账户
 * 可读的目录内，明文密钥绝不进日志、不进数据库、不回传客户端。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AnterosError, ERROR_CODES } from "@anteros/shared";

const MASTER_KEY_FILE = "master.key";

export function loadOrCreateMasterKey(dataDir: string): Buffer {
  const fromEnv = process.env.ANTEROS_MASTER_KEY;
  if (fromEnv && /^[0-9a-f]{64}$/i.test(fromEnv.trim())) {
    return Buffer.from(fromEnv.trim(), "hex");
  }
  const file = path.join(dataDir, MASTER_KEY_FILE);
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  } catch {
    /* create below */
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, key.toString("hex"), { encoding: "utf8", mode: 0o600 });
  return key;
}

export function encryptString(key: Buffer, plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptString(key: Buffer, payload: string): string {
  try {
    const raw = Buffer.from(payload, "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    throw new AnterosError(ERROR_CODES.EIO, "密钥解密失败：本机 master key 可能已更换", {
      hint: "重新在设置里填写 API Key",
    });
  }
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function randomHex(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/** 本机"ip hash"：单机形态没有真实 IP，用安装 ID 代替，满足 consent 记录的字段语义。 */
export function localIpHash(installId: string): string {
  return sha256Hex(`local:${installId}`).slice(0, 32);
}
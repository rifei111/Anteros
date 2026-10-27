/**
 * 插件 manifest 校验 —— 对齐《工程规范 6 §2》。
 *
 * 规则（任何一条不满足都拒绝整份 manifest，并一次列全原因）：
 * - id 唯一由内核注册表保证，这里校验格式；
 * - kernel_api 的主版本必须等于内核主版本；
 * - permissions 必须是白名单模式子集（出现未知权限名整份拒绝，防拼写绕过）；
 * - risk_level=high 必须声明 resources 与 healthcheck；
 * - entry 只接受 command + args 数组，不接受 shell 字符串。
 */
import { z } from "zod";
import type { PluginKind, PluginRisk } from "./domain.js";

/** 插件对外提供的能力（规范 6 §3.1）。 */
export const CAPABILITIES = [
  "channel.read",
  "channel.write",
  "channel.media",
  "channel.lease",
  "channel.history",
  "llm.generate",
  "embedding.encode",
  "extract.memory",
  "media.speak",
  "media.image",
  "world.info",
  "ui.panel",
  "ops.host",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** 插件申请使用的权限（规范 6 §3.2）。带参数的模式单独校验。 */
export const PLAIN_PERMISSIONS = ["ui.foreground", "kernel.events", "kernel.config"] as const;

export const PARAMETERIZED_PERMISSIONS: Array<{ prefix: string; parameter: string; description: string }> = [
  { prefix: "fs.read:", parameter: "allowlist", description: "只读指定目录" },
  { prefix: "fs.write:", parameter: "allowlist", description: "写指定目录（仅自己的数据目录）" },
  { prefix: "proc.read:", parameter: "name", description: "读指定进程内存（高危，需二次确认）" },
  { prefix: "proc.patch:", parameter: "name", description: "写指定进程内存（仅通道插件，需二次确认）" },
  { prefix: "net.allow:", parameter: "host", description: "访问指定域名" },
  { prefix: "secrets.read:", parameter: "name", description: "读取内核注入的指定密钥" },
];

const KIND_VALUES = ["channel", "provider", "processor", "media", "world", "ui", "ops"] as const;
const RISK_VALUES = ["low", "medium", "high"] as const;

export const pluginManifestSchema = z.object({
  id: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9.-]*$/, "id 只能是小写字母、数字、点和连字符"),
  name: z.string().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+([-+].+)?$/, "version 必须是 semver"),
  kernel_api: z.string().min(1),
  kind: z.enum(KIND_VALUES),
  description: z.string().min(1).max(400),
  entry: z.object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
  }),
  capabilities: z.array(z.enum(CAPABILITIES)).default([]),
  permissions: z.array(z.string()).default([]),
  risk_level: z.enum(RISK_VALUES),
  config_schema: z.record(z.string(), z.unknown()).optional(),
  secrets: z.array(z.string().min(1)).optional(),
  /** 声明这个插件需要一份外部运行环境（由用户在内核里点下载安装，v0.5+）。 */
  runtime_env: z.boolean().optional(),
  resources: z
    .object({
      max_memory_mb: z.number().int().positive().optional(),
      max_cpu_pct: z.number().int().positive().max(100).optional(),
      call_timeout_ms: z.number().int().positive().optional(),
    })
    .optional(),
  healthcheck: z
    .object({
      method: z.string().min(1),
      interval_ms: z.number().int().positive().optional(),
      timeout_ms: z.number().int().positive().optional(),
    })
    .optional(),
  min_os: z.string().optional(),
  dev: z.boolean().optional(),
});

export type PluginManifestInput = z.input<typeof pluginManifestSchema>;

export interface ParsedPluginManifest {
  id: string;
  name: string;
  version: string;
  kernelApi: string;
  kind: PluginKind;
  description: string;
  entry: { command: string; args: string[] };
  capabilities: Capability[];
  permissions: string[];
  /** 需要外部运行环境（manifest runtime_env: true） */
  runtimeEnv: boolean;
  riskLevel: PluginRisk;
  configSchema?: Record<string, unknown>;
  secrets: string[];
  resources: { maxMemoryMb?: number; maxCpuPct?: number; callTimeoutMs?: number };
  healthcheck?: { method: string; intervalMs: number; timeoutMs: number };
  minOs?: string;
  dev: boolean;
}

export type ManifestValidation =
  | { ok: true; manifest: ParsedPluginManifest; warnings: string[] }
  | { ok: false; errors: string[] };

export interface ValidateManifestOptions {
  /** 内核当前主版本，如 "1" */
  kernelApiMajor: string;
  /** 生产构建拒绝 dev 插件（规范 6 §11.2） */
  production?: boolean;
}

export function kernelApiMajor(versionRange: string): string | null {
  const match = versionRange.match(/(\d+)(?:\.\d+)?/);
  return match && match[1] ? match[1] : null;
}

export function permissionPattern(permission: string): string | null {
  if ((PLAIN_PERMISSIONS as readonly string[]).includes(permission)) return permission;
  for (const item of PARAMETERIZED_PERMISSIONS) {
    if (permission.startsWith(item.prefix) && permission.length > item.prefix.length) return item.prefix;
  }
  return null;
}

/** 按规范 6 §2.2 校验 manifest；失败时一次列出全部原因。 */
export function validateManifest(raw: unknown, options: ValidateManifestOptions): ManifestValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const parsed = pluginManifestSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      errors.push(`${path}: ${issue.message}`);
    }
    return { ok: false, errors };
  }

  const data = parsed.data;

  // kernel_api 主版本必须匹配
  const major = kernelApiMajor(data.kernel_api);
  if (!major) {
    errors.push(`kernel_api 无法解析版本号: ${data.kernel_api}`);
  } else if (major !== options.kernelApiMajor) {
    errors.push(`kernel_api 主版本不匹配: 插件要求 ${data.kernel_api}，内核为 ${options.kernelApiMajor}.x`);
  }

  // 权限白名单
  for (const permission of data.permissions) {
    if (permissionPattern(permission) === null) {
      errors.push(`未知权限: ${permission}（整份 manifest 拒绝，防止拼写绕过）`);
    }
  }

  // 高危插件必须有可观测与限流声明
  if (data.risk_level === "high") {
    if (!data.resources) errors.push("高危插件必须声明 resources（内存/CPU/调用超时上限）");
    if (!data.healthcheck) errors.push("高危插件必须声明 healthcheck（否则无法一键停用与降级）");
  }

  // 通道插件声明写能力时，必须同时声明租约能力
  if (data.capabilities.includes("channel.write") && !data.capabilities.includes("channel.lease")) {
    errors.push("声明 channel.write 的插件必须同时声明 channel.lease（写动作必须持租约）");
  }

  if (data.dev) {
    if (options.production) {
      errors.push("生产构建不允许加载 dev 插件（未签名）");
    } else {
      warnings.push("dev 插件：仅开发模式可加载");
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    warnings,
    manifest: {
      id: data.id,
      name: data.name,
      version: data.version,
      kernelApi: data.kernel_api,
      kind: data.kind,
      description: data.description,
      entry: { command: data.entry.command, args: data.entry.args ?? [] },
      capabilities: data.capabilities,
    runtimeEnv: data.runtime_env === true,
      permissions: data.permissions,
      riskLevel: data.risk_level,
      configSchema: data.config_schema,
      secrets: data.secrets ?? [],
      resources: {
        maxMemoryMb: data.resources?.max_memory_mb,
        maxCpuPct: data.resources?.max_cpu_pct,
        callTimeoutMs: data.resources?.call_timeout_ms,
      },
      healthcheck: data.healthcheck
        ? {
            method: data.healthcheck.method,
            intervalMs: data.healthcheck.interval_ms ?? 30_000,
            timeoutMs: data.healthcheck.timeout_ms ?? 5_000,
          }
        : undefined,
      minOs: data.min_os,
      dev: data.dev ?? false,
    },
  };
}

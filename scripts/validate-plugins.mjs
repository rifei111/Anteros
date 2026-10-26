#!/usr/bin/env node
/**
 * scripts/validate-plugins.mjs —— 校验 plugins/ 下每个 plugin.json。
 *
 * 设计取舍（重要）：
 * 1. **唯一真源是 packages/shared/src/manifest.ts**。为了不在脚本里复制一遍规则，
 *    优先从 `packages/shared/dist/manifest.js` 动态 import `validateManifest`
 *    （需要先 `npm run build:shared`）。CI 里 build 步骤会产出 dist，所以这条路径
 *    是主路径；本地刚克隆没构建时，脚本会自动回退到"与 manifest.ts 对齐"的最小校验，
 *    并明确提示"建议先构建 shared"，而不是直接崩掉。
 * 2. 回退校验只覆盖 manifest.ts 的 schema 与三条语义规则（kernel_api 主版本、
 *    权限白名单、high 必须 resources+healthcheck、channel.write 必须 channel.lease），
 *    字段清单若有更新必须同步；脚本会在 dist 存在时自动使用真源，降低漂移风险。
 * 3. 内置插件额外约定（shared schema 不表达、由宿主读原始 JSON）：
 *    - `enabled` 必须是布尔；高危插件必须 false（默认禁用）；
 *    - 7 个内置插件必须存在，且 kind/risk/capabilities 与草案 14.14.2 清单一致；
 *    - entry 必须是插件目录内的相对文件（宿主按 path.join(pluginDir, command) 解析，
 *      绝对路径会逃出目录，必须在此拒绝）；
 *    - 高危通道插件不得出现内存补丁/注入类原生调用（红线，草案 14.6/14.7）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_DIR = path.join(ROOT, "plugins");
const SHARED_DIST = path.join(ROOT, "packages", "shared", "dist", "manifest.js");
const SHARED_SRC = path.join(ROOT, "packages", "shared", "src", "manifest.ts");

const KERNEL_API_MAJOR = "1";

/** 草案 14.14.2 的内置插件清单（存在性与关键字段的硬约束）。 */
const REQUIRED_BUILTINS = {
  "core.llm-router": {
    kind: "provider",
    risk: "medium",
    enabled: false,
    capabilities: ["llm.generate"],
    permissions: ["kernel.config", "secrets.read:llm.api_key"],
  },
  "core.memory-extract": {
    kind: "processor",
    risk: "low",
    enabled: true,
    capabilities: ["extract.memory"],
    permissions: [],
  },
  "core.media": {
    kind: "media",
    risk: "medium",
    enabled: true,
    capabilities: ["media.speak", "media.image"],
    permissions: ["kernel.config", "secrets.read:media.api_key"],
  },
  "core.world-info": {
    kind: "world",
    risk: "low",
    enabled: true,
    capabilities: ["world.info"],
    permissions: ["kernel.config", "net.allow:api.open-meteo.com"],
  },
  "core.tray-notify": {
    kind: "channel",
    risk: "low",
    enabled: true,
    capabilities: [],
    permissions: [],
  },
  "core.dashboard": {
    kind: "ui",
    risk: "low",
    enabled: true,
    capabilities: ["ui.panel"],
    permissions: ["kernel.config"],
  },
  "channel.wechat-replica": {
    kind: "channel",
    risk: "high",
    enabled: false,
    capabilities: ["channel.read", "channel.history", "channel.write", "channel.lease", "channel.media"],
    permissions: ["proc.read:Weixin.exe", "proc.patch:Weixin.exe", "ui.foreground"],
    // fs.read:<本机微信数据目录> 的路径因机器而异，这里只要求存在一条 fs.read: 声明
    permissionsPrefix: ["fs.read:"],
  },
};

/** 红线：插件代码里不应出现这些原生调用（内存补丁/注入）。 */
const FORBIDDEN_CODE_TOKENS = [
  "WriteProcessMemory",
  "ReadProcessMemory",
  "CreateRemoteThread",
  "VirtualAllocEx",
  "NtWriteVirtualMemory",
  "NtReadVirtualMemory",
  "SetWindowsHookEx",
  "QueueUserAPC",
];

/** 回退校验用：与 packages/shared/src/manifest.ts 对齐（v0.1）。 */
const CAPABILITIES = [
  "channel.read", "channel.write", "channel.media", "channel.lease", "channel.history",
  "llm.generate", "embedding.encode", "extract.memory", "media.speak", "media.image",
  "world.info", "ui.panel", "ops.host",
];
const PLAIN_PERMISSIONS = ["ui.foreground", "kernel.events", "kernel.config"];
const PARAMETERIZED_PERMISSION_PREFIXES = [
  "fs.read:", "fs.write:", "proc.read:", "proc.patch:", "net.allow:", "secrets.read:",
];
const KINDS = ["channel", "provider", "processor", "media", "world", "ui", "ops"];
const RISKS = ["low", "medium", "high"];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function permissionAllowed(permission) {
  if (PLAIN_PERMISSIONS.includes(permission)) return true;
  return PARAMETERIZED_PERMISSION_PREFIXES.some(
    (prefix) => permission.startsWith(prefix) && permission.length > prefix.length,
  );
}

/** 与 manifest.ts 的 validateManifest 同规则的最小实现（dist 缺失时使用）。 */
function fallbackValidateManifest(raw, options) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(raw)) return { ok: false, errors: ["(root): manifest 必须是 JSON 对象"] };

  if (typeof raw.id !== "string" || !/^[a-z0-9][a-z0-9.-]*$/.test(raw.id) || raw.id.length < 3 || raw.id.length > 64) {
    errors.push("id: 必须是小写字母/数字/点/连字符，长度 3-64");
  }
  if (typeof raw.name !== "string" || raw.name.length < 1 || raw.name.length > 80) {
    errors.push("name: 必须是 1-80 字符的字符串");
  }
  if (typeof raw.version !== "string" || !/^\d+\.\d+\.\d+([-+].+)?$/.test(raw.version)) {
    errors.push("version: 必须是 semver（如 0.1.0）");
  }
  if (typeof raw.kernel_api !== "string" || raw.kernel_api.length === 0) {
    errors.push("kernel_api: 必须是非空字符串");
  } else {
    const major = raw.kernel_api.match(/(\d+)(?:\.\d+)?/)?.[1];
    if (!major) errors.push(`kernel_api: 无法解析版本号 ${raw.kernel_api}`);
    else if (major !== options.kernelApiMajor) {
      errors.push(`kernel_api: 主版本不匹配（插件 ${raw.kernel_api}，内核 ${options.kernelApiMajor}.x）`);
    }
  }
  if (!KINDS.includes(raw.kind)) errors.push(`kind: 必须是 ${KINDS.join("/")}`);
  if (typeof raw.description !== "string" || raw.description.length < 1 || raw.description.length > 400) {
    errors.push("description: 必须是 1-400 字符的字符串");
  }
  if (!isPlainObject(raw.entry)) {
    errors.push("entry: 必须是对象");
  } else {
    if (typeof raw.entry.command !== "string" || raw.entry.command.length === 0) {
      errors.push("entry.command: 必须是非空字符串（相对插件目录）");
    }
    if (raw.entry.args !== undefined && !Array.isArray(raw.entry.args)) errors.push("entry.args: 必须是字符串数组");
  }
  const capabilities = raw.capabilities ?? [];
  if (!Array.isArray(capabilities)) {
    errors.push("capabilities: 必须是数组");
  } else {
    for (const capability of capabilities) {
      if (!CAPABILITIES.includes(capability)) errors.push(`capabilities: 未知能力 ${String(capability)}`);
    }
    if (capabilities.includes("channel.write") && !capabilities.includes("channel.lease")) {
      errors.push("capabilities: 声明 channel.write 必须同时声明 channel.lease");
    }
  }
  const permissions = raw.permissions ?? [];
  if (!Array.isArray(permissions)) {
    errors.push("permissions: 必须是数组");
  } else {
    for (const permission of permissions) {
      if (typeof permission !== "string") errors.push("permissions: 每一项必须是字符串");
      else if (!permissionAllowed(permission)) errors.push(`permissions: 未知权限 ${permission}（整份拒绝）`);
    }
  }
  if (!RISKS.includes(raw.risk_level)) {
    errors.push(`risk_level: 必须是 ${RISKS.join("/")}`);
  } else if (raw.risk_level === "high") {
    if (!isPlainObject(raw.resources)) errors.push("高危插件必须声明 resources");
    if (!isPlainObject(raw.healthcheck)) errors.push("高危插件必须声明 healthcheck");
  }
  if (raw.healthcheck !== undefined) {
    if (!isPlainObject(raw.healthcheck) || typeof raw.healthcheck.method !== "string" || !raw.healthcheck.method) {
      errors.push("healthcheck.method: 必须是非空字符串");
    }
  }
  if (raw.dev === true && options.production) errors.push("生产构建不允许 dev 插件");
  else if (raw.dev === true) warnings.push("dev 插件：仅开发模式可加载");

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    warnings,
    manifest: {
      id: raw.id,
      name: raw.name,
      version: raw.version,
      kernelApi: raw.kernel_api,
      kind: raw.kind,
      description: raw.description,
      entry: { command: raw.entry.command, args: raw.entry.args ?? [] },
      capabilities,
      permissions,
      riskLevel: raw.risk_level,
      configSchema: raw.config_schema,
      secrets: raw.secrets ?? [],
      resources: raw.resources ?? {},
      healthcheck: isPlainObject(raw.healthcheck)
        ? {
            method: raw.healthcheck.method,
            intervalMs: raw.healthcheck.interval_ms ?? 30_000,
            timeoutMs: raw.healthcheck.timeout_ms ?? 5_000,
          }
        : undefined,
      minOs: raw.min_os,
      dev: raw.dev ?? false,
    },
  };
}

async function loadValidator() {
  if (fs.existsSync(SHARED_DIST)) {
    const mod = await import(pathToFileURL(SHARED_DIST).href);
    if (typeof mod.validateManifest !== "function") {
      throw new Error(`packages/shared/dist/manifest.js 未导出 validateManifest，请重新 npm run build:shared`);
    }
    if (fs.existsSync(SHARED_SRC)) {
      const srcMtime = fs.statSync(SHARED_SRC).mtimeMs;
      const distMtime = fs.statSync(SHARED_DIST).mtimeMs;
      if (srcMtime > distMtime + 1_000) {
        console.warn("⚠ packages/shared/src/manifest.ts 比 dist 新，dist 可能过期；建议先 npm run build:shared");
      }
    }
    return { validate: mod.validateManifest, source: "packages/shared/dist/manifest.js（唯一真源）" };
  }
  console.warn("⚠ 未找到 packages/shared/dist/manifest.js，回退到最小校验（与 manifest.ts 对齐）。");
  console.warn("  建议先运行：npm run build:shared");
  return { validate: fallbackValidateManifest, source: "fallback（与 packages/shared/src/manifest.ts 对齐）" };
}

function scanForbiddenCode(pluginDir) {
  const hits = [];
  const stack = [pluginDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!/\.(mjs|cjs|js|ts)$/.test(entry.name)) continue;
      const content = fs.readFileSync(full, "utf8");
      for (const token of FORBIDDEN_CODE_TOKENS) {
        if (content.includes(token)) hits.push(`${path.relative(ROOT, full)} 含 ${token}`);
      }
    }
  }
  return hits;
}

function validateEntryPath(pluginDir, manifest, errors) {
  if (!manifest?.entry?.command) return;
  const command = manifest.entry.command;
  if (path.isAbsolute(command) || /^[a-zA-Z]:[\\/]/.test(command)) {
    errors.push(`entry.command 必须是相对插件目录的路径，不能是绝对路径：${command}`);
    return;
  }
  const resolved = path.resolve(pluginDir, command);
  const relative = path.relative(pluginDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    errors.push(`entry.command 逃出了插件目录：${command}`);
    return;
  }
  if (!fs.existsSync(resolved)) {
    errors.push(`entry.command 指向的入口文件不存在：${path.relative(ROOT, resolved)}`);
    return;
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) errors.push(`entry.command 不是文件：${command}`);
}

function mainSync() {
  return { async run() {
    const { validate, source } = await loadValidator();
    if (!fs.existsSync(PLUGINS_DIR)) {
      console.error(`✖ 找不到 plugins 目录：${PLUGINS_DIR}`);
      return 1;
    }

    const pluginDirs = fs
      .readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();

    const results = [];
    const globalErrors = [];
    const warnings = [];

    for (const dirName of pluginDirs) {
      const pluginDir = path.join(PLUGINS_DIR, dirName);
      const manifestPath = path.join(pluginDir, "plugin.json");
      const errors = [];
      const localWarnings = [];
      const raw = (() => {
        if (!fs.existsSync(manifestPath)) {
          errors.push("缺少 plugin.json");
          return null;
        }
        try {
          return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        } catch (err) {
          errors.push(`plugin.json 不是合法 JSON：${err.message}`);
          return null;
        }
      })();

      let manifest = null;
      if (raw) {
        const result = validate(raw, { kernelApiMajor: KERNEL_API_MAJOR, production: false });
        if (!result.ok) {
          errors.push(...result.errors);
        } else {
          manifest = result.manifest;
          localWarnings.push(...result.warnings);
          if (raw.id !== dirName) errors.push(`manifest id(${raw.id}) 与目录名(${dirName}) 不一致`);
          if (typeof raw.enabled !== "boolean") {
            errors.push("内置插件必须在 plugin.json 显式声明 enabled: boolean（宿主读原始 JSON，shared schema 会 strip）");
          }
          if (manifest.riskLevel === "high" && raw.enabled !== false) {
            errors.push("高危插件必须默认禁用：risk_level=high 时 enabled 必须为 false");
          }
          validateEntryPath(pluginDir, manifest, errors);
          const forbidden = scanForbiddenCode(pluginDir);
          if (forbidden.length > 0) errors.push(...forbidden.map((hit) => `红线：${hit}`));
        }
      }

      // 内置清单硬约束
      const expected = REQUIRED_BUILTINS[dirName];
      if (expected && manifest) {
        if (manifest.kind !== expected.kind) errors.push(`kind 应为 ${expected.kind}，实际 ${manifest.kind}`);
        if (manifest.riskLevel !== expected.risk) errors.push(`risk_level 应为 ${expected.risk}，实际 ${manifest.riskLevel}`);
        if (raw.enabled !== expected.enabled) errors.push(`enabled 应为 ${expected.enabled}（草案 14.14.2）`);
        const actualCaps = [...manifest.capabilities].sort().join(",");
        const expectedCaps = [...expected.capabilities].sort().join(",");
        if (actualCaps !== expectedCaps) errors.push(`capabilities 应为 [${expected.capabilities.join(",")}]，实际 [${manifest.capabilities.join(",")}]`);
        for (const permission of expected.permissions) {
          if (!manifest.permissions.includes(permission)) errors.push(`缺少必需权限：${permission}`);
        }
        for (const prefix of expected.permissionsPrefix ?? []) {
          if (!manifest.permissions.some((permission) => permission.startsWith(prefix))) {
            errors.push(`缺少 ${prefix} 权限声明`);
          }
        }
      }

      if (manifest) {
        const dupCaps = manifest.capabilities.filter((cap, index) => manifest.capabilities.indexOf(cap) !== index);
        if (dupCaps.length > 0) errors.push(`capabilities 有重复项：${dupCaps.join(",")}`);
        const dupPerms = manifest.permissions.filter((perm, index) => manifest.permissions.indexOf(perm) !== index);
        if (dupPerms.length > 0) errors.push(`permissions 有重复项：${dupPerms.join(",")}`);
      }

      results.push({ dirName, manifest, raw, errors, warnings: localWarnings });
    }

    // 必选插件是否存在
    const found = new Set(results.map((item) => item.dirName));
    for (const id of Object.keys(REQUIRED_BUILTINS)) {
      if (!found.has(id)) globalErrors.push(`缺少内置插件：plugins/${id}/plugin.json`);
    }

    // 输出
    console.log(`Anteros 插件校验（验证器：${source}）\n`);
    let failures = 0;
    for (const item of results) {
      const ok = item.errors.length === 0;
      if (!ok) failures += 1;
      const mark = ok ? "✔" : "✖";
      if (item.manifest) {
        const caps = item.manifest.capabilities.length > 0 ? item.manifest.capabilities.join(",") : "无";
        console.log(
          `${mark} ${item.dirName}  ${item.manifest.kind}/${item.manifest.riskLevel}  enabled=${String(item.raw.enabled)}  caps=[${caps}]`,
        );
      } else {
        console.log(`${mark} ${item.dirName}  (manifest 不可用)`);
      }
      for (const warning of item.warnings) console.log(`   ⚠ ${warning}`);
      for (const error of item.errors) console.log(`   - ${error}`);
    }
    for (const error of globalErrors) console.log(`✖ ${error}`);
    for (const warning of warnings) console.log(`⚠ ${warning}`);

    const total = results.length;
    const failed = failures + (globalErrors.length > 0 ? 1 : 0);
    console.log(
      `\n共 ${total} 个插件，通过 ${total - failures}，失败 ${failed}。` +
        (failed === 0 ? "（高危插件默认禁用、入口与红线检查均通过）" : ""),
    );
    return failed === 0 ? 0 : 1;
  } };
}

const code = await mainSync().run();
process.exitCode = code;

#!/usr/bin/env node
/**
 * Anteros 打包自检（不依赖 electron-builder 的目录打包流程）。
 *
 * 分两段检查：
 * 1) 仓库产物：客户端 out/{main,preload,renderer}、内核 dist/kernel.mjs、7 个内置插件
 *    （每个 plugin.json 可解析且 id 与目录名一致、entry 指向的文件存在）、
 *    electron-builder.yml 里 extraResources / 图标 / license 指向的路径存在。
 * 2) 安装包（release/）：Anteros-Setup-*.exe 是否存在、体积是否合理，
 *    以及安装包内容是否含 resources/kernel/kernel.mjs 与 resources/plugins/<id>/plugin.json。
 *    exe 内容优先看 release/win-unpacked（electron-builder 的中间产物）。
 *    没有 win-unpacked 时，若本机有 7z 就列 exe 内容近似检查；两者都没有则只警告、不失败。
 *
 * 用法：
 *   node scripts/package-check.mjs                 # 完整检查，缺安装包即失败
 *   node scripts/package-check.mjs --repo-only     # 只检查仓库产物（安装包尚未构建时用）
 *   node scripts/package-check.mjs --allow-missing-installer
 *
 * 退出码：0 = 通过（允许有警告）；1 = 有错误。所有失败都输出可读原因，不抛栈。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientDir = path.join(repoRoot, "packages", "client");
const argv = new Set(process.argv.slice(2));
const repoOnly = argv.has("--repo-only");
const allowMissingInstaller = repoOnly || argv.has("--allow-missing-installer");

const REQUIRED_PLUGINS = [
  "core.dashboard",
  "core.llm-router",
  "core.media",
  "core.memory-extract",
  "core.tray-notify",
  "core.world-info",
];

const checks = [];
function ok(label, detail = "") {
  checks.push({ level: "ok", label, detail });
}
function warn(label, detail = "") {
  checks.push({ level: "warn", label, detail });
}
function err(label, detail = "") {
  checks.push({ level: "error", label, detail });
}
function rel(p) {
  return path.relative(repoRoot, p).replaceAll("\\", "/");
}
function exists(p) {
  try {
    return fs.statSync(p).isFile() || fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
function listDirs(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- 1. 仓库产物
function checkRepoArtifacts() {
  const clientOut = path.join(clientDir, "out");
  // Electron 45 的 ESM 主进程对具名导出不兼容，主进程/preload 走 CJS（.cjs）输出；
  // 兼容历史 .js 产物，两种后缀哪个存在算哪个。
  const requiredOut = [
    ["main", ["index.cjs", "index.js"]],
    ["preload", ["index.cjs", "index.js"]],
    ["renderer", ["index.html"]],
  ];
  for (const [name, candidates] of requiredOut) {
    const dir = path.join(clientOut, name);
    const found = candidates.map((file) => path.join(dir, file)).find((file) => exists(file));
    if (found) ok(`客户端产物 out/${name}`, rel(found));
    else err(`客户端产物 out/${name} 缺失`, `先运行 npm.cmd run build:client（期望 ${rel(path.join(dir, candidates[0]))}）`);
  }

  const kernelFile = path.join(repoRoot, "packages", "kernel", "dist", "kernel.mjs");
  if (exists(kernelFile)) ok("内核产物 kernel.mjs", `${rel(kernelFile)}（${(fs.statSync(kernelFile).size / 1024).toFixed(0)} KB）`);
  else err("内核产物 kernel.mjs 缺失", "先运行 npm.cmd run build:kernel");

  const pluginsDir = path.join(repoRoot, "plugins");
  const present = new Set(listDirs(pluginsDir).filter((d) => !d.startsWith("_")));
  for (const id of REQUIRED_PLUGINS) {
    if (!present.has(id)) {
      err(`内置插件 ${id} 缺失`, `应在 ${rel(path.join(pluginsDir, id))}/plugin.json`);
    }
  }
  for (const dir of present) {
    const manifestPath = path.join(pluginsDir, dir, "plugin.json");
    if (!exists(manifestPath)) {
      err(`插件 ${dir} 缺少 plugin.json`, rel(manifestPath));
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(readText(manifestPath));
    } catch (e) {
      err(`插件 ${dir} 的 plugin.json 不是合法 JSON`, String(e && e.message ? e.message : e));
      continue;
    }
    if (manifest.id !== dir) {
      err(`插件目录名与 manifest.id 不一致：${dir}`, `manifest.id = ${JSON.stringify(manifest.id)}`);
    }
    const command = manifest?.entry?.command;
    if (typeof command !== "string") {
      err(`插件 ${dir} 缺少 entry.command`, "manifest.entry.command 必须是入口 .mjs");
    } else if (!exists(path.join(pluginsDir, dir, command))) {
      err(`插件 ${dir} 的 entry 文件不存在`, `${rel(path.join(pluginsDir, dir, command))}`);
    } else {
      ok(`插件 ${dir}`, `${manifest.kind}/${manifest.risk_level} enabled=${String(manifest.enabled)}`);
    }
  }

  checkBuilderConfig();
}

/** 最小解析 electron-builder.yml（只取本检查关心的字段，不引 YAML 依赖）。 */
function parseBuilderConfig(text) {
  const config = { extraResources: [], winIcon: null, installerIcon: null, license: null, buildResources: "build", output: null };
  let section = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    const top = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (top) {
      section = top[1];
      continue;
    }
    if (section === "directories") {
      const m = /^\s+buildResources:\s*(.+)$/.exec(line);
      if (m) config.buildResources = unquote(m[1]);
      const o = /^\s+output:\s*(.+)$/.exec(line);
      if (o) config.output = unquote(o[1]);
    } else if (section === "extraResources") {
      const m = /^\s*-\s*from:\s*(.+)$/.exec(line) ?? /^\s+from:\s*(.+)$/.exec(line);
      if (m) config.extraResources.push(unquote(m[1]));
    } else if (section === "win") {
      const m = /^\s+icon:\s*(.+)$/.exec(line);
      if (m) config.winIcon = unquote(m[1]);
    } else if (section === "nsis") {
      const m = /^\s+(installerIcon|uninstallerIcon):\s*(.+)$/.exec(line);
      if (m) config.installerIcon = unquote(m[2]);
      const lic = /^\s+license:\s*(.+)$/.exec(line);
      if (lic) config.license = unquote(lic[1]);
    }
  }
  return config;
}
function unquote(v) {
  return v.trim().replace(/^['"]|['"]$/g, "");
}

function checkBuilderConfig() {
  const configPath = path.join(clientDir, "electron-builder.yml");
  if (!exists(configPath)) {
    err("electron-builder.yml 缺失", rel(configPath));
    return;
  }
  const config = parseBuilderConfig(readText(configPath) ?? "");
  if (config.extraResources.length === 0) {
    err("electron-builder.yml 未声明 extraResources", "安装包将不会带内核与插件");
  }
  for (const from of config.extraResources) {
    const abs = path.resolve(clientDir, from);
    if (exists(abs)) ok(`extraResources 源路径存在`, `${from} → ${rel(abs)}`);
    else err(`extraResources 源路径不存在`, `${from}（解析为 ${rel(abs)}）`);
  }
  // 注意：win.icon / nsis.*Icon 由 electron-builder 相对 app 目录（packages/client）解析，
  // 不是相对 buildResources；写成 build/icon.ico 才是 packages/client/build/icon.ico。
  for (const [label, value] of [
    ["win.icon", config.winIcon],
    ["nsis.installerIcon", config.installerIcon],
  ]) {
    if (!value) {
      warn(`electron-builder.yml 未配置 ${label}`, "");
      continue;
    }
    const abs = path.resolve(clientDir, value);
    if (exists(abs)) ok(`${label} 存在`, value);
    else err(`${label} 指向的文件不存在`, `${value}（解析为 ${rel(abs)}）`);
  }
  if (config.license) {
    const abs = path.resolve(clientDir, config.license);
    if (exists(abs)) ok("nsis.license 存在", rel(abs));
    else err("nsis.license 指向的文件不存在", `${config.license} → ${rel(abs)}（需要仓库根 LICENSE，或删掉该配置）`);
  } else {
    warn("electron-builder.yml 未声明 nsis.license", "安装器不会显示许可页");
  }
}

// ---------------------------------------------------------------- 2. 安装包
function findInstaller() {
  const releaseDir = path.join(repoRoot, "release");
  if (!exists(releaseDir)) return { releaseDir, installer: null };
  let names = [];
  try {
    names = fs.readdirSync(releaseDir).filter((n) => /^Anteros-Setup-.*\.exe$/i.test(n));
  } catch {
    names = [];
  }
  if (names.length === 0) return { releaseDir, installer: null };
  names.sort();
  const file = path.join(releaseDir, names[names.length - 1]);
  return { releaseDir, installer: file };
}

function checkInstaller() {
  if (repoOnly) {
    warn("跳过安装包检查", "使用了 --repo-only（安装包尚未构建时正常）");
    return;
  }
  const { releaseDir, installer } = findInstaller();
  if (!installer) {
    if (allowMissingInstaller) {
      warn("安装包尚未构建", "release/ 下没有 Anteros-Setup-*.exe；正式校验请先 npm.cmd run package -w @anteros/client");
    } else {
      err("安装包缺失", "release/ 下没有 Anteros-Setup-*.exe；先运行 npm.cmd run package -w @anteros/client，或加 --allow-missing-installer");
    }
    return;
  }
  const size = fs.statSync(installer).size;
  ok("安装包存在", `${rel(installer)}（${(size / 1024 / 1024).toFixed(1)} MB）`);
  if (size < 20 * 1024 * 1024) {
    warn("安装包体积偏小", "小于 20 MB，可能缺少内核/插件资源；确认 extraResources 是否打进包内");
  }

  checkUpdateArtifacts(releaseDir, installer);

  const winUnpacked = path.join(releaseDir, "win-unpacked");
  if (exists(winUnpacked)) {
    checkUnpacked(winUnpacked);
    return;
  }

  const sevenZip = spawnSync("7z", ["i"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  if (sevenZip.error || sevenZip.status !== 0) {
    warn("无法检查安装包内容", "没有 release/win-unpacked，且本机没有可用的 7z；跳过 resources 内容检查（不判失败）");
    return;
  }
  const list = spawnSync("7z", ["l", installer], { encoding: "utf8", timeout: 20000, windowsHide: true });
  if (list.error || list.status !== 0) {
    warn("7z 无法列出安装包内容", String(list.error?.message ?? list.stderr ?? list.status));
    return;
  }
  const text = list.stdout ?? "";
  checkInstallerEntries((needle) => text.includes(needle), "exe/7z");
}

function checkUnpacked(winUnpacked) {
  const resources = path.join(winUnpacked, "resources");
  checkInstallerEntries(
    (needle) => exists(path.join(resources, ...needle.split("/"))),
    "release/win-unpacked",
  );
}

/**
 * 应用内更新产物自检（electron-updater 依赖三件套）：
 * latest.yml（版本 + 文件名 + sha512）、安装包的 .blockmap（差分更新基础）、resources/app-update.yml（运行期读取的发布源）。
 */
function checkUpdateArtifacts(releaseDir, installer) {
  const latest = path.join(releaseDir, "latest.yml");
  if (!exists(latest)) {
    err("latest.yml 缺失", "electron-updater 靠它判断新版本；确认 electron-builder.yml 里有 publish（github）配置后重新打包");
    return;
  }
  const text = readText(latest) ?? "";
  const version = (text.match(/^version:\s*(.+)$/m)?.[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
  const filePath = (text.match(/^path:\s*(.+)$/m)?.[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
  const sha512 = (text.match(/^sha512:\s*(.+)$/m)?.[1] ?? "").trim();
  const installerName = path.basename(installer);

  if (!version) err("latest.yml 缺少 version 字段", rel(latest));
  else ok("latest.yml 版本", version);
  if (!filePath) err("latest.yml 缺少 path 字段", rel(latest));
  else if (path.basename(filePath) !== installerName) {
    // 允许 release 目录里同时躺着旧版安装包：只有最新那个才该被 latest.yml 指向
    err(
      "latest.yml 的 path 与最新安装包不一致",
      `latest.yml 指向 ${filePath}，但 release 里最新的安装包是 ${installerName}；先清掉旧安装包或重新打包`,
    );
  } else ok("latest.yml 指向当前安装包", filePath);
  if (!sha512) err("latest.yml 缺少 sha512", "没有校验值的更新包不会被安装器接受");
  else if (sha512.length < 40) warn("latest.yml 的 sha512 看起来太短", `长度 ${sha512.length}`);
  else ok("latest.yml 带 sha512 校验", `${sha512.slice(0, 16)}…`);

  const expectedVersioned = `Anteros-Setup-${version}-x64.exe`;
  if (version && installerName !== expectedVersioned) {
    warn("安装包文件名与 latest.yml 版本不一致", `期望 ${expectedVersioned}，实际 ${installerName}`);
  }

  const blockmap = `${installer}.blockmap`;
  if (exists(blockmap)) ok("差分更新 blockmap 存在", path.basename(blockmap));
  else err("缺少 .blockmap", "没有它 electron-updater 只能整包下载，增量更新失效");

  const appUpdateYml = path.join(releaseDir, "win-unpacked", "resources", "app-update.yml");
  if (!exists(path.join(releaseDir, "win-unpacked"))) {
    warn("跳过 app-update.yml 检查", "没有 release/win-unpacked");
  } else if (exists(appUpdateYml)) {
    const cfg = readText(appUpdateYml) ?? "";
    const provider = (cfg.match(/^provider:\s*(.+)$/m)?.[1] ?? "").trim();
    const owner = (cfg.match(/^owner:\s*(.+)$/m)?.[1] ?? "").trim();
    const repo = (cfg.match(/^repo:\s*(.+)$/m)?.[1] ?? "").trim();
    if (!provider || !owner || !repo) err("app-update.yml 字段不全", `provider=${provider || "?"} owner=${owner || "?"} repo=${repo || "?"}`);
    else ok("app-update.yml 发布源", `${provider}:${owner}/${repo}`);
  } else {
    err("缺少 resources/app-update.yml", "打包时没生成更新配置，应用内检查更新会永远失败");
  }
}

function checkInstallerEntries(predicate, where) {
  const kernelNeedle = "kernel/kernel.mjs";
  if (predicate(kernelNeedle)) ok(`安装包内含内核（${where}）`, kernelNeedle);
  else err(`安装包内缺少内核（${where}）`, "检查 extraResources: ../kernel/dist → kernel");

  let pluginCount = 0;
  for (const id of REQUIRED_PLUGINS) {
    if (predicate(`plugins/${id}/plugin.json`)) pluginCount += 1;
    else err(`安装包内缺少插件 ${id}（${where}）`, `期望 plugins/${id}/plugin.json`);
  }
  if (pluginCount === REQUIRED_PLUGINS.length) {
    ok(`安装包内含 ${pluginCount} 个内置插件（${where}）`, "resources/plugins/<id>/plugin.json");
  }

  // v0.7.0：微信通道改成软件本体自带的能力，旁路进程（Python sidecar）随包走
  if (predicate("integrations/wechatauto-sidecar/sidecar.py")) {
    ok(`安装包内含内置微信通道的旁路进程（${where}）`, "resources/integrations/wechatauto-sidecar/sidecar.py");
  } else {
    err(`安装包内缺少内置微信通道的旁路进程（${where}）`, "检查 extraResources: ../../integrations → integrations");
  }
}

// ---------------------------------------------------------------- 主流程
checkRepoArtifacts();
checkInstaller();

const errors = checks.filter((c) => c.level === "error");
const warnings = checks.filter((c) => c.level === "warn");
for (const c of checks) {
  const mark = c.level === "ok" ? "✔" : c.level === "warn" ? "⚠" : "✖";
  console.log(`${mark} ${c.label}${c.detail ? `：${c.detail}` : ""}`);
}
console.log("");
console.log(`[package-check] ${checks.length - warnings.length - errors.length} 通过，${warnings.length} 警告，${errors.length} 错误`);
if (errors.length > 0) {
  console.error("[package-check] 失败：先修复上面的错误再打包。");
  process.exitCode = 1;
} else {
  console.log("[package-check] 通过。");
}

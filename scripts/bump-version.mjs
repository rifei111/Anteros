#!/usr/bin/env node
/**
 * 统一改版本号：四个 package.json + shared 里的 KERNEL_VERSION 一次性对齐。
 *
 * 用法：
 *   node scripts/bump-version.mjs 0.6.0          # 写入新版本
 *   node scripts/bump-version.mjs --print        # 只打印当前各处版本
 *   node scripts/bump-version.mjs 0.6.0 --dry    # 只显示将要改什么，不落盘
 *
 * 为什么要有这个脚本：版本号散在 5 个地方（根、shared、kernel、client 的 package.json
 * 以及 packages/shared/src/version.ts 的 KERNEL_VERSION），手工改容易漏，
 * 漏了就会出现「安装包 0.6.0、内核自报 0.5.0」这种拿不到更新、也说不清版本的状态。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_FILES = [
  "package.json",
  "packages/shared/package.json",
  "packages/kernel/package.json",
  "packages/client/package.json",
];
const VERSION_FILE = "packages/shared/src/version.ts";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, rel), "utf8"));
}
function readVersionInFile(rel) {
  const text = fs.readFileSync(path.join(repoRoot, rel), "utf8");
  const m = /KERNEL_VERSION\s*=\s*"([^"]+)"/.exec(text);
  return m ? m[1] : null;
}
function writeIfChanged(rel, next, dry) {
  const abs = path.join(repoRoot, rel);
  const before = fs.readFileSync(abs, "utf8");
  if (before === next) return false;
  if (!dry) fs.writeFileSync(abs, next, "utf8");
  return true;
}

function currentVersions() {
  const rows = PACKAGE_FILES.map((rel) => {
    try {
      return { where: rel, version: readJson(rel).version ?? "(缺失)" };
    } catch (e) {
      return { where: rel, version: `(读不到：${e.message})` };
    }
  });
  rows.push({ where: VERSION_FILE, version: readVersionInFile(VERSION_FILE) ?? "(缺失)" });
  return rows;
}

function printVersions(rows) {
  const width = Math.max(...rows.map((r) => r.where.length));
  for (const r of rows) console.log(`  ${r.where.padEnd(width)}  ${r.version}`);
  const distinct = new Set(rows.map((r) => r.version));
  if (distinct.size > 1) console.log(`  → 版本不一致（${distinct.size} 种），建议先对齐`);
  else console.log("  → 版本一致");
}

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const target = argv.find((a) => !a.startsWith("--"));

if (argv.includes("--print") || !target) {
  console.log("[bump-version] 当前版本：");
  printVersions(currentVersions());
  if (!target) {
    console.log("\n用法：node scripts/bump-version.mjs <x.y.z> [--dry]");
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

if (!SEMVER.test(target)) {
  console.error(`[bump-version] 版本号不合法：${target}（期望 x.y.z，例如 0.6.0）`);
  process.exit(1);
}

const changed = [];
for (const rel of PACKAGE_FILES) {
  const abs = path.join(repoRoot, rel);
  const json = readJson(rel);
  const before = String(json.version ?? "");
  if (before === target) continue;
  json.version = target;
  const next = `${JSON.stringify(json, null, 2)}\n`;
  if (writeIfChanged(rel, next, dry)) changed.push(`${rel}：${before} → ${target}`);
}

const versionAbs = path.join(repoRoot, VERSION_FILE);
let versionText = fs.readFileSync(versionAbs, "utf8");
const beforeKernel = readVersionInFile(VERSION_FILE);
if (beforeKernel !== target) {
  versionText = versionText.replace(/KERNEL_VERSION\s*=\s*"[^"]+"/, `KERNEL_VERSION = "${target}"`);
  if (writeIfChanged(VERSION_FILE, versionText, dry)) changed.push(`${VERSION_FILE}：${beforeKernel} → ${target}`);
}

if (changed.length === 0) {
  console.log(`[bump-version] 已经是 ${target}，无需修改`);
} else {
  console.log(`[bump-version] ${dry ? "（dry-run，未落盘）" : ""}改成 ${target}：`);
  for (const line of changed) console.log(`  - ${line}`);
  console.log("\n下一步：npm.cmd run build:shared && npm.cmd run verify && npm.cmd run package");
}
console.log("\n[bump-version] 改完后的版本：");
printVersions(currentVersions());
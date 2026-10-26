// CI gate from 设计草案 14.14.3 / 附录 A8:
// business code must never mention a specific channel by name ("wechat" / "微信").
// Channel-specific code lives only in plugins/channel.* and packages/client (UI labels
// driven by channel metadata). This script fails the build when the invariant breaks.
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const scopes = ["packages/kernel/src", "packages/shared/src"];
const banned = [/wechat/i, /微信/];
const allow = [/[\\/]channel[\\/]/, /plugin-manifest/];

let violations = 0;
async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full);
      continue;
    }
    if (!/\.(ts|js|mjs)$/.test(entry.name)) continue;
    const rel = relative(root, full);
    if (allow.some((re) => re.test(rel))) continue;
    const text = await readFile(full, "utf8");
    text.split(/\r?\n/).forEach((line, i) => {
      if (banned.some((re) => re.test(line))) {
        violations += 1;
        console.error(`${rel}:${i + 1}: 业务代码不得出现通道名 -> ${line.trim()}`);
      }
    });
  }
}

for (const scope of scopes) await walk(join(root, scope));
if (violations > 0) {
  console.error(`[check-boundaries] ${violations} violation(s)`);
  process.exit(1);
}
console.log("[check-boundaries] ok");
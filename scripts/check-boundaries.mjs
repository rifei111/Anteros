// CI gate from 设计草案 14.14.3 / 附录 A8：
// 业务代码不得按"通道名"分支——通道差异只能通过 capabilities 读取
// （typing_is_real / can_recall / read_can_backfill / host_occupancy_ms）。
//
// 例外只有两类，且都是规范/草案本身规定的字面量，不含任何分支逻辑：
// 1) 《工程规范 1》owners 表的 wechat_id 列与环境变量 OWNER_WECHAT_ID（owner 绑定口径）；
// 2) 《设计草案 14.14.5》声明闸文案——法务口径必须点名"外部通道"是什么，故 shared/consent.ts 放行。
//
// 任何其它出现（含注释里的分支说明）都视为违规：需要通道差异时去读 capabilities。
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const scopes = ["packages/kernel/src", "packages/shared/src"];
const banned = [/wechat/i, /微信/];
/** 整文件放行：声明闸文案（版本化法务文本，必须点名外部通道） */
const allowFiles = [
  /[\\/]channel[\\/]/,
  /plugin-manifest/,
  /packages[\\/]shared[\\/]src[\\/]consent\.ts$/,
  // v0.7.0 起内置微信通道是软件本体能力（不是插件）：适配器本体可以点名，但它不参与业务分支。
  /packages[\\/]kernel[\\/]src[\\/]services[\\/]wechat\.ts$/,
];
/** 行级放行：规范 1 owners 表列名与草案 2.9 的构建期环境变量 */
const allowLines = [/\bwechat_id\b/i, /OWNER_WECHAT_ID/, /\bownerWechatConfigured\b/];
/**
 * 按文件行级放行：内置通道的类型契约（shared）与组合根装配（app.ts、settings 默认值）
 * 只是把这条能力接起来，不含"按通道名分支"的业务逻辑。
 */
const allowLineByFile = [
  { file: /packages[\\/]kernel[\\/]src[\\/]app\.ts$/, line: /wechat|微信/i },
  { file: /packages[\\/]kernel[\\/]src[\\/]settings\.ts$/, line: /wechat|微信/i },
  { file: /packages[\\/]shared[\\/]src[\\/](rpc|domain)\.ts$/, line: /wechat|微信/i },
];

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
    if (allowFiles.some((re) => re.test(rel))) continue;
    const perFile = allowLineByFile.find((entry) => entry.file.test(rel));
    const text = await readFile(full, "utf8");
    text.split(/\r?\n/).forEach((line, i) => {
      const hit = banned.some((re) => re.test(line));
      if (!hit) return;
      if (allowLines.some((re) => re.test(line))) return;
      if (perFile !== undefined && perFile.line.test(line)) return;
      violations += 1;
      console.error(`${rel}:${i + 1}: 业务代码不得出现通道名 -> ${line.trim()}`);
    });
  }
}

for (const scope of scopes) await walk(join(root, scope));
if (violations > 0) {
  console.error(`[check-boundaries] ${violations} violation(s)`);
  process.exit(1);
}
console.log("[check-boundaries] ok：业务代码里没有按通道名分支的痕迹");

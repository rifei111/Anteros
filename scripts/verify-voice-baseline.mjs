// 基线核验：docs/语音条.md 引用的每条前提都在这里有对应一条 grep。
// FAIL 不一定代表文档错了，也可能代表代码已经领先于文档——两种都要在开工前处理。
// 用法：仓库根目录 `node scripts/verify-voice-baseline.mjs`。
import { readFile, readdir } from "node:fs/promises";

const CHECKS = [
  // —— 前提：语音功能尚不存在（合入后这些应变成 FAIL，那是文档该更新）——
  ["packages/shared/src/domain.ts", "attachment?: MessageAttachment", "absent", "ChatMessage 还没有附件字段"],
  ["packages/shared/src/rpc.ts", /"plugin\.media\.listen"/, "absent", "PluginApi 还没有媒体方法"],
  ["packages/shared/src/manifest.ts", /"media\.listen"/, "absent", "能力白名单还没有 listen"],
  ["packages/client/src/renderer/index.html", /media-src/, "absent", "CSP 还没有 media-src"],
  ["packages/kernel/src/services/cost.ts", /record\(input: \{[^}]*costCny/, "absent", "record() 的入参里还没有 costCny"],
  ["packages/kernel/src/services/cost.ts", /checkBudget\(\) =>|checkBudget\(extra/, "absent", "预算闸还不会预检下一笔（10.6）"],
  ["packages/shared/src", /voicePlaceholder/, "absent", "占位符还没做成两端同源的纯函数（5.3）"],

  // —— 前提：现状（改了就要同步文档）——
  ["packages/shared/src/version.ts", /MAX_FRAME_BYTES = 8/, "found", "单帧 8MB"],
  ["packages/shared/src/version.ts", /DEFAULT_MONTHLY_BUDGET_CNY = 45/, "found", "默认月预算 ¥45"],
  ["packages/kernel/src/db/schema.ts", /SCHEMA_VERSION = 3/, "found", "schema 还是 v3"],
  ["packages/shared/src/domain.ts", /CostKind = "reply"/, "found", "CostKind 现状"],
  ["packages/shared/src/domain.ts", /attachments\?: \{ read\?: boolean/, "found", "PluginHealth.attachments 只有通道四键"],
  ["packages/kernel/src/services/chat.ts", /ports\.memory\s*\n?\s*\.extract/, "found", "抽取在 planReply 之前 fire-and-forget（7.3）"],
  ["packages/kernel/src/services/chat.ts", /checkBudget\(\);[\s\S]{0,600}planReply/, "found", "预算闸在生成之前、记账在投递之后（10.6）"],
  ["packages/kernel/src/services/chat.ts", /"event\.recall", \{ messageId, message: updated \}/, "found", "recall 事件与契约不一致（7.6）"],
  ["packages/kernel/src/services/chat.ts", /"event\.typing", \{/, "found", "打字事件有现成出口，转写期就用它（7.2）"],
  ["packages/kernel/src/services/cost.ts", /record\(input: \{ kind: CostKind/, "found", "record 签名"],
  ["packages/kernel/src/services/cost.ts", /INSERT INTO cost_ledger.*cost_cny/, "found", "账本已有 cost_cny 列，只是入口不会用（10.5）"],
  ["packages/kernel/src/services/cost.ts", /if \(month >= budget\)/, "found", "闸是「已达上限才拦」，不预测下一笔（10.6）"],
  ["packages/kernel/src/memory/service.ts", /findOpenLoopByTopic/, "found", "openLoop 已按 topic 幂等，别重复造（7.3）"],
  ["packages/kernel/src/memory/service.ts", /同一句话不重复落库/, "found", "episodic 已有 24h 同文本去重（7.3）"],
  ["packages/kernel/src/services/consent.ts", /row\.doc_version === CONSENT_DOC_VERSION/, "found", "声明闸比的是全局文案版本（12.2）"],
  ["packages/kernel/src/services/consent.ts", /channel = "app"/, "found", "consent 表本来就分通道记账（12.2 的渠道级勾选）"],
  ["packages/kernel/src/plugins/host.ts", /HIGH_RISK_PERMISSION = \/\^\(proc\\?\./, "found", "secrets.read: 已触发授权一次性 token（12.2）"],
  ["packages/kernel/src/expression/planner.ts", /MAX_PARTS = 20/, "found", "分条上限 20（10.1）"],
  ["packages/kernel/src/expression/planner.ts", /MAX_PART_CHARS = 32/, "found", "每条约 32 字（10.1）"],
  ["packages/kernel/src/expression/planner.ts", /rng\.float\(4, 6\)/, "found", "打字 4–6 字/秒"],
  ["packages/kernel/src/expression/punctuation.ts", /绝不新增任何标点/, "found", "1.0.11 补标点的教训还在（10.2）"],
  ["packages/client/src/main/kernel-client.ts", /DEFAULT_TIMEOUT_MS = 30_000/, "found", "客户端默认 30s（7.8）"],
  ["packages/client/src/main/kernel-client.ts", /"chat\.send": 120_000/, "found", "chat.send 已放宽到 120s"],
  ["packages/client/src/renderer/src/lib/app.ts", /unread: previous\.unread \+ 1/, "found", "未读 +1 在 exists 判断之前（13，P0 就修）"],
  ["packages/client/src/renderer/src/lib/app.ts", /item\.text === message\.text/, "found", "临时气泡按 text 逐字相等摘除（5.3）"],
  ["packages/client/src/renderer/src/lib/app.ts", /payload\.state === "start"/, "found", "typing 分支把非 start 一律当 stop，所以 transcribe 态必须与内核同 PR（7.2）"],
  ["packages/client/src/renderer/src/components/ChatPane.tsx", /只在 `event\.typing` 说 true 时出现/, "found", "界面不许自己造计时器，「正在听写」也只能由内核事件驱动（7.2）"],
  ["packages/shared/src/rpc.ts", /kind: "time" \| "weather" \| "news"/, "found", "plugin.world.info 问的是外界，不是内心状态（§4 的策略为什么在内核）"],
  ["packages/shared/src/rpc.ts", /"plugin\.world\.state"/, "absent", "没有向插件暴露 WorldState 的方法（§4）"],
  ["packages/shared/src/rpc.ts", /"plugin\.channel\.download_media"/, "found", "取别人媒体进本机的能力已存在，12.1 的规则不是假想敌"],
  ["packages/shared/src/rpc.ts", /"plugin\.ui\.panel\.render"/, "found", "插件面板只到内核，没有到客户端（§4 第 1 条）"],
  ["packages/shared/src/consent.ts", /channel/, "absent", "九条声明是全局的，没有按渠道分（12.2）"],
  ["packages/kernel/src/services/plugins.ts", /config_schema|configSchema/, "absent", "配置写入没有 schema 校验（§3 第 1 条）"],
  ["packages/kernel/src/services/consent.ts", /const required = CONSENT_ITEMS\.filter/, "found", "accept() 要求所有 required 项全勾（12.2 的代价）"],
  ["packages/kernel/src/app.ts", /consent\.status\("app"\)/, "found", "分发把通道写死成 app（12.2）"],
  ["packages/kernel/src/settings.ts", "api.deepseek.com/v1", "found", "默认 baseUrl 已带 /v1（8.2）"],
  ["packages/kernel/src/bootstrap.ts", /anteros\.sqlite/, "found", "DB 文件名（10.4 取语料）"],
  ["packages/kernel/src/services/export.ts", /collectMedia/, "found", "导出已带媒体（§3）"],
  ["packages/kernel/src/plugins/host.ts", /"plugin\.media\.speak": "media\.speak"/, "found", "能力映射已有 speak"],
  ["packages/shared/src/consent.ts", "只会发送装配后的对话上下文", "found", "c7 现文案不覆盖原始音频（12.2）"],
];

// 全仓"应当没有"的：出现就说明边界假设变了
const ABSENT_ANYWHERE = [
  ["packages/client/src/main", /setPermissionRequestHandler/, "主进程还没有权限处理器（9.6）"],
  ["packages/client/src/renderer", /panel\.render/, "渲染层不消费插件面板，所以界面进不了插件（§4 第 1 条）"],
  ["packages/kernel/src", /net\.allow/, "内核里若出现 net.allow 的执行点，§4 的诚实措辞要改"],
  ["packages/kernel/src", /\bhook\b|middleware|interceptor/, "内核若有了钩子机制，§4「策略不能放插件」的结论要重估"],
];

// 版本基线：不写死字面量，避免升版本必然误报 FAIL。
let versionFail = false;
const versionText = await readFile("packages/shared/src/version.ts", "utf8").catch(() => "");
const kernelVersion = versionText.match(/KERNEL_VERSION = "([^"]+)"/)?.[1] ?? null;
const pkgVersion = (await readFile("package.json", "utf8").catch(() => "{}"))
  .match(/"version":\s*"([^"]+)"/)?.[1] ?? null;
if (kernelVersion === null || kernelVersion !== pkgVersion) {
  versionFail = true;
  console.log(`FAIL 版本基线 :: KERNEL_VERSION=${kernelVersion} 与 package.json=${pkgVersion} 不一致`);
} else {
  console.log(`ok   版本基线 :: ${kernelVersion}（KERNEL_VERSION 与 package.json 对齐）`);
}

let fail = versionFail ? 1 : 0;

async function walk(dir, out) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await walk(full, out);
    else if (/\.(ts|tsx|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

for (const [file, needle, expect, why] of CHECKS) {
  const isDir = !/\.(ts|tsx|mjs|html|json)$/.test(file);
  const text = isDir ? "" : await readFile(file, "utf8").catch(() => "");
  if (isDir) {
    const files = await walk(file, []).catch(() => []);
    let hit = false;
    for (const f of files) {
      const body = await readFile(f, "utf8").catch(() => "");
      if (typeof needle === "string" ? body.includes(needle) : needle.test(body)) {
        hit = true;
        console.log(`     ↳ ${f}`);
        break;
      }
    }
    const ok = expect === "found" ? hit : !hit;
    if (!ok) fail += 1;
    console.log(`${ok ? "ok  " : "FAIL"} ${file}/ :: ${why}`);
    continue;
  }
  const hit = typeof needle === "string" ? text.includes(needle) : needle.test(text);
  const ok = expect === "found" ? hit : !hit;
  if (!ok) fail += 1;
  const label = typeof needle === "string" ? needle : `/${needle.source}/`;
  console.log(`${ok ? "ok  " : "FAIL"} ${file} :: ${why} [${label}]`);
}

for (const [dir, re, why] of ABSENT_ANYWHERE) {
  const files = await walk(dir, []).catch(() => []);
  let hit = false;
  for (const f of files) {
    const text = await readFile(f, "utf8").catch(() => "");
    if (re.test(text)) {
      hit = true;
      console.log(`     ↳ ${f}`);
      break;
    }
  }
  if (hit) fail += 1;
  console.log(`${hit ? "FAIL" : "ok  "} ${dir}/ :: ${why}`);
}

console.log(fail === 0 ? "\n[voice-baseline] 全部前提与 docs/语音条.md 一致" : `\n[voice-baseline] ${fail} 条不一致`);
process.exit(fail === 0 ? 0 : 1);

/**
 * 内核端到端冒烟测试（不需要 Electron、不需要模型 API Key）。
 *
 * 做的是真事：起一个真内核进程 → 连命名管道 → 走一遍
 *   握手 → 声明闸 → 快照 → 发消息（拿到分条事件）→ 历史 → 成本 → 健康 → 关停。
 *
 * 断言的是 M0c 的硬口径：声明闸没勾选不能发消息、回复必须按 1–3 条 ≤25 字下发、
 * 插件全部注册成功、内核在 LLM 未配置时必须降级而不是崩。
 *
 * 用法：npm.cmd run build:kernel 之后 `node scripts/smoke-kernel.mjs`
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kernelEntry = path.join(root, "packages", "kernel", "dist", "kernel.mjs");
const sharedEntry = path.join(root, "packages", "shared", "dist", "index.js");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const mark = ok ? "  ok  " : " FAIL ";
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

function fail(message) {
  console.error(`\n✗ 冒烟测试中断：${message}`);
  process.exit(1);
}

if (!fs.existsSync(kernelEntry)) fail(`找不到内核产物 ${kernelEntry}，请先 npm.cmd run build:kernel`);
if (!fs.existsSync(sharedEntry)) fail(`找不到共享契约产物 ${sharedEntry}，请先 npm.cmd run build:shared`);

const shared = await import(`file:///${sharedEntry.replace(/\\/g, "/")}`);
const { CONSENT_ITEMS, CONSENT_DOC_VERSION, KERNEL_API_VERSION } = shared;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "anteros-smoke-"));
const token = Array.from({ length: 32 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join("");
const pipeName = `\\\\.\\pipe\\anteros-smoke-${process.pid}-${Date.now().toString(36)}`;



/** 最小 ustar 打包（普通文件），供本地更新源生成 tar.gz 整包 */
function packTarGz(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data, "utf8");
    const header = Buffer.alloc(512, 0);
    header.write(entry.path.slice(0, 100), 0, "utf8");
    header.write("0000644\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
    header.write("00000000000\0", 136, "ascii");
    header.write("        ", 148, "ascii");
    header.write("0", 156, "ascii");
    header.write("ustar\0" + "00", 257, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    blocks.push(header);
    blocks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

/* 本地更新源：给「插件运行环境」用的真 http 服务（清单 + 按文件内容寻址的字节） */
const runtimeFileSets = {
  "1.0.0": [
    { path: "adapter/entry.mjs", data: "export const version = '1.0.0';\n" },
    { path: "adapter/README.md", data: "# wechat-replica runtime\n" },
  ],
  "1.1.0": [
    { path: "adapter/entry.mjs", data: "export const version = '1.1.0';\n" },
    { path: "adapter/README.md", data: "# wechat-replica runtime\n" },
  ],
};
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const fileRoute = new Map();
for (const files of Object.values(runtimeFileSets)) {
  for (const file of files) {
    const bytes = Buffer.from(file.data, "utf8");
    fileRoute.set("/files/" + sha256(bytes), bytes);
  }
}
const archiveRoute = new Map();
for (const version of Object.keys(runtimeFileSets)) {
  const bytes = packTarGz(runtimeFileSets[version]);
  archiveRoute.set("/pkg-" + version + ".tar.gz", bytes);
}
const downloadHits = [];
let feedVersion = "1.0.0";
const feedState = { pluginId: "core.media" };
const localFeedServer = createServer((request, response) => {
  const url = request.url ?? "/";
  if (url === "/feed.json") {
    const files = runtimeFileSets[feedVersion].map((file) => {
      const bytes = Buffer.from(file.data, "utf8");
      return { path: file.path, sha256: sha256(bytes), size: bytes.length };
    });
    const body = {
      schema: 1,
      packages: {
        [feedState.pluginId]: {
          pluginId: feedState.pluginId,
          version: feedVersion,
          notes: "冒烟用的本地运行环境包",
          entry: "adapter/entry.mjs",
          archive: {
            url: feedBaseUrl + "/pkg-" + feedVersion + ".tar.gz",
            sha256: sha256(archiveRoute.get("/pkg-" + feedVersion + ".tar.gz")),
            size: archiveRoute.get("/pkg-" + feedVersion + ".tar.gz").length,
            format: "tar.gz",
          },
          files,
          filesBaseUrl: feedBaseUrl + "/files",
        },
      },
    };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
    return;
  }
  const bytes = fileRoute.get(url) ?? archiveRoute.get(url);
  if (bytes === undefined) {
    response.statusCode = 404;
    response.end("not found");
    return;
  }
  downloadHits.push(url);
  response.setHeader("content-type", "application/octet-stream");
  response.end(bytes);
});
await new Promise((resolve) => localFeedServer.listen(0, "127.0.0.1", resolve));
const feedBaseUrl = "http://127.0.0.1:" + localFeedServer.address().port;

const child = spawn(process.execPath, [kernelEntry], {
  env: {
    ...process.env,
    ANTEROS_DATA_DIR: dataDir,
    ANTEROS_PIPE_NAME: pipeName,
    ANTEROS_TOKEN: token,
    ANTEROS_LOG_LEVEL: "warn",
    ANTEROS_PLUGIN_FEED: feedBaseUrl + "/feed.json",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr = `${stderr}${chunk}`.slice(-4000);
});

const ready = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`内核 20 秒内未就绪\n${stderr}`)), 20_000);
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.startsWith("{")) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.event === "ready" || parsed.type === "ready") {
            clearTimeout(timer);
            resolve(parsed);
            return;
          }
        } catch {
          /* 忽略非 JSON 噪声 */
        }
      }
      index = buffer.indexOf("\n");
    }
  });
  child.once("exit", (code) => reject(new Error(`内核提前退出（code ${code}）\n${stderr}`)));
});
check("内核启动并输出 ready 行", true, `pipe=${ready.pipe ?? ready.pipeName}`);

const socket = net.connect(ready.pipe ?? ready.pipeName);
socket.setEncoding("utf8");
await new Promise((resolve, reject) => {
  socket.once("connect", resolve);
  socket.once("error", reject);
});

let readBuffer = "";
const pending = new Map();
const events = [];
let sequence = 0;
const waiters = [];

socket.on("data", (chunk) => {
  readBuffer += chunk;
  let index = readBuffer.indexOf("\n");
  while (index >= 0) {
    const line = readBuffer.slice(0, index).trim();
    readBuffer = readBuffer.slice(index + 1);
    if (line) handle(line);
    index = readBuffer.indexOf("\n");
  }
});

function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== undefined && pending.has(String(message.id))) {
    const call = pending.get(String(message.id));
    pending.delete(String(message.id));
    clearTimeout(call.timer);
    if (message.error) {
      const failure = new Error(`${message.error.message}（${message.error.data?.code ?? "?"}）`);
      failure.code = message.error.data?.code;
      call.reject(failure);
    }
    else call.resolve(message.result);
    return;
  }
  if (typeof message.method === "string" && message.method.startsWith("event.")) {
    events.push({ method: message.method, params: message.params });
    for (const waiter of [...waiters]) waiter();
  }
}

function call(method, params = {}) {
  const id = `s${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`调用 ${method} 超时`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params, auth: token })}\n`);
  });
}

function waitFor(predicate, label, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${label} 超时`)), timeoutMs);
    const attempt = () => {
      const hit = predicate();
      if (hit) {
        clearTimeout(timer);
        waiters.splice(waiters.indexOf(attempt), 1);
        resolve(hit);
      }
    };
    waiters.push(attempt);
    attempt();
  });
}

try {
  /* 1. 握手 */
  const handshake = await call("client.handshake");
  check("握手返回内核版本与声明状态", handshake.kernelApi === KERNEL_API_VERSION, `kernelApi=${handshake.kernelApi}`);
  check("首次启动必须需要声明闸", handshake.needsConsent === true);

  /* 2. 未过声明闸不得发消息 */
  let consentBlocked = false;
  try {
    await call("chat.send", { text: "在吗", eventId: "smoke-before-consent" });
  } catch (error) {
    consentBlocked = String(error.message).includes("ECONSENT") || String(error.message).includes("声明");
  }
  check("未勾选声明时 chat.send 被拒（ECONSENT）", consentBlocked);

  /* 3. 勾选九条声明 */
  const accepted = await call("consent.accept", {
    docVersion: CONSENT_DOC_VERSION,
    checkedIds: CONSENT_ITEMS.map((item) => item.id),
    channel: "app",
  });
  check("九条声明全部勾选后通过", accepted.accepted === true, `doc=${accepted.docVersion}`);

  /* 4. 快照 */
  const snapshot = await call("state.snapshot");
  check("快照含人格", typeof snapshot.persona?.name === "string" && snapshot.persona.name.length > 0, `name=${snapshot.persona?.name}`);
  check("快照含关系阶段", snapshot.relation?.stage === "stranger", `stage=${snapshot.relation?.stage}`);
  check("持久化插件已注册", Array.isArray(snapshot.plugins) && snapshot.plugins.length >= 6, `plugins=${snapshot.plugins?.length}`);
  check(
    "需要密钥的插件默认不启用",
    snapshot.plugins.some((plugin) => plugin.id === "core.llm-router" && plugin.enabled === false),
  );
  check("App 内通道始终可用", snapshot.channels.some((channel) => channel.enabled === true && channel.writeReady === true));
  check("LLM 未配置时明示降级而不是假装在线", snapshot.llm.online === false && snapshot.llm.degradedLocalEcho === true);

  /* 5. 发一条消息，收分条事件 */
  events.length = 0;
  const sent = await call("chat.send", {
    text: "今天有点累，不太想说话",
    eventId: `smoke-${Date.now()}`,
    clientTs: Date.now(),
    presence: { isTyping: false, appFocused: true, lastInteractionMs: 0 },
  });
  check("用户消息落库并返回 turnId", typeof sent.turnId === "number" && sent.turnId > 0, `turnId=${sent.turnId}`);

  await waitFor(() => events.some((event) => event.method === "event.typing" && event.params?.state === "stop"), "打字结束事件");
  const parts = events.filter((event) => event.method === "event.part").map((event) => event.params);
  check("回复按 1–3 条下发", parts.length >= 1 && parts.length <= 3, `parts=${parts.length}`);
  check(
    "每条不超过 25 字",
    parts.every((part) => typeof part.text === "string" && part.text.length <= 25),
    parts.map((part) => part.text.length).join(","),
  );
  check("分条带打字时长与条间间隔", parts.every((part) => part.typingMs >= 0 && part.delayAfterMs >= 0));

  const history = await call("chat.history", { limit: 20 });
  const agentMessages = history.messages.filter((message) => message.role === "agent");
  check("历史里能取回它的回复", agentMessages.length >= 1, `agent=${agentMessages.length}`);

  /* 6. 回放：任意一句都能还原装配输入 */
  const replay = await call("turn.replay", { turnId: sent.turnId });
  check("回放能还原这一轮的装配快照", replay.ctxSnapshot !== null && typeof replay.plan === "object", `model=${replay.model}`);
  check("回放里带了 prompt 全文", typeof replay.ctxSnapshot?.prompt === "string" && replay.ctxSnapshot.prompt.length > 50);

  /* 7. 成本与健康 */
  const cost = await call("cost.summary");
  check("成本账本有记录", typeof cost.monthCny === "number" && cost.turnCount >= 1, `month=¥${cost.monthCny}`);
  const health = await call("system.health");
  check("系统健康可用且声明单点风险", health.ok === true && Array.isArray(health.singlePointRisks) && health.singlePointRisks.length >= 3);
  check("健康里能读出记忆条数", typeof health.memoryCount === "number" && health.memoryCount >= 1, `memory=${health.memoryCount}`);

  /* 8. 记忆检索与台账 */
  const stats = await call("memory.stats");
  check("记忆统计可用", typeof stats.total === "number" && stats.total >= 1, `total=${stats.total}`);
  const search = await call("memory.search", { query: "累" });
  check("记忆检索返回结果结构", Array.isArray(search.items) && Array.isArray(search.pinned));

  /* 9. 主动消息动作队列（影子模式，不真发） */
  const proactive = await call("proactive.list");
  check("主动动作队列可查询", Array.isArray(proactive.pending) && Array.isArray(proactive.recent));

  /* 10. 一键停用 */
  const panic = await call("channels.panicStop");
  check("一键停用返回可读结果", typeof panic.message === "string" && panic.message.length > 0, panic.message);

  /* 11. 预算上限是硬项：把月预算调到 0 后必须直接拒绝，不是"继续但提醒" */
  await call("cost.setBudget", { monthlyCny: 0 });
  let budgetBlocked = false;
  try {
    await call("chat.send", { text: "预算为零还能说话吗", eventId: `smoke-budget-${Date.now()}` });
  } catch (error) {
    budgetBlocked = String(error.message).includes("EBLOCKED");
  }
  check("预算用尽时 chat.send 被硬拒（EBLOCKED）", budgetBlocked);
  await call("cost.setBudget", { monthlyCny: 45 });

  /* 12. 导出 / 导入：导出包存在、能读出表清单，导入后消息数不丢 */
  const beforeCount = (await call("chat.history", { limit: 500 })).messages.length;
  const bundle = await call("export.bundle");
  check("导出数据包落盘", typeof bundle.path === "string" && fs.existsSync(bundle.path), `bytes=${bundle.bytes}`);
  const imported = await call("import.bundle", { path: bundle.path });
  check("导入数据包成功并报出表与行数", Array.isArray(imported.tables) && imported.tables.length >= 10 && imported.rows > 0, `tables=${imported.tables.length} rows=${imported.rows}`);
  const afterCount = (await call("chat.history", { limit: 500 })).messages.length;
  check("导入后消息条数一致", afterCount === beforeCount, `${beforeCount} -> ${afterCount}`);

  /* 13. 人设文本 → 人格内核：没配模型时必须走本地规则引擎，且能落库 */
  const compiled = await call("persona.compile", {
    text: "她叫林野，26 岁，在杭州做夜班护士，话不多，有点健忘，但记得住别人随口提过的事，喜欢下雨天和便利店的关东煮。",
  });
  const blueprint = compiled.blueprint;
  check("人设编译返回草稿", typeof blueprint?.name === "string" && blueprint.name === "林野", `name=${blueprint?.name}`);
  check("没配模型时用本地规则引擎（不假装调了模型）", blueprint?.engine === "rules" && compiled.usage === null, `engine=${blueprint?.engine}`);
  check("编译出的是数值内核，不是一句形容词", typeof blueprint?.traits?.memoryD === "number" && blueprint.traits.memoryD !== snapshot.persona?.traits?.memoryD, `d=${blueprint?.traits?.memoryD}`);
  check("每个改动的参数都带人话解释", Array.isArray(blueprint?.rationale) && blueprint.rationale.length >= 1);
  const applied = await call("persona.applyBlueprint", { blueprint });
  check("人格内核能落库并回读", applied?.name === "林野" && applied?.city === "杭州", `${applied?.name}@${applied?.city}`);
  const reread = await call("persona.get");
  check("重读人格=刚应用的内核", reread.name === "林野" && reread.immutable.background.length > 0);
  const updated = await call("persona.update", { patch: { traits: { burstMin: 9, burstMax: 9 } } });
  check("越界的数值被钳住而不是照单全收", updated.traits.burstMin <= 3 && updated.traits.burstMax <= 3, `burst=${updated.traits.burstMin}-${updated.traits.burstMax}`);
  /* 13b. 人设文档：能看、能存、能改完再导入 */
  const doc = await call("persona.exportDoc", {});
  check(
    "人设文档能导出一份可读的 Markdown",
    typeof doc?.text === "string" && doc.text.includes("# 人设：") && doc.filename.endsWith(".md"),
    doc?.filename ?? "",
  );
  check("文档里带参数表但只作只读查看", doc.text.includes("内核参数") && doc.text.includes("| 记忆衰减 d |"));
  const importedDoc = await call("persona.importDoc", {
    text: doc.text.replace(/## 兴趣[\s\S]*?## 背景/, "## 兴趣\n\n- 逛旧书店\n- 拍路牌\n\n## 背景"),
  });
  check(
    "改过的文档能导入回去（只改文档里写到的字段）",
    Array.isArray(importedDoc?.applied) && importedDoc.applied.length > 0 && importedDoc.persona?.interests.includes("逛旧书店"),
    `${importedDoc?.applied?.[0] ?? ""}`,
  );
  let badDocError = "";
  try {
    await call("persona.importDoc", { text: "一段完全没有结构的话" });
  } catch (error) {
    badDocError = String(error && error.message ? error.message : error);
  }
  check("读不懂的文档会明确报错并给出该怎么写", badDocError.includes("名字"), badDocError.slice(0, 60));

  /* 14. 插件授权与启用：界面用 plugins.* 叫法换 token、宿主按 plugin.* 消费，必须能对上 */
  const plugins = await call("plugins.list");
  const media = plugins.find((item) => item.id === "core.media");
  check(
    "插件清单带可授权项与缺密钥字段",
    Array.isArray(media?.grantable) && Array.isArray(media?.missingSecrets) && Array.isArray(media?.secrets),
  );
  check("声明了密钥的插件在缺密钥时如实列出", Array.isArray(media?.missingSecrets) && media.missingSecrets.includes("media.api_key"), JSON.stringify(media?.missingSecrets ?? []));
  const mediaGrantToken = await call("confirm.token", { action: "plugins.grant", target: media.id });
  const grantedMedia = await call("plugins.grant", {
    id: media.id,
    permissions: media.grantable,
    confirmToken: mediaGrantToken.token,
  });
  check("按 grantable 授权成功", Array.isArray(grantedMedia.granted) && grantedMedia.granted.length > 0, JSON.stringify(grantedMedia.granted));
  // 缺密钥时启用会被拦（core.media 声明了 media.api_key，这里还没录）
  let secretGateError = "";
  try {
    await call("plugins.enable", { id: media.id });
  } catch (error) {
    secretGateError = String(error && error.message ? error.message : error);
  }
  check("缺密钥时启用被拦并说清缺什么", secretGateError.includes("密钥"), secretGateError.slice(0, 80));

  const router = plugins.find((item) => item.id === "core.llm-router");
  check(
    "中风险插件的授权闸标记正确（授权要确认、启用不用）",
    router.grantNeedsConfirm === true && router.enableNeedsConfirm === false,
    `grant=${router.grantNeedsConfirm} enable=${router.enableNeedsConfirm}`,
  );
  let routerGrantNeedsToken = false;
  try {
    await call("plugins.grant", { id: router.id, permissions: router.grantable });
  } catch (error) {
    routerGrantNeedsToken = String(error.message).includes("ECONFIRM");
  }
  check("勾了 secrets.read 的中风险插件不带 token 授权会被拒（ECONFIRM）", routerGrantNeedsToken);
  const grantToken = await call("confirm.token", { action: "plugins.grant", target: router.id });
  const grantedRouter = await call("plugins.grant", {
    id: router.id,
    permissions: router.grantable,
    confirmToken: grantToken.token,
  });
  check("按 grantable 逐项授权成功", grantedRouter.granted.length > 0, `granted=${grantedRouter.granted.join(",")}`);
  const withSecret = await call("plugins.secret.put", {
    id: router.id,
    name: "llm.api_key",
    value: "smoke-key-123456",
  });
  check("密钥录入后不再报缺失", withSecret.missingSecrets.length === 0, `missing=${withSecret.missingSecrets.join(",")}`);
  const enabledRouter = await call("plugins.enable", { id: router.id });
  check("缺密钥的插件录完密钥能启用", enabledRouter.enabled === true);
  const afterDelete = await call("plugins.secret.delete", { id: router.id, name: "llm.api_key" });
  check("删掉密钥后缺失状态是实时算的", afterDelete.missingSecrets.includes("llm.api_key"));

  /* 15. 模型页：路由插件小节 + 真探测的两条路径 */
  const llmStatus = await call("llm.status", {});
  check(
    "llm.status 带路由插件小节（模型页要在一个页面里管它）",
    llmStatus.router !== null && llmStatus.router.id === "core.llm-router",
    `router=${JSON.stringify(llmStatus.router?.id ?? null)}`,
  );
  check(
    "路由插件小节里有它真读到的配置",
    llmStatus.router !== null && typeof llmStatus.router.config === "object",
  );
  check(
    "密钥删掉后，路由插件小节实时显示缺密钥",
    llmStatus.router !== null && llmStatus.router.missingSecrets.includes("llm.api_key"),
    `missing=${llmStatus.router?.missingSecrets.join(",")}`,
  );
  const probeFail = await call("llm.test", {
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "sk-smoke-not-real",
    model: "smoke-model",
  });
  check(
    "真探测在不通的地址上返回 ok=false 且给人话",
    probeFail.ok === false && probeFail.message.length > 0,
    `via=${probeFail.via} http=${probeFail.httpStatus ?? "null"} msg=${probeFail.message.slice(0, 60)}`,
  );
  const probeNoKey = await call("llm.test", { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" });
  check(
    "不显式给密钥时用已保存的密钥探测（被拒也要说清楚 HTTP 与原因）",
    probeNoKey.ok === false && probeNoKey.message.length > 0,
    `msg=${probeNoKey.message.slice(0, 40)}`,
  );

  /* 16. 审计：owner 危险操作留下追加记录（不存消息原文） */
  const audit = await call("audit.list", { limit: 50 });
  check("审计日志记录了 owner 操作", Array.isArray(audit) && audit.length >= 1, `entries=${audit.length}`);
  check("审计里不出现消息正文", Array.isArray(audit) && !audit.some((entry) => JSON.stringify(entry).includes("今天有点累")));

  /* 17. 插件运行环境：检查 → 下载（按文件增量）→ 落地 → 再升级只下变了的那几个文件 → 卸载 */
  const runtimeId = "core.media";
  const runtime0 = await call("plugins.runtime.status", { id: runtimeId });
  check("运行环境初始未安装", runtime0.installed === null, "installed=" + JSON.stringify(runtime0.installed));
  check("运行环境状态带上更新源", runtime0.feedUrl.includes("/feed.json"), runtime0.feedUrl);

  const runtimeCheck1 = await call("plugins.runtime.check", { id: runtimeId });
  check(
    "检查更新：能读到 1.0.0 且提示可安装",
    runtimeCheck1.updateAvailable === true && runtimeCheck1.available?.version === "1.0.0",
    "available=" + JSON.stringify(runtimeCheck1.available?.version ?? null),
  );

  const runtimeInstalled1 = await call("plugins.runtime.install", { id: runtimeId });
  check(
    "下载安装成功且落到磁盘",
    runtimeInstalled1.installed?.version === "1.0.0" && runtimeInstalled1.installed?.fileCount === 2,
    "installed=" + JSON.stringify(runtimeInstalled1.installed?.version ?? null),
  );
  check("首次安装走整包（mode=archive）", runtimeInstalled1.installed?.mode === "archive", runtimeInstalled1.installed?.mode);
  const onDiskEntry = fs.readFileSync(path.join(runtimeInstalled1.installed?.path ?? "", "adapter/entry.mjs"), "utf8");
  check("文件内容与清单一致", onDiskEntry.includes("1.0.0"), onDiskEntry.trim());

  const runtimeCheck2 = await call("plugins.runtime.check", { id: runtimeId });
  check("已是最新时不再提示更新", runtimeCheck2.updateAvailable === false);

  feedVersion = "1.1.0";
  const runtimeCheck3 = await call("plugins.runtime.check", { id: runtimeId });
  check(
    "发布新版后检查到 1.1.0",
    runtimeCheck3.updateAvailable === true && runtimeCheck3.available?.version === "1.1.0",
    "available=" + JSON.stringify(runtimeCheck3.available?.version ?? null),
  );

  const beforeHits = downloadHits.length;
  const runtimeInstalled2 = await call("plugins.runtime.install", { id: runtimeId });
  const deltaHits = downloadHits.length - beforeHits;
  check("升级到 1.1.0 成功", runtimeInstalled2.installed?.version === "1.1.0", String(runtimeInstalled2.installed?.version ?? null));
  check("增量升级只下载变了的那 1 个文件", deltaHits === 1, "downloaded=" + deltaHits);
  const upgradedEntry = fs.readFileSync(path.join(runtimeInstalled2.installed?.path ?? "", "adapter/entry.mjs"), "utf8");
  check("升级后磁盘内容是新的", upgradedEntry.includes("1.1.0"), upgradedEntry.trim());

  const runtimeGone = await call("plugins.runtime.uninstall", { id: runtimeId });
  check("卸载后状态清空、目录删掉", runtimeGone.installed === null && !fs.existsSync(runtimeInstalled2.installed?.path ?? ""));

  /* 19. 内置微信通道（软件本体能力，不是插件）：默认关闭、没确认风险不许开、缺环境时诚实报告 */
  const wechatStatus0 = await call("channels.wechat.status");
  check("内置通道默认关闭", wechatStatus0.enabled === false && wechatStatus0.state === "off", `state=${wechatStatus0.state}`);
  check("内置通道体检项不为空", Array.isArray(wechatStatus0.checks) && wechatStatus0.checks.length >= 3, `checks=${wechatStatus0.checks?.length}`);
  const builtinChannel = (await call("channels.list")).find((item) => item.pluginId === "core.wechat-channel");
  check(
    "通道列表里有内置微信通道且写能力未就绪",
    builtinChannel !== undefined && builtinChannel.kind === "external" && builtinChannel.writeReady === false,
    JSON.stringify(builtinChannel?.capabilities ?? null),
  );
  let ackRejected = false;
  try {
    await call("channels.wechat.enable", { ackRisk: false });
  } catch (error) {
    ackRejected = error.code === "EINVALID";
  }
  check("不确认风险不许开启（EINVALID）", ackRejected);
  let doctorBlocked = false;
  try {
    await call("channels.wechat.doctor", { action: "diagnose-keys" });
  } catch (error) {
    doctorBlocked = error.code === "EBLOCKED";
  }
  check("通道没跑时诊断被拒（EBLOCKED）", doctorBlocked);
  const wechatChat = await call("channels.wechat.setChat", { chatUsername: "filehelper" });
  check("能设置白名单会话", wechatChat.chatUsername === "filehelper");

  /* ---- 第 20 组：多用户 / 群聊（对话对象增删、模式、上限） ---- */
  const maxed = await call("channels.wechat.setMaxChats", { max: 3 });
  check("能设可对话用户上限", maxed.maxChats === 3, `maxChats=${maxed.maxChats}`);
  const addedDirect = await call("channels.wechat.addChat", { username: "wxid_smoke_direct", title: "冒烟私聊" });
  const directTarget = (addedDirect.chats ?? []).find((item) => item.username === "wxid_smoke_direct");
  check("加私聊对象默认「都回」", directTarget?.mode === "all" && directTarget?.kind === "direct");
  const addedGroup = await call("channels.wechat.addChat", { username: "12345@chatroom", title: "冒烟群" });
  const groupTarget = (addedGroup.chats ?? []).find((item) => item.username === "12345@chatroom");
  check("加群默认就是「都回」（嫌吵可在界面切到只在被 @ 时回）", groupTarget?.mode === "all" && groupTarget?.kind === "group");
const mentionBack = await call("channels.wechat.setChatMode", { username: "12345@chatroom", mode: "mention" });
check("群里也可以切成「只在被 @ 时回」", (mentionBack.chats ?? []).find((item) => item.username === "12345@chatroom")?.mode === "mention");
await call("channels.wechat.setChatMode", { username: "12345@chatroom", mode: "all" });
  const modeChanged = await call("channels.wechat.setChatMode", { username: "12345@chatroom", mode: "off" });
  check("能改群的回话模式", (modeChanged.chats ?? []).find((item) => item.username === "12345@chatroom")?.mode === "off");
  const removed = await call("channels.wechat.removeChat", { username: "wxid_smoke_direct" });
  check("能移除对话对象", !(removed.chats ?? []).some((item) => item.username === "wxid_smoke_direct"));
  check("对话对象数量不超上限", (removed.chats ?? []).length <= removed.maxChats, `chats=${(removed.chats ?? []).length}/${removed.maxChats}`);

  /* ---- 第 19 组：v0.10.0 的六项改动（头像 / 主动判定 / 通路验证 / 重置记忆） ---- */
  const tinyPng =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const avatar = await call("ui.avatar.set", { dataUrl: tinyPng });
  check("头像能存进本机（data URL）", avatar.dataUrl === tinyPng);
  const cleared = await call("ui.avatar.set", { dataUrl: null });
  check("头像能清空、回到名字首字", cleared.dataUrl === null);
  let avatarRejected = false;
  try {
    await call("ui.avatar.set", { dataUrl: "http://example.com/x.png" });
  } catch {
    avatarRejected = true;
  }
  check("非图片地址会被拒", avatarRejected);

  const tick = await call("proactive.tick", { force: true });
  check(
    "主动判定给明确结果（排了 / 被谁拦了）",
    typeof tick.queued === "boolean" && (tick.queued || typeof tick.blockedBy === "string"),
  );

  const relay = await call("proactive.verifyRelay", {});
  check("主动→微信通路如实回报（没开就说没开）", relay.ok === false && relay.message.length > 0, relay.message);

  await call("chat.send", { text: "记住：我叫测试员，生日 3 月 3 日。", clientTs: Date.now() });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const beforeReset = await call("memory.stats", {});
  const resetToken = await call("confirm.token", { action: "memory.reset" });
  const reset = await call("memory.reset", { confirmToken: resetToken.token, keepChat: false });
  check("重置记忆真的删（记忆与对话一起清）", beforeReset.total > 0 && reset.messages > 0);
  const historyAfterReset = await call("chat.history", { limit: 50 });
  const statsAfterReset = await call("memory.stats", {});
  check(
    "重置后它不再记得刚才那句",
    historyAfterReset.messages.length === 0 && statsAfterReset.total === 0,
    `历史 ${historyAfterReset.messages.length} 条 / 记忆 ${statsAfterReset.total} 条`,
  );
  // 关系数值也要归零：记忆删了、亲密度还挂着，用户看到的就是「重置了关系还在涨」
  const relationAfterReset = await call("relation.get", {});
  check(
    "重置记忆同时把关系退回陌生人（亲密归零）",
    relationAfterReset.stage === "stranger" && Number(relationAfterReset.intimacy) === 0,
    `stage=${relationAfterReset.stage} intimacy=${relationAfterReset.intimacy}`,
  );

  // 再验一次反方向：keepChat=true 时记忆清掉、对话留着（界面上的复选框就是映射到这个开关）
  await call("chat.send", { text: "第二句：我养了只猫叫豆豆。", clientTs: Date.now() });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const keepToken = await call("confirm.token", { action: "memory.reset" });
  await call("memory.reset", { confirmToken: keepToken.token, keepChat: true });
  const keptHistory = await call("chat.history", { limit: 50 });
  const keptStats = await call("memory.stats", {});
  check(
    "勾掉「清空聊天记录」时对话保留、记忆仍清零",
    keptHistory.messages.length > 0 && keptStats.total === 0,
    `历史 ${keptHistory.messages.length} 条 / 记忆 ${keptStats.total} 条`,
  );
  /* ---- 第 20 组：会话分线（群聊走独立会话键，应用内主会话不受影响） ---- */
  const groupKey = "wechat:45226657898@chatroom";
  await call("chat.send", { text: "群里测试一句", clientTs: Date.now(), conversation: groupKey });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const groupHistory = await call("chat.history", { limit: 20, conversation: groupKey });
  const appHistory = await call("chat.history", { limit: 20 });
  check(
    "群聊消息落在它自己的会话线里",
    groupHistory.messages.some((message) => String(message.text).includes("群里测试一句")),
  );
  check(
    "应用内主会话不会被群聊消息污染",
    !appHistory.messages.some((message) => String(message.text).includes("群里测试一句")),
    "主会话 " + appHistory.messages.length + " 条",
  );

  /* ---- 记忆也按会话分线：群里的记忆不会出现在私聊的记忆列表里 ---- */
  const groupMemory = await call("memory.list", { conversation: groupKey, limit: 50 });
  const appMemory = await call("memory.list", { conversation: "app", limit: 50 });
  check(
    "群会话线的记忆里有群里的对话",
    groupMemory.items.some((item) => String(item.text).includes("群里测试一句")),
    "群记忆 " + groupMemory.items.length + " 条",
  );
  check(
    "私聊的记忆列表里看不到群里的记忆",
    !appMemory.items.some((item) => String(item.text).includes("群里测试一句")),
    "私聊记忆 " + appMemory.items.length + " 条：" + appMemory.items.map((i) => `${i.channelId}|${String(i.text).slice(0, 20)}`).join(" / "),
  );
  check(
    "每条记忆都标着自己属于哪条对话线",
    groupMemory.items.every((item) => typeof item.channelId === "string"),
  );
} catch (error) {
  check("端到端流程", false, error.message);
} finally {
  try {
    socket.destroy();
  } catch {
    /* ignore */
  }
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    localFeedServer.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

const failed = results.filter((result) => !result.ok);
console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项。`);
if (failed.length > 0) {
  console.error("失败项：\n" + failed.map((item) => ` - ${item.name}${item.detail ? `：${item.detail}` : ""}`).join("\n"));
  process.exit(1);
}
console.log("✓ 内核端到端冒烟测试通过");

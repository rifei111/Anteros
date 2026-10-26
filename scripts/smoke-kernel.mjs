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

const child = spawn(process.execPath, [kernelEntry], {
  env: {
    ...process.env,
    ANTEROS_DATA_DIR: dataDir,
    ANTEROS_PIPE_NAME: pipeName,
    ANTEROS_TOKEN: token,
    ANTEROS_LOG_LEVEL: "warn",
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
    if (message.error) call.reject(new Error(`${message.error.message}（${message.error.data?.code ?? "?"}）`));
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
  check("持久化插件已注册", Array.isArray(snapshot.plugins) && snapshot.plugins.length >= 7, `plugins=${snapshot.plugins?.length}`);
  check(
    "高风险通道默认禁用",
    snapshot.plugins.some((plugin) => plugin.kind === "channel" && plugin.enabled === false),
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

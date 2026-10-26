/**
 * 测试用假插件：连接内核命名管道、按 NDJSON 收发 JSON-RPC。
 *
 * 行为由插件目录下的 mode.txt 决定：
 *  - normal ：正常握手，响应 health.check / read_since；
 *  - crash  ：握手成功后 60ms 主动退出（模拟崩溃）；
 *  - badapi ：握手声明的内核主版本是 2（应当被宿主断开）；
 *  - noauth ：握手不带正确的一次性 token（应当被宿主断开）。
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

function readMode() {
  try {
    return fs.readFileSync(path.join(process.cwd(), "mode.txt"), "utf8").trim() || "normal";
  } catch {
    return "normal";
  }
}

const mode = readMode();
const pipe = process.env.ANTEROS_PIPE_NAME ?? "";
const token = process.env.ANTEROS_TOKEN ?? "";
const pluginId = process.env.ANTEROS_PLUGIN_ID ?? "test.plugin";

if (!pipe) {
  process.stderr.write("missing ANTEROS_PIPE_NAME\n");
  process.exit(2);
}

const socket = net.connect(pipe);
socket.setEncoding("utf8");

let buffer = "";
let seq = 0;
const pending = new Map();

function send(message) {
  socket.write(JSON.stringify(message) + "\n");
}

function request(method, params) {
  const id = "p" + ++seq;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

socket.on("connect", async () => {
  const kernelApi = mode === "badapi" ? "2.0" : "1.0";
  const auth = mode === "noauth" ? "wrong-token" : token;
  const reply = await request("plugin.handshake", {
    pluginId,
    kernelApi,
    capabilities: [],
    auth,
  });
  if (reply && reply.error) {
    process.exit(1);
  }
  if (mode === "crash") {
    setTimeout(() => process.exit(1), 60);
  }
});

socket.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      continue;
    }
    if (message.method === "plugin.health.check") {
      respond(message.id, { ok: true, status: "ok", message: "healthy" });
      continue;
    }
    if (message.method === "plugin.channel.read_since") {
      respond(message.id, { messages: [], hasMore: false, waterline: Date.now() });
      continue;
    }
    if (message.id !== undefined) {
      respond(message.id, {});
    }
  }
});

socket.on("close", () => process.exit(0));
socket.on("error", () => process.exit(1));

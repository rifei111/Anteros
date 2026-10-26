/**
 * 内核进程入口。由主客户端以子进程方式启动：
 *   ELECTRON_RUN_AS_NODE=1 <electron.exe> kernel.mjs
 * 启动完成后向 stdout 打一行 JSON，主进程据此拿到管道名与版本。
 */
import { pipeNameFor, App } from "./app.js";
import { bootstrap } from "./bootstrap.js";
import { IpcServer } from "./ipc/server.js";
import { AnterosError } from "@anteros/shared";

async function main(): Promise<void> {
  const dataDir = process.env.ANTEROS_DATA_DIR;
  const token = process.env.ANTEROS_TOKEN;
  if (!token) {
    process.stderr.write("missing ANTEROS_TOKEN\n");
    process.exit(2);
  }
  const sessionId = process.env.ANTEROS_SESSION_ID ?? "default";
  const pipeName = process.env.ANTEROS_PIPE_NAME ?? pipeNameFor(sessionId);
  const tz = process.env.ANTEROS_TZ;
  const logLevel = (process.env.ANTEROS_LOG_LEVEL as "debug" | "info" | "warn" | "error" | undefined) ?? "info";

  const runtime = bootstrap({ dataDir, tz, logLevel });
  const app = new App(runtime, pipeName);
  const ipc = new IpcServer({
    pipeName,
    token,
    log: runtime.logger.child("ipc"),
    handler: (method, params) => app.call(method, params),
  });
  app.attachEmitter((method, payload) => ipc.broadcast(method, payload));
  await ipc.start();

  // 主客户端的握手行（客户端按 event === "ready" 判断，pipe 字段给出实际管道名）。
  const ready = {
    event: "ready",
    type: "ready",
    pid: process.pid,
    pipe: pipeName,
    pipeName,
    dataDir: runtime.dataDir,
    version: runtime.db.getMeta("app_version") ?? "0.1.0",
    kernelApi: "1.0",
    platform: process.platform,
    node: process.version,
    startedTs: Date.now(),
  };
  process.stdout.write(JSON.stringify(ready) + "\n");
  runtime.logger.child("main").info(`kernel ready (pid ${process.pid})`);

  let closing = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (closing) return;
    closing = true;
    runtime.logger.child("main").info(`shutdown: ${reason}`);
    try {
      await app.shutdown();
    } catch (err) {
      runtime.logger.child("main").error(`app shutdown failed: ${(err as Error).message}`);
    }
    await ipc.close();
    runtime.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    runtime.logger.child("main").error(`uncaught: ${(err as Error).stack ?? (err as Error).message}`);
    if (err instanceof AnterosError && err.code === "EVERSION") process.exit(3);
  });
  process.on("unhandledRejection", (err) => {
    runtime.logger.child("main").error(`unhandled rejection: ${String(err)}`);
  });
}

void main();
/**
 * 内置微信通道（软件本体自带，不是插件）。
 *
 * 结构：
 *   内核（TypeScript） ── NDJSON/stdio ──> sidecar.py（Python 子进程） ──> wechatauto-replica
 *                                       └─> 读本机微信数据库 / 驱动微信界面发消息
 *
 * 为什么不是插件：它要常驻、要有明确的生命周期与风险闸，还要能在插件宿主崩掉时
 * 仍然能停；而且它读写的东西（本机微信数据库）不是第三方插件该碰的。
 *
 * 默认关闭。开启必须同时满足：owner 身份 + 已过声明闸 + 前端传了 ackRisk:true。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AnterosError, ERROR_CODES } from "@anteros/shared";
import type { ErrorCode, WechatChannelStatus, WechatCheck } from "@anteros/shared";
import type { KernelDeps } from "../contracts.js";
import type { SettingsService } from "../settings.js";
import type { AuditService } from "./audit.js";
import type { ConsentService } from "./consent.js";
import type { PermissionsService } from "./permissions.js";

const DEFAULT_CHAT_USERNAME = "filehelper";
const POLL_INTERVAL_MS = 1500;
const REQUEST_TIMEOUT_MS = 20_000;
const HEALTH_TIMEOUT_MS = 90_000;
const MAX_LOG_LINES = 200;

/** 微信 4.x 桌面版可能的安装位置（只用来做存在性判断，不读它）。 */
const WECHAT_PATHS = [
  "C:\\Program Files\\Tencent\\Weixin\\Weixin.exe",
  "C:\\Program Files (x86)\\Tencent\\Weixin\\Weixin.exe",
  "C:\\Program Files\\Tencent\\WeChat\\WeChat.exe",
];

interface SidecarRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

export interface WechatChannelOptions {
  /** 把事件推给客户端（App 的 broadcast） */
  emit: (method: string, params: unknown) => void;
  /** 收到一条来自白名单会话的文本消息，交给对话编排去回 */
  onInbound: (message: { text: string; externalId: string }) => Promise<void>;
  /** 把 agent 的一条分条发回微信 */
  sendOutbound: (text: string) => void;
}

export class WechatChannelService {
  private child: ChildProcess | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer = "";
  private starting = false;
  private installing = false;
  private running = false;
  private canRead = false;
  private canSend = false;
  private account: { wxid: string; nickname: string | null } | null = null;
  private chatTitle: string | null = null;
  private sidecarVersion: string | null = null;
  private wechatautoVersion: string | null = null;
  private pythonPath: string | null = null;
  private checks: WechatCheck[] = [];
  private installLog: string[] = [];
  private lastError: string | null = null;
  private lastInboundTs: number | null = null;
  private lastOutboundTs: number | null = null;
  private inboundCount = 0;
  private outboundCount = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private sinceSeq: number | null = null;
  private deepChecksDone = false;

  constructor(
    private readonly deps: KernelDeps,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly consent: ConsentService,
    private readonly permissions: PermissionsService,
    private readonly options: WechatChannelOptions,
  ) {}

  // ---------------------------------------------------------------- 公共视图

  status(): WechatChannelStatus {
    return {
      enabled: this.isEnabled(),
      running: this.running,
      state: this.state(),
      checks: this.checks,
      account: this.account,
      chatUsername: this.chatUsername(),
      chatTitle: this.chatTitle,
      canRead: this.canRead,
      canSend: this.canSend,
      pythonPath: this.pythonPath,
      sidecarVersion: this.sidecarVersion,
      wechatautoVersion: this.wechatautoVersion,
      lastError: this.lastError,
      lastInboundTs: this.lastInboundTs,
      lastOutboundTs: this.lastOutboundTs,
      inboundCount: this.inboundCount,
      outboundCount: this.outboundCount,
      installing: this.installing,
      installLog: this.installLog.slice(-MAX_LOG_LINES),
      lastCheckTs: this.settings.getJson<number>("wechat.lastCheckTs", 0),
    };
  }

  /** 事件推送：任何状态变化都推一份全量快照，客户端不用自己拼。 */
  private publish(): void {
    this.options.emit("event.wechat", this.status());
  }

  private isEnabled(): boolean {
    return this.settings.getJson<boolean>("wechat.enabled", false) === true;
  }

  private chatUsername(): string {
    const value = this.settings.getJson<string>("wechat.chatUsername", DEFAULT_CHAT_USERNAME);
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : DEFAULT_CHAT_USERNAME;
  }

  private state(): WechatChannelStatus["state"] {
    if (!this.isEnabled()) return "off";
    if (this.starting) return "starting";
    if (!this.running) return this.lastError ? "error" : "blocked";
    if (this.checks.some((check) => check.state === "fail")) return "blocked";
    if (this.checks.some((check) => check.state === "warn") || !this.canSend) return "degraded";
    return "ready";
  }

  // ---------------------------------------------------------------- 环境体检

  /** 找 Python：设置里的 > 环境变量 > py -3 > python > python3，取第一个真能跑的 64 位 3.9+。 */
  private async detectPython(): Promise<{ command: string; args: string[]; version: string } | null> {
    const configured = this.settings.getJson<string>("wechat.pythonPath", "");
    const candidates: Array<{ command: string; args: string[] }> = [];
    if (typeof configured === "string" && configured.trim().length > 0) {
      candidates.push({ command: configured.trim(), args: [] });
    }
    const fromEnv = (process.env.ANTEROS_WECHAT_PYTHON ?? "").trim();
    if (fromEnv.length > 0) candidates.push({ command: fromEnv, args: [] });
    candidates.push({ command: "py", args: ["-3"] }, { command: "python", args: [] }, { command: "python3", args: [] });

    for (const candidate of candidates) {
      const result = await this.runProcess(candidate.command, [
        ...candidate.args,
        "-c",
        "import sys,platform;print(sys.version.split()[0]);print(platform.architecture()[0])",
      ], 10_000);
      if (!result.ok) continue;
      const lines = result.stdout.trim().split(/\r?\n/).filter((line) => line.length > 0);
      const version = lines[0] ?? "";
      const bits = lines[1] ?? "";
      const major = Number(version.split(".")[0]);
      const minor = Number(version.split(".")[1] ?? "0");
      if (major !== 3 || minor < 9) continue;
      if (!bits.includes("64")) continue;
      this.pythonPath = candidate.command === "py" ? "py -3" : candidate.command;
      return { command: candidate.command, args: candidate.args, version };
    }
    this.pythonPath = null;
    return null;
  }

  private async runProcess(
    command: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }> {
    return await new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let child: ChildProcess;
      try {
        child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        resolve({ ok: false, code: null, stdout: "", stderr: String(error) });
        return;
      }
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        resolve({ ok: false, code: null, stdout, stderr: `${stderr}\n超时（${timeoutMs}ms）` });
      }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, code: null, stdout, stderr: String(error) });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: code === 0, code, stdout, stderr });
      });
    });
  }

  private sidecarDir(): string {
    const fromEnv = (process.env.ANTEROS_WECHAT_SIDECAR_DIR ?? "").trim();
    // 环境变量给的目录也得真的有 sidecar.py 才算数：开发期/打包期路径算错时不至于把体检判死
    if (fromEnv.length > 0 && existsSync(path.join(fromEnv, "sidecar.py"))) return fromEnv;
    const here = path.dirname(fileURLToPath(import.meta.url));
    // 开发期：packages/kernel/dist/kernel.mjs -> 仓库根/integrations/wechatauto-sidecar
    // 打包后：resources/kernel/kernel.mjs -> resources/integrations/wechatauto-sidecar
    const candidates = [
      // 打包后：resources/kernel/kernel.mjs -> resources/integrations/wechatauto-sidecar
      path.resolve(here, "../integrations/wechatauto-sidecar"),
      path.resolve(here, "../../../integrations/wechatauto-sidecar"),
      path.resolve(here, "../../../../integrations/wechatauto-sidecar"),
      path.resolve(process.cwd(), "integrations/wechatauto-sidecar"),
    ];
    for (const candidate of candidates) {
      if (existsSync(path.join(candidate, "sidecar.py"))) return candidate;
    }
    return candidates[0] ?? "";
  }

  /** 本地体检（不启动 sidecar 也能跑）：Python / 依赖 / 微信装没装 / 微信在不在跑。 */
  private async runLocalChecks(): Promise<WechatCheck[]> {
    const checks: WechatCheck[] = [];

    const python = await this.detectPython();
    checks.push(
      python
        ? { id: "python", label: "Python 解释器", state: "ok", message: `找到 64 位 Python ${python.version}（${this.pythonPath}）` }
        : {
            id: "python",
            label: "Python 解释器",
            state: "fail",
            message: "没找到 64 位 Python 3.10+（32 位 Python 读不了微信内存）",
            hint: "去 python.org 装 64 位 Windows 版，安装时勾选 Add python.exe to PATH，然后回来点「重新体检」",
          },
    );

    if (python) {
      const probe = await this.runProcess(
        python.command,
        [...python.args, "-c", "import wechatauto;print(wechatauto.__version__)"],
        30_000,
      );
      if (probe.ok) {
        this.wechatautoVersion = probe.stdout.trim();
        checks.push({
          id: "library",
          label: "适配库 wechatauto-replica",
          state: "ok",
          message: `已安装 v${this.wechatautoVersion}`,
        });
      } else {
        this.wechatautoVersion = null;
        checks.push({
          id: "library",
          label: "适配库 wechatauto-replica",
          state: "fail",
          message: "Python 里还没有 wechatauto-replica",
          hint: "点「安装运行依赖」，或手动执行：python -m pip install --upgrade wechatauto-replica pypinyin",
        });
      }
    } else {
      this.wechatautoVersion = null;
      checks.push({
        id: "library",
        label: "适配库 wechatauto-replica",
        state: "fail",
        message: "没有 Python，装不了适配库",
        hint: "先把 Python 装上",
      });
    }

    const installed = WECHAT_PATHS.find((candidate) => existsSync(candidate));
    checks.push(
      installed
        ? { id: "wechat-installed", label: "微信桌面版", state: "ok", message: `找到 ${installed}` }
        : {
            id: "wechat-installed",
            label: "微信桌面版",
            state: "fail",
            message: "没找到微信 4.x 桌面版（这条通道只对接桌面客户端，不是网页版）",
            hint: "先装微信 4.x 桌面版并登录",
          },
    );

    const running = await this.isWechatRunning();
    checks.push(
      running
        ? { id: "wechat-running", label: "微信进程", state: "ok", message: "Weixin.exe 正在运行" }
        : {
            id: "wechat-running",
            label: "微信进程",
            state: "warn",
            message: "微信没在运行，读不到登录状态",
            hint: "打开微信并登录后再开这条通道",
          },
    );

    const sidecarPresent = existsSync(path.join(this.sidecarDir(), "sidecar.py"));
    checks.push(
      sidecarPresent
        ? { id: "sidecar", label: "旁路进程", state: "ok", message: `sidecar.py 在 ${this.sidecarDir()}` }
        : {
            id: "sidecar",
            label: "旁路进程",
            state: "fail",
            message: "安装目录里缺 sidecar.py（安装包不完整）",
            hint: "重装 Anteros",
          },
    );

    return checks;
  }

  private async isWechatRunning(): Promise<boolean> {
    const result = await this.runProcess("tasklist", ["/FI", "IMAGENAME eq Weixin.exe"], 10_000);
    if (result.ok) return result.stdout.toLowerCase().includes("weixin.exe");
    // tasklist 不可用时再看进程列表：/FI 过滤失败就退化成全量匹配
    const all = await this.runProcess("tasklist", [], 10_000);
    return all.stdout.toLowerCase().includes("weixin.exe");
  }

  // ---------------------------------------------------------------- 对外动作

  async refresh(): Promise<WechatChannelStatus> {
    const local = await this.runLocalChecks();
    const deep = this.running ? await this.deepChecks() : [];
    this.settings.setJson("wechat.lastCheckTs", Date.now());
    this.checks = this.mergeChecks(local, deep);
    this.publish();
    return this.status();
  }

  /** 已经拉起 sidecar 时，向它要一份更深的信息（登录账号、能不能发）。 */
  private async deepChecks(): Promise<WechatCheck[]> {
    try {
      const health = (await this.request("health", {}, HEALTH_TIMEOUT_MS)) as {
        checks?: WechatCheck[];
        account?: { wxid?: string; nickname?: string } | null;
        canRead?: boolean;
        canSend?: boolean;
      };
      this.canRead = health.canRead === true;
      this.canSend = health.canSend === true;
      this.account = health.account?.wxid
        ? { wxid: String(health.account.wxid), nickname: health.account.nickname ? String(health.account.nickname) : null }
        : null;
      this.deepChecksDone = true;
      return Array.isArray(health.checks) ? health.checks : [];
    } catch (error) {
      this.deepChecksDone = true;
      return [
        {
          id: "sidecar-health",
          label: "旁路进程体检",
          state: "fail",
          message: `旁路进程没回话：${error instanceof Error ? error.message : String(error)}`,
          hint: "看「安装运行依赖」下面的日志，或者关掉通道重开一次",
        },
      ];
    }
  }

  private mergeChecks(local: WechatCheck[], deep: WechatCheck[]): WechatCheck[] {
    const merged = [...local];
    for (const check of deep) {
      if (merged.some((item) => item.id === check.id)) continue;
      merged.push(check);
    }
    return merged;
  }

  async installDeps(): Promise<WechatChannelStatus> {
    this.permissions.assertOwner("安装微信通道运行依赖");
    if (this.installing) return this.status();
    const python = await this.detectPython();
    if (!python) {
      throw new AnterosError(
        ERROR_CODES.EBLOCKED,
        "没找到 64 位 Python 3.10+，装依赖之前先装 Python",
        { hint: "去 python.org 下载 Windows installer（64-bit），安装时勾选 Add python.exe to PATH" },
      );
    }
    this.installing = true;
    this.installLog = [];
    this.lastError = null;
    this.publish();
    this.audit.log("wechat.install_deps", { actorRole: "owner" });

    const args = [
      ...python.args,
      "-m",
      "pip",
      "install",
      "--upgrade",
      "wechatauto-replica",
      "pypinyin",
      "--disable-pip-version-check",
    ];
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(python.command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        const onData = (chunk: Buffer): void => {
          const text = chunk.toString("utf8");
          for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trimEnd();
            if (trimmed.length === 0) continue;
            this.installLog.push(trimmed);
            if (this.installLog.length > MAX_LOG_LINES) this.installLog.shift();
            this.options.emit("event.wechat.log", { line: trimmed });
          }
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.on("error", (error) => reject(error));
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new AnterosError(ERROR_CODES.EBLOCKED, `pip 退出码 ${code}，看日志最后几行`));
        });
      });
    } catch (error) {
      this.lastError = error instanceof AnterosError ? error.message : String(error);
      this.installing = false;
      this.installLog.push(`✖ ${this.lastError}`);
      await this.refresh();
      this.publish();
      return this.status();
    }
    this.installing = false;
    this.installLog.push("✔ 依赖安装完成");
    await this.refresh();
    return this.status();
  }

  async enable(input: { ackRisk: boolean; chatUsername?: string }): Promise<WechatChannelStatus> {
    this.permissions.assertOwner("开启微信通道");
    this.consent.requireConsent("app");
    if (input.ackRisk !== true) {
      throw new AnterosError(
        ERROR_CODES.EINVALID,
        "开启微信通道前必须逐条确认风险（前端的勾选框没传上来）",
        { hint: "重新打开风险确认，把五条都勾上再点确认开启" },
      );
    }
    const chatUsername = (input.chatUsername ?? "").trim();
    if (chatUsername.length > 0) {
      this.settings.setJson("wechat.chatUsername", chatUsername);
    }
    this.settings.setJson("wechat.enabled", true);
    this.audit.log("wechat.enable", { actorRole: "owner", after: { chatUsername: this.chatUsername() } });
    this.lastError = null;
    await this.refresh();
    await this.start();
    return this.status();
  }

  async disable(): Promise<WechatChannelStatus> {
    this.permissions.assertOwner("关闭微信通道");
    this.settings.setJson("wechat.enabled", false);
    this.audit.log("wechat.disable", { actorRole: "owner" });
    await this.stop();
    await this.refresh();
    return this.status();
  }

  async setChat(chatUsername: string): Promise<WechatChannelStatus> {
    this.permissions.assertOwner("设置微信通道会话");
    const value = (chatUsername ?? "").trim();
    if (value.length === 0 || value.length > 120) {
      throw new AnterosError(ERROR_CODES.EINVALID, "会话标识不合法（1–120 字符）");
    }
    this.settings.setJson("wechat.chatUsername", value);
    if (this.running) {
      try {
        await this.request("configure", { chatUsername: value }, REQUEST_TIMEOUT_MS);
        this.sinceSeq = null;
      } catch (error) {
        this.deps.log.warn(`wechat configure failed: ${(error as Error)?.message ?? String(error)}`);
      }
    }
    this.audit.log("wechat.set_chat", { actorRole: "owner", after: { chatUsername: value } });
    return this.status();
  }

  async doctor(action: "dump-account" | "diagnose-keys"): Promise<{ ok: boolean; output: string }> {
    this.permissions.assertOwner("微信通道诊断");
    if (!this.running) {
      throw new AnterosError(ERROR_CODES.EBLOCKED, "通道没在跑，先开启通道再做诊断");
    }
    const result = (await this.request("doctor", { action }, 90_000)) as { ok?: boolean; output?: string };
    return { ok: result.ok === true, output: String(result.output ?? "") };
  }

  // ---------------------------------------------------------------- 进程与协议

  async start(): Promise<void> {
    if (this.child || this.starting) return;
    if (!this.isEnabled()) return;
    this.starting = true;
    this.lastError = null;
    this.publish();

    const python = await this.detectPython();
    const sidecarDir = this.sidecarDir();
    const script = path.join(sidecarDir, "sidecar.py");
    if (!python || !existsSync(script)) {
      this.starting = false;
      this.running = false;
      this.lastError = python ? "安装目录里缺 sidecar.py" : "没找到 64 位 Python 3.10+";
      await this.refresh();
      this.publish();
      return;
    }

    try {
      // 测试口子：用一条自定义命令替换 python sidecar.py（自动化测试里跑假旁路进程）
      const override = (process.env.ANTEROS_WECHAT_SIDECAR_CMD ?? "").trim();
      const command = override.length > 0 ? override.split(/\s+/)[0]! : python.command;
      const args = override.length > 0 ? override.split(/\s+/).slice(1) : [...python.args, script];
      const child = spawn(command, args, {
        cwd: sidecarDir,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          PYTHONUNBUFFERED: "1",
          ANTEROS_WECHAT_CHAT: this.chatUsername(),
        },
      });
      this.child = child;
      child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
      child.stderr?.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split(/\r?\n/)) {
          if (line.trim().length > 0) this.deps.log.debug(`[wechat-sidecar] ${line.trim()}`);
        }
      });
      child.on("error", (error) => {
        this.lastError = `旁路进程起不来：${String(error)}`;
        this.running = false;
        this.child = null;
        this.publish();
      });
      child.on("close", (code, signal) => {
        this.running = false;
        this.child = null;
        this.stopPolling();
        if (this.isEnabled() && code !== 0) {
          this.lastError = `旁路进程退出（code=${code ?? "null"} signal=${signal ?? "null"}）`;
        }
        this.publish();
      });

      const hello = (await this.request("hello", {}, REQUEST_TIMEOUT_MS)) as {
        version?: string;
        wechatauto?: string | null;
      };
      this.sidecarVersion = typeof hello.version === "string" ? hello.version : null;
      this.wechatautoVersion = typeof hello.wechatauto === "string" ? hello.wechatauto : this.wechatautoVersion;
      await this.request("configure", { chatUsername: this.chatUsername() }, REQUEST_TIMEOUT_MS);
      this.running = true;
      this.starting = false;
      this.sinceSeq = null;
      await this.refresh();
      // 先建基线，避免把历史消息当成"刚收到"
      try {
        const baseline = (await this.request("poll", { limit: 200 }, REQUEST_TIMEOUT_MS)) as { nextSeq?: number };
        this.sinceSeq = typeof baseline.nextSeq === "number" ? baseline.nextSeq : 0;
      } catch {
        this.sinceSeq = 0;
      }
      this.startPolling();
    } catch (error) {
      this.starting = false;
      this.running = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      await this.stop();
      await this.refresh();
      this.publish();
    }
  }

  async stop(): Promise<void> {
    this.stopPolling();
    const child = this.child;
    this.child = null;
    this.running = false;
    this.canRead = false;
    this.canSend = false;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("channel stopped"));
    }
    this.pending.clear();
    if (!child) return;
    try {
      child.stdin?.write(`${JSON.stringify({ id: this.nextId++, method: "shutdown", params: {} })}\n`);
    } catch {
      // 进程已经死了就算了
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        resolve();
      }, 3000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.publish();
  }

  private startPolling(): void {
    this.stopPolling();
    const tick = async (): Promise<void> => {
      if (!this.running) return;
      try {
        await this.pollOnce();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.publish();
      }
      if (this.running) {
        this.pollTimer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
      }
    };
    this.pollTimer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollOnce(): Promise<void> {
    const sinceSeq = this.sinceSeq ?? 0;
    const result = (await this.request("poll", { sinceSeq, limit: 100 }, REQUEST_TIMEOUT_MS)) as {
      messages?: Array<{
        seq?: number;
        msgId?: string | null;
        chatUsername?: string;
        senderUsername?: string;
        isSelf?: boolean;
        kind?: string;
        text?: string | null;
      }>;
      nextSeq?: number;
    };
    if (typeof result.nextSeq === "number") this.sinceSeq = result.nextSeq;
    for (const message of result.messages ?? []) {
      if (message.isSelf === true) continue;
      if ((message.kind ?? "text") !== "text") continue;
      const text = (message.text ?? "").trim();
      if (text.length === 0) continue;
      this.lastInboundTs = Date.now();
      this.inboundCount += 1;
      this.publish();
      try {
        await this.options.onInbound({ text, externalId: String(message.msgId ?? message.seq ?? Date.now()) });
      } catch (error) {
        this.deps.log.warn(`wechat inbound failed: ${(error as Error)?.message ?? String(error)}`);
      }
    }
  }

  /** agent 的一条分条 → 微信。失败只记日志，不打断对话。 */
  send(text: string): void {
    const value = (text ?? "").trim();
    if (value.length === 0 || !this.running) return;
    void this.request("send", { text: value, chatUsername: this.chatUsername() }, 60_000)
      .then(() => {
        this.lastOutboundTs = Date.now();
        this.outboundCount += 1;
        this.publish();
      })
      .catch((error: unknown) => {
        this.lastError = `发送失败：${error instanceof Error ? error.message : String(error)}`;
        this.publish();
      });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) {
        try {
          this.onLine(JSON.parse(line) as Record<string, unknown>);
        } catch (error) {
          this.deps.log.warn(`wechat sidecar 输出不是 JSON: ${(error as Error)?.message ?? String(error)}`);
        }
      }
      index = this.buffer.indexOf("\n");
    }
  }

  private onLine(message: Record<string, unknown>): void {
    if (typeof message.event === "string") {
      this.deps.log.debug(`[wechat-sidecar] event ${message.event}`);
      return;
    }
    const id = typeof message.id === "number" ? message.id : null;
    if (id === null) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (message.ok === true) {
      pending.resolve(message.result ?? {});
      return;
    }
    const error = (message.error ?? {}) as { code?: string; message?: string; hint?: string };
    pending.reject(
      new AnterosError(
        typeof error.code === "string" && error.code in ERROR_CODES ? (error.code as ErrorCode) : ERROR_CODES.EBLOCKED,
        typeof error.message === "string" ? error.message : "旁路进程返回了错误",
        error.hint ? { hint: error.hint } : undefined,
      ),
    );
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child || !child.stdin) {
      return Promise.reject(new AnterosError(ERROR_CODES.EBLOCKED, "微信通道没在跑"));
    }
    const id = this.nextId++;
    const payload: SidecarRequest = { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AnterosError(ERROR_CODES.EBLOCKED, `旁路进程超时（${method}，${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(`${JSON.stringify(payload)}\n`);
    });
  }

  /** 内核启动时如果这条通道是开着的，就顺手拉起来；失败只记日志。 */
  async boot(): Promise<void> {
    try {
      await this.refresh();
      if (this.isEnabled()) await this.start();
    } catch (error) {
      this.deps.log.warn(`wechat channel boot failed: ${(error as Error)?.message ?? String(error)}`);
    }
  }

  async shutdown(): Promise<void> {
    await this.stop();
  }
}
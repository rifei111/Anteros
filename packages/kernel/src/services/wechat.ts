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
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { AnterosError, ERROR_CODES } from "@anteros/shared";
import type { ErrorCode, WechatChannelStatus, WechatChatTarget, WechatCheck } from "@anteros/shared";
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

/**
 * 应用内可下载的便携 Python（官方 embeddable 包，解压即用，不装进系统、不写注册表）。
 *
 * 为什么用便携包：用户不该为了这条通道去动系统 Python（PATH、版本冲突、32/64 位）。
 * 为什么钉 hash：这是会被当解释器执行的二进制，必须能证明拿到的就是这一份。
 * 如果哪天 python.org 换了文件，会明确报「校验不通过」，不会静默执行别的二进制。
 */
const EMBEDDED_PYTHON = {
  version: "3.11.9",
  url: "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip",
  sha256: "009d6bf7e3b2ddca3d784fa09f90fe54336d5b60f0e0f305c37f400bf83cfd3b",
  bytes: 11_249_023,
} as const;

/** get-pip.py 没有稳定 hash（官方每周重建），只校验它是 Python 脚本且能跑通。 */
const GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py";

/** 这条通道需要的 Python 依赖。 */
const PYTHON_PACKAGES = ["wechatauto-replica", "pypinyin"];

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
  /**
   * 收到一条来自白名单会话的文本消息，交给对话编排去回。
   * chat* 字段让上层知道「这句话是谁说的」——不同的人要各自一条对话线。
   */
  onInbound: (message: {
    text: string;
    externalId: string;
    chatUsername: string;
    chatTitle: string;
    chatKind: "direct" | "group";
    mentioned: boolean;
    /** 群聊里发言的人（昵称优先，没有就用 wxid）；私聊为空 */
    senderName?: string;
    senderId?: string;
  }) => Promise<void>;
  /** 把 agent 的一条分条发回微信（第二个参数是会话；不传就发到第一个会话） */
  sendOutbound: (text: string, chatUsername?: string) => void;
  /** 本机数据目录（便携 Python 运行环境装在这里的 wechat-runtime/ 下） */
  dataDir: string;
}

export class WechatChannelService {
  private child: ChildProcess | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer = "";
  private starting = false;
  private installing = false;
  /** 是我们自己停的（不是它自己崩的）：close 事件里别把 lastError 改成 SIGTERM。
   *  用「粘住」的标记而不是短暂窗口：close 事件是异步到的，stop() 早返回了。 */
  private stoppedByUs = false;
  /** 正在启动中的那一次（并发调用共用，别各起一个 python）。 */
  private startPromise: Promise<void> | null = null;
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
  /** 每个会话各自的水位：群聊和私聊同时盯，不能共用一个 */
  private sinceSeqByChat = new Map<string, number>();
  private deepChecksDone = false;
  /** 旁路进程是单线程的：发消息/预热期间它没法响应 poll，这段时间暂停巡检 */
  private sendInFlight = 0;
  /** 每个会话的收发计数与最近一条消息时间（状态里要按会话显示） */
  private perChat = new Map<string, { inbound: number; outbound: number; lastTs: number | null; error: string | null }>();
  /** 上层注入的队列深度查询：不同会话排队多少条，界面上要看得到 */
  private queueStats: ((username: string) => { depth: number; lastError: string | null }) | null = null;

  /** 最近收发记录：只放内存，用来回答"它到底读到了没有/发出去了没有"。 */
  private recentLog: Array<{
    ts: number;
    direction: "in" | "out";
    chat: string;
    title: string;
    text: string;
    ok: boolean;
    error: string | null;
  }> = [];

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
      relayProactive: this.settings.getJson<boolean>("wechat.relayProactive", false) === true,
      chats: this.chatsView(),
      maxChats: this.maxChats(),
      queueDepth: this.chatsView().reduce((sum, chat) => sum + chat.queueDepth, 0),
    };
  }

  /** 上层（App）在队列建好之后注入，用来把「排队几条」显示到界面上。 */
  setQueueStats(provider: (username: string) => { depth: number; lastError: string | null }): void {
    this.queueStats = provider;
  }

  /**
   * 可对话对象列表。新版存在 wechat.chats（JSON 数组），老数据只有一个
   * wechat.chatUsername —— 那里补一条，升级上来的用户不会突然变成"没有会话"。
   */
  chats(): WechatChatTarget[] {
    const stored = this.settings.getJson<unknown>("wechat.chats", null);
    const list: WechatChatTarget[] = Array.isArray(stored)
      ? (stored as WechatChatTarget[]).filter((item) => item && typeof item.username === "string" && item.username.length > 0)
      : [];
    if (list.length === 0) {
      const legacy = this.chatUsername();
      if (legacy.length > 0) {
        list.push({
          username: legacy,
          title: this.chatTitle ?? legacy,
          kind: "direct",
          mode: "all",
          inboundCount: 0,
          outboundCount: 0,
          lastMessageTs: null,
          queueDepth: 0,
          lastError: null,
        });
      }
    }
    return list;
  }

  private chatsView(): WechatChatTarget[] {
    return this.chats().map((chat) => {
      const stats = this.perChat.get(chat.username);
      const queue = this.queueStats?.(chat.username) ?? { depth: 0, lastError: null };
      return {
        ...chat,
        title: chat.title || chat.username,
        inboundCount: stats?.inbound ?? chat.inboundCount ?? 0,
        outboundCount: stats?.outbound ?? chat.outboundCount ?? 0,
        lastMessageTs: stats?.lastTs ?? chat.lastMessageTs ?? null,
        queueDepth: queue.depth,
        lastError: queue.lastError ?? stats?.error ?? chat.lastError ?? null,
      };
    });
  }

  maxChats(): number {
    const value = this.settings.getJson<number>("wechat.maxChats", 1);
    const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 1;
    return Math.min(Math.max(parsed, 1), 8);
  }

  private saveChats(chats: WechatChatTarget[]): void {
    this.settings.setJson(
      "wechat.chats",
      chats.map((chat) => ({
        username: chat.username,
        title: chat.title,
        kind: chat.kind,
        mode: chat.mode,
        inboundCount: chat.inboundCount,
        outboundCount: chat.outboundCount,
        lastMessageTs: chat.lastMessageTs,
        queueDepth: 0,
        lastError: null,
      })),
    );
  }

  /** 会话清单变化后告诉旁路进程：它只巡检这几个会话。 */
  private async pushChatsToSidecar(): Promise<void> {
    if (!this.running) return;
    try {
      await this.request("configure", { chats: this.chats().map((chat) => ({ username: chat.username, title: chat.title, kind: chat.kind })) }, REQUEST_TIMEOUT_MS);
      this.sinceSeq = null;
      this.perChat.clear();
    } catch (error) {
      this.deps.log.warn(`wechat configure failed: ${(error as Error)?.message ?? String(error)}`);
    }
  }

  /** 添加一个可对话对象（受上限约束）。 */
  async addChat(input: { username: string; title?: string; kind?: "direct" | "group"; mode?: "all" | "mention" | "off" }): Promise<WechatChannelStatus> {
    this.permissions.assertOwner("添加微信可对话对象");
    const username = (input.username ?? "").trim();
    if (username.length === 0 || username.length > 160) {
      throw new AnterosError(ERROR_CODES.EINVALID, "会话标识不合法（1–160 字符）");
    }
    const chats = this.chats().filter((chat) => chat.username !== username);
    if (chats.length >= this.maxChats()) {
      throw new AnterosError(
        ERROR_CODES.EBLOCKED,
        `已经到可对话用户上限（${this.maxChats()} 个）：先删掉一个，或者把上限调大`,
        { hint: "上限在通道页的「可对话对象」里改，最多 8 个" },
      );
    }
    const kind = input.kind ?? (username.endsWith("@chatroom") ? "group" : "direct");
    chats.push({
      username,
      title: (input.title ?? "").trim() || username,
      kind,
      mode: input.mode ?? "all",
      inboundCount: 0,
      outboundCount: 0,
      lastMessageTs: null,
      queueDepth: 0,
      lastError: null,
    });
    this.saveChats(chats);
    await this.pushChatsToSidecar();
    this.audit.log("wechat.add_chat", { actorRole: "owner", after: { username, kind } });
    this.publish();
    return this.status();
  }

  async removeChat(username: string): Promise<WechatChannelStatus> {
    this.permissions.assertOwner("删除微信可对话对象");
    const value = (username ?? "").trim();
    const chats = this.chats().filter((chat) => chat.username !== value);
    this.saveChats(chats);
    this.perChat.delete(value);
    await this.pushChatsToSidecar();
    this.audit.log("wechat.remove_chat", { actorRole: "owner", after: { username: value } });
    this.publish();
    return this.status();
  }

  async setChatMode(username: string, mode: "all" | "mention" | "off"): Promise<WechatChannelStatus> {
    this.permissions.assertOwner("设置微信会话回复策略");
    const value = (username ?? "").trim();
    const chats = this.chats().map((chat) => (chat.username === value ? { ...chat, mode } : chat));
    this.saveChats(chats);
    await this.pushChatsToSidecar();
    this.audit.log("wechat.set_chat_mode", { actorRole: "owner", after: { username: value, mode } });
    this.publish();
    return this.status();
  }

  async setMaxChats(max: number): Promise<WechatChannelStatus> {
    this.permissions.assertOwner("设置可对话用户上限");
    const value = Math.min(Math.max(Math.floor(Number.isFinite(max) ? max : 1), 1), 8);
    const chats = this.chats();
    if (value < chats.length) {
      throw new AnterosError(ERROR_CODES.EINVALID, `现在有 ${chats.length} 个可对话对象，上限不能设成比它还小`);
    }
    this.settings.setJson("wechat.maxChats", value);
    this.audit.log("wechat.set_max_chats", { actorRole: "owner", after: { max: value } });
    this.publish();
    return this.status();
  }

  /** 旁路进程读本机微信的最近会话与群，给「添加」界面挑人用（只读，不发消息）。 */
  async listCandidates(limit = 40): Promise<{ chats: Array<{ username: string; title: string; kind: "direct" | "group"; added: boolean }> }> {
    this.permissions.assertOwner("读取微信最近会话");
    if (!this.running) {
      throw new AnterosError(ERROR_CODES.EBLOCKED, "通道没在跑：先开启通道，才能读到微信里的会话");
    }
    const result = (await this.request("list-chats", { limit }, 30_000)) as {
      chats?: Array<{ username?: string; title?: string; kind?: string }>;
    };
    const existing = new Set(this.chats().map((chat) => chat.username));
    const chats = (result.chats ?? [])
      .filter((item) => typeof item.username === "string" && item.username.length > 0)
      .map((item) => ({
        username: String(item.username),
        title: String(item.title ?? item.username),
        kind: (item.kind === "group" ? "group" : "direct") as "direct" | "group",
        added: existing.has(String(item.username)),
      }));
    return { chats };
  }

  /** 主动消息要不要同时同步到微信（默认关）。 */
  setRelayProactive(enabled: boolean): WechatChannelStatus {
    this.settings.setJson("wechat.relayProactive", enabled === true);
    this.deps.log.info(`wechat relayProactive = ${enabled === true}`);
    this.publish();
    return this.status();
  }

  /** 事件推送：任何状态变化都推一份全量快照，客户端不用自己拼。 */
  private publish(): void {
    this.options.emit("event.wechat", this.status());
  }

  private pushRecent(entry: {
    direction: "in" | "out";
    chat: string;
    title: string;
    text: string;
    ok: boolean;
    error?: string | null;
  }): void {
    this.recentLog.unshift({
      ts: Date.now(),
      direction: entry.direction,
      chat: entry.chat,
      title: entry.title,
      text: entry.text.slice(0, 200),
      ok: entry.ok,
      error: entry.error ?? null,
    });
    if (this.recentLog.length > 60) this.recentLog.length = 60;
  }

  /** 最近收发（新的在前）。界面拿它当"证据"用，不靠猜。 */
  recent(limit = 20): Array<{
    ts: number;
    direction: "in" | "out";
    chat: string;
    title: string;
    text: string;
    ok: boolean;
    error: string | null;
  }> {
    return this.recentLog.slice(0, Math.max(1, Math.min(60, limit)));
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
      ...PYTHON_PACKAGES,
      "--disable-pip-version-check",
    ];
    try {
      await this.runStreaming(python.command, args, 15 * 60_000);
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

  /**
   * 一键准备这条通道需要的运行环境（应用内下载，不装系统 Python）：
   *   官方便携版 Python → 校验 sha256 → 解压到数据目录 → 开 site → get-pip → 装依赖
   * 全程只有用户点这一下，之后走的是"自己的 Python"，不污染系统、卸载删目录即可。
   */
  async installRuntime(): Promise<WechatChannelStatus> {
    this.permissions.assertOwner("下载微信通道运行环境");
    this.consent.requireConsent("app");
    if (this.installing) return this.status();
    this.installing = true;
    this.installLog = [];
    this.lastError = null;
    this.publish();
    this.audit.log("wechat.install_runtime", {
      actorRole: "owner",
      after: { python: EMBEDDED_PYTHON.version, packages: PYTHON_PACKAGES },
    });

    const baseDir = path.join(this.options.dataDir, "wechat-runtime");
    const runtimeDir = path.join(baseDir, `python-${EMBEDDED_PYTHON.version}`);
    const pythonExe = path.join(runtimeDir, "python.exe");
    try {
      if (!existsSync(pythonExe)) {
        mkdirSync(baseDir, { recursive: true });
        const zipPath = path.join(baseDir, `python-${EMBEDDED_PYTHON.version}-embed-amd64.zip`);
        await this.logLine(
          `下载便携版 Python ${EMBEDDED_PYTHON.version}（64 位，约 ${Math.round(EMBEDDED_PYTHON.bytes / 1024 / 1024)}MB）…`,
        );
        const digest = await this.download(EMBEDDED_PYTHON.url, zipPath, EMBEDDED_PYTHON.bytes);
        if (digest !== EMBEDDED_PYTHON.sha256) {
          rmSync(zipPath, { force: true });
          throw new AnterosError(
            ERROR_CODES.EBLOCKED,
            "下载下来的 Python 包校验不通过（内容和预期不一致），已删掉不执行",
            {
              hint: "可能是网络代理改写了内容。可以自己装 64 位 Python 3.10+ 后在设置里填路径，或稍后重试",
            },
          );
        }
        await this.logLine("校验通过（sha256 一致）");
        rmSync(runtimeDir, { recursive: true, force: true });
        await this.logLine("解压…");
        await this.extractZip(zipPath, runtimeDir);
        this.fixEmbeddedPth(runtimeDir);
        rmSync(zipPath, { force: true });
        await this.logLine(`便携 Python 就位：${pythonExe}`);
      } else {
        await this.logLine(`复用已下载的便携 Python：${pythonExe}`);
      }

      await this.logLine("引导 pip…");
      const getPip = path.join(runtimeDir, "get-pip.py");
      await this.download(GET_PIP_URL, getPip, 0);
      await this.runStreaming(pythonExe, [getPip, "--no-warn-script-location"], 10 * 60_000);
      rmSync(getPip, { force: true });

      await this.logLine(`安装依赖：${PYTHON_PACKAGES.join(" ")}（会联网，几分钟）…`);
      await this.runStreaming(
        pythonExe,
        ["-m", "pip", "install", "--upgrade", ...PYTHON_PACKAGES, "--disable-pip-version-check"],
        30 * 60_000,
      );

      const probe = await this.runProcess(
        pythonExe,
        ["-c", "import sys,platform,wechatauto;print(sys.version.split()[0]);print(platform.architecture()[0]);print(wechatauto.__version__)"],
        60_000,
      );
      if (!probe.ok) {
        throw new AnterosError(ERROR_CODES.EBLOCKED, "依赖装完了但 Python 里还导不进 wechatauto，看日志最后几行");
      }
      const [version = "", bits = "", libVersion = ""] = probe.stdout.trim().split(/\r?\n/);
      this.settings.setJson("wechat.pythonPath", pythonExe);
      this.settings.setJson("wechat.pythonSource", "embedded");
      await this.logLine(`✔ 运行环境就绪：Python ${version}（${bits}）+ wechatauto ${libVersion}`);
    } catch (error) {
      this.lastError = error instanceof AnterosError ? error.message : String(error);
      this.installLog.push(`✖ ${this.lastError}`);
      this.installing = false;
      await this.refresh();
      this.publish();
      return this.status();
    }

    this.installing = false;
    await this.refresh();
    return this.status();
  }

  /** 下载到文件，边下边报进度（每 10% 一条日志），返回 sha256。 */
  private async download(url: string, dest: string, expectedBytes: number): Promise<string> {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || response.body === null) {
      throw new AnterosError(ERROR_CODES.EBLOCKED, `下载失败：${url} 返回 ${response.status}`, {
        hint: "检查网络；公司代理/防火墙可能会拦 python.org 与 pypi",
      });
    }
    const total = Number(response.headers.get("content-length") ?? 0) || expectedBytes;
    const hash = createHash("sha256");
    let got = 0;
    let lastPercent = -1;
    const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    source.on("data", (chunk: Buffer) => {
      got += chunk.length;
      hash.update(chunk);
      if (total > 0) {
        const percent = Math.floor((got / total) * 100);
        if (percent >= lastPercent + 10) {
          lastPercent = percent;
          void this.logLine(`  ${percent}%  ${(got / 1024 / 1024).toFixed(1)}MB / ${(total / 1024 / 1024).toFixed(1)}MB`);
        }
      }
    });
    await pipeline(source, createWriteStream(dest));
    return hash.digest("hex");
  }

  /** 解压 zip：优先 tar.exe（Win10+ 自带，libarchive 支持 zip），失败退回 PowerShell。 */
  private async extractZip(zipPath: string, destDir: string): Promise<void> {
    mkdirSync(destDir, { recursive: true });
    const viaTar = await this.runProcess("tar.exe", ["-xf", zipPath, "-C", destDir], 5 * 60_000);
    if (viaTar.ok && existsSync(path.join(destDir, "python.exe"))) return;
    rmSync(destDir, { recursive: true, force: true });
    mkdirSync(destDir, { recursive: true });
    const viaPs = await this.runProcess(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${zipPath.replaceAll("'", "''")}' -DestinationPath '${destDir.replaceAll("'", "''")}' -Force`,
      ],
      5 * 60_000,
    );
    if (!viaPs.ok || !existsSync(path.join(destDir, "python.exe"))) {
      throw new AnterosError(ERROR_CODES.EBLOCKED, "解压 Python 包失败", { hint: "看日志；也可以手动解压后填 Python 路径" });
    }
  }

  /**
   * 便携版 Python 默认不加载 site-packages（_pth 里 import site 是注释掉的），
   * pip 装的东西就看不见。这里把 Lib\site-packages 加成搜索路径并打开 site。
   */
  private fixEmbeddedPth(runtimeDir: string): void {
    const pth = ["python311._pth", "python312._pth", "python310._pth", "python313._pth"]
      .map((name) => path.join(runtimeDir, name))
      .find((candidate) => existsSync(candidate));
    if (pth === undefined) return;
    const content = [
      `${path.basename(pth).replace("._pth", "")}.zip`,
      "Lib\\site-packages",
      ".",
      "import site",
      "",
    ].join("\r\n");
    writeFileSync(pth, content, "utf8");
    mkdirSync(path.join(runtimeDir, "Lib", "site-packages"), { recursive: true });
  }

  /** 跑一个子进程，把输出逐行写进安装日志（pip 这类会跑很久的命令都用它）。 */
  private async runStreaming(command: string, args: string[], timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new AnterosError(ERROR_CODES.EBLOCKED, `命令超时（${Math.round(timeoutMs / 60_000)} 分钟）：${command}`));
      }, timeoutMs);
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
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new AnterosError(ERROR_CODES.EBLOCKED, `命令退出码 ${code}，看日志最后几行`));
      });
    });
  }

  /** 追加一条安装日志并推到界面（下载进度、步骤提示都走这里）。 */
  private async logLine(line: string): Promise<void> {
    this.installLog.push(line);
    if (this.installLog.length > MAX_LOG_LINES) this.installLog.shift();
    this.options.emit("event.wechat.log", { line });
    this.publish();
    await Promise.resolve();
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
      const chats = this.chats();
      if (!chats.some((chat) => chat.username === chatUsername)) {
        this.saveChats([
          ...chats,
          {
            username: chatUsername,
            title: chatUsername,
            kind: chatUsername.endsWith("@chatroom") ? "group" : "direct",
            mode: "all",
            inboundCount: 0,
            outboundCount: 0,
            lastMessageTs: null,
            queueDepth: 0,
            lastError: null,
          },
        ]);
      }
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

  /** 老接口：把某个会话设成唯一的可对话对象（界面上现在用 addChat/removeChat）。 */
  async setChat(chatUsername: string): Promise<WechatChannelStatus> {
    this.permissions.assertOwner("设置微信通道会话");
    const value = (chatUsername ?? "").trim();
    if (value.length === 0 || value.length > 160) {
      throw new AnterosError(ERROR_CODES.EINVALID, "会话标识不合法（1–160 字符）");
    }
    this.settings.setJson("wechat.chatUsername", value);
    const kind: "direct" | "group" = value.endsWith("@chatroom") ? "group" : "direct";
    this.saveChats([
      {
        username: value,
        title: this.chatTitle ?? value,
        kind,
        mode: "all",
        inboundCount: 0,
        outboundCount: 0,
        lastMessageTs: null,
        queueDepth: 0,
        lastError: null,
      },
    ]);
    await this.pushChatsToSidecar();
    this.audit.log("wechat.set_chat", { actorRole: "owner", after: { chatUsername: value } });
    this.publish();
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

  /** 并发安全：boot() 与 enable() 可能同时调 start()，共用同一次启动。 */
  async start(): Promise<void> {
    // 先看有没有正在启动的那一次：那时 child 已经赋值但握手还没完成，等它更准
    if (this.startPromise !== null) return this.startPromise;
    if (this.child !== null) return;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    if (this.child !== null || this.starting) return;
    this.stoppedByUs = false;
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
          ANTEROS_WECHAT_CHATS: JSON.stringify(this.chats().map((chat) => chat.username)),
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
        if (!this.stoppedByUs && this.isEnabled() && code !== 0) {
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
      // 预热：先把目标会话打开。不预热的话，用户第一条消息要等界面驱动找窗口
      // + 搜会话（十几秒）才开始打字；预热过之后只是粘贴 + 回车。
      // 预热会占住单线程的旁路进程，所以期间暂停巡检（见 startPolling 里的 sendInFlight 判断）。
      this.sendInFlight += 1;
      void this.request("warmup", {}, 180_000)
        .then(() => {
          this.deps.log.info("wechat warmup: 目标会话已打开");
        })
        .catch((error: unknown) => {
          this.deps.log.warn(`wechat warmup 失败：${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          this.sendInFlight = Math.max(0, this.sendInFlight - 1);
        });
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
    this.stoppedByUs = true;
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
      // 旁路进程是单线程的：发消息要驱动界面（点窗口、粘贴、OCR），一次十几秒，
      // 期间它没法响应 poll。这时候再往管道里塞请求只会排队、超时、刷错误日志，
      // 所以发送期间干脆跳过这一轮巡检。
      if (this.sendInFlight === 0) {
        try {
          await this.pollOnce();
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error);
          this.publish();
        }
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
    const targets = this.chats();
    if (targets.length === 0) return;
    const result = (await this.request(
      "poll",
      {
        sinceSeq: this.sinceSeq ?? 0,
        limit: 100,
        chats: targets.map((chat) => ({
          username: chat.username,
          title: chat.title,
          kind: chat.kind,
          sinceSeq: this.sinceSeqByChat.get(chat.username) ?? 0,
        })),
      },
      REQUEST_TIMEOUT_MS,
    )) as {
      messages?: Array<{
        seq?: number;
        msgId?: string | null;
        chatUsername?: string;
        chatTitle?: string;
        chatKind?: string;
        senderUsername?: string;
        senderTitle?: string;
        isSelf?: boolean;
        kind?: string;
        text?: string | null;
        mentioned?: boolean;
      }>;
      nextSeq?: number;
      nextSeqs?: Record<string, number>;
      error?: string;
    };
    if (result.error && String(result.error).length > 0) {
      this.lastError = "读消息出错：" + String(result.error);
    }
    for (const [username, value] of Object.entries(result.nextSeqs ?? {})) {
      if (typeof value === "number") this.sinceSeqByChat.set(username, value);
    }
    if (typeof result.nextSeq === "number") {
      this.sinceSeq = Math.max(this.sinceSeq ?? 0, result.nextSeq);
    }

    for (const message of result.messages ?? []) {
      if (message.isSelf === true) continue;
      // 旁路进程负责把上游的中文类型归一成 text/image/…，这里再兜一层：
      // 只处理文本，但两种写法都认（历史上中文 kind 被直接透传过，导致消息全被丢掉）
      const kind = String(message.kind ?? "text").trim().toLowerCase();
      if (kind !== "text" && kind !== "文本") continue;
      const text = (message.text ?? "").trim();
      if (text.length === 0) continue;
      const chatUsername = String(message.chatUsername ?? "").trim();
      // 认不出是哪个会话的消息不能乱记到第一个会话头上（以前就是这么串线的）
      const target = targets.find((chat) => chat.username === chatUsername);
      if (!target) continue;
      // 只看不回：连计数都不动，免得界面上以为它在处理
      if (target.mode === "off") continue;
      // 群聊默认跟着所有消息回；切成「只在被 @ 时回」的，非 @ 消息就不接
      if (target.kind === "group" && target.mode === "mention" && message.mentioned !== true) continue;
      this.lastInboundTs = Date.now();
      this.inboundCount += 1;
      const stats = this.perChat.get(target.username) ?? { inbound: 0, outbound: 0, lastTs: null, error: null };
      stats.inbound += 1;
      stats.lastTs = Date.now();
      this.perChat.set(target.username, stats);
      this.pushRecent({
        direction: "in",
        chat: target.username,
        title: target.title,
        text,
        ok: true,
      });
      this.publish();
      const senderName = String(message.senderTitle ?? "").trim();
      const senderId = String(message.senderUsername ?? "").trim();
      try {
        await this.options.onInbound({
          text,
          externalId: String(message.msgId ?? message.seq ?? Date.now()),
          chatUsername: target.username,
          chatTitle: target.title,
          chatKind: target.kind,
          mentioned: message.mentioned === true,
          senderName: target.kind === "group" ? senderName || senderId : undefined,
          senderId: target.kind === "group" ? senderId : undefined,
        });
      } catch (error) {
        this.deps.log.warn("wechat inbound failed: " + ((error as Error)?.message ?? String(error)));
      }
    }
  }

  /** agent 的一条分条 → 微信。失败只记日志，不打断对话。 */
  send(text: string, chatUsername?: string): void {
    const value = (text ?? "").trim();
    if (value.length === 0) return;
    const target = this.resolveTarget(chatUsername);
    if (!this.running) {
      // 别静默丢：通道没在跑的时候，外界看到的现象就是"只在本地回、微信没动"，
      // 所以这里必须留痕，并把原因挂到状态上让界面能显示。
      this.pushRecent({
        direction: "out",
        chat: target.username,
        title: target.title,
        text: value,
        ok: false,
        error: "通道没在运行",
      });
      this.lastError = "消息没发出去：微信通道没在运行（去通道页看一下是关着还是异常）";
      this.deps.log.warn(`[wechat] 丢弃一条外发消息（通道未运行）：${value.slice(0, 24)}`);
      this.publish();
      return;
    }
    this.sendInFlight += 1;
    void this.request("send", { text: value, ...this.sendParams(target) }, 60_000)
      .then(() => {
        this.lastOutboundTs = Date.now();
        this.outboundCount += 1;
        this.pushRecent({
          direction: "out",
          chat: target.username,
          title: target.title,
          text: value,
          ok: true,
        });
        const stats = this.perChat.get(target.username) ?? { inbound: 0, outbound: 0, lastTs: null, error: null };
        stats.outbound += 1;
        stats.lastTs = Date.now();
        this.perChat.set(target.username, stats);
        this.publish();
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.pushRecent({
          direction: "out",
          chat: target.username,
          title: target.title,
          text: value,
          ok: false,
          error: message,
        });
        this.lastError = `发送失败：${message}`;
        this.deps.log.warn(`[wechat] 发送失败：${message}`);
        this.publish();
      })
      .finally(() => {
        this.sendInFlight = Math.max(0, this.sendInFlight - 1);
      });
  }

  /** 带结果的发送：给「验证主动消息 → 微信」这类需要如实回报的路径用。 */
  async sendAsync(text: string, chatUsername?: string): Promise<{ ok: boolean; error?: string }> {
    const value = (text ?? "").trim();
    if (value.length === 0) return { ok: false, error: "内容为空" };
    if (!this.running) return { ok: false, error: "微信通道没有运行：先在通道页开启它" };
    const target = this.resolveTarget(chatUsername);
    this.sendInFlight += 1;
    try {
      await this.request("send", { text: value, ...this.sendParams(target) }, 60_000);
      this.lastOutboundTs = Date.now();
      this.outboundCount += 1;
      this.publish();
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = `发送失败：${message}`;
      this.publish();
      return { ok: false, error: message };
    } finally {
      this.sendInFlight = Math.max(0, this.sendInFlight - 1);
    }
  }

  /** 找要发的会话：给了 username 用它，否则用第一个；一个都没有就报错说明白。 */
  private resolveTarget(chatUsername?: string): WechatChatTarget {
    const chats = this.chats();
    const wanted = (chatUsername ?? "").trim();
    const found = wanted.length > 0 ? chats.find((chat) => chat.username === wanted) : undefined;
    if (found) return found;
    if (wanted.length > 0) {
      // 目标会话不在白名单里也不能退回 chats[0]：那会把群里的回复发到白名单那个人身上。
      // 显示名由旁路按 wxid 自己解析，这里只需要带上身份与类型。
      return {
        username: wanted,
        title: wanted,
        kind: wanted.endsWith("@chatroom") ? "group" : "direct",
        mode: "all",
        inboundCount: 0,
        outboundCount: 0,
        lastMessageTs: null,
        queueDepth: 0,
        lastError: null,
      };
    }
    const first = chats[0];
    if (first) return first;
    return {
      username: DEFAULT_CHAT_USERNAME,
      title: DEFAULT_CHAT_USERNAME,
      kind: "direct",
      mode: "all",
      inboundCount: 0,
      outboundCount: 0,
      lastMessageTs: null,
      queueDepth: 0,
      lastError: null,
    };
  }

  private sendParams(target: WechatChatTarget): Record<string, unknown> {
    return {
      chatUsername: target.username,
      chatTitle: target.title,
      chatKind: target.kind,
      // 群聊里回话时 @ 一下说话的人，别让整群人以为在跟自己说
      mention: target.kind === "group",
    };
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
    // sidecar 两种回包都认：{ok:true,result} 与标准 {result}（老版本/新版本兼容）
    if (message.error === undefined || message.error === null) {
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
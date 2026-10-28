/**
 * 组合根：把脑子（mind/memory/expression）、服务（chat/proactive）、插件宿主、
 * 导出与系统服务装在一起，并把 KernelApi 的每个方法路由到具体实现。
 *
 * 这里是唯一知道"全部零件"的地方；其它模块之间只通过 contracts.ts 的端口通信，
 * 这样内核在没有插件时也能跑（草案 14.9 第 14 条）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KERNEL_API_VERSION, PIPE_PREFIX, AnterosError, ERROR_CODES } from "@anteros/shared";
import type {
  AppSnapshot,
  ChannelInfo,
  HandshakeResult,
  LlmStatus,
  Persona,
  PersonaBlueprint,
  PluginInfo,
  ProactiveSummary,
  TurnReplay,
} from "@anteros/shared";
import type { Runtime } from "./bootstrap.js";
import type { ChatDeps, ExpressionPort, KernelDeps, MemoryPort, MindPort, PluginHostPort } from "./contracts.js";
import { loadOrCreateMasterKey } from "./util/crypto.js";
import { LlmClient } from "./llm/client.js";
import { probeProvider } from "./llm/probe.js";
import { MemoryService } from "./memory/service.js";
import { MindService } from "./mind/service.js";
import { ExpressionService } from "./expression/service.js";
import { PluginService } from "./services/plugins.js";
import { ChannelService } from "./services/channels.js";
import { WechatChannelService } from "./services/wechat.js";
import { ExportService } from "./services/export.js";
import { ResetService } from "./services/reset.js";
import { SystemService } from "./services/system.js";
import { ChatService } from "./services/chat.js";
import { ProactiveService } from "./services/proactive.js";

export function pipeNameFor(sessionId: string): string {
  const suffix = sessionId.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 32) || "default";
  return `\\\\.\\pipe\\${PIPE_PREFIX}-${suffix}`;
}

/** 用户自己换模型服务时用的那个插件（可选的代理层，不是唯一通路） */
const ROUTER_PLUGIN_ID = "core.llm-router";

/**
 * 插件目录解析：开发期在仓库根 `plugins/`，打包后在 `resources/plugins/`
 * （内核 bundle 位于 `resources/kernel/kernel.mjs`，`../plugins` 正好是它）。
 */
export function resolvePluginsDir(): string {
  const candidates: string[] = [];
  const override = process.env.ANTEROS_PLUGINS_DIR;
  if (override) candidates.push(override);
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.resolve(here, "..", "plugins"));
    candidates.push(path.resolve(here, "..", "..", "plugins"));
    candidates.push(path.resolve(here, "..", "..", "..", "plugins"));
  } catch {
    // import.meta.url 不可用时忽略
  }
  candidates.push(path.resolve(process.cwd(), "plugins"));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0] ?? path.resolve("plugins");
}

type Emitter = (method: string, params: unknown) => void;

export class App {
  private readonly deps: KernelDeps;
  private readonly llm: LlmClient;
  private readonly memory: MemoryPort;
  private readonly mind: MindPort;
  private readonly expression: ExpressionPort;
  private readonly plugins: PluginService;
  private readonly pluginHost: PluginHostPort;
  private readonly channels: ChannelService;
  private readonly exporter: ExportService;
  private readonly system: SystemService;
  private readonly chat: ChatService;
  private readonly proactive: ProactiveService;
  private readonly reset: ResetService;
  private readonly wechat: WechatChannelService;
  private readonly startedTs = Date.now();
  private readonly sessionId: string;
  private emit: Emitter = () => undefined;
  private shuttingDown = false;

  constructor(
    private readonly runtime: Runtime,
    pipeName: string,
  ) {
    this.deps = runtime.deps;
    this.sessionId = pipeName.split("-").slice(-1)[0] ?? "default";
    const masterKey = loadOrCreateMasterKey(runtime.dataDir);
    this.llm = new LlmClient(runtime.settings, masterKey);

    this.memory = new MemoryService(this.deps, this.llm);
    this.mind = new MindService(this.deps, this.memory, this.llm);
    this.expression = new ExpressionService(this.deps, this.mind, this.memory, this.llm);

    const pluginsDir = resolvePluginsDir();
    this.plugins = new PluginService(this.deps, runtime.permissions, runtime.audit, runtime.consent, {
      pluginsDir,
    });
    this.pluginHost = this.plugins;
    this.channels = new ChannelService(this.deps, this.plugins);
    this.exporter = new ExportService(this.deps, { dataDir: runtime.dataDir });
    this.system = new SystemService(this.deps, { plugins: this.plugins, channels: this.channels });
    this.reset = new ResetService(this.deps.db, runtime.dataDir, runtime.logger.child("reset"), {
      extraRuntimeDirs: ["wechat-runtime"],
      extraSettingPrefixes: [{ prefix: "wechat.", label: "运行环境" }],
    });

    const ports: ChatDeps = {
      deps: this.deps,
      memory: this.memory,
      mind: this.mind,
      expression: this.expression,
      llm: this.llm,
      pluginHost: this.pluginHost,
      emit: (method, params) => this.emit(method, params),
      recordCost: (input) =>
        runtime.cost.record({
          kind: input.kind as "reply" | "proactive" | "impulse" | "extract" | "world" | "embedding",
          model: input.model,
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
        }),
    };
    this.chat = new ChatService({ deps: this.deps, ports, consent: runtime.consent, cost: runtime.cost, audit: runtime.audit });
    this.wechat = new WechatChannelService(this.deps, runtime.settings, runtime.audit, runtime.consent, runtime.permissions, {
      emit: (method, params) => this.emit(method, params),
      // 收到白名单会话的消息：当成用户说的话走同一套对话编排，agent 的每条分条再转回微信
      onInbound: async ({ text, externalId }) => {
        await this.chat.send({
          text,
          eventId: `wechat:${externalId}`,
          onPart: (part) => this.wechat.send(part),
        });
      },
      sendOutbound: (text) => this.wechat.send(text),
      dataDir: this.runtime.dataDir,
    });
    this.proactive = new ProactiveService(this.deps, ports, runtime.consent, runtime.cost, runtime.settings);
    // 主动消息的第二个出口：通道可用且开关打开时才真的发出去（判断逻辑留在通道层）
    this.proactive.setRelay({
      deliver: (text) => this.wechat.sendAsync(text),
      enabled: () => {
        const status = this.wechat.status();
        return status.enabled && status.relayProactive;
      },
      ready: () => this.wechat.status().state === "ready",
    });
    this.proactive.start();
  }

  attachEmitter(emit: Emitter): void {
    this.emit = emit;
    (this.plugins as unknown as { attachEvents?: (handler: Emitter) => void }).attachEvents?.(emit);
  }

  /**
   * 启动插件宿主与通道轮询（草案 14.14.2：插件可以死，内核不能死）。
   * 不阻塞 ready：插件起不来只影响对应能力，App 内对话照常。
   */
  async start(): Promise<void> {
    try {
      await this.plugins.start();
      void this.wechat.boot();
      this.deps.log.info?.(`plugin host started: ${this.plugins.list().filter((item) => item.status === "running").length} running`);
    } catch (error) {
      this.deps.log.warn?.(`plugin host start failed: ${(error as Error).message}`);
    }
    try {
      this.channels.start();
    } catch (error) {
      this.deps.log.warn?.(`channel poller start failed: ${(error as Error).message}`);
    }
  }

  /** 用户刚过声明闸：把 blocked 且仍标记为启用的插件再拉一次（幂等，失败只降级）。 */
  async resumePluginsAfterConsent(): Promise<void> {
    for (const info of this.plugins.list()) {
      if (!info.enabled || info.status !== "blocked") continue;
      try {
        await this.plugins.enable(info.id);
        this.deps.log.info?.(`plugin enabled after consent: ${info.id}`);
      } catch (error) {
        this.deps.log.warn?.(`plugin still blocked after consent: ${info.id} — ${(error as Error).message}`);
      }
    }
  }

  /* --------------------------------------------------------------- */
  /* 路由                                                             */
  /* --------------------------------------------------------------- */

  async call(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, any>;
    switch (method) {
      case "client.handshake":
        return this.handshake();

      case "state.snapshot":
        return this.snapshot();

      /* ---------------- 对话 ---------------- */
      case "chat.history": {
        const limit = Math.min(Math.max(Number(p.limit ?? 60), 1), 300);
        let beforeId: number | undefined;
        if (typeof p.beforeTs === "number") {
          beforeId = this.deps.db.get<{ id: number }>(
            "SELECT id FROM messages WHERE agent_id = ? AND ts <= ? ORDER BY id DESC LIMIT 1",
            [this.deps.agentId, p.beforeTs],
          )?.id;
        }
        const rows = this.deps.db.all<{ id: number }>(
          beforeId
            ? "SELECT id FROM messages WHERE agent_id = ? AND id < ? ORDER BY id DESC LIMIT ?"
            : "SELECT id FROM messages WHERE agent_id = ? ORDER BY id DESC LIMIT ?",
          beforeId ? [this.deps.agentId, beforeId, limit + 1] : [this.deps.agentId, limit + 1],
        );
        const hasMore = rows.length > limit;
        const ids = rows.slice(0, limit).map((row) => row.id).reverse();
        const messages = ids.map((id) => this.chat.getMessage(id));
        return { messages, hasMore };
      }
      case "chat.send":
        return this.chat.send({
          text: String(p.text ?? ""),
          eventId: typeof p.eventId === "string" ? p.eventId : undefined,
          clientTs: typeof p.clientTs === "number" ? p.clientTs : undefined,
          presence: p.presence,
        });
      case "chat.typing": {
        this.mind.touchPresence(p.isTyping ? "phone_in_hand" : "idle", "behavior");
        return { ack: true };
      }
      case "chat.markRead": {
        const lastTs = Number(p.lastTs ?? Date.now());
        this.deps.db.run("UPDATE messages SET client_ack_ts = ? WHERE agent_id = ? AND role = 'agent' AND ts <= ? AND client_ack_ts IS NULL", [
          Date.now(),
          this.deps.agentId,
          lastTs,
        ]);
        return { ack: true };
      }
      case "chat.recall":
        return { message: this.chat.recall(Number(p.messageId)) };

      /* ---------------- 记忆 ---------------- */
      case "memory.search": {
        const result = this.memory.recall({
          agentId: this.deps.agentId,
          text: String(p.query ?? ""),
          now: Date.now(),
          topK: typeof p.topK === "number" ? p.topK : 8,
        });
        return result;
      }
      case "memory.list":
        return this.memory.list({
          agentId: this.deps.agentId,
          kind: p.kind,
          importance: p.importance,
          limit: Math.min(Number(p.limit ?? 50), 200),
          offset: Number(p.offset ?? 0),
        });
      case "memory.get":
        return { item: this.memory.get(this.deps.agentId, Number(p.id)) };
      case "memory.delete":
        return { deleted: this.memory.softDelete(this.deps.agentId, Number(p.id), Date.now()) };
      case "memory.deleteAll": {
        this.runtime.permissions.assertOwner("清空记忆");
        this.runtime.permissions.consumeConfirm(p.confirmToken, "memory.deleteAll");
        const deleted = this.memory.deleteAll(this.deps.agentId, Date.now());
        this.runtime.audit.log("memory.delete_all", { actorRole: "owner", after: { deleted } });
        return { deleted };
      }
      case "memory.stats":
        return this.memory.stats(this.deps.agentId);
      case "memory.reset": {
        this.runtime.permissions.assertOwner("重置记忆");
        this.runtime.permissions.consumeConfirm(p.confirmToken, "memory.reset");
        const keepChat = p.keepChat === true;
        const result = this.reset.resetMemory(this.deps.agentId, { keepChat });
        this.runtime.audit.log("memory.reset", { actorRole: "owner", after: { ...result, keepChat } });
        return result;
      }
      case "memory.export": {
        const file = path.join(this.runtime.dirs.exports, `memory-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
        const payload = {
          exportedTs: Date.now(),
          items: this.memory.list({ agentId: this.deps.agentId, limit: 5000, offset: 0 }),
          stats: this.memory.stats(this.deps.agentId),
        };
        fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
        this.runtime.audit.log("memory.export", { actorRole: "owner", after: { file } });
        return { path: file, bytes: fs.statSync(file).size };
      }

      /* ---------------- 声明闸 ---------------- */
      case "consent.status":
        return this.runtime.consent.status("app");
      case "consent.accept": {
        const status = this.runtime.consent.accept({
          docVersion: String(p.docVersion ?? ""),
          checkedIds: Array.isArray(p.checkedIds) ? p.checkedIds.map(String) : [],
          channel: p.channel ?? "app",
        });
        this.runtime.audit.log("consent.accept", { actorRole: "owner", after: { docVersion: status.docVersion } });
        this.emit("event.consent", status);
        // 声明闸过了，把首启时因"还没同意"而卡在 blocked 的默认插件补起来。
        void this.resumePluginsAfterConsent();
        return status;
      }
      case "consent.revoke": {
        const status = this.runtime.consent.revoke("app");
        this.runtime.audit.log("consent.revoke", { actorRole: "owner" });
        this.emit("event.consent", status);
        return status;
      }

      /* ---------------- 人格/关系 ---------------- */
      case "persona.get":
        return this.mind.getPersona();
      case "persona.update": {
        this.runtime.permissions.assertOwner("修改人格");
        const persona = this.mind.updatePersona((p.patch ?? {}) as Partial<Persona>);
        this.runtime.audit.log("persona.update", { actorRole: "owner", before: null, after: { name: persona.name } });
        return persona;
      }
      case "persona.presets":
        return { presets: this.mind.listPresets() };
      case "persona.compile": {
        this.runtime.permissions.assertOwner("编译人设文本");
        this.runtime.consent.requireConsent();
        const text = String(p.text ?? "").trim();
        if (text.length < 4) {
          throw new AnterosError(ERROR_CODES.EINVALID, "人设太短了：至少写一句她是谁、做什么、什么脾气");
        }
        const compiled = await this.mind.compileBlueprint(text.slice(0, 4000));
        if (compiled.usage !== null) {
          this.runtime.cost.record({
            kind: "persona",
            model: compiled.usage.model,
            inputTokens: compiled.usage.inputTokens,
            outputTokens: compiled.usage.outputTokens,
          });
        }
        return compiled;
      }
      case "persona.applyBlueprint": {
        this.runtime.permissions.assertOwner("应用人格内核");
        const blueprint = p.blueprint as PersonaBlueprint | undefined;
        if (blueprint === undefined || blueprint === null) {
          throw new AnterosError(ERROR_CODES.EINVALID, "缺少要应用的人格内核草稿");
        }
        const persona = this.mind.applyBlueprint(blueprint);
        this.runtime.audit.log("persona.apply_blueprint", {
          actorRole: "owner",
          after: { name: persona.name, engine: blueprint.engine, sourceLength: blueprint.sourceText.length },
        });
        return persona;
      }
      case "persona.applyPreset": {
        this.runtime.permissions.assertOwner("套用人格预设");
        return this.mind.applyPreset(String(p.presetId));
      }
      case "ui.avatar.get":
        return { dataUrl: this.avatarDataUrl() };
      case "ui.avatar.set": {
        this.runtime.permissions.assertOwner("修改聊天对象头像");
        const raw = typeof p.dataUrl === "string" ? p.dataUrl.trim() : "";
        if (raw !== "" && !raw.startsWith("data:image/")) {
          throw new AnterosError(ERROR_CODES.EINVALID, "头像必须是图片（data:image/... 形式）");
        }
        // 2MB 的 data URL 已经够一张头像；再大就不要往 SQLite 里塞了
        if (raw.length > 2_000_000) {
          throw new AnterosError(ERROR_CODES.EINVALID, "这张图太大了（超过约 1.5MB），换一张小一点的");
        }
        this.runtime.settings.set("ui.agentAvatar", raw);
        this.runtime.audit.log("ui.avatar_set", { actorRole: "owner", after: { bytes: raw.length } });
        return { dataUrl: this.avatarDataUrl() };
      }
      case "relation.get":
        return this.mind.getRelation();
      case "relation.setMode": {
        this.runtime.permissions.assertOwner("切换完全体模式");
        this.runtime.permissions.consumeConfirm(p.confirmToken, "relation.setMode", String(p.mode));
        const relation = this.mind.setMode(p.mode);
        this.runtime.audit.log("relation.set_mode", { actorRole: "owner", after: { mode: p.mode } });
        this.emit("event.relation", relation);
        return relation;
      }
      case "relation.ledger": {
        const rows = this.deps.db.all<{ id: number; ts: number; situation: string; chosen: string; given_up: string; user_reaction: string | null }>(
          "SELECT * FROM decision_ledger WHERE agent_id = ? ORDER BY id DESC LIMIT ?",
          [this.deps.agentId, Math.min(Number(p.limit ?? 50), 200)],
        );
        return {
          entries: rows.map((row) => ({
            id: row.id,
            ts: row.ts,
            situation: row.situation,
            chosen: row.chosen,
            givenUp: row.given_up,
            userReaction: row.user_reaction,
          })),
        };
      }

      /* ---------------- owner / 确认 ---------------- */
      case "owner.status":
        return this.runtime.permissions.ownerStatus();
      case "confirm.token": {
        this.runtime.permissions.assertOwner("该操作");
        return this.runtime.permissions.createConfirm(String(p.action ?? "unknown"), p.target ? String(p.target) : undefined);
      }

      /* ---------------- 插件 ---------------- */
      case "plugins.list":
        return this.plugins.list();
      case "plugins.enable": {
        this.runtime.permissions.assertOwner("启用插件");
        return this.plugins.enable(String(p.id), typeof p.confirmToken === "string" ? p.confirmToken : undefined);
      }
      case "plugins.disable":
        this.runtime.permissions.assertOwner("停用插件");
        return this.plugins.disable(String(p.id));
      case "plugins.grant": {
        this.runtime.permissions.assertOwner("授予插件能力");
        return this.plugins.grant(String(p.id), Array.isArray(p.permissions) ? p.permissions.map(String) : [], p.confirmToken);
      }
      case "plugins.config.put":
        return this.plugins.setConfig(String(p.id), (p.config ?? {}) as Record<string, unknown>);
      case "plugins.secret.put": {
        await this.runtime.consent.requireConsent();
        return this.plugins.setSecret(String(p.id), String(p.name), String(p.value ?? ""));
      }
      case "plugins.secret.delete":
        return this.plugins.deleteSecret(String(p.id), String(p.name));
      case "plugins.restart":
        this.runtime.permissions.assertOwner("重启插件");
        return this.plugins.restart(String(p.id));

      /* 插件运行环境：下载 / 校验 / 增量升级 / 卸载（v0.5） */
      case "plugins.runtime.status":
        this.runtime.permissions.assertOwner("读取插件运行环境");
        return this.plugins.runtimeStatus(String(p.id));
      case "plugins.runtime.check":
        return this.plugins.runtimeCheck(String(p.id));
      case "plugins.runtime.install":
        return this.plugins.runtimeInstall(String(p.id));
      case "plugins.runtime.uninstall":
        return this.plugins.runtimeUninstall(String(p.id));
      case "plugins.runtime.feed":
        return this.plugins.runtimeFeed(typeof p.url === "string" ? p.url : undefined);

      /* ---------------- 通道 ---------------- */
      case "channels.list":
        return this.channelsWithBuiltin();
      case "channels.panicStop": {
        this.runtime.permissions.assertOwner("一键停用");
        const result = await this.plugins.panicStop();
        this.runtime.audit.log("channels.panic_stop", { actorRole: "owner", after: result });
        this.emit("event.channels", this.channels.list());
        return result;
      }
      case "channels.wechat.status":
        return this.wechat.refresh();
      case "channels.wechat.installDeps":
        return this.wechat.installDeps();
      case "channels.wechat.installRuntime":
        return this.wechat.installRuntime();
      case "channels.wechat.enable": {
        const input = (params ?? {}) as { ackRisk?: unknown; chatUsername?: unknown };
        return this.wechat.enable({
          ackRisk: input.ackRisk === true,
          chatUsername: typeof input.chatUsername === "string" ? input.chatUsername : undefined,
        });
      }
      case "channels.wechat.disable":
        return this.wechat.disable();
      case "channels.wechat.setChat": {
        const input = (params ?? {}) as { chatUsername?: unknown };
        return this.wechat.setChat(String(input.chatUsername ?? ""));
      }
      case "channels.wechat.doctor": {
        const input = (params ?? {}) as { action?: unknown };
        return this.wechat.doctor(input.action === "dump-account" ? "dump-account" : "diagnose-keys");
      }
      case "channels.wechat.setRelay": {
        this.runtime.permissions.assertOwner("设置主动消息同步微信");
        const input = (params ?? {}) as { enabled?: unknown };
        const status = this.wechat.setRelayProactive(input.enabled === true);
        this.runtime.audit.log("wechat.setRelay", {
          actorRole: "owner",
          after: { enabled: status.relayProactive },
        });
        return status;
      }
      /** 验证「主动消息 → 微信」这条路：真发一条带标记的自检消息，如实回报成败。 */
      case "proactive.verifyRelay": {
        this.runtime.permissions.assertOwner("验证主动消息通路");
        await this.runtime.consent.requireConsent();
        const input = (params ?? {}) as { text?: unknown };
        const text = typeof input.text === "string" && input.text.trim().length > 0
          ? input.text.trim()
          : "【自检】这是一条主动消息通路检查：你在微信里看到它，说明这条线是通的。";
        const sent = await this.wechat.sendAsync(text);
        this.runtime.audit.log("proactive.verifyRelay", {
          actorRole: "owner",
          after: { ok: sent.ok, error: sent.error ?? null },
        });
        return {
          ok: sent.ok,
          message: sent.ok
            ? "已经发到微信会话了：去那个会话里看看有没有收到。"
            : sent.error ?? "发送失败，原因不明。",
        };
      }

      /* ---------------- 世界 / 动机 / 主动 ---------------- */
      case "world.state":
        return this.mind.getWorld(Date.now());
      case "drives.state":
        return this.mind.getDrives();
      case "proactive.list": {
        const all = this.proactive.list(80);
        return {
          pending: all.filter((action) => action.state === "queued" || action.state === "quarantined"),
          recent: all.filter((action) => action.state !== "queued" && action.state !== "quarantined"),
        };
      }
      case "proactive.setFrequency": {
        this.runtime.permissions.assertOwner("调整主动频率");
        const result = this.proactive.setFrequency(p.level);
        this.runtime.audit.log("proactive.set_frequency", { actorRole: "owner", after: { level: p.level } });
        return { level: result.level };
      }
      case "proactive.tick": {
        this.runtime.permissions.assertOwner("立即触发一次主动判定");
        const result = this.proactive.tickNow(p.force === true);
        this.runtime.audit.log("proactive.tick", { actorRole: "owner", after: { ...result, force: p.force === true } });
        return result;
      }

      /* ---------------- 回放 / 成本 / 模型 ---------------- */
      case "turns.list": {
        const rows = this.deps.db.all<{ id: number; created_ts: number; trigger: string; outcome: string | null }>(
          "SELECT id, created_ts, trigger, outcome FROM turns WHERE agent_id = ? ORDER BY id DESC LIMIT ?",
          [this.deps.agentId, Math.min(Number(p.limit ?? 30), 200)],
        );
        return { turns: rows.map((row) => ({ id: row.id, ts: row.created_ts, trigger: row.trigger, outcome: row.outcome })) };
      }
      case "turn.replay":
        return this.replay(Number(p.turnId));
      case "cost.summary":
        return this.runtime.cost.summary();
      case "cost.setBudget": {
        this.runtime.permissions.assertOwner("调整预算");
        const summary = this.runtime.cost.setBudget(Number(p.monthlyCny));
        this.emit("event.cost", summary);
        return summary;
      }
      case "llm.status":
        return this.llmStatus();
      case "llm.test": {
        // 探测不写任何东西：地址、密钥、模型都可能只是"试着用一下"。
        const saved = this.llm.status();
        const apiKey =
          typeof p.apiKey === "string" && p.apiKey.trim().length > 0 ? p.apiKey.trim() : this.llm.apiKeyForProbe();
        const result = await probeProvider({
          baseUrl:
            typeof p.baseUrl === "string" && p.baseUrl.trim().length > 0
              ? p.baseUrl.trim()
              : (saved.baseUrl ?? this.runtime.settings.get("llm.baseUrl")),
          apiKey,
          model:
            typeof p.model === "string" && p.model.trim().length > 0
              ? p.model.trim()
              : (saved.model ?? this.runtime.settings.get("llm.model")),
        });
        this.deps.log.info?.(
          `[app] 模型探测 ${result.ok ? "通过" : "失败"}（${result.via}，${result.latencyMs}ms）：${result.message}`,
        );
        return result;
      }
      case "llm.configure": {
        this.runtime.permissions.assertOwner("配置模型");
        if (typeof p.apiKey === "string" && p.apiKey.length > 0) this.llm.setApiKey(p.apiKey);
        if (typeof p.baseUrl === "string" && p.baseUrl.length > 0) this.runtime.settings.set("llm.baseUrl", p.baseUrl);
        if (typeof p.model === "string" && p.model.length > 0) this.runtime.settings.set("llm.model", p.model);
        if (typeof p.temperature === "number") this.runtime.settings.set("llm.temperature", p.temperature);
        if (typeof p.maxTokens === "number") this.runtime.settings.set("llm.maxTokens", p.maxTokens);
        if (typeof p.providerId === "string" && p.providerId.length > 0) this.runtime.settings.set("llm.providerId", p.providerId);
        // 模型 Key 同时递给声明了 llm.api_key 的 provider 插件：用户只在「模型」页配一次，
        // 不该再去插件详情里把同一个 Key 抄第二遍。
        if (typeof p.apiKey === "string" && p.apiKey.trim().length > 0) {
          this.syncProviderPluginSecret("core.llm-router", "llm.api_key", p.apiKey.trim());
        }
        // 地址/模型同理：路由插件读的是它自己的 config，用户在「模型」页改完就该同步过去，
        // 否则会出现"页面显示 deepseek-chat、插件还在用旧地址"的分裂。
        if (p.syncPlugin !== false) this.syncProviderPluginConfig();
        this.runtime.audit.log("llm.configure", { actorRole: "owner", after: { model: p.model ?? null, baseUrl: p.baseUrl ?? null } });
        return { status: this.llmStatus() };
      }
      case "audit.list":
        return this.runtime.audit.list(Math.min(Number(p.limit ?? 100), 500), typeof p.beforeId === "number" ? p.beforeId : undefined);
      case "narrative.get":
        return { slots: this.mind.getNarrative() };

      /* ---------------- 系统 ---------------- */
      case "system.health":
        return this.health();
      case "system.panic": {
        this.runtime.settings.set("system.proactivePaused", true);
        this.runtime.settings.set("system.panicUntilTs", Date.now() + 24 * 3600 * 1000);
        this.proactive.stop();
        const result = await this.plugins.panicStop();
        this.runtime.audit.log("system.panic", { actorRole: "owner", after: result });
        return { ok: true, message: result.message, disabledPlugins: result.stopped };
      }
      case "system.resume": {
        this.runtime.permissions.assertOwner("恢复主动消息");
        this.runtime.settings.set("system.proactivePaused", false);
        this.runtime.settings.set("system.panicUntilTs", 0);
        this.proactive.start();
        return { ok: true };
      }
      case "system.dataDir":
        return { path: this.runtime.dataDir, dbPath: this.deps.db.path };
      case "system.shutdown": {
        setTimeout(() => void this.shutdown().then(() => process.exit(0)), 150);
        return { ok: true as const };
      }
      case "system.logs":
        return this.runtime.logger.recent(Math.min(Number(p.limit ?? 200), 500));

      /* ---------------- 导出/导入 ---------------- */
      case "export.bundle": {
        const file = await this.exporter.exportBundle();
        this.runtime.audit.log("export.bundle", { actorRole: "owner", after: { file } });
        return { path: file, bytes: fs.statSync(file).size };
      }
      case "import.bundle": {
        this.runtime.permissions.assertOwner("导入数据");
        const result = await this.exporter.importBundle(String(p.path ?? ""));
        this.runtime.audit.log("import.bundle", { actorRole: "owner", after: result });
        return result;
      }
      case "system.resetData": {
        this.runtime.permissions.assertOwner("整体重置数据");
        this.runtime.permissions.consumeConfirm(p.confirmToken, "system.resetData");
        const options = {
          keepApiKey: p.keepApiKey === true,
          keepRuntime: p.keepRuntime === true,
          keepPlugins: p.keepPlugins === true,
        };
        const result = this.reset.resetData(this.deps.agentId, options);
        this.runtime.audit.log("system.reset_data", { actorRole: "owner", after: { ...options, tables: result.tables } });
        return result;
      }

      default:
        throw new AnterosError(ERROR_CODES.ENOTFOUND, `未知的内核方法：${method}`);
    }
  }

  async shutdown(): Promise<void> {    try {
      await this.wechat.shutdown();
    } catch (error) {
      this.deps.log.warn(`内置微信通道关闭失败：${(error as Error)?.message ?? String(error)}`);
    }
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.proactive.stop();
    try {
      await this.plugins.shutdown();
    } catch (err) {
      this.deps.log.warn(`plugin shutdown failed: ${(err as Error).message}`);
    }
  }

  /* --------------------------------------------------------------- */
  /* 组装快照与回放                                                   */
  /* --------------------------------------------------------------- */

  private handshake(): HandshakeResult & { needsConsent: boolean } {
    return {
      kernelVersion: this.runtime.db.getMeta("app_version") ?? "0.1.0",
      kernelApi: KERNEL_API_VERSION,
      sessionId: this.sessionId,
      dataDir: this.runtime.dataDir,
      startedTs: this.startedTs,
      platform: process.platform,
      nodeVersion: process.version,
      needsConsent: this.runtime.consent.status("app").needsAccept,
    };
  }

  /**
   * 通道列表 = 插件通道 + 内置微信通道。
   * 内置通道是软件本体的一部分，没有 manifest、不靠插件自吹，状态由内核自己探。
   */
  private channelsWithBuiltin(): ChannelInfo[] {
    const wechat = this.wechat.status();
    const attached = wechat.state === "ready";
    return [
      ...this.channels.list(),
      {
        pluginId: "core.wechat-channel",
        displayName: "微信（内置通道）",
        kind: "external",
        capabilities: {
          readCanBackfill: true,
          // 写路径要 GUI 驱动，能发但不可打包票：就绪与否看 attachments
          writeIsDeterministic: attached,
          typingIsReal: false,
          canRecall: false,
          hostOccupancyMs: 3_000,
          riskLevel: "red",
        },
        enabled: wechat.enabled,
        status: wechat.running ? "running" : wechat.enabled ? "blocked" : "disabled",
        writeReady: attached && wechat.canSend,
        health: {
          ok: attached,
          status: attached ? "ok" : wechat.enabled ? "blocked" : "degraded",
          message: wechat.running
            ? `内置通道运行中（${wechat.chatTitle ?? wechat.chatUsername}），读 ${wechat.canRead ? "可以" : "未就绪"}、发 ${wechat.canSend ? "可以" : "未就绪"}`
            : wechat.enabled
              ? `内置通道已开启但没跑起来：${wechat.lastError ?? "看体检项"}`
              : "内置通道默认关闭：在「通道」页点开启并确认风险后才读本机微信数据",
          checkedTs: Date.now(),
          attachments: { read: wechat.canRead, write: wechat.canSend, typing: false, recall: false },
        },
      },
    ];
  }
  private snapshot(): AppSnapshot {
    const now = Date.now();
    return {
      handshake: this.handshake(),
      consent: this.runtime.consent.status("app"),
      owner: this.runtime.permissions.ownerStatus(),
      persona: this.mind.getPersona(),
      relation: this.mind.getRelation(),
      world: this.mind.getWorld(now),
      drives: this.mind.getDrives(),
      plugins: this.plugins.list() as PluginInfo[],
      channels: this.channelsWithBuiltin(),
      cost: this.runtime.cost.summary(),
      health: this.health(),
      llm: this.llmStatus(),
      openLoops: this.memory.list({ agentId: this.deps.agentId, kind: "open_loop", limit: 20, offset: 0 }).items,
      pendingActions: this.proactive
        .list(20)
        .filter((action) => action.state === "queued" || action.state === "quarantined"),
      proactive: this.proactiveSummary(),
      agentAvatar: this.avatarDataUrl(),
    };
  }

  private proactiveSummary(): ProactiveSummary {
    const base = this.proactive.summary();
    const wechat = this.wechat.status();
    return { ...base, relayToExternal: wechat.enabled && wechat.relayProactive, externalReady: wechat.state === "ready" };
  }

  /** 头像存在 settings 里（data URL）；空字符串对外统一成 null，界面就知道回退首字。 */
  private avatarDataUrl(): string | null {
    const raw = this.runtime.settings.get("ui.agentAvatar");
    return typeof raw === "string" && raw.startsWith("data:image/") ? raw : null;
  }

  private health() {
    const base = this.system.health();
    return {
      ...base,
      memoryCount: this.memory.stats(this.deps.agentId).total,
      pluginCount: this.plugins.list().length,
    };
  }

  private llmStatus() {
    const status = this.llm.status();
    const configured = status.configured;
    return {
      providerId: status.providerId ?? "openai-compatible",
      providerName: status.providerId === "openai-compatible" ? "OpenAI 兼容接口" : (status.providerId ?? "未配置"),
      model: status.model ?? this.runtime.settings.get("llm.model"),
      online: configured,
      lastError: status.lastError,
      degradedLocalEcho: !configured,
      baseUrl: status.baseUrl ?? this.runtime.settings.get("llm.baseUrl"),
      hasKey: configured,
      temperature: this.runtime.settings.get("llm.temperature"),
      maxTokens: this.runtime.settings.get("llm.maxTokens"),
      router: this.routerStatus(),
    };
  }

  /** 路由插件（core.llm-router）的状态：模型页要把它和内核配置一起显示、一起管 */
  private routerStatus(): LlmStatus["router"] {
    const info = this.plugins.list().find((plugin) => plugin.id === ROUTER_PLUGIN_ID);
    if (info === undefined) return null;
    const missingGrants = info.grantable.filter((item) => !info.granted.includes(item));
    return {
      id: info.id,
      enabled: info.enabled,
      status: info.status,
      grantedAll: missingGrants.length === 0,
      missingGrants,
      missingSecrets: info.missingSecrets,
      issues: info.issues,
      config: info.config,
    };
  }

  /**
   * 把内核里生效的地址/模型/采样参数写进路由插件的配置。
   * 插件读的是自己的 config（manifest.config_schema），不读内核 settings——
   * 所以「模型」页改完必须同步，否则两边会各用各的。
   */
  private syncProviderPluginConfig(): void {
    try {
      const current = this.plugins.list().find((plugin) => plugin.id === ROUTER_PLUGIN_ID);
      if (current === undefined) return;
      this.plugins.setConfig(ROUTER_PLUGIN_ID, {
        ...current.config,
        baseUrl: this.runtime.settings.get("llm.baseUrl"),
        model: this.runtime.settings.get("llm.model"),
        temperature: this.runtime.settings.get("llm.temperature"),
        maxTokens: this.runtime.settings.get("llm.maxTokens"),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log.debug?.(`[app] 同步 ${ROUTER_PLUGIN_ID} 配置失败（不影响模型本身）：${message}`);
    }
  }

  /**
   * 把内核侧配置里的密钥补给声明了同名密钥的插件（目前只有 core.llm-router 的 llm.api_key）。
   * 插件没装/没声明就直接跳过——这是顺手的便利，不是硬依赖。
   */
  private syncProviderPluginSecret(pluginId: string, secretName: string, value: string): void {
    try {
      this.plugins.setSecret(pluginId, secretName, value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log.debug?.(`[app] 同步 ${pluginId} 的 ${secretName} 失败（不影响模型本身）：${message}`);
    }
  }

  private replay(turnId: number): TurnReplay {
    const row = this.deps.db.get<{
      id: number;
      trigger: string;
      plan: string | null;
      ctx_snapshot: string | null;
      model: string | null;
      output: string | null;
      outcome: string | null;
      created_ts: number;
    }>("SELECT * FROM turns WHERE id = ? AND agent_id = ?", [turnId, this.deps.agentId]);
    if (!row) throw new AnterosError(ERROR_CODES.ENOTFOUND, `找不到第 ${turnId} 轮对话`);
    const timeline = this.deps.db.all<{ id: number; role: string; text: string; ts: number }>(
      "SELECT id, role, text, ts FROM messages WHERE turn_id = ? ORDER BY id",
      [turnId],
    );
    return {
      turnId: row.id,
      trigger: row.trigger as TurnReplay["trigger"],
      plan: row.plan ? (JSON.parse(row.plan) as TurnReplay["plan"]) : null,
      ctxSnapshot: row.ctx_snapshot ? (JSON.parse(row.ctx_snapshot) as unknown as TurnReplay["ctxSnapshot"]) : null,
      model: row.model,
      output: row.output,
      timeline: row.plan
        ? [{ ts: row.created_ts, event: "planned" }]
        : [{ ts: row.created_ts, event: "created" }],
      outcome: row.outcome,
    };
  }
}
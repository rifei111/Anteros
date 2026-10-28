/**
 * 多模型：模型清单 + 任务类别路由 + 聊天框当前模型。
 *
 * 为什么要它：一个模型不可能同时擅长闲聊、结构化抽取、看图和生图。
 * 这里把「有哪些模型」「哪类任务用哪个」记在本机，生成时按类别解析，
 * 解析不到的类别回落到主模型（`llm.*` 那套），所以老配置永远能用。
 *
 * 红线：API Key 一律加密存 settings，明文只在本进程里出现，绝不进日志、绝不回 RPC。
 */
import { randomUUID } from "node:crypto";
import { AnterosError, ERROR_CODES } from "@anteros/shared";
import type { ModelCatalog, ModelEntry, ModelTaskKind } from "@anteros/shared";
import type { SettingsService } from "../settings.js";
import type { LogSink } from "../util/log.js";
import { decryptString, encryptString } from "../util/crypto.js";

const ENTRY_KEY = "models.entries";
const ROUTE_KEY = "models.routes";
const ACTIVE_KEY = "models.activeChat";
const SECRET_PREFIX = "models.key.";

/** 存在 settings 里的原始行（不含明文 key）。 */
interface StoredEntry extends Omit<ModelEntry, "apiKeyConfigured"> {}

export const MODEL_TASK_KINDS: ModelTaskKind[] = [
  "reply",
  "proactive",
  "extract",
  "world",
  "narrative",
  "persona",
  "audio",
  "image",
  "vision",
];

export interface ResolvedModel {
  modelId: string | null;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 从哪来的：路由指定的模型 / 聊天框选择 / 主模型 */
  source: "route" | "active-chat" | "primary";
}

export interface ModelUpsertInput {
  id?: string | null;
  label: string;
  provider?: string;
  baseUrl: string;
  model: string;
  /** 传 undefined = 不改；传空串 = 清掉 */
  apiKey?: string;
  kinds?: ModelTaskKind[];
  enabled?: boolean;
}

export class ModelService {
  constructor(
    private readonly settings: SettingsService,
    private readonly masterKey: Buffer,
    private readonly log: LogSink,
  ) {}

  // ── 读 ──────────────────────────────────────────────────────────────

  private stored(): StoredEntry[] {
    const rows = this.settings.getJson<StoredEntry[]>(ENTRY_KEY, []);
    return Array.isArray(rows) ? rows.filter((row) => row && typeof row.id === "string") : [];
  }

  private saveStored(rows: StoredEntry[]): void {
    this.settings.setJson(ENTRY_KEY, rows);
  }

  private apiKeyOf(id: string): string | null {
    const enc = this.settings.getJson<string | null>(`${SECRET_PREFIX}${id}`, null);
    if (!enc) return null;
    try {
      return decryptString(this.masterKey, enc);
    } catch {
      this.log.warn(`[models] 模型 ${id} 的密钥解密失败（master key 可能已更换）`);
      return null;
    }
  }

  private routes(): Partial<Record<ModelTaskKind, string | null>> {
    const raw = this.settings.getJson<Partial<Record<ModelTaskKind, string | null>>>(ROUTE_KEY, {});
    const out: Partial<Record<ModelTaskKind, string | null>> = {};
    for (const kind of MODEL_TASK_KINDS) {
      const id = raw?.[kind];
      if (typeof id === "string" && id.length > 0) out[kind] = id;
    }
    return out;
  }

  list(): ModelCatalog {
    const entries = this.stored().map((row) => ({
      ...row,
      apiKeyConfigured: this.apiKeyOf(row.id) !== null,
    })) satisfies ModelEntry[];
    return {
      entries,
      routes: this.routes(),
      activeChatModelId: this.settings.getJson<string | null>(ACTIVE_KEY, null),
      primary: {
        label: "主模型（设置里的那一套）",
        baseUrl: this.settings.get("llm.baseUrl"),
        model: this.settings.get("llm.model"),
        configured: this.settings.getJson<string | null>("llm.apiKeyEnc", null) !== null,
      },
    };
  }

  // ── 写 ──────────────────────────────────────────────────────────────

  upsert(input: ModelUpsertInput): ModelEntry {
    const label = input.label.trim();
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
    const model = input.model.trim();
    if (!label) throw new AnterosError(ERROR_CODES.EINVALID, "模型名字不能为空");
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new AnterosError(ERROR_CODES.EINVALID, "接口地址要以 http:// 或 https:// 开头", {
        hint: "填到 /v1 结尾就行，例如 https://api.deepseek.com/v1",
      });
    }
    if (!model) throw new AnterosError(ERROR_CODES.EINVALID, "模型名不能为空");

    const rows = this.stored();
    const id = input.id ?? randomUUID();
    const existing = rows.find((row) => row.id === id);
    const kinds = (input.kinds ?? existing?.kinds ?? []).filter((kind): kind is ModelTaskKind =>
      MODEL_TASK_KINDS.includes(kind),
    );
    const next: StoredEntry = {
      id,
      label,
      provider: (input.provider ?? existing?.provider ?? "openai-compatible").trim() || "openai-compatible",
      baseUrl,
      model,
      kinds,
      enabled: input.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? Date.now(),
      lastOkTs: existing?.lastOkTs ?? null,
      lastError: existing?.lastError ?? null,
    };
    const replaced = rows.filter((row) => row.id !== id).concat(next);
    this.saveStored(replaced);

    if (input.apiKey !== undefined) {
      const key = input.apiKey.trim();
      this.settings.setJson(`${SECRET_PREFIX}${id}`, key ? encryptString(this.masterKey, key) : null);
    }
    this.log.info(`[models] upsert ${id} (${label}/${model}) kinds=${kinds.join(",") || "-"}`);
    return { ...next, apiKeyConfigured: this.apiKeyOf(id) !== null };
  }

  remove(id: string): { removed: boolean } {
    const rows = this.stored();
    if (!rows.some((row) => row.id === id)) return { removed: false };
    this.saveStored(rows.filter((row) => row.id !== id));
    this.settings.setJson(`${SECRET_PREFIX}${id}`, null);
    // 路由里指向它的都清掉，免得解析时指向一个不存在的模型
    const routes = this.routes();
    let changed = false;
    for (const kind of MODEL_TASK_KINDS) {
      if (routes[kind] === id) {
        delete routes[kind];
        changed = true;
      }
    }
    if (changed) this.settings.setJson(ROUTE_KEY, routes);
    if (this.settings.getJson<string | null>(ACTIVE_KEY, null) === id) {
      this.settings.setJson(ACTIVE_KEY, null);
    }
    this.log.info(`[models] removed ${id}`);
    return { removed: true };
  }

  setRoute(kind: ModelTaskKind, modelId: string | null): ModelCatalog {
    if (!MODEL_TASK_KINDS.includes(kind)) {
      throw new AnterosError(ERROR_CODES.EINVALID, `未知的任务类别：${String(kind)}`);
    }
    if (modelId && !this.stored().some((row) => row.id === modelId)) {
      throw new AnterosError(ERROR_CODES.EINVALID, "要绑定的模型不存在");
    }
    const routes = this.routes();
    if (modelId) routes[kind] = modelId;
    else delete routes[kind];
    this.settings.setJson(ROUTE_KEY, routes);
    return this.list();
  }

  setActiveChat(modelId: string | null): ModelCatalog {
    if (modelId && !this.stored().some((row) => row.id === modelId)) {
      throw new AnterosError(ERROR_CODES.EINVALID, "选的模型不存在");
    }
    this.settings.setJson(ACTIVE_KEY, modelId);
    return this.list();
  }

  /** 探测：用这个模型的配置发一次极短的请求，成功就记 lastOkTs。 */
  async probe(id: string): Promise<{ ok: boolean; message: string; latencyMs: number }> {
    const entry = this.stored().find((row) => row.id === id);
    if (!entry) throw new AnterosError(ERROR_CODES.EINVALID, "模型不存在");
    const apiKey = this.apiKeyOf(id);
    if (!apiKey) return { ok: false, message: "这个模型还没保存密钥", latencyMs: 0 };
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const url = entry.baseUrl.endsWith("/chat/completions")
        ? entry.baseUrl
        : `${entry.baseUrl}/chat/completions`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: entry.model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - started;
      if (!response.ok) {
        const text = (await response.text().catch(() => "")).slice(0, 300);
        this.patchEntry(id, { lastError: `HTTP ${response.status}：${text || "无响应正文"}` });
        return { ok: false, message: `连接失败（HTTP ${response.status}）`, latencyMs };
      }
      await response.text().catch(() => "");
      this.patchEntry(id, { lastOkTs: Date.now(), lastError: null });
      return { ok: true, message: `通了（${latencyMs}ms）`, latencyMs };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.patchEntry(id, { lastError: message.slice(0, 200) });
      return { ok: false, message: `连接失败：${message.slice(0, 160)}`, latencyMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }

  private patchEntry(id: string, patch: Partial<StoredEntry>): void {
    const rows = this.stored().map((row) => (row.id === id ? { ...row, ...patch } : row));
    this.saveStored(rows);
  }

  // ── 解析 ────────────────────────────────────────────────────────────

  /**
   * 按任务类别解析出这次请求该用哪个模型。
   * 顺序：类别路由 → 聊天框选中的模型（只有 reply/proactive 算聊天）→ 主模型。
   */
  resolve(kind: ModelTaskKind): ResolvedModel | null {
    const rows = this.stored().filter((row) => row.enabled);
    const byId = (id: string | null | undefined): StoredEntry | null =>
      id ? rows.find((row) => row.id === id) ?? null : null;

    const routed = byId(this.routes()[kind]);
    const chatKinds: ModelTaskKind[] = ["reply", "proactive"];
    const active = chatKinds.includes(kind) ? byId(this.settings.getJson<string | null>(ACTIVE_KEY, null)) : null;
    const picked = routed ?? active;
    if (!picked) return null;
    const apiKey = this.apiKeyOf(picked.id);
    if (!apiKey) return null;
    return { modelId: picked.id, baseUrl: picked.baseUrl, model: picked.model, apiKey, source: routed ? "route" : "active-chat" };
  }
}
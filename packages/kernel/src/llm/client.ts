/**
 * 内置 LLM 客户端（OpenAI 兼容 /chat/completions）。
 *
 * 为什么内核内置而不是只靠插件：草案 14.9 第 14 条要求"禁用/强杀插件后
 * App 内对话 100% 可用"，所以 LLM 出站必须有内核兜底；core.llm-router 插件
 * 只是可选的替换/代理，不是唯一通路。
 *
 * 红线：API Key 只从加密存储读，绝不写日志、绝不经 RPC 回传客户端。
 */
import { AnterosError, ERROR_CODES } from "@anteros/shared";
import type { LlmMessage, LlmPort, LlmResult } from "../contracts.js";
import type { SettingsService } from "../settings.js";
import { decryptString, encryptString } from "../util/crypto.js";

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export class LlmClient implements LlmPort {
  private lastError: string | null = null;

  constructor(
    private readonly settings: SettingsService,
    private readonly masterKey: Buffer,
  ) {}

  private apiKey(): string | null {
    const enc = this.settings.getJson<string | null>("llm.apiKeyEnc", null);
    if (!enc) return null;
    try {
      return decryptString(this.masterKey, enc);
    } catch {
      return null;
    }
  }

  setApiKey(key: string): void {
    this.settings.setJson("llm.apiKeyEnc", key ? encryptString(this.masterKey, key) : null);
  }

  /** 只给「测试连接」用：探测时要在内存里拿一次明文，不写日志、不回传客户端。 */
  apiKeyForProbe(): string | null {
    return this.apiKey();
  }

  isConfigured(): boolean {
    return this.apiKey() !== null;
  }

  status(): { configured: boolean; providerId: string | null; baseUrl: string | null; model: string | null; lastError: string | null } {
    return {
      configured: this.isConfigured(),
      providerId: this.settings.get("llm.providerId"),
      baseUrl: this.settings.get("llm.baseUrl"),
      model: this.settings.get("llm.model"),
      lastError: this.lastError,
    };
  }

  async generate(input: {
    messages: LlmMessage[];
    temperature?: number;
    maxTokens?: number;
    json?: boolean;
    purpose?: "reply" | "proactive" | "extract" | "world" | "narrative" | "persona";
    /** 多模型：本次指定用的模型（地址/模型名/密钥）；不传就走主模型 */
    override?: { baseUrl: string; model: string; apiKey: string };
  }): Promise<LlmResult> {
    // 多模型：这一次用哪个模型由调用方决定（路由/聊天框选择都解析在 ModelService 里）
    const key = input.override?.apiKey ?? this.apiKey();
    if (!key) {
      this.lastError = "尚未配置 API Key";
      throw new AnterosError(ERROR_CODES.EBLOCKED, "还没配置模型 API Key", {
        hint: "打开设置 → 模型，填入 OpenAI 兼容接口的 Base URL、模型名与 API Key",
      });
    }
    const base = (input.override?.baseUrl ?? this.settings.get("llm.baseUrl")).replace(/\/+$/, "");
    const model = input.override?.model ?? this.settings.get("llm.model");
    const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: input.messages,
          temperature: input.temperature ?? this.settings.get("llm.temperature"),
          max_tokens: input.maxTokens ?? this.settings.get("llm.maxTokens"),
          ...(input.json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        this.lastError = `HTTP ${response.status}: ${text.slice(0, 200)}`;
        throw new AnterosError(ERROR_CODES.EIO, `模型接口返回 ${response.status}`, {
          hint: "检查 Base URL、模型名与 API Key 是否正确；余额是否充足",
          detail: text.slice(0, 500),
        });
      }
      const data = (await response.json()) as ChatCompletionResponse;
      const text = (data.choices?.[0]?.message?.content ?? "").trim();
      if (!text) {
        this.lastError = "模型返回空内容";
        throw new AnterosError(ERROR_CODES.EIO, "模型返回了空内容", { hint: "稍后重试，或检查模型是否支持当前 max_tokens" });
      }
      const usage = {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      };
      this.settings.setJson("llm.lastOkTs", Date.now());
      this.lastError = null;
      return { text, model: data.model ?? model, usage };
    } catch (err) {
      if (err instanceof AnterosError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      throw new AnterosError(ERROR_CODES.EIO, `调用模型失败：${message}`, {
        hint: "检查网络与 Base URL；单机模式不支持离线模型调用",
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
/**
 * 一次「到底连不连得通」的真实探测。
 *
 * 为什么要有它：`llm.status().online` 只表示"密钥/地址/模型都填了"，不是网络通。
 * 界面上写「在线」就必须是真的连上过——所以这里发真请求，并把延迟与模型列表拿回来。
 *
 * 两条路径（都只读，不改任何配置）：
 *  1. GET {baseUrl}/models —— 便宜、能顺便列出可用模型；
 *  2. 上一条不通且给了模型名时，POST {baseUrl}/chat/completions 发一个 1 token 的 ping。
 *
 * 密钥只在内存里用一次，绝不进日志与错误信息。
 */
import type { LlmProbeResult } from "@anteros/shared";

const PROBE_TIMEOUT_MS = 10_000;

function normalizeBaseUrl(raw: string): string {
  let base = raw.trim().replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) base = base.slice(0, -"/chat/completions".length);
  if (base.endsWith("/completions")) base = base.slice(0, -"/completions".length);
  return base.replace(/\/+$/, "");
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Node 的 fetch 只会抛 `TypeError: fetch failed`，真正的原因在 cause 链里（ECONNREFUSED 等） */
function describeNetworkError(error: unknown, baseUrl: string): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  const message = parts.join(" | ");
  const host = hostOf(baseUrl);
  if (/timeout|abort/i.test(message)) return `请求超时（10 秒）：连不上 ${host}（地址填错、被墙或服务没起来）`;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return `域名解析失败：${host} 这个域名不存在，或这台机器没网`;
  if (/ECONNREFUSED/i.test(message)) return `连接被拒绝：${host} 的端口不对，或那个服务没启动`;
  if (/CERT|self.signed|UNABLE_TO_VERIFY|SELF_SIGNED/i.test(message)) {
    return `TLS 证书校验失败：${host} 用了自签证书（换成 http，或换一个能用正常证书的地址）`;
  }
  if (/fetch failed/i.test(message)) return `连不上 ${host}：网络不可达或被拦截（原始信息：${message.slice(0, 120)}）`;
  return `${host}：${message.slice(0, 180)}`;
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function pickModels(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const names: string[] = [];
  for (const item of data) {
    if (typeof item === "string") names.push(item);
    else if (typeof item === "object" && item !== null) {
      const id = (item as { id?: unknown }).id;
      if (typeof id === "string") names.push(id);
    }
  }
  return names.sort((left, right) => left.localeCompare(right));
}

function short(text: string, limit = 160): string {
  const squeezed = text.replace(/\s+/g, " ").trim();
  return squeezed.length > limit ? `${squeezed.slice(0, limit)}…` : squeezed;
}

export async function probeProvider(input: {
  baseUrl: string;
  apiKey: string | null;
  model: string | null;
}): Promise<LlmProbeResult> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const model = input.model !== null && input.model.trim().length > 0 ? input.model.trim() : null;
  const startedAt = Date.now();
  /** /models 那一步的失败原因（给最后结论用） */
  let modelsFailure: string | null = null;
  const auth: Record<string, string> = input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {};

  const failed = (message: string, httpStatus: number | null = null): LlmProbeResult => ({
    ok: false,
    baseUrl,
    model,
    latencyMs: Date.now() - startedAt,
    models: [],
    via: "none",
    httpStatus,
    message,
  });

  if (baseUrl.length === 0) return failed("Base URL 是空的");
  if (!/^https?:\/\//i.test(baseUrl)) return failed("Base URL 必须以 http:// 或 https:// 开头");

  // 1) /models
  try {
    const response = await withTimeout((signal) =>
      fetch(`${baseUrl}/models`, { headers: { ...auth, accept: "application/json" }, signal }),
    );
    const text = await response.text();
    if (response.ok) {
      const models = pickModels(safeJson(text));
      const latencyMs = Date.now() - startedAt;
      const missing = model !== null && models.length > 0 && !models.includes(model);
      return {
        ok: true,
        baseUrl,
        model,
        latencyMs,
        models,
        via: "models",
        httpStatus: response.status,
        message:
          models.length === 0
            ? `通了（${latencyMs}ms），但服务没返回模型列表；保存前确认模型名对`
            : missing
              ? `通了（${latencyMs}ms），但这个地址没有 ${model}，可用：${models.slice(0, 5).join("、")}${models.length > 5 ? " …" : ""}`
              : `通了（${latencyMs}ms），发现 ${models.length} 个模型${model === null ? "" : `，包含 ${model}`}`,
      };
    }
    if (response.status === 401 || response.status === 403) {
      return failed(
        `密钥被拒（HTTP ${response.status}）：检查 Key 是否有效、是否属于这个服务`,
        response.status,
      );
    }
    // 有些服务不实现 /models，继续试对话
  } catch (error) {
    // /models 这层失败先记下原因：后面那次对话请求要是也失败，就用它当结论
    modelsFailure = describeNetworkError(error, baseUrl);
  }

  // 2) 一次 1 token 的对话
  if (model === null) {
    return failed(modelsFailure ?? "没能通过 /models 确认连通，而且没填模型名，无法用对话验证");
  }
  try {
    const response = await withTimeout((signal) =>
      fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          temperature: 0,
        }),
        signal,
      }),
    );
    const text = await response.text();
    const latencyMs = Date.now() - startedAt;
    if (response.ok) {
      return {
        ok: true,
        baseUrl,
        model,
        latencyMs,
        models: [],
        via: "chat",
        httpStatus: response.status,
        message: `通了（${latencyMs}ms，用一次 1 token 的对话验证）；该服务没提供 /models 列表`,
      };
    }
    const detail = safeJson(text);
    const errorMessage =
      typeof detail === "object" && detail !== null
        ? String((detail as { error?: { message?: unknown } }).error?.message ?? short(text))
        : short(text);
    return failed(`对话请求失败（HTTP ${response.status}）：${short(errorMessage, 240)}`, response.status);
  } catch (error) {
    return failed(describeNetworkError(error, baseUrl) + (modelsFailure === null ? "" : `（/models：${modelsFailure}）`));
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

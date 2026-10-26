/**
 * core.llm-router —— OpenAI 兼容 LLM 适配器（可选，默认禁用）。
 *
 * 为什么是插件而不是内核内置：内核必须能在"没有任何外部服务"时完成最小闭环，
 * 所以内核自带兜底客户端；这个插件只是让用户换成自己的模型服务。
 *
 * 安全约束（不可妥协）：
 * - API Key 只从内核注入的环境变量读（readSecret），不落盘、不写日志、不进错误信息；
 * - 只把内核给的消息转发出去，不做 prompt 加工，不缓存对话；
 * - 失败返回可读错误码，不伪造文本（宁可让内核降级，也不能编答案）。
 */
import { createPlugin, fail, readSecret, DEFAULT_CALL_TIMEOUT_MS } from "../_sdk/plugin-runtime.mjs";

const CONFIG_KEYS = [
  "baseUrl",
  "model",
  "temperature",
  "maxTokens",
  "timeoutMs",
  "llm.baseUrl",
  "llm.model",
  "llm.temperature",
  "llm.maxTokens",
  "llm.timeoutMs",
];

const DEFAULTS = { temperature: 0.7, maxTokens: 1024, timeoutMs: 30_000 };
const MAX_PROMPT_CHARS = 200_000;

function pick(cfg, ...keys) {
  for (const key of keys) {
    const value = cfg[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function asNumber(value, fallback, min, max) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function loadConfig(ctx) {
  let config = {};
  try {
    const result = await ctx.call("kernel.config.get", { keys: CONFIG_KEYS }, { timeoutMs: 5_000 });
    if (result && typeof result === "object" && result.config && typeof result.config === "object") {
      config = result.config;
    }
  } catch (err) {
    // 读配置失败不等于可以直接放弃：给出可读原因，由内核决定是否降级到兜底客户端。
    throw fail("EDEGRADED", "读取 LLM 配置失败，无法确定 API 地址", { detail: String(err?.message ?? err) });
  }
  return {
    baseUrl: pick(config, "baseUrl", "llm.baseUrl", "base_url"),
    model: pick(config, "model", "llm.model"),
    temperature: asNumber(pick(config, "temperature", "llm.temperature"), DEFAULTS.temperature, 0, 2),
    maxTokens: asNumber(pick(config, "maxTokens", "llm.maxTokens"), DEFAULTS.maxTokens, 1, 200_000),
    timeoutMs: asNumber(pick(config, "timeoutMs", "llm.timeoutMs"), DEFAULTS.timeoutMs, 1_000, 120_000),
  };
}

/** 密钥存在性检查：只判断"有没有"，绝不返回、打印或记录密钥本身。 */
function readApiKey() {
  return readSecret("llm.api_key");
}

function chatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl).replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

function validMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw fail("EINVALID", "plugin.llm.generate 需要非空的 messages 数组");
  }
  let total = 0;
  return messages.map((message) => {
    if (!message || typeof message !== "object") throw fail("EINVALID", "messages 里存在非对象条目");
    const role = message.role;
    const content = message.content;
    if (!["system", "user", "assistant"].includes(role)) {
      throw fail("EINVALID", `不支持的 message.role：${String(role)}（只允许 system/user/assistant）`);
    }
    if (typeof content !== "string") throw fail("EINVALID", `message.content 必须是字符串（role=${role}）`);
    total += content.length;
    return { role, content };
  }).map((message) => {
    if (total > MAX_PROMPT_CHARS) throw fail("EINVALID", "本次请求文本过长，超过单次 20 万字符上限");
    return message;
  });
}

async function generate(params, ctx) {
  const cfg = await loadConfig(ctx);
  const apiKey = readApiKey();
  if (!cfg.baseUrl || !cfg.model) {
    throw fail("EBLOCKED", "未配置 LLM 服务：缺少 baseUrl 或 model", {
      hint: "在内核设置里填写 LLM 地址与模型名；不配置时内核会使用内置兜底客户端",
    });
  }
  if (!apiKey) {
    throw fail("EBLOCKED", "未注入 LLM API 密钥（ANTEROS_SECRET_LLM_API_KEY）", {
      hint: "密钥只能由内核按 manifest secrets 注入；插件不会读取本地任何密钥文件",
    });
  }

  const messages = validMessages(params?.messages);
  const body = {
    model: cfg.model,
    messages,
    temperature: asNumber(params?.temperature, cfg.temperature, 0, 2),
    max_tokens: asNumber(params?.maxTokens, cfg.maxTokens, 1, 200_000),
    stream: false,
  };
  if (params?.json === true) body.response_format = { type: "json_object" };

  let response;
  try {
    response = await fetch(chatCompletionsUrl(cfg.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    const reason = err?.name === "TimeoutError" ? `请求超时（${cfg.timeoutMs}ms）` : `网络请求失败（${err?.name ?? "Error"}）`;
    throw fail("EIO", `调用 LLM 服务失败：${reason}`, {
      hint: "检查网络、baseUrl 与代理设置；插件不会退回编造内容",
    });
  }

  const rawText = await response.text();
  if (!response.ok) {
    // 错误体可能带请求回显，只截一小段并去掉可能的密钥形状，绝不整段回传。
    const snippet = rawText
      .slice(0, 300)
      .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
      .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer ***");
    throw fail("EIO", `LLM 服务返回 HTTP ${response.status}`, { detail: snippet || undefined });
  }

  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    throw fail("EIO", "LLM 服务返回的不是 JSON（可能是网关错误页）");
  }
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.length === 0) {
    throw fail("EIO", "LLM 响应里没有 choices[0].message.content", {
      detail: "服务可能返回了工具调用/多模态内容，v0.1 只支持纯文本",
    });
  }

  const usage = {
    inputTokens: Number(payload?.usage?.prompt_tokens ?? 0),
    outputTokens: Number(payload?.usage?.completion_tokens ?? 0),
  };
  ctx.log(
    `生成完成 model=${String(payload?.model ?? cfg.model)} purpose=${String(params?.purpose ?? "chat")} tokens=${usage.inputTokens}/${usage.outputTokens}`,
  );
  return { text, model: String(payload?.model ?? cfg.model), usage };
}

const runtime = createPlugin({
  id: "core.llm-router",
  capabilities: ["llm.generate"],
  handlers: {
    "plugin.health.check": async (_params, ctx) => {
      const missing = [];
      if (!readApiKey()) missing.push("密钥");
      try {
        const cfg = await loadConfig(ctx);
        if (!cfg.baseUrl) missing.push("baseUrl");
        if (!cfg.model) missing.push("model");
      } catch (err) {
        return { ok: false, status: "degraded", message: `读取配置失败：${err?.message ?? err}` };
      }
      if (missing.length > 0) {
        return {
          ok: false,
          status: "degraded",
          message: `LLM 路由插件未就绪（缺少 ${missing.join("、")}），内核将使用内置兜底客户端`,
        };
      }
      return { ok: true, status: "ok", message: "LLM 路由配置齐全；实际可用性取决于服务端" };
    },
    "plugin.llm.generate": generate,
  },
  onReady(info, ctx) {
    ctx.log(`已就绪：kernel ${info.kernelApi}，等待 plugin.llm.generate`);
  },
});

// 供宿主/调试读取；不暴露密钥。
export const stats = () => runtime.stats();
export const _test = { validMessages, chatCompletionsUrl, asNumber };

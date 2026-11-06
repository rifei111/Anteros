/**
 * core.media 0.3.0 —— 语音合成（默认 BreezeBlue / Breeze TTS 2）+ 语音识别（OpenAI 兼容）文档 8.1、8.2。
 *
 * 两件事：把文字变成音频字节、把音频字节变成文字。
 * 不碰内核数据库、不写用户目录、不替模型编内容——听不清就返回 kind:"none" 或 "error"，
 * 让内核去决定"没听清"怎么回，而不是这里编一句话。
 *
 * 合成可以两个供应商：breezeblue（默认，只有合成、密钥头是 xi-api-key）与 openai（任何 OpenAI 兼容的 /v1/audio/speech）。
 * BreezeBlue 没有识别接口，所以转写永远走 media.api_key 指向的 OpenAI 兼容服务。
 * 未配置时一律 blocked：没有密钥时不假装生成成功（假音频比没音频更糟）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { setDefaultResultOrder } from "node:dns";
import { createPlugin, fail, readSecret } from "../_sdk/plugin-runtime.mjs";

// 这台机器上 api.breeze.blue 同时有 A 和 AAAA 记录，而 IPv6 出口时通时不通。
// Node 默认按 DNS 返回顺序（IPv6 在前）直连，连不上就是 10 秒的 connect timeout；
// 优先走 IPv4 能让绝大多数请求一次就过。
try {
  setDefaultResultOrder("ipv4first");
} catch {
  /* 老版本 Node 没有这个接口，忽略即可 */
}

const CONFIG_KEYS = [
  "provider",
  "breezeBaseUrl",
  "breezeTtsModel",
  "breezeVoiceId",
  "breezeLanguage",
  "breezeGuidanceScale",
  "breezeInstructions",
  "baseUrl",
  "ttsModel",
  "asrModel",
  "voice",
  "rate",
  "maxSeconds",
  "asrTimeoutMs",
  "pricePerMillionCharsCny",
  "pricePerSecondCny",
  "pricePerMinuteCny",
  "media.baseUrl",
  "media.ttsModel",
  "media.asrModel",
  "media.voice",
];

const DEFAULT_PROVIDER = "breezeblue";
const DEFAULT_BREEZE_URL = "https://api.breeze.blue";
const DEFAULT_BREEZE_MODEL = "breeze-tts-2";
const DEFAULT_BREEZE_GUIDANCE = 4;
const DEFAULT_BASE_URL = "https://api.openai.com";
const DEFAULT_TTS_MODEL = "tts-1";
const DEFAULT_ASR_MODEL = "whisper-1";
const DEFAULT_VOICE = "alloy";
/** BreezeBlue 官方价 $30 / 100 万字符，按 7.2 折人民币 ≈ ¥216。改价只需要改配置。 */
const DEFAULT_PRICE_PER_MILLION_CHARS = 216;
/** 一次朗读最多 2000 字——超过这个长度通常是调用方写错了，不是用户想听十分钟。 */
const MAX_SPEAK_CHARS = 2_000;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
/**
 * 单次合成的等待上限（同一次调用里最多试 2 次）。
 * 原来给 60 秒是怕线路慢，但实测「连不上」时它会一直等到超时：
 * 界面上那条消息就干等 2 分钟不落定，用户看到的是「一直卡在生成中」。
 * 35 秒 × 2 次 + 内核侧 90 秒总闸 = 一分钟内一定有结论（要么出声，要么显示「没能生成」）。
 */
const SPEAK_ATTEMPT_TIMEOUT_MS = 35_000;

async function getConfig(ctx) {
  try {
    const result = await ctx.call("kernel.config.get", { keys: CONFIG_KEYS }, { timeoutMs: 5_000 });
    return result && typeof result.config === "object" && result.config !== null ? result.config : {};
  } catch {
    return {};
  }
}

function pick(config, ...keys) {
  for (const key of keys) {
    const value = config[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

function num(config, key, fallback) {
  const raw = config[key];
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function providerOf(config) {
  const raw = pick(config, "provider").toLowerCase();
  return raw === "openai" ? "openai" : DEFAULT_PROVIDER;
}

/**
 * baseUrl 归一：内核的 llm.baseUrl 习惯带到 /v1，而音频接口是 /v1/audio/* 或 /v1/text-to-speech/*。
 * 不剥掉的后果是拼成 /v1/v1/...——文档 8.2 特意点名的坑。
 */
function apiRoot(raw, fallback = DEFAULT_BASE_URL) {
  let base = (raw || fallback).trim().replace(/\/+$/, "");
  if (base.endsWith("/v1")) base = base.slice(0, -3);
  return base;
}

/**
 * 密钥清洗：粘贴时常带尾部换行、首尾空格或一对引号，HTTP 头里带这些字符会被服务端判成 401。
 * 只做「不可能属于密钥本身」的清洗，不改中间内容。
 */
function cleanSecret(name) {
  const raw = readSecret(name) || "";
  let value = String(raw).trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1).trim();
  }
  return value;
}

function apiKey() {
  return cleanSecret("media.api_key");
}

function breezeKey() {
  return cleanSecret("breeze.api_key");
}

function priceOf(config) {
  return {
    perMillionChars: num(config, "pricePerMillionCharsCny", DEFAULT_PRICE_PER_MILLION_CHARS),
    perSecond: num(config, "pricePerSecondCny", 0),
    perMinute: num(config, "pricePerMinuteCny", 0),
  };
}

function requireText(value, field, maxLength) {
  if (typeof value !== "string" || value.trim() === "") {
    throw fail("EINVALID", `参数 ${field} 必须是非空字符串`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw fail("EINVALID", `参数 ${field} 超过 ${maxLength} 字符上限`);
  }
  return trimmed;
}

/** 计时/计价都按"非空白字符数"：语气词也算钱，空格与换行不算。 */
function speechChars(text) {
  return [...text.replace(/\s+/g, "")].length;
}

/** 时长估算：中文口播约每秒 4.5 字，rate 快就短；仅用于成本预检与界面占位。 */
function estimateDurMs(text, rate) {
  const speed = Number.isFinite(rate) && rate > 0 ? rate : 1;
  return Math.round(([...text].length / 4.5 / speed) * 1000);
}

/** 微信「按住说话」要按音频真实时长来按，估出来的字数时长差太多就会截断/拖尾。 */
function wavDurationMs(bytes) {
  if (!(bytes.length >= 44 && bytes[0] === 0x52 && bytes[1] === 0x49)) return 0;
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const size =
      (bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24)) >>> 0;
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= bytes.length) {
      byteRate =
        (bytes[body + 8] | (bytes[body + 9] << 8) | (bytes[body + 10] << 16) | (bytes[body + 11] << 24)) >>> 0;
    } else if (id === "data") {
      dataSize = size;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (byteRate > 0 && dataSize > 0) return Math.round((dataSize / byteRate) * 1000);
  return 0;
}

function sniffMime(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "audio/wav";
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "audio/mpeg";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio/mpeg";
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return "audio/ogg";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "audio/webm";
  return "audio/mpeg";
}

/** 转写结果里的"其实没人说话"：Whisper 会吐 [BLANK_AUDIO]、(音乐)、嗯…… 这类。 */
const NO_SPEECH_PATTERNS = [
  /^\[?\s*(blank_?audio|silence|music|no ?speech|inaudible)\s*\]?$/i,
  /^[（(【\[]?\s*(音乐|掌声|笑声|静音|无声|空白)\s*[)）】\]]?$/,
  /^[\s.,!?，。！？、…~～-]*$/,
];

function transcriptKind(text) {
  const trimmed = text.trim();
  if (trimmed === "") return "none";
  const bare = trimmed.replace(/^\[|\]$/g, "");
  if (NO_SPEECH_PATTERNS.some((pattern) => pattern.test(bare))) return "none";
  // 只有标点或单个语气词：不算"说了一句话"，但也不是错误。
  if ([...trimmed].length <= 1) return "none";
  return "assistant";
}

/** 网络层抖动（连接超时、TLS 握手失败、DNS 抽风）值得当场再试一次，别让用户重打一遍字。 */
const NET_ERROR_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
]);

function netErrorCode(error) {
  const cause = error?.cause;
  return cause?.code ?? cause?.errno ?? error?.code ?? "";
}

function isNetError(error) {
  if (!error || error.name === "AbortError") return false;
  const code = netErrorCode(error);
  if (NET_ERROR_CODES.has(code)) return true;
  // Node 的 fetch 在 TLS/DNS 失败时统一包成 TypeError: fetch failed，只能看 cause。
  return error.name === "TypeError" && cause_mentions_network(error);
}

function cause_mentions_network(error) {
  const text = `${error?.cause?.code ?? ""} ${error?.cause?.message ?? ""}`.toLowerCase();
  return /certificate|tls|ssl|getaddrinfo|connect|socket|network|fetch failed/.test(text) || text.trim() !== "";
}

async function request(ctx, url, options, timeoutMs, attempts = 3) {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "媒体服务";
    }
  })();
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const hint = body.slice(0, 300);
        const denied = response.status === 401 || response.status === 403;
        throw fail(
          denied ? "EPERM" : "EUPSTREAM",
          denied
            ? `${host} 拒了这把密钥（HTTP ${response.status}）：密钥可能抄错、已被撤销，或者填错了服务商`
            : `${host} 返回 ${response.status}`,
          hint || undefined,
        );
      }
      return response;
    } catch (error) {
      lastError = error;
      // 密钥错误、参数错误是确定性失败，重试没有意义。
      if (error && typeof error.code === "string" && (error.code === "EPERM" || error.code === "EINVALID")) throw error;
      const timedOut = error && error.name === "AbortError";
      if (!timedOut && !isNetError(error)) throw error;
      if (attempt === attempts) {
        if (timedOut) throw fail("ETIMEOUT", `${host} 在 ${timeoutMs}ms 内没有响应（试了 ${attempts} 次）`);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  const code = netErrorCode(lastError);
  if (lastError && !isNetError(lastError)) throw lastError;
  const reason = code === "" ? "网络连不上" : `网络连不上（${code}）`;
  throw fail(
    "EUPSTREAM",
    `${reason}：${host} 这次没连上，本机到它的线路不太稳，过一会儿再点一次「重新生成」`,
    `${host}${code === "" ? "" : ` ${code}`}`,
  );
}

/**
 * 情绪 → BreezeBlue 的语气指令。
 *
 * Breeze TTS 2 的 instructions 是自由文本；实测英文描述最稳，所以这里拼英文短句，
 * 只在有 mood 时才追加，不覆盖用户手填的 breezeInstructions。
 */
function buildInstructions(mood, rate, extra) {
  const parts = [];
  const hasMood = mood && typeof mood === "object";
  if (hasMood) {
    const clamp01 = (value, fallback) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback);
    const arousal = clamp01(mood.arousal, 0.5);
    const valence = clamp01(mood.valence, 0.5);
    const energy = clamp01(mood.energy, 0.5);
    const warmth = clamp01(mood.warmth, 0.5);
    if (valence >= 0.62) parts.push("light and smiling");
    else if (valence <= 0.35) parts.push("subdued, holding back the smile");
    if (warmth >= 0.65) parts.push("warm, like talking to someone close");
    if (arousal >= 0.68) parts.push("a little more animated");
    if (energy <= 0.4) parts.push("tired, keep the endings flat");
    else if (energy >= 0.72) parts.push("alert and awake");
  }
  if (Number.isFinite(rate)) {
    if (rate >= 1.06) parts.push("slightly faster pace");
    else if (rate <= 0.95) parts.push("slightly slower pace");
  }
  const manual = typeof extra === "string" ? extra.trim() : "";
  if (manual) parts.push(manual);
  if (parts.length === 0) return "";
  return `${parts.join(", ")}.`;
}

/** 自动挑音色的缓存：同一 baseUrl + 语言只查一次 GET /v1/voices。
 *
 * 这台机器连 api.breeze.blue 会抖（1.2s ~ 20s，偶尔 connect timeout），
 * 所以挑中的音色要落盘记住——下次不用再走那次又慢又容易超时的音色列表请求。
 */
const VOICE_CACHE_FILE = "breeze-voice.json";
/** 进程内记住挑中的音色（盘上那份管重启后）。 */
let voiceCache = null;

function voiceCachePath() {
  const dir = process.env.ANTEROS_DATA_DIR;
  return dir ? path.join(dir, VOICE_CACHE_FILE) : "";
}

async function readVoiceCache() {
  const file = voiceCachePath();
  if (file === "") return null;
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.key === "string" && typeof parsed.voiceId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

async function writeVoiceCache(entry) {
  const file = voiceCachePath();
  if (file === "") return;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(entry), "utf8");
  } catch {
    /* 缓存写不进去不影响功能，下次再查一次而已 */
  }
}

async function resolveBreezeVoice(ctx, config, key) {
  const configured = pick(config, "breezeVoiceId", "breeze.voiceId");
  if (configured) return configured;

  const base = apiRoot(pick(config, "breezeBaseUrl"), DEFAULT_BREEZE_URL);
  const language = pick(config, "breezeLanguage") || "zh";
  const cacheKey = `${base}|${language}`;
  if (voiceCache && voiceCache.key === cacheKey) return voiceCache.voiceId;

  const cached = await readVoiceCache();
  if (cached && cached.key === cacheKey) {
    voiceCache = cached;
    return cached.voiceId;
  }

  const query = new URLSearchParams({ language_code: language, page_size: "20" });
  const response = await request(
    ctx,
    `${base}/v1/voices?${query.toString()}`,
    { method: "GET", headers: { "xi-api-key": key } },
    20_000,
    1,
  );
  const payload = await response.json().catch(() => null);
  const list = Array.isArray(payload?.voices) ? payload.voices : Array.isArray(payload) ? payload : [];
  const found = list.map((item) => (item && typeof item.voice_id === "string" ? item.voice_id : "")).find(Boolean);
  if (!found) {
    throw fail(
      "EINVALID",
      `BreezeBlue 没有可用的「${language}」音色`,
      "在插件配置里手动填 breezeVoiceId（GET /v1/voices 可以列出来）",
    );
  }
  voiceCache = { key: cacheKey, voiceId: found };
  await writeVoiceCache(voiceCache);
  ctx.log(`BreezeBlue 自动挑中音色 ${found}（${language}）`);
  return found;
}

/** 微信语音条要的是能直接丢进 waveOut 的 wav，所以调用方可指定格式。 */
function speakFormat(params) {
  return params && params.format === "wav" ? "wav" : "mp3";
}

/** BreezeBlue 合成：POST /v1/text-to-speech/{voice_id}?output_format=...&delivery=sync */
async function breezeSpeak(params, ctx, config) {
  const text = requireText(params?.text, "text", MAX_SPEAK_CHARS);
  const key = breezeKey();
  if (!key) return { ok: false, status: "blocked", message: "未配置 breeze.api_key（BreezeBlue 密钥）" };

  const format = speakFormat(params);
  const base = apiRoot(pick(config, "breezeBaseUrl"), DEFAULT_BREEZE_URL);
  const model = pick(config, "breezeTtsModel") || DEFAULT_BREEZE_MODEL;
  const voiceId = await resolveBreezeVoice(ctx, config, key);
  const guidanceRaw = num(config, "breezeGuidanceScale", DEFAULT_BREEZE_GUIDANCE);
  const guidance = Math.min(10, Math.max(1, guidanceRaw));
  const rate = Number.isFinite(params?.rate) ? Math.min(2, Math.max(0.5, params.rate)) : num(config, "rate", 1);
  const instructions = buildInstructions(params?.mood, rate, pick(config, "breezeInstructions"));

  const body = {
    text,
    model_id: model,
    voice_settings: { guidance_scale: guidance },
  };
  if (instructions) body.instructions = instructions;

  const response = await request(
    ctx,
    `${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${format === "wav" ? "wav_24000" : "mp3_24000_128"}&delivery=sync`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    SPEAK_ATTEMPT_TIMEOUT_MS,
    2,
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) throw fail("EUPSTREAM", "BreezeBlue 返回了 0 字节音频");
  if (bytes.length > MAX_AUDIO_BYTES) throw fail("EUPSTREAM", `音频过大（${bytes.length} 字节）`);

  const chars = speechChars(text);
  const durMs = (format === "wav" ? wavDurationMs(bytes) : 0) || estimateDurMs(text, rate);
  const price = priceOf(config);
  const costCny = Number(((chars / 1_000_000) * price.perMillionChars).toFixed(6));
  ctx.log(`BreezeBlue 合成 ${chars} 字 → ${bytes.length}B，估 ${durMs}ms，¥${costCny}`);
  return {
    ok: true,
    provider: "breezeblue",
    dataBase64: Buffer.from(bytes).toString("base64"),
    mime: sniffMime(bytes),
    durMs,
    model,
    voiceId,
    costCny,
    estimated: true,
  };
}

/** OpenAI 兼容合成：POST /v1/audio/speech（provider=openai 或自建服务） */
async function openaiSpeak(params, ctx, config) {
  const text = requireText(params?.text, "text", MAX_SPEAK_CHARS);
  const key = apiKey();
  if (!key) return { ok: false, status: "blocked", message: "未配置 media.api_key" };

  const model = pick(config, "ttsModel", "media.ttsModel") || DEFAULT_TTS_MODEL;
  const voice = pick(config, "voice", "media.voice") || DEFAULT_VOICE;
  const rate = Number.isFinite(params?.rate) ? Math.min(2, Math.max(0.5, params.rate)) : num(config, "rate", 1);
  const format = speakFormat(params);
  const body = {
    model,
    voice,
    input: text,
    // mp3 全平台可播；opus 在部分旧音频栈上会哑掉。微信语音条要 wav（能直接喂 waveOut）。
    response_format: format === "wav" ? "wav" : "mp3",
    speed: rate,
  };
  const response = await request(
    ctx,
    `${apiRoot(pick(config, "baseUrl", "media.baseUrl"))}/v1/audio/speech`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    SPEAK_ATTEMPT_TIMEOUT_MS,
    2,
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) throw fail("EUPSTREAM", "媒体服务返回了 0 字节音频");
  if (bytes.length > MAX_AUDIO_BYTES) throw fail("EUPSTREAM", `音频过大（${bytes.length} 字节）`);

  const durMs = estimateDurMs(text, rate);
  const price = priceOf(config);
  const costCny = price.perSecond > 0 ? Number(((durMs / 1000) * price.perSecond).toFixed(6)) : 0;
  ctx.log(`合成 ${[...text].length} 字 → ${bytes.length}B，估 ${durMs}ms`);
  return {
    ok: true,
    provider: "openai",
    dataBase64: Buffer.from(bytes).toString("base64"),
    mime: sniffMime(bytes),
    durMs,
    model,
    costCny,
    estimated: true,
  };
}

const runtime = createPlugin({
  id: "core.media",
  capabilities: ["media.speak", "media.listen", "media.voices", "media.image"],
  handlers: {
    "plugin.health.check": async (_params, ctx) => {
      const config = await getConfig(ctx);
      const provider = providerOf(config);
      const bKey = breezeKey();
      const oKey = apiKey();
      const breezeModel = pick(config, "breezeTtsModel") || DEFAULT_BREEZE_MODEL;
      const opensaiModel = pick(config, "ttsModel", "media.ttsModel");
      const asrModel = pick(config, "asrModel", "media.asrModel");
      let speak = provider === "breezeblue" ? Boolean(bKey) : Boolean(oKey && opensaiModel);
      const listen = Boolean(oKey && asrModel);
      const messages = [];

      if (provider === "breezeblue" && bKey) {
        // 真的打一次只读接口：网络通不通、密钥认不认，只有打了才知道。
        const base = apiRoot(pick(config, "breezeBaseUrl"), DEFAULT_BREEZE_URL);
        const started = Date.now();
        try {
          const query = new URLSearchParams({ language_code: pick(config, "breezeLanguage") || "zh", page_size: "1" });
          await request(
            ctx,
            `${base}/v1/voices?${query.toString()}`,
            { method: "GET", headers: { "xi-api-key": bKey } },
            12_000,
            1,
          );
          messages.push(`合成就绪（BreezeBlue·${breezeModel}，密钥有效，${Date.now() - started}ms）`);
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          const denied = /HTTP 40[13]/.test(text);
          if (denied) {
            speak = false;
            messages.push(`合成不可用：BreezeBlue 拒了这把密钥（breeze.api_key 无效或已撤销）`);
          } else {
            messages.push(`合成暂不可用：${text}`);
          }
        }
      } else if (speak) {
        messages.push(`合成（OpenAI 兼容）就绪`);
      } else if (provider === "breezeblue") {
        messages.push("合成不可用：未填 breeze.api_key（BreezeBlue 密钥）");
      } else {
        messages.push("合成不可用：未填 media.api_key 或 ttsModel");
      }

      if (listen) messages.push("识别就绪");
      else messages.push("识别不可用：需要另配 OpenAI 兼容的 asrModel 与 media.api_key（BreezeBlue 只有合成）");
      return {
        ok: true,
        status: speak || listen ? "ready" : "degraded",
        message: messages.join("；"),
        provider,
        attachments: { listen, speak },
      };
    },

    "plugin.media.speak": async (params, ctx) => {
      const config = await getConfig(ctx);
      return providerOf(config) === "openai" ? openaiSpeak(params, ctx, config) : breezeSpeak(params, ctx, config);
    },

    "plugin.media.listen": async (params, ctx) => {
      const config = await getConfig(ctx);
      const key = apiKey();
      const model = pick(config, "asrModel", "media.asrModel") || DEFAULT_ASR_MODEL;
      if (!key) return { ok: false, status: "blocked", kind: "error", reason: "未配置 media.api_key" };

      const filePath = typeof params?.path === "string" ? params.path : "";
      if (filePath === "") throw fail("EINVALID", "参数 path 必须是非空字符串");
      // 只允许读内核媒体目录里的文件：插件被要求转写的永远是一条语音，不是任意磁盘路径。
      if (!path.isAbsolute(filePath) || filePath.includes("..")) {
        throw fail("EPERM", "path 必须是内核媒体目录下的绝对路径");
      }
      let bytes;
      try {
        bytes = await fs.readFile(filePath);
      } catch {
        return { ok: false, status: "missing", kind: "error", reason: "音频文件不在了" };
      }
      if (bytes.length === 0) return { ok: false, status: "missing", kind: "error", reason: "音频文件是空的" };
      if (bytes.length > MAX_AUDIO_BYTES) throw fail("EINVALID", "音频文件过大");

      const mime = typeof params?.mime === "string" && params.mime ? params.mime : sniffMime(bytes);
      const ext = mime.includes("wav")
        ? "wav"
        : mime.includes("ogg")
          ? "ogg"
          : mime.includes("mp4") || mime.includes("m4a")
            ? "m4a"
            : mime.includes("webm")
              ? "webm"
              : "mp3";
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: mime }), `voice.${ext}`);
      form.append("model", model);
      form.append("language", "zh");
      form.append("response_format", "json");

      const timeoutMs = Math.min(30_000, Math.max(2_000, num(config, "asrTimeoutMs", 10_000)));
      const response = await request(
        ctx,
        `${apiRoot(pick(config, "baseUrl", "media.baseUrl"))}/v1/audio/transcriptions`,
        { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form },
        timeoutMs,
        1,
      );
      const payload = await response.json().catch(() => ({}));
      const text = typeof payload?.text === "string" ? payload.text.trim() : "";
      const kind = transcriptKind(text);
      const price = priceOf(config);
      const costCny = price.perMinute > 0 ? Number(((price.perMinute / 60) * 1).toFixed(6)) : 0;
      ctx.log(`转写 ${bytes.length}B → ${kind}（${text.slice(0, 40)}）`);
      return { ok: true, text, kind, model, mime, costCny, estimated: true };
    },

    // 图片生成还没排进 P0：保持 blocked，但把"没实现"与"没配置"分开说。
    "plugin.media.image": async (_params, ctx) => {
      const config = await getConfig(ctx);
      const configured = Boolean(apiKey() || breezeKey() || pick(config, "baseUrl", "media.baseUrl"));
      return {
        ok: false,
        status: "blocked",
        configured,
        message: configured ? "图片生成尚未接入（语音先行）" : "未配置媒体服务",
      };
    },

    // 列音色：给管理面板的「声音」栏做下拉用。只读、不计费。
    // BreezeBlue 走 GET /v1/voices（这家有真接口）；OpenAI 兼容那边只能返回当前配置的那一个。
    "plugin.media.voices": async (params, ctx) => {
      const config = await getConfig(ctx);
      const provider = providerOf(config);
      if (provider === "breezeblue") {
        const key = breezeKey();
        if (!key) return { provider, voices: [], message: "没填 breeze.api_key，拿不到音色列表" };
        const base = apiRoot(pick(config, "breezeBaseUrl"), DEFAULT_BREEZE_URL);
        const language = params?.language || pick(config, "breezeLanguage") || "zh";
        try {
          const query = new URLSearchParams({ language_code: language, page_size: "50" });
          const response = await request(
            ctx,
            `${base}/v1/voices?${query.toString()}`,
            { method: "GET", headers: { "xi-api-key": key } },
            20_000,
            2,
          );
          const payload = await response.json().catch(() => null);
          const list = Array.isArray(payload?.voices) ? payload.voices : Array.isArray(payload) ? payload : [];
          const voices = list
            .map((item) => {
              if (!item || typeof item.voice_id !== "string") return null;
              return {
                id: item.voice_id,
                name: typeof item.name === "string" && item.name.trim() !== "" ? item.name : item.voice_id,
                ...(typeof item.language === "string" ? { language: item.language } : {}),
                ...(typeof item.gender === "string" ? { gender: item.gender } : {}),
                ...(typeof item.preview_url === "string" ? { previewUrl: item.preview_url } : {}),
              };
            })
            .filter(Boolean);
          return { provider, voices };
        } catch (error) {
          return { provider, voices: [], message: error instanceof Error ? error.message : String(error) };
        }
      }
      const voice = pick(config, "voice", "media.voice") || DEFAULT_VOICE;
      const model = pick(config, "ttsModel", "media.ttsModel") || DEFAULT_TTS_MODEL;
      return {
        provider,
        voices: [{ id: voice, name: `${voice}（${model}）` }],
        message: "OpenAI 兼容服务没有音色列表接口，这里显示的是配置里填的那个",
      };
    },
  },

  onReady(_info, ctx) {
    ctx.log("core.media 0.3.0 就绪：合成默认 BreezeBlue（breeze-tts-2），识别走 OpenAI 兼容接口");
  },
});

export const stats = () => runtime.stats();
export const _test = {
  apiRoot,
  estimateDurMs,
  sniffMime,
  transcriptKind,
  buildInstructions,
  speechChars,
  providerOf,
};

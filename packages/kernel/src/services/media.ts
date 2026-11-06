/**
 * 语音条的内核侧服务（docs/语音条.md）：
 *
 * - 收：客户端把录好的音频 base64 送进来（`media.upload`），校验 → 落盘到 `<dataDir>/media/.pending`，
 *   15 分钟内被 `chat.send` 绑定就转正，否则进 GC。
 * - 转写：`transcribe()` 调 core.media 的 `plugin.media.listen`，成功写回消息正文，
 *   失败保留 `[语音 12″]` 占位符 + 一句人话（文档 11.2：失败必须让用户看见）。
 * - 出：`synthesize()` 调 `plugin.media.speak`，把音频写进 media 目录并回一条 attachment。
 * - 记账：按秒计价的调用走 `cost.recordMedia`，单价由插件配置给出；给不出就记 0（账可缺，闸不可绕）。
 *
 * 三条硬约束（评审反复强调的）：
 * 1. 不认识的格式一律拒——mime 白名单 + 魔数嗅探双重校验，扩展名只从白名单生成；
 * 2. 路径永不来自输入——落盘文件名全是 randomUUID，读盘时做 mediaRoot 前缀校验；
 * 3. 转写/合成失败不许静默——attachment.error 与 media.status 都要有中文原因。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  AUDIO_DUR_MAX_MS,
  AUDIO_DUR_TOLERANCE_MS,
  AUDIO_MAX_BYTES,
  MEDIA_UPLOAD_TTL_MS,
  audioExtForMime,
  estimateSpeakCostCeilingByCharsCny,
  estimateSpeakCostCeilingCny,
  mimeForAudioExt,
  normalizeDurationMs,
  normalizePeaks,
  sniffAudioMagic,
  voicePlaceholder,
} from "@anteros/shared";
import type { AudioExt, MessageAttachment, PluginInfo, VoiceOption } from "@anteros/shared";
import { AnterosError, ERROR_CODES } from "@anteros/shared";
import type { Db } from "../db/database.js";
import type { LogSink } from "../util/log.js";
import type { SettingsService } from "../settings.js";
import type { CostService } from "./cost.js";
import type { SpeechMood } from "../contracts.js";

/** 转写窗口上限：超过这个时间就该先告诉用户"还在听"（文档 11.2），而不是空着等。 */
export const ASR_TIMEOUT_MS = 10_000;
/**
 * 合成超时：一句 56 字的话最慢也就十几秒，留足余量但不许挂死。
 *
 * 历史：曾经给到 150 秒（怕线路慢 + 插件重试）。实测「线路连不上」时它不是慢慢变慢，
 * 而是一动不动直到超时——气泡就会在「语音生成中…」上干等两分半，看起来像卡死。
 * 现在插件单次 35 秒、最多 2 次（≈70 秒），这里给 90 秒总闸：一分钟多一点一定有结论，
 * 要么出声，要么把气泡标成「没能生成」并把正文露出来。
 */
export const TTS_TIMEOUT_MS = 90_000;
/**
 * 默认按字计价（元 / 百万字）：BreezeBlue 官方 $30 / 1M 字符 ≈ ¥216。
 * 插件没配这个数时用它兜底——预检为 0 等于把成本硬上限对语音放空。
 */
export const DEFAULT_SPEAK_PRICE_PER_MILLION_CHARS = 216;

export interface MediaPluginBridge {
  list(): unknown[];
  call(pluginId: string, method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
}

export interface MediaServiceParts {
  db: Db;
  /** <userData>/data；媒体目录固定是它下面的 media/ */
  dataDir: string;
  log: LogSink;
  plugins: MediaPluginBridge;
  settings: SettingsService;
  cost: CostService;
  agentId: number;
}

/** attachment 补丁：transcriptKind / error 允许显式置 null 表示"清掉这个字段"。 */
export type AttachmentPatch = Omit<Partial<MessageAttachment>, "transcriptKind" | "error"> & {
  transcriptKind?: MessageAttachment["transcriptKind"] | null;
  error?: string | null;
};

interface PendingUpload {
  path: string;
  mime: string;
  ext: AudioExt;
  bytes: number;
  durMs: number;
  peaks: number[];
  ts: number;
}

export interface MediaStatus {
  listenReady: boolean;
  speakReady: boolean;
  message: string;
  asrAffordable: boolean;
  voiceOutbound: "off" | "auto" | "always";
  reason?: string;
}

const MEDIA_PLUGIN_ID = "core.media";

export class MediaService {
  private readonly mediaRoot: string;
  private readonly pendingDir: string;
  private readonly pending = new Map<string, PendingUpload>();

  constructor(private readonly parts: MediaServiceParts) {
    this.mediaRoot = join(parts.dataDir, "media");
    this.pendingDir = join(this.mediaRoot, ".pending");
    mkdirSync(this.pendingDir, { recursive: true });
  }

  // ───────────────────────────── 收：上传与绑定 ─────────────────────────────

  /** 校验并暂存一段录音。返回的 attachment 是"能立刻显示"的形态（state ready）。 */
  upload(input: { dataBase64?: unknown; mime?: unknown; durMs?: unknown; peaks?: unknown }): {
    uploadId: string;
    attachment: MessageAttachment;
  } {
    const raw = typeof input?.dataBase64 === "string" ? input.dataBase64 : "";
    if (raw === "") throw new AnterosError(ERROR_CODES.EINVALID, "没有收到音频数据");
    // 先按 base64 长度粗筛，避免把上百 MB 的字符串解码进内存。
    if (raw.length > Math.ceil((AUDIO_MAX_BYTES * 4) / 3) + 16) {
      throw new AnterosError(ERROR_CODES.EINVALID, "这段语音太大了（上限 4MB）", {
        hint: "录短一点，或者换更省空间的格式",
      });
    }
    const mimeRaw = typeof input.mime === "string" ? input.mime : "";
    const ext = audioExtForMime(mimeRaw);
    if (!ext) {
      throw new AnterosError(ERROR_CODES.EINVALID, `不支持的音频格式：${mimeRaw || "(空)"}`, {
        hint: "只接受 webm / ogg / mp3 / wav",
      });
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(raw, "base64");
    } catch {
      throw new AnterosError(ERROR_CODES.EINVALID, "音频数据不是合法的 base64");
    }
    if (bytes.byteLength === 0) throw new AnterosError(ERROR_CODES.EINVALID, "音频数据是空的");
    if (bytes.byteLength > AUDIO_MAX_BYTES) {
      throw new AnterosError(ERROR_CODES.EINVALID, "这段语音太大了（上限 4MB）");
    }
    const sniffed = sniffAudioMagic(bytes);
    if (sniffed === null) {
      throw new AnterosError(ERROR_CODES.EINVALID, "音频文件头认不出来", {
        hint: "可能是浏览器给的容器格式和我们支持的四种都不一样，换一个浏览器或检查录音设备",
      });
    }
    if (sniffed !== ext) {
      throw new AnterosError(ERROR_CODES.EINVALID, `音频格式对不上：声明 ${ext}，文件头是 ${sniffed}`);
    }
    const durMs = normalizeDurationMs(input.durMs);
    if (durMs === 0 && input.durMs !== undefined && Number(input.durMs) > AUDIO_DUR_MAX_MS + AUDIO_DUR_TOLERANCE_MS) {
      throw new AnterosError(ERROR_CODES.EINVALID, `这段语音太长了（上限 ${Math.round(AUDIO_DUR_MAX_MS / 1000)} 秒）`);
    }
    const peaks = normalizePeaks(input.peaks);
    const uploadId = randomUUID();
    const abs = join(this.pendingDir, `${uploadId}.${ext}`);
    mkdirSync(this.pendingDir, { recursive: true });
    writeFileSync(abs, bytes);
    this.pending.set(uploadId, {
      path: abs,
      mime: mimeForAudioExt(ext),
      ext,
      bytes: bytes.byteLength,
      durMs,
      peaks,
      ts: Date.now(),
    });
    return {
      uploadId,
      attachment: {
        kind: "audio",
        path: this.toRelative(abs),
        mime: mimeForAudioExt(ext),
        bytes: bytes.byteLength,
        durMs,
        peaks,
        state: "ready",
      },
    };
  }

  /** 把暂存的录音转正到 media/voice/YYYY-MM-DD/，返回最终 attachment（chat.send 用它写库）。 */
  bindUpload(uploadId: string): MessageAttachment {
    const item = this.pending.get(uploadId);
    if (!item) {
      throw new AnterosError(ERROR_CODES.ENOTFOUND, "录音已过期（超过 15 分钟），再录一次吧");
    }
    const dir = join(this.voiceRoot(), dateKey(Date.now()));
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `${randomUUID()}.${item.ext}`);
    renameSync(item.path, target);
    this.pending.delete(uploadId);
    return {
      kind: "audio",
      path: this.toRelative(target),
      mime: item.mime,
      bytes: item.bytes,
      durMs: item.durMs,
      peaks: item.peaks,
      state: "ready",
    };
  }

  // ───────────────────────────── 读：给界面送字节 ─────────────────────────────

  /** 取音频字节。uploadId 走暂存区；messageId 走消息里的 attachment。 */
  load(input: { uploadId?: string; messageId?: number }): {
    dataBase64: string;
    mime: string;
    durMs: number;
    transcript?: string | null;
  } {
    if (typeof input.uploadId === "string" && input.uploadId !== "") {
      const item = this.pending.get(input.uploadId);
      if (!item) throw new AnterosError(ERROR_CODES.ENOTFOUND, "录音已过期，再录一次吧");
      return {
        dataBase64: readFileSync(item.path).toString("base64"),
        mime: item.mime,
        durMs: item.durMs,
        transcript: null,
      };
    }
    if (typeof input.messageId === "number") {
      const att = this.readAttachment(input.messageId);
      if (!att) throw new AnterosError(ERROR_CODES.ENOTFOUND, "这条消息没有语音");
      if (att.state === "pending") throw new AnterosError(ERROR_CODES.EINVALID, "语音还在生成，稍等一下");
      if (att.state === "missing") throw new AnterosError(ERROR_CODES.ENOTFOUND, "这段语音的文件不在了");
      const abs = this.absOf(att.path);
      if (!existsSync(abs)) {
        this.patchAttachment(input.messageId, { state: "missing", error: "语音文件不在了" });
        throw new AnterosError(ERROR_CODES.ENOTFOUND, "这段语音的文件不在了");
      }
      return {
        dataBase64: readFileSync(abs).toString("base64"),
        mime: att.mime,
        durMs: att.durMs,
        transcript: att.transcript ?? null,
      };
    }
    throw new AnterosError(ERROR_CODES.EINVALID, "要么给 uploadId，要么给 messageId");
  }

  /** 语音单价（元/秒），预检用。插件没配单价就是 0——硬上限对音频失效，文档 17 节第 1 条。 */
  speakPricePerSecond(): number {
    const info = this.findPluginInfo();
    return this.configNumber(info, "pricePerSecondCny", 0);
  }

  /**
   * 按字计价的合成单价（元 / 百万字）。BreezeBlue 这类供应商按字符收费（$30 / 1M 字符），
   * 只按秒估会得出 0，等于让预算闸对语音失效。
   */
  speakPricePerMillionChars(): number {
    const info = this.findPluginInfo();
    // 插件没填就按 BreezeBlue 的官方价兜底（¥216 / 百万字），不能是 0——
    // 0 会让"预算闸"对语音彻底失效，而语音又是唯一可能几毛一条的通道。
    return this.configNumber(info, "pricePerMillionCharsCny", DEFAULT_SPEAK_PRICE_PER_MILLION_CHARS);
  }

  /**
   * 出站预检上限（文档 10.6）：两种计价口径取大者。插件一般只配其中一种，
   * 另一种是 0，取大不会重复收费，也不会因为口径不对把闸门放空。
   */
  speakCeilingCny(text: string, rate: number): number {
    const bySecond = estimateSpeakCostCeilingCny(text, this.speakPricePerSecond(), rate);
    const byChars = estimateSpeakCostCeilingByCharsCny(text, this.speakPricePerMillionChars());
    return Math.max(bySecond, byChars);
  }

  /** 这笔钱花下去会不会越过本月预算（出站预检用 ceiling 值，文档 10.6）。 */
  affordable(costCny: number): boolean {
    const budget = this.parts.settings.get("plan.budgetCny");
    const month = this.parts.cost.monthTotal();
    return month + Math.max(0, costCny) <= budget;
  }

  /** 面板/调试用：语音能力到底通不通。每个 false 都带中文原因。 */
  status(): MediaStatus {
    const outbound = this.parts.settings.get("media.voiceOutbound");
    const plugin = this.findPlugin();
    const info = plugin ? (this.parts.plugins.list() as PluginInfo[]).find((p) => p.id === plugin) : undefined;
    const health = info?.health ?? null;
    const attachments = (health as { attachments?: { listen?: boolean; speak?: boolean } } | null)?.attachments ?? null;
    const listenReady = Boolean(info?.enabled) && attachments?.listen === true;
    const speakReady = Boolean(info?.enabled) && attachments?.speak === true;
    const budget = this.parts.settings.get("plan.budgetCny");
    const month = this.parts.cost.monthTotal();
    const pricePerMinute = this.configNumber(info, "pricePerMinuteCny", 0);
    const asrAffordable = listenReady && month + pricePerMinute <= budget;
    let message: string;
    // 插件自己知道得最清楚（哪一路缺什么密钥），优先把它的原话给用户看；
    // 只有它没说话时才回退到内核的通用判断。
    const healthMessage =
      health && typeof (health as { message?: unknown }).message === "string"
        ? (health as { message: string }).message.trim()
        : "";
    if (!info) message = "没装语音插件（core.media），现在只能收发文字";
    else if (!info.enabled) message = "语音插件装了但没启用";
    else if (healthMessage !== "" && (!listenReady || !speakReady)) message = healthMessage;
    else if (info.missingSecrets.length > 0) message = `语音插件缺密钥（${info.missingSecrets.join("、")}）`;
    else if (!listenReady && !speakReady) message = "语音插件开着，但没握手成功（看看它的健康状态）";
    else if (!listenReady) message = "能说话，但听不了（没配识别模型）";
    else if (!speakReady) message = "能听，但说不了（没配合成模型）";
    else if (!asrAffordable) message = "本月预算不够再听一条语音了";
    else message = "语音能用";
    return { listenReady, speakReady, message, asrAffordable, voiceOutbound: outbound };
  }

  /** 同步时长/波形：客户端实际播出来的时长比估算准，以它为准（文档 9.1）。 */
  metaSet(input: { messageId: number; durMs?: unknown; peaks?: unknown }): MessageAttachment {
    const att = this.readAttachment(input.messageId);
    if (!att) throw new AnterosError(ERROR_CODES.ENOTFOUND, "这条消息没有语音");
    const patch: Partial<MessageAttachment> = {};
    const durMs = normalizeDurationMs(input.durMs);
    if (durMs > 0 && Math.abs(durMs - att.durMs) > 200) patch.durMs = durMs;
    const peaks = normalizePeaks(input.peaks);
    if (peaks.length > 0 && att.peaks.length === 0) patch.peaks = peaks;
    if (Object.keys(patch).length === 0) return att;
    return this.patchAttachment(input.messageId, patch) ?? att;
  }

  // ───────────────────────────── 转写（听） ─────────────────────────────

  /**
   * 把一条语音消息转成文字。成功时正文被改写、attachment 记 transcript；
   * 失败时保留占位符并写一句人话进去（文档 11.2），调用方据此走"没听清"的回复分支。
   */
  async transcribe(messageId: number): Promise<{ ok: true; text: string; silent: boolean } | { ok: false; reason: string }> {
    const att = this.readAttachment(messageId);
    if (!att) return { ok: false, reason: "这条消息没有语音" };
    if (att.transcript && att.transcript.length > 0) return { ok: true, text: att.transcript, silent: false };
    if (att.transcriptKind === "none") return { ok: true, text: "", silent: true };
    const status = this.status();
    if (!status.listenReady) {
      const reason = status.message;
      this.patchAttachment(messageId, { transcriptKind: "error", error: reason });
      return { ok: false, reason };
    }
    const abs = this.absOf(att.path);
    if (!existsSync(abs)) {
      this.patchAttachment(messageId, { state: "missing", error: "语音文件不在了" });
      return { ok: false, reason: "语音文件不在了" };
    }
    let result: unknown;
    try {
      result = await this.parts.plugins.call(
        MEDIA_PLUGIN_ID,
        "plugin.media.listen",
        { path: abs, mime: att.mime, durMs: att.durMs },
        { timeoutMs: ASR_TIMEOUT_MS },
      );
    } catch (err) {
      const reason = err instanceof AnterosError ? err.message : ((err as Error)?.message ?? String(err));
      this.parts.log.warn(`语音转写失败（消息 ${messageId}）：${reason}`);
      this.patchAttachment(messageId, { transcriptKind: "error", error: reason });
      return { ok: false, reason };
    }
    const parsed = result as { text?: unknown; kind?: unknown; costCny?: unknown; model?: unknown; reason?: unknown };
    const kind = parsed?.kind === "none" || parsed?.kind === "error" || parsed?.kind === "assistant" ? parsed.kind : "assistant";
    if (kind === "none") {
      this.patchAttachment(messageId, { transcriptKind: "none" });
      return { ok: true, text: "", silent: true };
    }
    if (kind === "error") {
      const reason = typeof parsed.reason === "string" && parsed.reason !== "" ? parsed.reason : "没听清";
      this.patchAttachment(messageId, { transcriptKind: "error", error: reason });
      return { ok: false, reason };
    }
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    if (text === "") {
      this.patchAttachment(messageId, { transcriptKind: "none" });
      return { ok: true, text: "", silent: true };
    }
    const costCny = typeof parsed.costCny === "number" && Number.isFinite(parsed.costCny) ? parsed.costCny : 0;
    const model = typeof parsed.model === "string" ? parsed.model : "asr";
    try {
      this.parts.cost.recordMedia({ kind: "media.asr", model, costCny, estimated: costCny === 0 });
    } catch (err) {
      this.parts.log.warn(`语音识别记账失败：${(err as Error)?.message ?? String(err)}`);
    }
    this.patchAttachment(messageId, { transcript: text, transcriptKind: "asr", error: null });
    return { ok: true, text, silent: false };
  }

  /** 官方对嫌麻烦的美德：失败后给一次重试入口（文档 11.2 / 11.3）。 */
  async retry(input: { messageId: number }): Promise<{ ok: boolean; text?: string; reason?: string }> {
    const att = this.readAttachment(input.messageId);
    if (!att) return { ok: false, reason: "这条消息没有语音" };
    if (att.transcript && att.transcript.length > 0) return { ok: true, text: att.transcript };
    this.patchAttachment(input.messageId, { transcriptKind: null, error: null });
    const result = await this.transcribe(input.messageId);
    return result.ok ? { ok: true, text: result.text } : { ok: false, reason: result.reason };
  }

  // ───────────────────────────── 合成（说） ─────────────────────────────

  /**
   * 合成失败后重来一次：只有「说话」这一侧会失败（识别侧走 retry）。
   * 朗读稿原文存在 attachment.transcript 里，所以不需要模型再写一遍。
   */
  async respeak(input: { messageId: number }): Promise<{ ok: boolean; attachment?: MessageAttachment; reason?: string }> {
    const att = this.readAttachment(input.messageId);
    if (!att) return { ok: false, reason: "这条消息没有语音" };
    if (att.state === "ready" && att.path !== "") return { ok: true, attachment: att };
    const text = typeof att.transcript === "string" ? att.transcript.trim() : "";
    if (text === "") return { ok: false, reason: "这条语音没有留下朗读稿，没法重新生成" };
    try {
      const { attachment } = await this.synthesize({ text, rate: 1, volume: 1 });
      const next = this.patchAttachment(input.messageId, {
        state: "ready",
        path: attachment.path,
        mime: attachment.mime,
        bytes: attachment.bytes,
        durMs: attachment.durMs,
        peaks: [],
        costCny: attachment.costCny,
        error: null,
        transcriptKind: "shown",
      });
      return { ok: true, attachment: next ?? attachment };
    } catch (err) {
      const reason = err instanceof AnterosError ? err.message : ((err as Error)?.message ?? String(err));
      this.patchAttachment(input.messageId, { state: "skipped", error: reason });
      return { ok: false, reason };
    }
  }

  /**
   * 把朗读稿合成为一段音频，落盘后返回 attachment。
   * 失败直接抛错——调用方（chat.ts）负责把它变成 skipped，绝不影响正文投递。
   *
   * 长文本处理（v1.0.29）：一次合成只送**一句话**进插件。整段先按句切开，
   * 一句一次调用，最后把音频拼成一条。原因是长文本一次性送进 TTS 会崩
   * （实测：一段长回复直接失败或超时，拆成单句就稳）。多句必然要求 wav，
   * 因为 PCM 能无损拼接；供应商没给 wav 时退化成"只播第一句"并记一条 warn。
   */
  async synthesize(input: {
    text: string;
    rate?: number;
    volume?: number;
    cacheKey?: string;
    mood?: SpeechMood;
    /** mp3 给应用内播放器；wav 给外部通道（虚拟声卡要能直接喂 waveOut） */
    format?: "mp3" | "wav";
  }): Promise<{ attachment: MessageAttachment; costCny: number }> {
    const status = this.status();
    if (!status.speakReady) throw new AnterosError(ERROR_CODES.EDEGRADED, status.message);
    const sentences = splitSpeechSentences(input.text);
    if (sentences.length === 0) throw new AnterosError(ERROR_CODES.EDEGRADED, "没有可合成的内容");
    // 多句必须 wav 才能拼；单句按调用方要的格式。
    const format: "mp3" | "wav" = sentences.length > 1 ? "wav" : input.format === "wav" ? "wav" : "mp3";

    const pieces: Buffer[] = [];
    let costCny = 0;
    let model = "tts";
    let durMs = 0;
    let firstMime = "";
    for (const sentence of sentences) {
      let result: unknown;
      try {
        result = await this.parts.plugins.call(
          MEDIA_PLUGIN_ID,
          "plugin.media.speak",
          {
            text: sentence,
            rate: input.rate,
            volume: input.volume,
            cacheKey: sentences.length === 1 ? input.cacheKey : undefined,
            mood: input.mood,
            format,
          },
          { timeoutMs: TTS_TIMEOUT_MS },
        );
      } catch (err) {
        const reason = err instanceof AnterosError ? err.message : ((err as Error)?.message ?? String(err));
        throw new AnterosError(ERROR_CODES.EDEGRADED, `语音合成失败：${reason}`);
      }
      const parsed = result as { dataBase64?: unknown; mime?: unknown; durMs?: unknown; costCny?: unknown; model?: unknown };
      const b64 = typeof parsed?.dataBase64 === "string" ? parsed.dataBase64 : "";
      if (b64 === "") throw new AnterosError(ERROR_CODES.EDEGRADED, "语音合成没返回音频");
      const bytes = Buffer.from(b64, "base64");
      if (bytes.byteLength === 0) throw new AnterosError(ERROR_CODES.EDEGRADED, "语音合成返回了空音频");
      pieces.push(bytes);
      if (firstMime === "" && typeof parsed.mime === "string") firstMime = parsed.mime;
      if (typeof parsed.costCny === "number" && Number.isFinite(parsed.costCny)) costCny += parsed.costCny;
      if (typeof parsed.model === "string") model = parsed.model;
      durMs += normalizeDurationMs(parsed.durMs);
    }

    let bytes: Buffer = Buffer.concat(pieces);
    if (pieces.length > 1) {
      const merged = mergeWavBuffers(pieces);
      if (merged) {
        bytes = merged;
        // 拼接后的真实时长以合并结果为准（供应商可能不报每句时长）。
        durMs = wavDurationMs(merged) || durMs;
      } else {
        this.parts.log.warn("多句语音拼接失败（不是同格式的 wav），只保留第一句声音");
        bytes = pieces[0]!;
        // 时长按留下来的那一段报，别报成所有句子的总和（界面会显示一个它说不了的长度）。
        durMs = wavDurationMs(bytes) || 0;
      }
    }
    if (bytes.byteLength > AUDIO_MAX_BYTES) throw new AnterosError(ERROR_CODES.EDEGRADED, "合成出来的音频太大（>4MB）");
    const sniffed = sniffAudioMagic(bytes);
    const ext = audioExtForMime(firstMime) ?? sniffed;
    if (!ext) throw new AnterosError(ERROR_CODES.EDEGRADED, "合成出来的音频格式不认识");
    const dir = join(this.voiceRoot(), dateKey(Date.now()));
    mkdirSync(dir, { recursive: true });
    const abs = join(dir, `${randomUUID()}.${ext}`);
    writeFileSync(abs, bytes);
    try {
      this.parts.cost.recordMedia({ kind: "media.tts", model, costCny, estimated: costCny === 0 });
    } catch (err) {
      this.parts.log.warn(`语音合成记账失败：${(err as Error)?.message ?? String(err)}`);
    }
    return {
      costCny,
      attachment: {
        kind: "audio",
        path: this.toRelative(abs),
        mime: mimeForAudioExt(ext),
        bytes: bytes.byteLength,
        durMs,
        peaks: [],
        state: "ready",
        transcript: input.text,
        transcriptKind: "shown",
        costCny,
      },
    };
  }

  /**
   * 列出供应商能给到的音色（管理面板「声音」用）。只读、不计费。
   *
   * 列不出来也返回 ok:false + message：界面要显示原因，而不是一个空白下拉框。
   */
  async voices(): Promise<{ ok: boolean; provider: string; voices: VoiceOption[]; message?: string }> {
    try {
      const result = (await this.parts.plugins.call(MEDIA_PLUGIN_ID, "plugin.media.voices", {}, { timeoutMs: 30_000 })) as {
        provider?: unknown;
        voices?: unknown;
        message?: unknown;
      };
      const raw = Array.isArray(result?.voices) ? result.voices : [];
      const voices: VoiceOption[] = [];
      for (const item of raw) {
        const row = item as { id?: unknown; name?: unknown; language?: unknown; gender?: unknown; previewUrl?: unknown };
        if (typeof row?.id !== "string" || row.id === "") continue;
        voices.push({
          id: row.id,
          name: typeof row.name === "string" && row.name !== "" ? row.name : row.id,
          ...(typeof row.language === "string" ? { language: row.language } : {}),
          ...(typeof row.gender === "string" ? { gender: row.gender } : {}),
          ...(typeof row.previewUrl === "string" ? { previewUrl: row.previewUrl } : {}),
        });
      }
      return {
        ok: voices.length > 0,
        provider: typeof result?.provider === "string" ? result.provider : "unknown",
        voices,
        ...(typeof result?.message === "string" && result.message !== "" ? { message: result.message } : {}),
      };
    } catch (err) {
      const reason = err instanceof AnterosError ? err.message : ((err as Error)?.message ?? String(err));
      return { ok: false, provider: "unknown", voices: [], message: `拿不到音色列表：${reason}` };
    }
  }

  /**
   * 试听一句：不进对话、不占语音档位、不落消息表，但成本照实记账。
   * 音频直接以 base64 回给客户端播放，省掉"预览文件"的落盘与清理。
   */
  async preview(text: string): Promise<{
    ok: boolean;
    audioBase64?: string;
    mime?: string;
    durMs?: number;
    costCny?: number;
    reason?: string;
  }> {
    const status = this.status();
    if (!status.speakReady) return { ok: false, reason: status.message };
    const sentence = text.trim() === "" ? "嗯，我在。你听得清吗？" : text.trim().slice(0, 60);
    const ceiling = this.speakCeilingCny(sentence, 1);
    if (ceiling > 0 && !this.affordable(ceiling)) return { ok: false, reason: "这个月的语音预算已经不够试听了" };
    let result: unknown;
    try {
      result = await this.parts.plugins.call(
        MEDIA_PLUGIN_ID,
        "plugin.media.speak",
        { text: sentence, rate: 1 },
        { timeoutMs: TTS_TIMEOUT_MS },
      );
    } catch (err) {
      const reason = err instanceof AnterosError ? err.message : ((err as Error)?.message ?? String(err));
      return { ok: false, reason };
    }
    const parsed = result as { dataBase64?: unknown; mime?: unknown; durMs?: unknown; costCny?: unknown; model?: unknown };
    const b64 = typeof parsed?.dataBase64 === "string" ? parsed.dataBase64 : "";
    if (b64 === "") return { ok: false, reason: "合成没返回音频" };
    const costCny = typeof parsed.costCny === "number" && Number.isFinite(parsed.costCny) ? parsed.costCny : 0;
    try {
      this.parts.cost.recordMedia({
        kind: "media.tts",
        model: typeof parsed.model === "string" ? parsed.model : "tts",
        costCny,
        estimated: costCny === 0,
      });
    } catch (err) {
      this.parts.log.warn(`试听记账失败：${(err as Error)?.message ?? String(err)}`);
    }
    return {
      ok: true,
      audioBase64: b64,
      mime: typeof parsed.mime === "string" && parsed.mime !== "" ? parsed.mime : "audio/mpeg",
      durMs: normalizeDurationMs(parsed.durMs),
      costCny,
    };
  }

  // ───────────────────────────── attachment 读写 ─────────────────────────────

  readAttachment(messageId: number): MessageAttachment | null {
    const row = this.parts.db.get<{ attachment: string | null }>(
      "SELECT attachment FROM messages WHERE id = ? AND agent_id = ?",
      [messageId, this.parts.agentId],
    );
    if (!row || row.attachment === null || row.attachment === "") return null;
    try {
      const parsed = JSON.parse(row.attachment) as MessageAttachment;
      if (!parsed || parsed.kind !== "audio" || typeof parsed.path !== "string") return null;
      if (!Array.isArray(parsed.peaks)) parsed.peaks = [];
      return parsed;
    } catch {
      // 一条坏 attachment 不该让整个历史打不开。
      return null;
    }
  }

  writeAttachment(messageId: number, att: MessageAttachment): void {
    this.parts.db.run("UPDATE messages SET attachment = ? WHERE id = ? AND agent_id = ?", [
      JSON.stringify(att),
      messageId,
      this.parts.agentId,
    ]);
  }

  patchAttachment(messageId: number, patch: AttachmentPatch): MessageAttachment | null {
    const current = this.readAttachment(messageId);
    if (!current) return null;
    const next: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) delete next[key];
      else next[key] = value;
    }
    const result = next as unknown as MessageAttachment;
    this.writeAttachment(messageId, result);
    return result;
  }

  /** 占位符正文：给 chat.send 建临时气泡用，模板只在 shared 里有一份。 */
  placeholderFor(att: MessageAttachment): string {
    return voicePlaceholder({ durMs: att.durMs });
  }

  // ───────────────────────────── GC ─────────────────────────────

  /** 清掉过了 TTL 还没被绑定的暂存录音（文档 5.2：15 分钟）。返回删了几个。 */
  gc(now = Date.now()): number {
    let removed = 0;
    for (const [id, item] of this.pending) {
      if (now - item.ts < MEDIA_UPLOAD_TTL_MS) continue;
      try {
        if (existsSync(item.path)) rmSync(item.path, { force: true });
      } catch {
        /* 删不掉就算了，下次启动再删 */
      }
      this.pending.delete(id);
      removed += 1;
    }
    // 进程重启后 pending 表是空的，但盘上可能还留着上次的临时文件。
    if (existsSync(this.pendingDir)) {
      for (const name of readdirSync(this.pendingDir)) {
        const abs = join(this.pendingDir, name);
        try {
          const info = statSync(abs);
          if (info.isFile() && now - info.mtimeMs > MEDIA_UPLOAD_TTL_MS) {
            rmSync(abs, { force: true });
            removed += 1;
          }
        } catch {
          /* 同上 */
        }
      }
    }
    return removed;
  }

  // ───────────────────────────── 内部 ─────────────────────────────

  /** 目录只为了让文件系统别把几万个文件堆在一起；日期用本地时区，人看得懂。 */
  private voiceRoot(): string {
    return join(this.mediaRoot, "voice");
  }

  private findPlugin(): string | null {
    const list = this.parts.plugins.list() as PluginInfo[];
    return list.some((p) => p.id === MEDIA_PLUGIN_ID) ? MEDIA_PLUGIN_ID : null;
  }

  private findPluginInfo(): PluginInfo | undefined {
    return (this.parts.plugins.list() as PluginInfo[]).find((p) => p.id === MEDIA_PLUGIN_ID);
  }

  private configNumber(info: PluginInfo | undefined, key: string, fallback: number): number {
    const raw = info?.config?.[key];
    const value = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(value) ? value : fallback;
  }

  /** attachment 的相对路径 → 绝对路径。外部通道要把文件交给旁路进程去播。 */
  absPathFor(attachment: MessageAttachment): string {
    if (!attachment.path) throw new AnterosError(ERROR_CODES.ENOTFOUND, "这条消息没有音频文件");
    return this.absOf(attachment.path);
  }

  private toRelative(abs: string): string {
    const root = resolve(this.mediaRoot);
    const full = resolve(abs);
    const rel = full.startsWith(root) ? full.slice(root.length + 1) : full;
    return rel.split("\\").join("/");
  }

  private absOf(rel: string): string {
    const root = resolve(this.mediaRoot);
    const full = resolve(this.mediaRoot, rel);
    if (full !== root && !full.startsWith(root + "\\") && !full.startsWith(root + "/")) {
      throw new AnterosError(ERROR_CODES.EINVALID, "语音路径不合法");
    }
    return full;
  }
}

function dateKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 一次合成允许送进 TTS 的最大字数：**一句话**。
 *
 * 实测背景（v1.0.29）：一整段长回复直接送进合成，会出现插件内部错误或超时，
 * 拆成一句一句就不会。超过这个长度的"句子"再按逗号兜底切。
 */
export const SPEECH_SENTENCE_MAX_CHARS = 120;

/**
 * 把朗读稿按句子切开，一句一项；相邻的极短句（≤6 字）跟随前句，
 * 避免「嗯。」「对。」这种碎句各花一次合成钱。
 */
export function splitSpeechSentences(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/[ \t\u3000]+/g, " ").trim();
  if (normalized === "") return [];
  const sentences: string[] = [];
  for (const line of normalized.split(/\n+/)) {
    const pieces = line
      .split(/(?<=[。！？!?…；;])/)
      .map((piece) => piece.trim())
      .filter((piece) => piece.length > 0);
    for (const piece of pieces) {
      const last = sentences[sentences.length - 1];
      if (last !== undefined && (piece.length <= 6 || /^[，,、：:]/.test(piece))) {
        sentences[sentences.length - 1] = `${last}${piece}`;
        continue;
      }
      sentences.push(piece);
    }
  }
  // 单句仍然太长（没有标点的长串）就按逗号切成几截
  const out: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= SPEECH_SENTENCE_MAX_CHARS) {
      out.push(sentence);
      continue;
    }
    let buffer = "";
    for (const clause of sentence.split(/(?<=[，,、])/)) {
      if (buffer.length + clause.length > SPEECH_SENTENCE_MAX_CHARS && buffer.length > 0) {
        out.push(buffer);
        buffer = "";
      }
      if (clause.length > SPEECH_SENTENCE_MAX_CHARS) {
        for (let at = 0; at < clause.length; at += SPEECH_SENTENCE_MAX_CHARS) {
          const slice = clause.slice(at, at + SPEECH_SENTENCE_MAX_CHARS).trim();
          if (slice.length > 0) out.push(slice);
        }
        continue;
      }
      buffer += clause;
    }
    if (buffer.trim().length > 0) out.push(buffer.trim());
  }
  return out.filter((sentence) => sentence.length > 0);
}

/** wav 头里读出来的时长（毫秒）；认不出来回 0。 */
export function wavDurationMs(bytes: Buffer): number {
  const info = readWavInfo(bytes);
  if (!info) return 0;
  if (info.byteRate <= 0) return 0;
  return Math.round((info.dataSize / info.byteRate) * 1000);
}

interface WavInfo {
  header: Buffer;
  byteRate: number;
  dataOffset: number;
  dataSize: number;
  formatTag: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

/** 只认标准 PCM wav（RIFF/WAVE + fmt + data）；其它一律当"拼不了"。 */
function readWavInfo(bytes: Buffer): WavInfo | null {
  if (bytes.byteLength < 44) return null;
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  let formatTag = 0;
  let channels = 0;
  let sampleRate = 0;
  let byteRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= bytes.byteLength) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= bytes.byteLength) {
      formatTag = bytes.readUInt16LE(body);
      channels = bytes.readUInt16LE(body + 2);
      sampleRate = bytes.readUInt32LE(body + 4);
      byteRate = bytes.readUInt32LE(body + 8);
      bitsPerSample = bytes.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataOffset = body;
      dataSize = Math.min(size, bytes.byteLength - body);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (dataOffset < 0 || formatTag !== 1 || byteRate <= 0) return null;
  return {
    header: bytes.subarray(0, dataOffset),
    byteRate,
    dataOffset,
    dataSize,
    formatTag,
    sampleRate,
    channels,
    bitsPerSample,
  };
}

/**
 * 把多段 wav 拼成一条：要求每段的采样率/声道/位深一致（同一供应商同一配置，
 * 正常都一致；不一致就放弃，调用方退化成只播第一句）。
 *
 * 只重写 RIFF 的 4 字节长度与 data 的 4 字节长度，其余头部原样搬第一段的。
 */
export function mergeWavBuffers(buffers: readonly Buffer[]): Buffer | null {
  if (buffers.length === 0) return null;
  if (buffers.length === 1) return buffers[0]!;
  const infos: WavInfo[] = [];
  for (const buffer of buffers) {
    const info = readWavInfo(buffer);
    if (!info) return null;
    infos.push(info);
  }
  const first = infos[0]!;
  for (const info of infos) {
    if (info.sampleRate !== first.sampleRate || info.channels !== first.channels || info.bitsPerSample !== first.bitsPerSample) {
      return null;
    }
  }
  // data 块在头部里的偏移：把第一段头部复制一份，改两处长度即可
  const header = Buffer.from(first.header);
  const dataSizeAt = header.length - 8;
  if (dataSizeAt < 12) return null;
  const totalData = infos.reduce((sum, info) => sum + info.dataSize, 0);
  const out = Buffer.alloc(header.length + totalData);
  header.copy(out, 0);
  out.writeUInt32LE(header.length - 8 + totalData, 4); // RIFF 剩余长度
  out.writeUInt32LE(totalData, dataSizeAt + 4); // data 块长度
  let cursor = header.length;
  for (let index = 0; index < buffers.length; index += 1) {
    const info = infos[index]!;
    buffers[index]!.copy(out, cursor, info.dataOffset, info.dataOffset + info.dataSize);
    cursor += info.dataSize;
  }
  return out;
}
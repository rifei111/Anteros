/**
 * MediaService / voicePolicy（docs/语音条.md）单测。
 *
 * 全部用内存库 + 临时目录 + 假插件：不碰真麦克风、不碰真供应商。
 * 这里守的三件事——上传要真校验、转写失败不许编、出站语音的硬门槛一条都不能漏。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInfo } from "@anteros/shared";
import { CostService } from "../src/services/cost.js";
import { MediaService, mergeWavBuffers, SPEECH_SENTENCE_MAX_CHARS, splitSpeechSentences, wavDurationMs } from "../src/services/media.js";
import { decideVoice, prosodyFor } from "../src/services/voice.js";
import { SettingsService } from "../src/settings.js";
import { insertMessage, makeKernel } from "./fixtures/kernel.js";

const NOW = 1_760_000_000_000;
/** 一段最小的 mp3 头（ID3）——只为了过魔数嗅探，不会被真的解码。 */
const MP3_BYTES = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const MP3_B64 = MP3_BYTES.toString("base64");

interface StubOptions {
  listenResult?: unknown;
  speakResult?: unknown;
  /** 按调用顺序逐次返回，用于验证「一句一句合成」时的多句拼接。 */
  speakResults?: unknown[];
  health?: { listen?: boolean; speak?: boolean } | null;
  healthMessage?: string;
  config?: Record<string, number | string>;
}

/** 造一段 PCM wav（默认 16k/16bit/单声道静音），durMs 决定采样数。 */
function makeWav(durMs: number, sampleRate = 16000, channels = 1, bits = 16): Buffer {
  const bytesPerSample = (bits / 8) * channels;
  const data = Buffer.alloc(Math.round((sampleRate * durMs) / 1000) * bytesPerSample);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * bytesPerSample, 28);
  header.writeUInt16LE(bytesPerSample, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function wavB64(durMs: number, sampleRate = 16000): string {
  return makeWav(durMs, sampleRate).toString("base64");
}

function makeMedia(options: StubOptions = {}) {
  const kernel = makeKernel();
  const calls: Array<{ method: string; params: unknown }> = [];
  const dataDir = mkdtempSync(join(tmpdir(), "anteros-media-"));
  const settings = new SettingsService(kernel.db);
  const cost = new CostService(kernel.db, settings, kernel.deps.agentId);
  const info = {
    id: "core.media",
    enabled: true,
    missingSecrets: [] as string[],
    config: options.config ?? { pricePerSecondCny: 0.02, pricePerMinuteCny: 0.06 },
    health:
      options.health === null
        ? null
        : {
            ok: true,
            status: "ready",
            message: options.healthMessage ?? "就绪",
            checkedTs: NOW,
            attachments: options.health ?? { listen: true, speak: true },
          },
  };
  const plugins = {
    list: () => [info],
    call: async (_id: string, method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "plugin.media.voices") {
        return options.voicesResult ?? { provider: "breezeblue", voices: [{ id: "voc_1", name: "小满", language: "zh" }] };
      }
      if (method === "plugin.media.listen") {
        return options.listenResult ?? { ok: true, text: "今天好累啊", kind: "assistant", model: "whisper-1", costCny: 0.001 };
      }
      if (method === "plugin.media.speak" && options.speakResults && options.speakResults.length > 0) {
        return options.speakResults.shift();
      }
      return options.speakResult ?? { ok: true, dataBase64: MP3_B64, mime: "audio/mpeg", durMs: 1800, model: "tts-1", costCny: 0.036 };
    },
  };
  const media = new MediaService({
    db: kernel.db,
    dataDir,
    log: kernel.deps.log,
    plugins: plugins as never,
    settings,
    cost,
    agentId: kernel.deps.agentId,
  });
  return {
    kernel,
    dataDir,
    media,
    settings,
    cost,
    calls,
    info: info as unknown as PluginInfo,
    close() {
      kernel.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe("语音上传", () => {
  it("正常上传能拿到 uploadId，绑定后落到 media/voice 下并有字节", () => {
    const env = makeMedia();
    try {
      const { uploadId } = env.media.upload({ dataBase64: MP3_B64, mime: "audio/mpeg", durMs: 1500, peaks: [0.1, 0.5] });
      expect(uploadId).toBeTruthy();
      const bound = env.media.bindUpload(uploadId);
      expect(bound.kind).toBe("audio");
      expect(bound.state).toBe("ready");
      expect(bound.durMs).toBe(1500);
      expect(bound.path.startsWith("voice/")).toBe(true);
      const bytes = readFileSync(join(env.dataDir, "media", bound.path));
      expect(bytes.byteLength).toBe(MP3_BYTES.byteLength);
      // 同一个 uploadId 只能绑一次：重放要报"过期"，不能把同一条语音发两遍。
      expect(() => env.media.bindUpload(uploadId)).toThrowError(/过期/);
    } finally {
      env.close();
    }
  });

  it("声称的格式与文件头不一致就拒绝（防止把任意文件塞进语音条）", () => {
    const env = makeMedia();
    try {
      expect(() => env.media.upload({ dataBase64: MP3_B64, mime: "audio/webm", durMs: 1000 })).toThrowError(/格式对不上/);
      expect(() => env.media.upload({ dataBase64: MP3_B64, mime: "audio/x-whatever", durMs: 1000 })).toThrowError(/不支持的音频格式/);
      expect(() => env.media.upload({ dataBase64: Buffer.from("不是音频").toString("base64"), mime: "audio/mpeg" })).toThrowError(
        /文件头认不出来/,
      );
    } finally {
      env.close();
    }
  });

  it("播放时长以客户端实测回写：差 200ms 以内不动", () => {
    const env = makeMedia();
    try {
      const { uploadId } = env.media.upload({ dataBase64: MP3_B64, mime: "audio/mpeg", durMs: 1000 });
      const bound = env.media.bindUpload(uploadId);
      const messageId = insertMessage(env.kernel.db, env.kernel.deps.agentId, "user", "[语音 1″]", NOW);
      env.media.writeAttachment(messageId, bound);
      expect(env.media.metaSet({ messageId, durMs: 1150 }).durMs).toBe(1000);
      expect(env.media.metaSet({ messageId, durMs: 2600 }).durMs).toBe(2600);
    } finally {
      env.close();
    }
  });
});

describe("语音转写", () => {
  it("成功后把文本写回 attachment，并记一笔 ASR 成本", async () => {
    const env = makeMedia();
    try {
      const { uploadId } = env.media.upload({ dataBase64: MP3_B64, mime: "audio/mpeg", durMs: 1200 });
      const messageId = insertMessage(env.kernel.db, env.kernel.deps.agentId, "user", "[语音 1″]", NOW);
      env.media.writeAttachment(messageId, env.media.bindUpload(uploadId));

      const result = await env.media.transcribe(messageId);
      expect(result).toEqual({ ok: true, text: "今天好累啊", silent: false });
      expect(env.media.readAttachment(messageId)?.transcriptKind).toBe("asr");
      expect(env.cost.monthTotal()).toBeGreaterThan(0);
    } finally {
      env.close();
    }
  });

  it("插件说没人说话（kind none）时不编内容，只是 silent", async () => {
    const env = makeMedia({ listenResult: { ok: true, text: "", kind: "none", model: "whisper-1", costCny: 0 } });
    try {
      const { uploadId } = env.media.upload({ dataBase64: MP3_B64, mime: "audio/mpeg", durMs: 900 });
      const messageId = insertMessage(env.kernel.db, env.kernel.deps.agentId, "user", "[语音 1″]", NOW);
      env.media.writeAttachment(messageId, env.media.bindUpload(uploadId));

      const result = await env.media.transcribe(messageId);
      expect(result).toEqual({ ok: true, text: "", silent: true });
      expect(env.media.readAttachment(messageId)?.transcriptKind).toBe("none");
    } finally {
      env.close();
    }
  });

  it("插件报错时返回 ok:false 并留下可重试的 error 标记", async () => {
    const env = makeMedia({ listenResult: { ok: true, kind: "error", reason: "没听清" } });
    try {
      const { uploadId } = env.media.upload({ dataBase64: MP3_B64, mime: "audio/mpeg", durMs: 900 });
      const messageId = insertMessage(env.kernel.db, env.kernel.deps.agentId, "user", "[语音 1″]", NOW);
      env.media.writeAttachment(messageId, env.media.bindUpload(uploadId));

      const result = await env.media.transcribe(messageId);
      expect(result.ok).toBe(false);
      const att = env.media.readAttachment(messageId);
      expect(att?.transcriptKind).toBe("error");
      expect(att?.error).toBe("没听清");
    } finally {
      env.close();
    }
  });

  it("语音能力没就绪时明确说原因，而不是静默失败", async () => {
    const env = makeMedia({ health: { listen: false, speak: false } });
    try {
      const { uploadId } = env.media.upload({ dataBase64: MP3_B64, mime: "audio/mpeg", durMs: 900 });
      const messageId = insertMessage(env.kernel.db, env.kernel.deps.agentId, "user", "[语音 1″]", NOW);
      env.media.writeAttachment(messageId, env.media.bindUpload(uploadId));

      const result = await env.media.transcribe(messageId);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
      expect(env.media.status().listenReady).toBe(false);
    } finally {
      env.close();
    }
  });
});

describe("语音合成", () => {
  it("写盘并回一条 ready attachment", async () => {
    const env = makeMedia();
    try {
      const out = await env.media.synthesize({ text: "我在呢", rate: 1.05 });
      expect(out.attachment.state).toBe("ready");
      expect(out.attachment.path.startsWith("voice/")).toBe(true);
      expect(readFileSync(join(env.dataDir, "media", out.attachment.path)).byteLength).toBe(MP3_BYTES.byteLength);
      expect(out.costCny).toBeCloseTo(0.036, 6);
      expect(env.media.absPathFor(out.attachment)).toBe(join(env.dataDir, "media", out.attachment.path));
    } finally {
      env.close();
    }
  });

  it("外部通道要 wav：格式透传给插件，音频路径不许越界", async () => {
    const env = makeMedia();
    try {
      await env.media.synthesize({ text: "在的", format: "wav" });
      const speak = env.calls.find((item) => item.method === "plugin.media.speak");
      expect((speak?.params as { format?: string } | undefined)?.format).toBe("wav");
      expect(() => env.media.absPathFor({ kind: "audio", path: "../../secret.wav", mime: "", bytes: 0, durMs: 0, peaks: [], state: "ready" })).toThrowError(
        /不合法/,
      );
    } finally {
      env.close();
    }
  });
});

describe("长文本语音：一句一句合成再拼起来", () => {
  it("按句切：一句一条，碎句跟在前句后面，不各花一次合成钱", () => {
    expect(splitSpeechSentences("今天下班路上下了点雨。我在便利店门口站了一会儿。买了关东煮，萝卜煮得很软。")).toEqual([
      "今天下班路上下了点雨。",
      "我在便利店门口站了一会儿。",
      "买了关东煮，萝卜煮得很软。",
    ]);
    // 「嗯。」「好。」这种不超过 6 字的碎句并入前句（省钱：碎句不该各花一次合成）。
    expect(splitSpeechSentences("嗯。好。今天真累啊，感觉腿都不是自己的了。")).toEqual([
      "嗯。好。",
      "今天真累啊，感觉腿都不是自己的了。",
    ]);
    expect(splitSpeechSentences("   ")).toEqual([]);
  });

  it("没有标点的长串按上限硬切，一个字都不丢", () => {
    const long = "一".repeat(300);
    const pieces = splitSpeechSentences(long);
    expect(pieces.every((piece) => piece.length <= SPEECH_SENTENCE_MAX_CHARS)).toBe(true);
    expect(pieces.join("")).toBe(long);
  });

  it("多句时一句一次合成，拼成一条 wav，时长和成本都累加", async () => {
    const env = makeMedia({
      speakResults: [
        { ok: true, dataBase64: wavB64(1000), mime: "audio/wav", durMs: 1000, model: "breeze-tts-2", costCny: 0.036 },
        { ok: true, dataBase64: wavB64(500), mime: "audio/wav", durMs: 500, model: "breeze-tts-2", costCny: 0.018 },
      ],
    });
    try {
      const out = await env.media.synthesize({ text: "今天路上下了点雨。我在便利店门口站了一会儿。" });
      const speaks = env.calls.filter((item) => item.method === "plugin.media.speak");
      expect(speaks.length).toBe(2);
      expect(speaks.map((item) => (item.params as { text: string }).text)).toEqual(["今天路上下了点雨。", "我在便利店门口站了一会儿。"]);
      // 多句时强制 wav：mp3 拼不了，只有 wav 能接。
      expect((speaks[0]?.params as { format?: string }).format).toBe("wav");
      expect(out.attachment.mime).toBe("audio/wav");
      expect(out.attachment.durMs).toBeGreaterThanOrEqual(1450);
      expect(out.attachment.durMs).toBeLessThanOrEqual(1550);
      expect(out.costCny).toBeCloseTo(0.054, 6);
      // 44 字节头 + 1000ms 的 16000Hz/16bit 数据 + 500ms 的数据。
      expect(out.attachment.bytes).toBe(44 + 32000 + 16000);
    } finally {
      env.close();
    }
  });

  it("两份 wav 格式不一致时拼不了：只保留第一句，时长按那一段报", async () => {
    const env = makeMedia({
      speakResults: [
        { ok: true, dataBase64: wavB64(1000), mime: "audio/wav", durMs: 1000, costCny: 0.01 },
        { ok: true, dataBase64: wavB64(500, 24000), mime: "audio/wav", durMs: 500, costCny: 0.01 },
      ],
    });
    try {
      const out = await env.media.synthesize({ text: "第一句。第二句。" });
      expect(out.attachment.bytes).toBe(44 + 32000);
      expect(out.attachment.durMs).toBeGreaterThanOrEqual(950);
      expect(out.attachment.durMs).toBeLessThanOrEqual(1050);
    } finally {
      env.close();
    }
  });

  it("只认标准 PCM wav：别的格式读不出时长、也拼不了", () => {
    expect(wavDurationMs(makeWav(1200))).toBeGreaterThanOrEqual(1150);
    expect(wavDurationMs(MP3_BYTES)).toBe(0);
    expect(mergeWavBuffers([makeWav(100), MP3_BYTES])).toBeNull();
    expect(mergeWavBuffers([])).toBeNull();
  });
});

describe("BreezeBlue（按字符计价）", () => {
  it("合成预检按字符单价算，不再靠按秒的占位价", () => {
    // BreezeBlue 官方价 $30 / 100 万字符 ≈ ¥216；ceiling 还要乘上朗读稿改写上限 1.6。
    const env = makeMedia({ config: { pricePerMillionCharsCny: 216, pricePerSecondCny: 0 } });
    try {
      expect(env.media.speakPricePerMillionChars()).toBe(216);
      const ceiling = env.media.speakCeilingCny("一".repeat(500), 1);
      // 上限向上取整到分：500 字 × ¥216/M × 1.6 = ¥0.1728 → ¥0.18
      expect(ceiling).toBe(0.18);
      // 空白不收费：换行、空格不该被算成字。
      expect(env.media.speakCeilingCny("一".repeat(500) + "\n\n   ", 1)).toBeCloseTo(ceiling, 6);
    } finally {
      env.close();
    }
  });

  it("没配字符单价时回退到默认 ¥216，而不是 0（0 会让预算闸对语音失效）", () => {
    const env = makeMedia({ config: { pricePerSecondCny: 0, pricePerMinuteCny: 0 } });
    try {
      expect(env.media.speakPricePerMillionChars()).toBe(216);
      expect(env.media.speakCeilingCny("一".repeat(1000), 1)).toBeGreaterThan(0);
    } finally {
      env.close();
    }
  });

  it("status 优先转述插件 health 的原话（哪一路缺什么密钥说得清楚）", () => {
    const env = makeMedia({
      health: { listen: false, speak: false },
      healthMessage: "合成不可用：未填 breeze.api_key（BreezeBlue 密钥）；识别不可用：需要另配 OpenAI 兼容的 asrModel 与 media.api_key",
    });
    try {
      const status = env.media.status();
      expect(status.message).toContain("breeze.api_key");
      expect(status.listenReady).toBe(false);
      expect(status.speakReady).toBe(false);
    } finally {
      env.close();
    }
  });

  it("默认出声档位是 auto（配好 BreezeBlue 密钥就开口，但仍看场合）", () => {
    const env = makeMedia();
    try {
      expect(env.settings.get("media.voiceOutbound")).toBe("auto");
    } finally {
      env.close();
    }
  });
});

describe("出站语音策略（10.1）", () => {
  const base = {
    outbound: "auto" as const,
    speakReady: true,
    externalChannel: false,
    presence: "idle" as const,
    degraded: false,
    trigger: "reply" as const,
    stage: "close" as const,
    moodValence: 0,
    moodArousal: 0.3,
    fullText: "在呢",
  };

  it("默认关：off 档一律不发", () => {
    expect(decideVoice({ ...base, outbound: "off" }).action).toBe("off");
  });

  it("硬门槛优先于档位：睡觉 / 忙 / 外部通道 / 太长都不发", () => {
    expect(decideVoice({ ...base, outbound: "always", presence: "sleep" }).action).toBe("off");
    expect(decideVoice({ ...base, outbound: "always", presence: "busy" }).action).toBe("off");
    expect(decideVoice({ ...base, outbound: "always", externalChannel: true }).action).toBe("off");
    expect(decideVoice({ ...base, outbound: "always", fullText: "一".repeat(80) }).action).toBe("off");
  });

  it("auto：熟人且短才发；陌生人即使很短也不发", () => {
    expect(decideVoice({ ...base, outbound: "auto", stage: "close", fullText: "在呢" }).action).toBe("voice");
    expect(decideVoice({ ...base, outbound: "auto", stage: "stranger", fullText: "在呢" }).action).toBe("off");
  });

  it("always：硬门槛之外都发", () => {
    expect(decideVoice({ ...base, outbound: "always", stage: "stranger", fullText: "今天有点想你" }).action).toBe("voice");
  });

  it("外部通道：开关没开时说清是哪个开关，开了就按语音条口径发", () => {
    const off = decideVoice({ ...base, outbound: "off", externalChannel: true });
    expect(off.action).toBe("off");
    expect(off.reason).toContain("语音条没开");
    // 开了：一条 100 字的话，应用内会被 56 字门槛挡掉，语音条能发
    const long = "今天在地铁上突然想起你上次说的那件事".repeat(4);
    expect(decideVoice({ ...base, outbound: "always", externalChannel: true, voiceMessage: true, fullText: long }).action).toBe("voice");
    expect(decideVoice({ ...base, outbound: "always", externalChannel: false, fullText: long }).action).toBe("off");
  });

  it("外部通道语音条也有上限：超过 200 字不发", () => {
    const decision = decideVoice({
      ...base,
      outbound: "always",
      externalChannel: true,
      voiceMessage: true,
      fullText: "一".repeat(260),
    });
    expect(decision.action).toBe("off");
    expect(decision.reason).toContain("太长");
  });

  it("韵律参数落在可播范围内", () => {
    const fast = prosodyFor(1, 1, 1, 1);
    const slow = prosodyFor(0, 0, 0, 0);
    expect(fast.rate).toBeLessThanOrEqual(1.15);
    expect(slow.rate).toBeGreaterThanOrEqual(0.85);
    expect(fast.volume).toBeLessThanOrEqual(1);
    expect(slow.volume).toBeGreaterThanOrEqual(0.7);
  });
});
describe("声音面板用的两个接口", () => {
  it("列音色：把插件回的 voices 规整成界面能用的形状", async () => {
    const env = makeMedia();
    try {
      const result = await env.media.voices();
      expect(result.ok).toBe(true);
      expect(result.provider).toBe("breezeblue");
      expect(result.voices).toHaveLength(1);
      expect(result.voices[0]).toEqual({ id: "voc_1", name: "小满", language: "zh" });
    } finally {
      env.close();
    }
  });

  it("试听：返回 base64 音频并记一笔 media.tts 成本，但不落消息表", async () => {
    const env = makeMedia();
    try {
      const result = await env.media.preview("在呢");
      expect(result.ok).toBe(true);
      expect(result.audioBase64).toBe(MP3_B64);
      expect(result.mime).toBe("audio/mpeg");
      const rows = env.kernel.db.all<{ kind: string; cost_cny: number }>(
        "SELECT kind, cost_cny FROM cost_ledger WHERE kind = 'media.tts'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].cost_cny).toBeCloseTo(0.036, 6);
      const messages = env.kernel.db.all<{ id: number }>("SELECT id FROM messages");
      expect(messages).toHaveLength(0);
    } finally {
      env.close();
    }
  });
});

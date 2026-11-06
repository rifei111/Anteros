/**
 * 语音条：录音、峰值、上传、播放缓存。
 *
 * 只在这一个文件里碰 MediaRecorder / AudioContext / blob URL，
 * 组件层只管"按下去/松开/正在录"，这样换录音方案不用改界面。
 */

import { AUDIO_DUR_MAX_MS, VOICE_PEAK_BUCKETS, audioExtForMime } from "@anteros/shared";
import { invoke } from "./kernel";

/** 录音时刻画的 24 格峰值：0..1。 */
export interface RecordingState {
  elapsedMs: number;
  peaks: number[];
  speaking: boolean;
}

export interface RecordedClip {
  blob: Blob;
  mime: string;
  durMs: number;
  peaks: number[];
}

/** MediaRecorder 在 Chromium 里优先 webm/opus；其它环境退到第一个支持的。 */
function pickMime(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  for (const type of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private raf = 0;
  private startedAt = 0;
  private peaks: number[] = [];
  private mime = "";

  /** 开始录音；浏览器没有麦克风权限时抛出一句人话。 */
  async start(onTick: (state: RecordingState) => void): Promise<void> {
    this.mime = pickMime();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    } catch (error) {
      const name = (error as { name?: string })?.name ?? "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        throw new Error("没有麦克风权限：在系统设置里允许本应用使用麦克风");
      }
      throw new Error("打不开麦克风，检查一下设备是否被别的程序占着");
    }

    this.audioCtx = new AudioContext();
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 2048;
    source.connect(this.analyser);

    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.start(250);
    this.startedAt = performance.now();
    this.peaks = [];
    this.tick(onTick);
  }

  /**
   * 时长用 performance.now() 计，不读录制数据的 duration——
   * webm 的时长元数据常常是 Infinity 或缺失（文档 9.1）。
   */
  private tick(onTick: (state: RecordingState) => void): void {
    const buffer = new Uint8Array(this.analyser?.frequencyBinCount ?? 1024);
    const loop = () => {
      const elapsedMs = performance.now() - this.startedAt;
      let speaking = false;
      if (this.analyser) {
        this.analyser.getByteTimeDomainData(buffer);
        let sum = 0;
        for (const value of buffer) {
          const centered = (value - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / buffer.length);
        speaking = rms > 0.02;
        this.peaks.push(Math.min(1, rms * 4));
      }
      onTick({ elapsedMs, peaks: bucketPeaks(this.peaks), speaking });
      if (elapsedMs >= AUDIO_DUR_MAX_MS) {
        return;
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** 停止并拿到可上传的片段；取消时传 abort=true，不返回数据。 */
  async stop(): Promise<RecordedClip | null> {
    const recorder = this.recorder;
    if (!recorder) return null;
    const durMs = Math.round(performance.now() - this.startedAt);
    const done = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.stop();
    await done;
    const mime = recorder.mimeType || this.mime || "audio/webm";
    const blob = new Blob(this.chunks, { type: mime });
    const peaks = bucketPeaks(this.peaks);
    this.cleanup();
    if (blob.size === 0) return null;
    return { blob, mime, durMs, peaks };
  }

  private cleanup(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.recorder = null;
    this.chunks = [];
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    void this.audioCtx?.close();
    this.audioCtx = null;
    this.analyser = null;
  }

  /** 组件卸载或取消时一定要调，否则麦克风一直亮着。 */
  dispose(): void {
    try {
      this.recorder?.stop();
    } catch {
      // 已经停了
    }
    this.cleanup();
  }
}

function bucketPeaks(raw: number[]): number[] {
  if (raw.length === 0) return [];
  const buckets: number[] = [];
  const per = Math.max(1, Math.ceil(raw.length / VOICE_PEAK_BUCKETS));
  for (let index = 0; index < raw.length; index += per) {
    let peak = 0;
    for (const value of raw.slice(index, index + per)) peak = Math.max(peak, value);
    buckets.push(Number(peak.toFixed(2)));
  }
  return buckets.slice(0, VOICE_PEAK_BUCKETS);
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("读取录音失败"));
    reader.readAsDataURL(blob);
  });
}

/** 上传录音，拿到 uploadId；真正发消息是之后 chat.send(uploadId)。 */
export async function uploadClip(clip: RecordedClip): Promise<string> {
  const dataBase64 = await toBase64(clip.blob);
  const result = await invoke("media.upload", {
    dataBase64,
    mime: clip.mime,
    durMs: clip.durMs,
    peaks: clip.peaks,
  });
  return result.uploadId;
}

/* ---------------- 播放缓存 ---------------- */

const MAX_CACHED = 8;
const cache = new Map<number, string>();

/** 取音频字节并转成 blob URL；同一个 messageId 只拉一次（LRU 8 条）。 */
export async function audioUrlFor(messageId: number): Promise<string> {
  const cached = cache.get(messageId);
  if (cached) {
    cache.delete(messageId);
    cache.set(messageId, cached);
    return cached;
  }
  const loaded = await invoke("media.load", { messageId });
  const ext = audioExtForMime(loaded.mime) ?? "webm";
  const bytes = base64ToBytes(loaded.dataBase64);
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([copy], { type: loaded.mime || `audio/${ext}` }));
  cache.set(messageId, url);
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value as number | undefined;
    if (oldest === undefined) break;
    const stale = cache.get(oldest);
    cache.delete(oldest);
    if (stale) URL.revokeObjectURL(stale);
  }
  return url;
}

export function dropAudioCache(messageId: number): void {
  const url = cache.get(messageId);
  cache.delete(messageId);
  if (url) URL.revokeObjectURL(url);
}

function base64ToBytes(input: string): Uint8Array {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
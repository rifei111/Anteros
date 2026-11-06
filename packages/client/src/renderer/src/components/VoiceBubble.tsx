/**
 * 气泡里的语音条（文档第 9 节）。
 *
 * 五个状态都要有话说：ready 能播；pending 是"还在合成"；skipped 是"没合成出来"；
 * missing 是"文件没了"；error 是"转写失败"。用户不该看到一个点了没反应的播放键。
 */

import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@anteros/shared";
import { audioUrlFor, dropAudioCache } from "../lib/voice";
import { invoke } from "../lib/kernel";
import { applyMessageAttachment } from "../lib/app";
import { pushToast } from "../lib/store";

function formatSeconds(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function VoiceBubble({ message }: { message: ChatMessage }) {
  const attachment = message.attachment;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durMs, setDurMs] = useState(attachment?.durMs ?? 0);
  const [showTranscript, setShowTranscript] = useState(false);
  const [busy, setBusy] = useState(false);

  const state = attachment?.state ?? "ready";
  const isAgent = message.role === "agent";

  useEffect(() => {
    if (!attachment || attachment.state !== "ready") return;
    let cancelled = false;
    void audioUrlFor(message.id)
      .then((next) => {
        if (!cancelled) setUrl(next);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const reason = error instanceof Error ? error.message : String(error);
        pushToast("error", "这条语音读不出来", reason);
      });
    return () => {
      cancelled = true;
      audioRef.current?.pause();
    };
  }, [attachment, message.id]);

  // 组件卸载时放掉这一条的 blob：8 条 LRU 之外的点开就会重新拉，不必留着。
  useEffect(() => () => dropAudioCache(message.id), [message.id]);

  // 合成失败重来一次：朗读稿在内核里，客户端只要说"这条再来一遍"。
  async function respeak() {
    setBusy(true);
    try {
      const result = await invoke("media.respeak", { messageId: message.id });
      if (result.ok && result.attachment) {
        applyMessageAttachment(message.id, result.attachment);
        pushToast("success", "语音重新生成好了", "");
      } else {
        pushToast("warn", "还是没能生成", result.reason ?? "");
      }
    } catch (error) {
      pushToast("error", "重新生成失败", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  if (!attachment) return null;

  if (state === "pending") {
    return (
      <div className="voice-bar is-pending" aria-label="语音生成中" title="正在合成这条语音，最多等一分钟">
        <span className="voice-icon">◌</span>
        <span className="voice-pending-text">语音生成中…</span>
        <span className="voice-broken-hint">正文已经发出来了，声音补上就替换</span>
      </div>
    );
  }

  if (state === "skipped" || state === "missing") {
    return (
      <div className="voice-bar is-broken" title={attachment.error ?? undefined}>
        <span className="voice-icon">⚠</span>
        <span>{state === "missing" ? "语音文件不在了" : "这条语音没能生成"}</span>
        <span className="voice-broken-hint">{attachment.error ? attachment.error.slice(0, 40) : "正文不受影响"}</span>
        <button type="button" className="voice-retry" onClick={() => void respeak()} disabled={busy}>
          {busy ? "重新生成中…" : "重新生成"}
        </button>
      </div>
    );
  }

  const peaks = attachment.peaks.length > 0 ? attachment.peaks : new Array(24).fill(0.25);
  const progress = durMs > 0 ? Math.min(1, positionMs / durMs) : 0;
  const asrFailed = attachment.transcriptKind === "error";

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play();
      setPlaying(true);
    } else {
      audio.pause();
      setPlaying(false);
    }
  };

  const seek = (fraction: number) => {
    const audio = audioRef.current;
    if (!audio || !durMs) return;
    audio.currentTime = (durMs / 1000) * fraction;
    setPositionMs(durMs * fraction);
  };

  const retryTranscribe = async () => {
    setBusy(true);
    try {
      const result = await invoke("media.retry", { messageId: message.id });
      pushToast(result.ok ? "info" : "warn", result.ok ? "又听了一遍" : "还是没听清", result.reason ?? "");
    } catch (error) {
      pushToast("error", "重试转写失败", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="voice-block">
      <div className={`voice-bar ${isAgent ? "is-agent" : "is-user"}`}>
        <button type="button" className="voice-play" onClick={toggle} disabled={!url} aria-label={playing ? "暂停" : "播放"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <button type="button" className="voice-wave" onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          seek(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)));
        }} aria-label="跳转到某处播放">
          {peaks.map((peak, index) => (
            <span
              key={index}
              className={`voice-peak ${index / peaks.length < progress ? "is-played" : ""}`}
              style={{ height: `${Math.max(12, Math.round(peak * 100))}%` }}
            />
          ))}
        </button>
        <span className="voice-time">{formatSeconds(playing || positionMs > 0 ? positionMs : durMs)}</span>
        {attachment.transcript ? (
          <button type="button" className="voice-transcript-toggle" onClick={() => setShowTranscript((value) => !value)}>
            {showTranscript ? "收起" : "转文字"}
          </button>
        ) : null}
      </div>
      {asrFailed ? (
        <div className="voice-asr-failed">
          <span>没听清这条</span>
          <button type="button" onClick={() => void retryTranscribe()} disabled={busy}>
            {busy ? "重试中…" : "再听一遍"}
          </button>
        </div>
      ) : null}
      {showTranscript && attachment.transcript ? (
        <div className="voice-transcript">{attachment.transcript}</div>
      ) : null}
      {url ? (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onLoadedMetadata={(event) => {
            const measured = Number(event.currentTarget.duration);
            if (Number.isFinite(measured) && measured > 0) setDurMs(Math.round(measured * 1000));
          }}
          onTimeUpdate={(event) => setPositionMs(Math.round(event.currentTarget.currentTime * 1000))}
          onEnded={() => {
            setPlaying(false);
            setPositionMs(0);
            if (audioRef.current) audioRef.current.currentTime = 0;
          }}
        />
      ) : null}
    </div>
  );
}
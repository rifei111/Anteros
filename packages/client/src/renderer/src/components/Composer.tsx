import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@anteros/shared";
import { loadModelCatalog, sendMessage, sendVoice, openAdmin } from "../lib/app";
import { invoke } from "../lib/kernel";
import { applyModelCatalog, pushToast, useAppState } from "../lib/store";
import { truncate } from "../lib/format";
import { CloseIcon, MicIcon, SendIcon } from "./Icons";
import { VoiceRecorder, type RecordingState } from "../lib/voice";

interface ComposerProps {
  quote: ChatMessage | null;
  onClearQuote: () => void;
}

const SPLIT_SEND_KEY = "anteros.splitSend";
const INPUT_MIN_HEIGHT = 44;
const INPUT_MAX_HEIGHT = 160;

/** 逐条发送是本地偏好：读不到 localStorage（隐私模式等）就按关闭处理。 */
function readSplitSend(): boolean {
  try {
    return window.localStorage.getItem(SPLIT_SEND_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSplitSend(enabled: boolean): void {
  try {
    window.localStorage.setItem(SPLIT_SEND_KEY, enabled ? "1" : "0");
  } catch {
    // 存不了就只在本轮生效，不影响发送。
  }
}

/** 按换行拆成多条；空行丢掉，行首行尾空白去掉。 */
function splitSegments(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 条与条之间等 400–1200ms 随机，模拟真人打一条发一条。 */
function humanGapMs(): number {
  return 400 + Math.floor(Math.random() * 800);
}

/** 录音计时：0:03 这种，超过一分钟也只会显示 1:00（上限就是 60 秒）。 */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * 输入区：一块卡片里放输入框和工具行，不再把设置钉在底下一行小字里。
 *
 * Enter 发送、Shift+Enter 换行；输入框随内容长到 160px 就不再长，内部滚动。
 * 引用只把被引用文本附在正文前（"> xxx"），不伪造引用结构。
 * 内核断开时禁用发送，不假装消息已发出。
 *
 * 「逐条发送」开启后（偏好存在 localStorage），整段输入按换行拆成几条依次发出，
 * 中间随机停顿；Enter 仍然是发送（多行用 Shift+Enter 换行或直接粘贴），只是不再
 * 合成一条消息。某条发不出去就停下，没发的部分留在输入框里，不吞草稿。
 */
export function Composer({ quote, onClearQuote }: ComposerProps) {
  const state = useAppState();
  const disabled = !state.connection.connected;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [splitSend, setSplitSend] = useState(readSplitSend);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const toggleSplitSend = (enabled: boolean): void => {
    setSplitSend(enabled);
    writeSplitSend(enabled);
  };

  /** 输入框跟着内容长高：44px 起步、160px 封顶，再长就在框里滚。 */
  const growInput = (element: HTMLTextAreaElement | null): void => {
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(INPUT_MAX_HEIGHT, Math.max(INPUT_MIN_HEIGHT, element.scrollHeight))}px`;
    element.style.overflowY = element.scrollHeight > INPUT_MAX_HEIGHT ? "auto" : "hidden";
  };

  useEffect(() => {
    growInput(textareaRef.current);
  }, [text]);

  // 语音输入的可用性由内核说了算（插件装没装、ASR 配没配），界面只是跟着开关。
  const [listenReady, setListenReady] = useState(false);
  const [voiceHint, setVoiceHint] = useState("");
  const [recording, setRecording] = useState(false);
  const [recordingState, setRecordingState] = useState<RecordingState>({ elapsedMs: 0, peaks: [], speaking: false });
  const [uploading, setUploading] = useState(false);
  const recorderRef = useRef<VoiceRecorder | null>(null);

  useEffect(() => {
    let cancelled = false;
    void invoke("media.status", {})
      .then((status) => {
        if (cancelled) return;
        setListenReady(status.listenReady);
        setVoiceHint(status.reason ?? status.message ?? "");
      })
      .catch(() => {
        if (!cancelled) setListenReady(false);
      });
    return () => {
      cancelled = true;
      recorderRef.current?.dispose();
      recorderRef.current = null;
    };
  }, [state.connection.connected]);

  const startRecording = async (): Promise<void> => {
    if (recording || uploading || disabled) return;
    const recorder = new VoiceRecorder();
    recorderRef.current = recorder;
    try {
      await recorder.start(setRecordingState);
      setRecording(true);
    } catch (error) {
      recorderRef.current = null;
      recorder.dispose();
      pushToast("error", "录不了音", error instanceof Error ? error.message : String(error));
    }
  };

  const cancelRecording = (): void => {
    recorderRef.current?.dispose();
    recorderRef.current = null;
    setRecording(false);
    setRecordingState({ elapsedMs: 0, peaks: [], speaking: false });
  };

  const finishRecording = async (): Promise<void> => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    setUploading(true);
    try {
      const clip = await recorder.stop();
      recorderRef.current = null;
      setRecording(false);
      setRecordingState({ elapsedMs: 0, peaks: [], speaking: false });
      if (!clip) return;
      if (clip.durMs < 400) {
        pushToast("warn", "太短了", "说一句话再松手");
        return;
      }
      await sendVoice(clip);
    } catch (error) {
      pushToast("error", "发送语音失败", error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
    }
  };

  const models = state.modelsCatalog;
  const chatModelValue = models?.activeChatModelId ?? "";
  const selectModel = async (value: string): Promise<void> => {
    try {
      const result = await invoke("models.setActiveChat", { modelId: value.length > 0 ? value : null });
      applyModelCatalog(result.catalog);
      const picked = result.catalog.entries.find((entry) => entry.id === value);
      pushToast("success", "已切换聊天模型", picked ? `${picked.label}（${picked.model}）` : "回到主模型");
    } catch (error) {
      pushToast("error", "切换失败", error instanceof Error ? error.message : String(error));
      void loadModelCatalog();
    }
  };

  const submit = async (): Promise<void> => {
    if (sending || disabled || text.trim().length === 0) return;
    const segments = splitSend ? splitSegments(text) : [text];
    if (segments.length === 0) return;
    setSending(true);
    try {
      for (let index = 0; index < segments.length; index += 1) {
        if (index > 0) await sleep(humanGapMs());
        const segment = segments[index] ?? "";
        if (segment.length === 0) continue;
        const ok = await sendMessage(segment, index === 0 ? quote : null);
        if (!ok) {
          // 失败的那条和还没发的留在输入框，用户可以直接重试。
          setText(segments.slice(index).join("\n"));
          if (segments.length > 1) {
            // sendMessage 已经报过具体错误，这里只说明「后面不发了」。
            pushToast("warn", "逐条发送已停止", `第 ${index + 1} 条没发出去，剩下的留在输入框里。`);
          }
          return;
        }
        // 引用只跟第一条走，发出去了就从输入区撤掉，不重复引用。
        if (index === 0) onClearQuote();
      }
      setText("");
      textareaRef.current?.focus();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="composer">
      {quote ? (
        <div className="quote-bar">
          <div className="quote-text">引用：{truncate(quote.text, 60)}</div>
          <button className="icon-btn" onClick={onClearQuote} aria-label="取消引用">
            <CloseIcon size={12} />
          </button>
        </div>
      ) : null}

      {recording ? (
        <div className="composer-card">
          <div className="recording-bar">
            <span className="recording-dot" />
            <span className="recording-time">{formatElapsed(recordingState.elapsedMs)}</span>
            <div className="recording-wave" aria-label="录音中">
              {(recordingState.peaks.length > 0 ? recordingState.peaks : new Array(24).fill(0.1)).map((peak, index) => (
                <span key={index} className="recording-peak" style={{ height: `${Math.max(10, Math.round(peak * 100))}%` }} />
              ))}
            </div>
            <button className="btn btn-ghost" onClick={cancelRecording} disabled={uploading}>
              取消
            </button>
            <button className="btn btn-primary send-btn" onClick={() => void finishRecording()} disabled={uploading}>
              <SendIcon />
              <span>{uploading ? "发送中…" : "发送语音"}</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="composer-card">
          <textarea
            ref={(element) => {
              textareaRef.current = element;
              growInput(element);
            }}
            className="composer-input"
            value={text}
            rows={1}
            placeholder={disabled ? "内核未连接，暂时不能发送" : "说点什么…"}
            disabled={disabled || sending}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />

          <div className="composer-tools">
            <button
              className="tool-btn"
              title={listenReady ? "按住录一段语音" : voiceHint || "语音输入不可用：先在插件里配置语音服务"}
              onClick={() => void startRecording()}
              disabled={disabled || sending || !listenReady || uploading}
            >
              <MicIcon size={15} />
              <span>语音</span>
            </button>
            <label className="split-toggle" title="开启后你打的每行会分成几条依次发出">
              <input
                type="checkbox"
                checked={splitSend}
                disabled={sending}
                onChange={(event) => toggleSplitSend(event.target.checked)}
              />
              <span>逐条发送</span>
            </label>

            <span className="composer-tools-spacer" />

            <label className="model-pick" title="这次对话用哪个模型；不选就用设置里的主模型">
              <span>模型</span>
              <select value={chatModelValue} disabled={sending} onChange={(event) => void selectModel(event.target.value)}>
                <option value="">主模型（{models?.primary.model ?? "还没配"}）</option>
                {(models?.entries ?? [])
                  .filter((entry) => entry.enabled)
                  .map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}（{entry.model}）
                    </option>
                  ))}
              </select>
            </label>
            {(models?.entries.length ?? 0) === 0 ? (
              <button className="text-btn" type="button" onClick={() => openAdmin("models")}>
                添加模型
              </button>
            ) : null}

            <button
              className="btn btn-primary send-btn"
              onClick={() => void submit()}
              disabled={disabled || sending || text.trim().length === 0}
            >
              <SendIcon size={14} />
              <span>{sending ? "发送中…" : "发送"}</span>
            </button>
          </div>
        </div>
      )}

      <div className="composer-foot-note">
        <span>Enter 发送 · Shift+Enter 换行</span>
        {listenReady ? null : (
          <span className="composer-foot-warn" title={voiceHint || "先在插件里配置语音服务"}>
            · 语音暂不可用
          </span>
        )}
      </div>
    </div>
  );
}
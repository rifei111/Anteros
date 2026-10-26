import { useRef, useState } from "react";
import type { ChatMessage } from "@anteros/shared";
import { sendMessage } from "../lib/app";
import { pushToast, useAppState } from "../lib/store";
import { truncate } from "../lib/format";
import { CloseIcon, SendIcon } from "./Icons";

interface ComposerProps {
  quote: ChatMessage | null;
  onClearQuote: () => void;
}

const SPLIT_SEND_KEY = "anteros.splitSend";

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

/**
 * 输入区：Enter 发送、Shift+Enter 换行；引用只把被引用文本附在正文前（"> xxx"），
 * 不伪造引用结构。内核断开时禁用发送，不假装消息已发出。
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

      <div className="composer-row">
        <textarea
          ref={textareaRef}
          className="composer-input"
          value={text}
          rows={2}
          placeholder={disabled ? "内核未连接，暂时不能发送" : "说点什么…（Enter 发送，Shift+Enter 换行）"}
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
        <button
          className="btn btn-primary send-btn"
          onClick={() => void submit()}
          disabled={disabled || sending || text.trim().length === 0}
        >
          <SendIcon />
          <span>{sending ? "发送中…" : "发送"}</span>
        </button>
      </div>

      <div className="composer-foot">
        <label className="split-toggle">
          <input
            type="checkbox"
            checked={splitSend}
            disabled={sending}
            onChange={(event) => toggleSplitSend(event.target.checked)}
          />
          <span>逐条发送</span>
        </label>
        <span className="split-hint">开启后你打的每行会分成几条依次发出</span>
      </div>
    </div>
  );
}

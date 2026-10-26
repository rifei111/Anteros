import { useRef, useState } from "react";
import type { ChatMessage } from "@anteros/shared";
import { sendMessage } from "../lib/app";
import { useAppState } from "../lib/store";
import { truncate } from "../lib/format";
import { CloseIcon, SendIcon } from "./Icons";

interface ComposerProps {
  quote: ChatMessage | null;
  onClearQuote: () => void;
}

/**
 * 输入区：Enter 发送、Shift+Enter 换行；引用只把被引用文本附在正文前（"> xxx"），
 * 不伪造引用结构。内核断开时禁用发送，不假装消息已发出。
 */
export function Composer({ quote, onClearQuote }: ComposerProps) {
  const state = useAppState();
  const disabled = !state.connection.connected;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const submit = async (): Promise<void> => {
    if (sending || disabled || text.trim().length === 0) return;
    setSending(true);
    try {
      const ok = await sendMessage(text, quote);
      if (ok) {
        setText("");
        onClearQuote();
        textareaRef.current?.focus();
      }
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
          disabled={disabled}
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
          <span>{sending ? "发送中" : "发送"}</span>
        </button>
      </div>
    </div>
  );
}

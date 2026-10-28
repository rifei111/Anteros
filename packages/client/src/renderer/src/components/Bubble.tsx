import type { ChatMessage } from "@anteros/shared";

interface BubbleProps {
  message: ChatMessage;
  agentName: string;
  /** 聊天对象头像（data URL）；null 用名字首字 */
  agentAvatar?: string | null;
  onContextMenu: (event: React.MouseEvent, message: ChatMessage) => void;
  onResend: (message: ChatMessage) => void;
}

function renderText(text: string) {
  const lines = text.split("\n");
  return lines.map((line, index) => {
    const key = `${index}-${line.slice(0, 8)}`;
    if (line.startsWith("> ")) {
      return (
        <span className="quoted-line" key={key}>
          {line.slice(2)}
        </span>
      );
    }
    return (
      <span key={key}>
        {line}
        {index < lines.length - 1 ? <br /> : null}
      </span>
    );
  });
}

/** 单条消息气泡：助手白底左对齐、用户绿底右对齐，带小尖角与失败/待发状态。
 *  自己的消息不画头像（占地方又没信息量），对方消息优先用自定义头像。 */
export function Bubble({ message, agentName, agentAvatar = null, onContextMenu, onResend }: BubbleProps) {
  if (message.role === "system") {
    return <div className="system-line">{message.text}</div>;
  }

  const isUser = message.role === "user";
  const failed = message.delivery === "failed";

  return (
    <div className={`msg-row ${isUser ? "msg-user" : "msg-agent"}`}>
      {!isUser ? (
        agentAvatar ? (
          <img className="avatar avatar-agent avatar-image" src={agentAvatar} alt={agentName} />
        ) : (
          <div className="avatar avatar-agent">{agentName.slice(0, 1)}</div>
        )
      ) : null}

      <div className="msg-col">
        {message.recalled ? (
          <div className={`bubble ${isUser ? "bubble-user" : "bubble-agent"} bubble-recalled`}>
            消息已撤回
          </div>
        ) : (
          <div
            className={`bubble ${isUser ? "bubble-user" : "bubble-agent"}`}
            onContextMenu={(event) => {
              event.preventDefault();
              onContextMenu(event, message);
            }}
          >
            {renderText(message.text)}
          </div>
        )}

        {failed ? (
          <div className="msg-meta msg-failed">
            发送失败
            <button className="link-btn" onClick={() => onResend(message)}>
              重发
            </button>
          </div>
        ) : null}
        {message.delivery === "pending" ? <div className="msg-meta">发送中…</div> : null}
      </div>
    </div>
  );
}

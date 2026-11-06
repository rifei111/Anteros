import type { ChatMessage } from "@anteros/shared";
import { VoiceBubble } from "./VoiceBubble";

interface BubbleProps {
  message: ChatMessage;
  agentName: string;
  /** 聊天对象头像（data URL）；null 用名字首字 */
  agentAvatar?: string | null;
  /** 群聊：其他人的消息左边带昵称与头像，「它」的消息走右边 */
  groupMode?: boolean;
  /** 同一个人的连续消息：不重复画头像，段间距收紧 */
  grouped?: boolean;
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
export function Bubble({
  message,
  agentName,
  agentAvatar = null,
  groupMode = false,
  grouped = false,
  onContextMenu,
  onResend,
}: BubbleProps) {
  if (message.role === "system") {
    return <div className="system-line">{message.text}</div>;
  }

  const isUser = message.role === "user";
  const failed = message.delivery === "failed";
  // 群聊里我自己发的那条没有发送者信息（senderName/senderId 都空）：它是「我」，不是群成员。
  const fromMe = isUser && !message.senderName && !message.senderId;
  // 群聊里它占右边（你在群里是旁观者），其他群成员的消息带昵称与首字头像在左边；
  // 私聊保持原样：你说的话在右、它说的话在左。
  const onRight = groupMode ? !isUser || fromMe : isUser;
  const senderLabel = groupMode && isUser && !fromMe ? message.senderName || message.senderId || "群成员" : "";
  // 气泡样式跟"在哪一侧"走，而不是跟角色走：
  // 群聊里群成员在左边，如果用用户色（绿底 + 右侧尖角），尖角会朝外，看着就是反的。
  const bubbleClass = onRight ? "bubble-user" : "bubble-agent";

  return (
    <div className={`msg-row ${onRight ? "msg-right" : "msg-left"}${grouped ? " msg-grouped" : ""}`}>
      {!onRight ? (
        grouped ? (
          <span className="avatar-spacer" aria-hidden="true" />
        ) : isUser ? (
          <div className="avatar avatar-member" title={senderLabel}>
            {senderLabel.slice(0, 1)}
          </div>
        ) :
        agentAvatar ? (
          <img className="avatar avatar-agent avatar-image" src={agentAvatar} alt={agentName} />
        ) : (
          <div className="avatar avatar-agent">{agentName.slice(0, 1)}</div>
        )
      ) : null}

      <div className="msg-col">
        {senderLabel ? <div className="msg-sender">{senderLabel}</div> : null}
        {message.recalled ? (
          <div className={`bubble ${bubbleClass} bubble-recalled`}>
            消息已撤回
          </div>
        ) : (
          <div
            className={`bubble ${bubbleClass}`}
            onContextMenu={(event) => {
              event.preventDefault();
              onContextMenu(event, message);
            }}
          >
            {message.attachment ? <VoiceBubble message={message} /> : null}
            {/* 语音条的正文是占位符（[语音 12″]），没有可读内容，别再当成一句人话渲染一遍；
                但「生成中」和「没能生成」的气泡必须把正文兜住——
                合成要等几秒到一分钟，这期间如果只给一句「语音生成中…」，
                用户看到的就是「它不说话了、界面卡住了」（v1.0.28 的报障就是这么来的）。 */}
            {message.attachment && message.attachment.state === "ready"
              ? null
              : renderText(message.text)}
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

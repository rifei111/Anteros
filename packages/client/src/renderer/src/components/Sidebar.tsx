import { openAdmin, openSearch, switchConversation } from "../lib/app";
import { formatListTime, truncate } from "../lib/format";
import { RELATION_STAGE_LABEL, labelOf } from "../lib/labels";
import { useAppState } from "../lib/store";

/**
 * 左侧会话列表：本机会话 + 未来的外部通道会话。
 * 外部通道还没接入时只显示「未接入」占位，不编造任何消息。
 */
export function Sidebar() {
  const state = useAppState();
  const agentName = state.persona?.name ?? "Anteros";

  const lastMessage = [...state.messages].reverse().find((message) => message.role !== "system");
  const lastTs = lastMessage ? lastMessage.ts : null;
  const summary = lastMessage
    ? lastMessage.recalled
      ? "[消息已撤回]"
      : truncate(lastMessage.text.replace(/^> .*\n/, ""), 22)
    : "还没有聊过";


  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="self-avatar">A</div>
        <div className="self-meta">
          <div className="self-name">本机</div>
          <div className="self-sub">单机闭环 · 数据不出本机</div>
        </div>
        {state.owner?.isOwner ? <span className="owner-tag">owner</span> : null}
      </div>

      <div className="search-box" onClick={() => openSearch()} role="button" tabIndex={0}>
        <input readOnly placeholder="搜索本机记忆" aria-label="搜索本机记忆" />
      </div>

      <div className="conv-list">
        <button
          className={`conv-item${state.activeConversation === "app" ? " active" : ""}`}
          type="button"
          onClick={() => void switchConversation("app")}
        >
          {state.agentAvatar ? (
            <img className="conv-avatar conv-avatar-image" src={state.agentAvatar} alt={agentName} />
          ) : (
            <div className="conv-avatar">{agentName.slice(0, 1)}</div>
          )}
          <div className="conv-main">
            <div className="conv-top">
              <span className="conv-name">{agentName}</span>
              <span className="conv-time">{formatListTime(lastTs)}</span>
            </div>
            <div className="conv-bottom">
              <span className="conv-summary">{summary}</span>
              {state.unread > 0 ? <span className="unread-dot">{state.unread > 99 ? "99+" : state.unread}</span> : null}
            </div>
          </div>
        </button>

        {state.wechatChats.map((chat) => {
          const key = `wechat:${chat.username}`;
          const active = state.activeConversation === key;
          return (
            <button
              key={key}
              className={`conv-item${active ? " active" : ""}`}
              type="button"
              onClick={() => void switchConversation(key)}
              title={chat.username}
            >
              <div className="conv-avatar">{chat.kind === "group" ? "群" : (chat.title || chat.username).slice(0, 1)}</div>
              <div className="conv-main">
                <div className="conv-top">
                  <span className="conv-name">{chat.title || chat.username}</span>
                  {chat.kind === "group" ? <span className="conv-tag">群</span> : null}
                </div>
                <div className="conv-bottom">
                  <span className="conv-summary">
                    {chat.mode === "off"
                      ? "只读不回复"
                      : chat.kind === "group" && chat.mode === "mention"
                        ? "@ 它才回"
                        : `收到 ${chat.inboundCount} 条 · 发出 ${chat.outboundCount} 条`}
                  </span>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="sidebar-foot">
        <button className="text-btn" onClick={() => openAdmin("owner")}>
          管理面板
        </button>
        <span className="sidebar-foot-text">
          关系：{labelOf(RELATION_STAGE_LABEL, state.relation?.stage)}
        </span>
      </div>
    </aside>
  );
}

import { openAdmin, openSearch } from "../lib/app";
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

  const externalChannels = state.channels.filter((channel) => channel.kind === "external");

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
        <button className="conv-item active" type="button">
          <div className="conv-avatar">{agentName.slice(0, 1)}</div>
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

        {externalChannels.map((channel) => (
          <button className="conv-item conv-external" type="button" key={channel.pluginId} disabled>
            <div className="conv-avatar conv-avatar-muted">{channel.displayName.slice(0, 1)}</div>
            <div className="conv-main">
              <div className="conv-top">
                <span className="conv-name">{channel.displayName}</span>
                <span className="conv-tag">外部通道</span>
              </div>
              <div className="conv-bottom">
                <span className="conv-summary">
                  {channel.enabled ? "已启用，等待消息" : "未接入（默认关闭）"}
                </span>
              </div>
            </div>
          </button>
        ))}
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

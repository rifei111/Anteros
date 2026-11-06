import { openAdmin, openSearch, switchConversation } from "../lib/app";
import { formatListTime, truncate } from "../lib/format";
import { PRESENCE_LABEL, PRESENCE_TONE, RELATION_STAGE_LABEL, labelOf } from "../lib/labels";
import { useAppState } from "../lib/store";
import { SearchIcon } from "./Icons";

/**
 * 左侧是「它在这里」：名字、此刻的关系、此刻在不在。
 *
 * 这里不画账号卡、不挂 owner 标记——单机单人，没有第二个账号可切；
 * 关系与在场是这个产品的主语，就放在最上面，而不是缩在页脚 11px 灰字里。
 * 再往下才是会话列表（本机一条，接入外部通道后每条通道一条）。
 */
export function Sidebar() {
  const state = useAppState();
  const agentName = state.persona?.name ?? "Anteros";
  const agentInitial = agentName.slice(0, 1);
  const stage = state.relation?.stage ?? null;
  const presence = state.world?.presence ?? null;

  // 摘要优先取内核给的「这条线最后一句」：重启、切走都不影响，
  // 也不会把别的会话的内容显示在别的条目上。
  const appSummary = state.conversationSummaries["app"];
  const lastMessage = [...state.messages].reverse().find((message) => message.role !== "system");
  const lastTs = appSummary?.lastTs || (lastMessage ? lastMessage.ts : null);
  const summary =
    appSummary && appSummary.lastText.length > 0
      ? truncate(appSummary.lastText, 22)
      : lastMessage
        ? lastMessage.recalled
          ? "[消息已撤回]"
          : truncate(lastMessage.text.replace(/^> .*\n/, ""), 22)
        : "还没有聊过";

  return (
    <aside className="sidebar">
      <div className="agent-panel">
        {state.agentAvatar ? (
          <img className="agent-panel-avatar agent-panel-avatar-image" src={state.agentAvatar} alt={agentName} />
        ) : (
          <div className="agent-panel-avatar">{agentInitial}</div>
        )}
        <div className="agent-panel-main">
          <div className="agent-panel-name">{agentName}</div>
          <div className="agent-panel-sub">
            <span className={presence ? `presence presence-${PRESENCE_TONE[presence]}` : "presence presence-muted"}>
              {presence ? labelOf(PRESENCE_LABEL, presence) : "在场状态还没同步"}
            </span>
            <span className="dot-sep">·</span>
            <span className="stage-text">{labelOf(RELATION_STAGE_LABEL, stage)}</span>
          </div>
        </div>
      </div>

      <div className="agent-note">
        {state.world?.timeAnchor ? <span className="agent-note-anchor">{state.world.timeAnchor}</span> : null}
        <span>它只用这台电脑上的记忆和你说话。</span>
      </div>

      <button className="search-box" type="button" onClick={() => openSearch()}>
        <SearchIcon size={14} />
        <span className="search-box-text">搜索本机记忆</span>
      </button>

      <div className="conv-list">
        <button
          className={`conv-item${state.activeConversation === "app" ? " active" : ""}`}
          type="button"
          onClick={() => void switchConversation("app")}
        >
          {state.agentAvatar ? (
            <img className="conv-avatar conv-avatar-image" src={state.agentAvatar} alt={agentName} />
          ) : (
            <div className="conv-avatar">{agentInitial}</div>
          )}
          <div className="conv-main">
            <div className="conv-top">
              <span className="conv-name">应用内</span>
              <span className="conv-time">{formatListTime(lastTs)}</span>
            </div>
            <div className="conv-bottom">
              <span className="conv-summary">{summary}</span>
              {(state.unreadByConversation["app"] ?? 0) > 0 ? (
                <span className="unread-dot">
                  {(state.unreadByConversation["app"] ?? 0) > 99 ? "99+" : state.unreadByConversation["app"]}
                </span>
              ) : null}
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
                  {(state.unreadByConversation[key] ?? 0) > 0 ? (
                    <span className="unread-dot">
                      {(state.unreadByConversation[key] ?? 0) > 99 ? "99+" : state.unreadByConversation[key]}
                    </span>
                  ) : null}
                </div>
                <div className="conv-bottom">
                  <span className="conv-summary">
                    {(() => {
                      const line = state.conversationSummaries[key];
                      if (line && line.lastText.length > 0) {
                        const prefix = line.lastRole === "user" ? "你：" : "";
                        return truncate(prefix + line.lastText, 22);
                      }
                      if (chat.mode === "off") return "只读不回复";
                      if (chat.kind === "group" && chat.mode === "mention") return "@ 它才回";
                      return "还没有聊过";
                    })()}
                  </span>
                  {state.conversationSummaries[key]?.lastTs ? (
                    <span className="conv-time">{formatListTime(state.conversationSummaries[key].lastTs)}</span>
                  ) : null}
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
        <span className="sidebar-foot-text">数据不出这台电脑</span>
      </div>
    </aside>
  );
}
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ChatMessage, ProactiveSummary } from "@anteros/shared";
import {
  deleteLocalMessage,
  loadOlderMessages,
  markReadSoon,
  openAdmin,
  switchConversation,
  resendMessage,
} from "../lib/app";
import { formatClock, formatDayLabel, shouldShowTimestamp, truncate } from "../lib/format";
import {
  PRESENCE_LABEL,
  PRESENCE_TONE,
  RELATION_STAGE_LABEL,
  labelOf,
} from "../lib/labels";
import { useAppState } from "../lib/store";
import { Bubble } from "./Bubble";
import { Composer } from "./Composer";
import { GearIcon } from "./Icons";

interface ContextMenuState {
  x: number;
  y: number;
  message: ChatMessage;
}

/** 主动消息档位的中文短名（聊天页常驻条与设置页共用一套词）。 */
const PROACTIVE_LEVEL_TEXT: Record<ProactiveSummary["level"], string> = {
  off: "关闭",
  low: "低",
  normal: "正常",
  high: "高",
};

function messageText(message: ChatMessage): string {
  return message.text.replace(/^(> .*\n)+/, "").trim();
}

/**
 * 右侧聊天区。
 *
 * 三条硬约束（草案 14.14.4）：
 * 1. 「正在输入…」只在 `event.typing` 说 true 时出现，不自己造计时器；
 * 2. 在场状态只显示 `event.presence` / 快照里的真实值，不编「已读」「在线」；
 * 3. 日志、权限、插件状态一律不进气泡。
 */
export function ChatPane() {
  const state = useAppState();
  const [quote, setQuote] = useState<ChatMessage | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const agentName = state.persona?.name ?? "Anteros";
  const agentInitial = agentName.slice(0, 1);

  /* ---------------- 滚动：贴底跟随 + 顶部加载更早历史 ---------------- */

  useEffect(() => {
    const element = listRef.current;
    if (!element || !stickToBottom.current) return;
    element.scrollTop = element.scrollHeight;
  }, [state.messages.length, state.stream]);

  const onScroll = useCallback((): void => {
    const element = listRef.current;
    if (!element) return;
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
    if (element.scrollTop > 48 || !state.hasMoreHistory || state.historyLoading) return;
    const previousHeight = element.scrollHeight;
    const previousTop = element.scrollTop;
    void loadOlderMessages().then(() => {
      const current = listRef.current;
      if (!current) return;
      current.scrollTop = current.scrollHeight - previousHeight + previousTop;
    });
  }, [state.hasMoreHistory, state.historyLoading]);

  useEffect(() => {
    if (state.messages.length === 0) return;
    markReadSoon();
  }, [state.messages.length]);

  /* ---------------- 右键菜单 ---------------- */

  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(null);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenu(null);
    };
    globalThis.addEventListener("mousedown", close);
    globalThis.addEventListener("keydown", onKey);
    return () => {
      globalThis.removeEventListener("mousedown", close);
      globalThis.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const copyMessage = async (message: ChatMessage): Promise<void> => {
    try {
      await globalThis.navigator.clipboard.writeText(messageText(message));
    } catch {
      // 剪贴板被拒绝时不假装复制成功
    }
    setMenu(null);
  };

  /* ---------------- 消息渲染 ---------------- */

  const nodes: ReactNode[] = [];
  let previousTs: number | null = null;
  let previousDay = "";

  for (const message of state.messages) {
    const day = formatDayLabel(message.ts);
    if (day !== previousDay) {
      nodes.push(
        <div className="day-sep" key={`day-${day}-${message.id}`}>
          {day}
        </div>,
      );
      previousDay = day;
      previousTs = null;
    }
    if (shouldShowTimestamp(previousTs, message.ts)) {
      nodes.push(
        <div className="time-sep" key={`time-${message.id}`}>
          {formatClock(message.ts)}
        </div>,
      );
    }
    nodes.push(
      <Bubble
        key={message.id}
        message={message}
        agentName={agentName}
        agentAvatar={state.agentAvatar}
        onContextMenu={(event, target) =>
          setMenu({
            x: Math.min(event.clientX, globalThis.innerWidth - 160),
            y: Math.min(event.clientY, globalThis.innerHeight - 160),
            message: target,
          })
        }
        onResend={(target) => {
          void resendMessage(target);
        }}
      />,
    );
    previousTs = message.ts;
  }

  const presence = state.world?.presence ?? null;
  const stage = state.relation?.stage ?? null;
  const typing = state.stream?.typing === true;
  const plannedMs = state.stream?.plannedMs ?? null;

  return (
    <main className="chat">
      <header className="chat-head">
        {state.agentAvatar ? (
          <img className="chat-head-avatar chat-head-avatar-image" src={state.agentAvatar} alt={agentName} />
        ) : (
          <div className="chat-head-avatar">{agentInitial}</div>
        )}
        <div className="chat-head-meta">
          <div className="chat-head-name">{agentName}</div>
          <div className="chat-head-sub">
            <span>{labelOf(RELATION_STAGE_LABEL, stage)}</span>
            <span className="dot-sep">·</span>
            <span className={presence ? `presence presence-${PRESENCE_TONE[presence]}` : "presence"}>
              {presence ? labelOf(PRESENCE_LABEL, presence) : "尚未同步在场状态"}
            </span>
            {state.world?.timeAnchor ? (
              <>
                <span className="dot-sep">·</span>
                <span>{state.world.timeAnchor}</span>
              </>
            ) : null}
          </div>
        </div>
        {state.wechatChats.length > 0 ? (
          <select
            className="conversation-select"
            value={state.activeConversation}
            onChange={(event) => void switchConversation(event.target.value)}
            aria-label="切换会话"
            title="切换要看的会话"
          >
            <option value="app">应用内</option>
            {state.wechatChats.map((chat) => (
              <option key={chat.username} value={`wechat:${chat.username}`}>
                {chat.kind === "group" ? "群 · " : "微信 · "}
                {chat.title || chat.username}
              </option>
            ))}
          </select>
        ) : null}
        <div className="chat-head-actions">
          <button className="icon-btn" onClick={() => openAdmin("owner")} aria-label="管理面板" title="管理面板">
            <GearIcon />
          </button>
        </div>
      </header>

      {!state.connection.connected ? (
        <div className="banner banner-warn">
          内核已断开，正在重连…
          <span className="banner-detail">{state.connection.message}</span>
        </div>
      ) : null}

      {state.llm?.degradedLocalEcho ? (
        <div className="banner banner-info">
          未配置模型：当前回复来自本地回声（演示模式，不产生云端调用）。
          <button className="link-btn" onClick={() => openAdmin("model")}>
            去配置
          </button>
        </div>
      ) : null}

      {state.proactive ? (
        <div className="proactive-strip">
          <span className={`proactive-chip proactive-${state.proactive.level}`}>
            主动消息 · {PROACTIVE_LEVEL_TEXT[state.proactive.level]}
          </span>
          <span className="proactive-detail">
            {state.proactive.level === "off"
              ? "当前不会主动找你"
              : `约 ${state.proactive.intervalMinutes} 分钟一次 · 每天最多 ${state.proactive.dailyCap} 条 · 今天已发 ${state.proactive.sentToday} 条`}
          </span>
          {state.proactive.paused ? <span className="proactive-warn">已暂停</span> : null}
          <span className="proactive-detail">
            {state.proactive.relayToExternal
              ? state.proactive.externalReady
                ? "会同步到外部通道"
                : "外部通道未就绪，只在本机"
              : "只在本机"}
          </span>
          <button className="link-btn" onClick={() => openAdmin("proactive")}>
            调整
          </button>
        </div>
      ) : null}

      <div className="chat-list" ref={listRef} onScroll={onScroll}>
        {state.hasMoreHistory ? (
          <button
            className="load-more"
            onClick={() => {
              const element = listRef.current;
              const previousHeight = element?.scrollHeight ?? 0;
              const previousTop = element?.scrollTop ?? 0;
              void loadOlderMessages().then(() => {
                const current = listRef.current;
                if (!current) return;
                current.scrollTop = current.scrollHeight - previousHeight + previousTop;
              });
            }}
            disabled={state.historyLoading}
          >
            {state.historyLoading ? "正在加载…" : "查看更早的消息"}
          </button>
        ) : null}

        {state.messages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-title">还没有聊过</div>
            <div className="chat-empty-note">发第一句话吧。它的人格与记忆只存在这台电脑上。</div>
          </div>
        ) : null}

        {nodes}

        {typing ? (
          <div className="msg-row msg-agent">
            <div className="avatar avatar-agent">{agentInitial}</div>
            <div className="msg-col">
              <div
                className="typing-bubble"
                title={plannedMs ? `内核预计打字 ${Math.round(plannedMs / 1000)} 秒` : "来自内核的真实 typing 事件"}
              >
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-text">正在输入…</span>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <Composer quote={quote} onClearQuote={() => setQuote(null)} />

      {menu ? (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(event) => event.stopPropagation()}>
          <button
            onClick={() => {
              void copyMessage(menu.message);
            }}
          >
            复制
          </button>
          <button
            onClick={() => {
              setQuote(menu.message);
              setMenu(null);
            }}
          >
            引用（发送时附上行首 &gt; {truncate(messageText(menu.message), 12)}）
          </button>
          <button
            className="danger"
            onClick={() => {
              deleteLocalMessage(menu.message);
              setMenu(null);
            }}
          >
            删除本地显示
          </button>
        </div>
      ) : null}
    </main>
  );
}

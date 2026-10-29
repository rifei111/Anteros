import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatMessage } from "@anteros/shared";
import { Bubble } from "../src/renderer/src/components/Bubble";

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 1,
    agentId: 1,
    role: "user",
    text: "来打原神",
    ts: Date.now(),
    turnId: null,
    partIndex: 0,
    recalled: false,
    clientAckTs: null,
    channelId: "wechat:45226657898@chatroom",
    delivery: "sent",
    senderName: null,
    senderId: null,
    ...overrides,
  } as ChatMessage;
}

const noop = () => undefined;

describe("群聊气泡布局", () => {
  it("群聊里别人说的话在左边，并显示昵称", () => {
    const html = renderToStaticMarkup(
      <Bubble
        message={message({ role: "user", senderName: "大肥鱼" })}
        agentName="小满"
        groupMode
        onContextMenu={noop}
        onResend={noop}
      />,
    );
    expect(html).toContain("msg-left");
    expect(html).toContain("大肥鱼");
    expect(html).toContain("avatar-member");
    expect(html).not.toContain("msg-right");
  });

  it("群聊里它说的话在右边，且不带群昵称", () => {
    const html = renderToStaticMarkup(
      <Bubble
        message={message({ role: "agent", senderName: null })}
        agentName="小满"
        groupMode
        onContextMenu={noop}
        onResend={noop}
      />,
    );
    expect(html).toContain("msg-right");
    expect(html).not.toContain("msg-sender");
  });

  it("私聊保持原样：自己在右、它在左", () => {
    const mine = renderToStaticMarkup(
      <Bubble message={message({ role: "user", channelId: "app" })} agentName="小满" onContextMenu={noop} onResend={noop} />,
    );
    const agent = renderToStaticMarkup(
      <Bubble message={message({ role: "agent", channelId: "app" })} agentName="小满" onContextMenu={noop} onResend={noop} />,
    );
    expect(mine).toContain("msg-right");
    expect(agent).toContain("msg-left");
    expect(mine).not.toContain("avatar-member");
  });

  it("没拿到昵称时退回微信号，不显示空白头像", () => {
    const html = renderToStaticMarkup(
      <Bubble
        message={message({ role: "user", senderName: null, senderId: "wxid_azqocbj6ktli12" })}
        agentName="小满"
        groupMode
        onContextMenu={noop}
        onResend={noop}
      />,
    );
    expect(html).toContain("wxid_azqocbj6ktli12");
  });
});
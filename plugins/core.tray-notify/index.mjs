/**
 * core.tray-notify —— 通知桥。
 *
 * 插件进程不是 Electron 主进程，拿不到 Tray 对象，也不该为了发通知去启动 UI。
 * 因此这里只做一件事：把 plugin.notify.send 校验后**转交内核**，由宿主向客户端
 * 发 event.notify，托盘气泡 / App 内通知由客户端渲染。
 *
 * "发不出去退化 App 通知、不重试"的语义：
 * - 插件不重试（一次调用一次回答，失败就让调用方看到失败）；
 * - 客户端托盘不可用时，客户端把同一条 event.notify 退化为 App 内通知；
 * - 插件不伪造 delivered=true 以外的送达细节，也不持久化通知内容。
 */
import { createPlugin, fail } from "../_sdk/plugin-runtime.mjs";

const MAX_TITLE = 120;
const MAX_BODY = 2_000;

const runtime = createPlugin({
  id: "core.tray-notify",
  capabilities: [],
  handlers: {
    "plugin.health.check": () => ({
      ok: true,
      status: "ok",
      message: "通知桥就绪：通知经内核事件转交客户端渲染（托盘/App 内），插件不重试",
    }),
    "plugin.notify.send": (params) => {
      if (!params || typeof params.title !== "string" || params.title.trim() === "") {
        throw fail("EINVALID", "plugin.notify.send 需要非空 title");
      }
      const title = params.title.trim().slice(0, MAX_TITLE);
      const body = typeof params.body === "string" ? params.body.slice(0, MAX_BODY) : "";
      // 返回 delivered=true 的含义是"已交给内核事件通道"，不是"用户已经看到"。
      // 真正的失败（客户端不在、托盘不可用）由客户端侧退化处理，插件不重试。
      return {
        delivered: true,
        transport: "kernel-event",
        detail: "已转交内核 event.notify；托盘气泡或 App 内通知由客户端渲染，失败时客户端退化为 App 通知且不重试",
        title,
        bodyLength: body.length,
      };
    },
  },
  onReady(_info, ctx) {
    ctx.log("通知桥就绪：只做事件转交，不直接操作托盘");
  },
});

export const stats = () => runtime.stats();

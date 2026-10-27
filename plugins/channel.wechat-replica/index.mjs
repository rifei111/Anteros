/**
 * channel.wechat-replica —— 微信通道适配器**骨架**（v0.2：运行环境就绪后可拉起）。
 *
 * ============================================================================
 *  红线声明（草案 14.6 / 14.7；工程规范 6 §9）
 *
 *  本文件不含任何内存偏移、RVA、指针扫描、DLL 注入、代码补丁、协议逆向、
 *  密钥读取或风控规避逻辑；不启动、不读取、不修改任何第三方客户端。
 *
 *  Anteros 不自带、不内置、不提供任何绕过手段。要使用第三方通道，用户必须
 *  自行安装并授权其信任的第三方通道组件，并自行承担账号与合规风险
 *  （"用户自装自用自担"）。本项目只负责：
 *    - 声明能力与权限（manifest 可审计）；
 *    - 在启用时走声明闸（用户逐条确认）、体检、租约（写动作串行化）；
 *    - 提供可卸载/可一键停用的生命周期；
 *    - 未就绪时诚实返回 blocked，绝不假装已接通。
 * ============================================================================
 *
 * v0.2 的变化（对应「下载运行环境后插件也要就绪」）：
 * - 宿主在拉起插件时注入 `ANTEROS_PLUGIN_RUNTIME_DIR` / `..._VERSION`；
 * - 没装运行环境 → 体检 blocked（并提示去插件页下载）；
 * - 装了且目录可用 → 体检 ok，消息写「适配器骨架已就绪，未接入微信本体」；
 *   这时插件进程真的在跑、能应答健康检查，但 **channel.send 仍然拒绝**：
 *   就绪的是骨架，不是通道。
 *
 * 生命周期（规范 6 §4）：
 * - 宿主启动插件 → handshake → 本进程只回答 describe/health，不建立任何外部连接；
 * - 若未来接入真实适配器：启用后必须先 begin 租约才能 send；停用必须调用
 *   disable_and_restore 并确认第三方组件状态已恢复。
 */
import fs from "node:fs";
import { createPlugin, fail } from "../_sdk/plugin-runtime.mjs";

const RUNTIME_DIR = (process.env.ANTEROS_PLUGIN_RUNTIME_DIR ?? "").trim();
const RUNTIME_VERSION = (process.env.ANTEROS_PLUGIN_RUNTIME_VERSION ?? "").trim();

const NOT_READY_MESSAGE = "通道未就绪：需要用户自行安装并授权第三方通道组件；Anteros 不自带、不内置任何绕过/注入/逆向手段，也不会读取或修改微信进程内存。";

/**
 * 运行环境体检：只做「目录在不在、有没有内容」这种可自证的事，
 * 不去执行里面的任何代码（执行权归第三方组件自己，Anteros 不代跑）。
 */
function inspectRuntime() {
  if (RUNTIME_DIR.length === 0) {
    return {
      ok: false,
      reason: "no-runtime",
      message: "还没下载运行环境：这个通道需要一个外部适配器运行环境才能拉起，Anteros 不内置它。",
      hint: "在插件页点「下载运行环境」，装好之后再启用这个插件。",
      fileCount: 0,
    };
  }
  try {
    const stat = fs.statSync(RUNTIME_DIR);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        reason: "bad-runtime",
        message: `运行环境路径不是目录：${RUNTIME_DIR}`,
        hint: "重新下载一次运行环境（会覆盖到同版本目录）。",
        fileCount: 0,
      };
    }
    const entries = fs.readdirSync(RUNTIME_DIR);
    if (entries.length === 0) {
      return {
        ok: false,
        reason: "empty-runtime",
        message: `运行环境目录是空的：${RUNTIME_DIR}`,
        hint: "重新下载一次运行环境；如果一直为空，检查磁盘空间与权限。",
        fileCount: 0,
      };
    }
    return {
      ok: true,
      reason: "ready",
      message: `适配器骨架已就绪（运行环境 ${RUNTIME_VERSION || "未知版本"}，${entries.length} 个条目）；尚未接入微信本体，收发消息仍会诚实拒绝。`,
      hint: "骨架就绪只代表插件进程能正常拉起，不代表微信已接通。",
      fileCount: entries.length,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "missing-runtime",
      message: `运行环境目录不存在或读不到：${RUNTIME_DIR}（${error instanceof Error ? error.message : String(error)}）`,
      hint: "重新下载运行环境。",
      fileCount: 0,
    };
  }
}

/** 骨架就绪 ≠ 通道可用：真正收发的动作一律拒绝，并把原因说清楚。 */
function notAttached(action) {
  const runtime = inspectRuntime();
  const prefix = runtime.ok ? runtime.message : NOT_READY_MESSAGE;
  return fail("EBLOCKED", `${action} 不可用：${prefix}`, {
    hint: runtime.hint,
    detail: `拒绝的动作：${action}；运行环境状态：${runtime.reason}`,
  });
}

createPlugin({
  id: "channel.wechat-replica",
  capabilities: ["channel.read", "channel.history", "channel.write", "channel.lease", "channel.media"],
  handlers: {
    "plugin.describe": () => {
      const runtime = inspectRuntime();
      return {
        id: "channel.wechat-replica",
        capabilities: ["channel.read", "channel.history", "channel.write", "channel.lease", "channel.media"],
        status: runtime.ok ? "degraded" : "blocked",
        message: runtime.ok ? runtime.message : `${NOT_READY_MESSAGE}${runtime.message}`,
        runtime: { dir: RUNTIME_DIR || null, version: RUNTIME_VERSION || null, ready: runtime.ok, reason: runtime.reason },
      };
    },

    "plugin.health.check": () => {
      const runtime = inspectRuntime();
      if (runtime.ok) {
        // 插件进程健康（骨架在跑、能应答），但通道没接上——这两件事分开说。
        return {
          ok: true,
          status: "ok",
          message: runtime.message,
          attachments: { read: false, write: false, typing: false, recall: false },
          detail: { runtime: "ready", channel: "not-attached" },
        };
      }
      return {
        ok: false,
        status: "blocked",
        message: `${runtime.message} ${runtime.hint}`,
        attachments: { read: false, write: false, typing: false, recall: false },
        detail: { runtime: runtime.reason, channel: "not-attached" },
      };
    },

    // 读：一律拒绝，不返回任何伪造的消息、水位线或历史记录。
    "plugin.channel.read_since": () => {
      throw notAttached("channel.read_since");
    },
    "plugin.channel.send": () => {
      throw notAttached("channel.send");
    },
    "plugin.channel.download_media": () => {
      throw notAttached("channel.download_media");
    },

    // 租约：没有通道就没有租约。返回 granted:false（而不是抛错），让内核按"未授予"处理。
    "plugin.channel.lease.begin": () => ({
      granted: false,
      detail: "通道未接入微信本体，不会授予写租约；未持有租约时内核不得发送任何消息。",
    }),
    "plugin.channel.lease.end": () => ({
      released: true,
      detail: "本进程从未授予租约，无需释放。",
    }),

    // 停用/恢复：本进程未加载任何第三方组件、未修改目标客户端，所以"恢复"是诚实空操作。
    "plugin.channel.disable_and_restore": () => ({
      restored: true,
      detail: "本进程未加载任何第三方组件、未注入/补丁/读取目标客户端，因此无需恢复；不存在遗留修改。",
    }),
  },
  onReady(_info, ctx) {
    const runtime = inspectRuntime();
    ctx.log(
      runtime.ok
        ? `微信通道骨架已连接内核：运行环境就绪（${RUNTIME_VERSION || "未知版本"}），通道未接入微信本体`
        : `微信通道骨架已连接内核：无运行环境（${runtime.reason}），体检将报 blocked`,
    );
  },
});
/**
 * channel.wechat-replica —— 微信通道适配器**骨架**（v0.1，未就绪）。
 *
 * ============================================================================
 *  红线声明（草案 14.6 / 14.7；工程规范 6 §9）
 *
 *  本文件是空实现。没有任何内存偏移、RVA、指针扫描、DLL 注入、代码补丁、
 *  协议逆向、密钥读取或风控规避逻辑；不启动、不读取、不修改任何第三方客户端。
 *
 *  Anteros 不自带、不内置、不提供任何绕过手段。要使用第三方通道，用户必须
 *  自行安装并授权其信任的第三方通道组件，并自行承担账号与合规风险
 *  （"用户自装自用自担"）。本项目只负责：
 *    - 声明能力与权限（manifest 可审计）；
 *    - 在启用时走声明闸（用户逐条确认）、体检、租约（写动作串行化）；
 *    - 提供可卸载/可一键停用的生命周期；
 *    - 未就绪时诚实返回 blocked，绝不假装已接通。
 *
 *  当前状态：blocked。未实现前不得发布为可用，也不得在文档/UI 里宣称支持微信。
 * ============================================================================
 *
 * 生命周期（规范 6 §4）：
 * - 宿主启动插件 → handshake → 本进程只回答 describe/health，不建立任何外部连接；
 * - 用户尝试启用 → 内核先过声明闸与体检；体检结果 blocked，启用被拒绝；
 * - 若未来接入真实适配器：启用后必须先 begin 租约才能 send；停用必须调用
 *   disable_and_restore 并确认第三方组件状态已恢复。
 */
import { createPlugin, fail } from "../_sdk/plugin-runtime.mjs";

const BLOCKED_MESSAGE =
  "通道未就绪：需要用户自行安装并授权第三方通道组件；Anteros 不自带、不内置任何绕过/注入/逆向手段，也不会读取或修改微信进程内存。";
const BLOCKED_HINT =
  "本插件 v0.1 是空实现（blocked）。启用需要声明闸 + 体检 + 租约；未实现前请在插件页保持禁用。";

function blocked(code, action) {
  return fail("EBLOCKED", `${action} 不可用：${BLOCKED_MESSAGE}`, { hint: BLOCKED_HINT, detail: `拒绝的动作：${action}` });
}

createPlugin({
  id: "channel.wechat-replica",
  capabilities: ["channel.read", "channel.history", "channel.write", "channel.lease", "channel.media"],
  handlers: {
    "plugin.describe": () => ({
      id: "channel.wechat-replica",
      capabilities: ["channel.read", "channel.history", "channel.write", "channel.lease", "channel.media"],
      status: "blocked",
      message: BLOCKED_MESSAGE,
    }),

    "plugin.health.check": () => ({
      ok: false,
      status: "blocked",
      message: BLOCKED_MESSAGE,
    }),

    // 读：一律拒绝，不返回任何伪造的消息、水位线或历史记录。
    "plugin.channel.read_since": () => {
      throw blocked("EBLOCKED", "channel.read_since");
    },
    "plugin.channel.send": () => {
      throw blocked("EBLOCKED", "channel.send");
    },
    "plugin.channel.download_media": () => {
      throw blocked("EBLOCKED", "channel.download_media");
    },

    // 租约：没有通道就没有租约。返回 granted:false（而不是抛错），让内核按"未授予"处理。
    "plugin.channel.lease.begin": () => ({
      granted: false,
      detail: "通道未就绪，不会授予写租约；未持有租约时内核不得发送任何消息。",
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
    ctx.log("微信通道骨架已连接内核：状态 blocked（空实现，不做任何外部操作）");
  },
});

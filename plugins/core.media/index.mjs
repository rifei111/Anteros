/**
 * core.media —— 媒体能力占位（语音 / 图片）。
 *
 * 为什么 v0.1 只做占位：媒体供应商（TTS/图像）涉及密钥、计费与内容审核，
 * 没有真实密钥时**唯一诚实的回答是 blocked**。这个插件绝不返回假音频、假图片、
 * 假 URL，也不把"未配置"伪装成"已生成"。
 *
 * 接入真实实现时的约束（见 docs/PLUGINS.md / docs/SECURITY.md）：
 * - 密钥只从内核注入的 ANTEROS_SECRET_MEDIA_API_KEY 读取，不落盘、不打日志；
 * - 生成结果写到插件自己的数据目录（ANTEROS_DATA_DIR）或内核媒体目录，由内核登记；
 * - 失败返回可读错误，不做"兜底伪造"。
 */
import { createPlugin, fail, readSecret } from "../_sdk/plugin-runtime.mjs";

const CONFIG_KEYS = ["provider", "speakModel", "imageModel", "media.provider", "media.speakModel", "media.imageModel"];

async function getConfig(ctx) {
  try {
    const result = await ctx.call("kernel.config.get", { keys: CONFIG_KEYS }, { timeoutMs: 5_000 });
    return result && typeof result.config === "object" && result.config !== null ? result.config : {};
  } catch {
    return {}; // 读不到配置按"未配置"处理，调用侧返回 blocked
  }
}

function pick(config, ...keys) {
  for (const key of keys) {
    const value = config[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

/** 统一的 blocked 回答：未配置与"已配置但未实现"必须说清楚，不能混为一谈。 */
function blocked(capability, config) {
  const provider = pick(config, "provider", "media.provider");
  const hasKey = Boolean(readSecret("media.api_key"));
  const configured = Boolean(provider || hasKey);
  return {
    ok: false,
    status: "blocked",
    capability,
    configured,
    message: configured
      ? `媒体服务已配置${provider ? `（${provider}）` : ""}，但 v0.1 尚未接入该供应商实现`
      : "未配置媒体服务",
    detail:
      "core.media 在 v0.1 是占位实现：不会调用任何供应商，也不会返回假的音频/图片/URL。" +
      "接入真实实现前，所有媒体调用都会保持 blocked；内核应按 EDEGRADED 处理，而不是重试。",
  };
}

function requireText(value, field, maxLength) {
  if (typeof value !== "string" || value.trim() === "") {
    throw fail("EINVALID", `参数 ${field} 必须是非空字符串`);
  }
  if (value.length > maxLength) {
    throw fail("EINVALID", `参数 ${field} 超过 ${maxLength} 字符上限`);
  }
  return value;
}

const runtime = createPlugin({
  id: "core.media",
  capabilities: ["media.speak", "media.image"],
  handlers: {
    "plugin.health.check": async (_params, ctx) => {
      const config = await getConfig(ctx);
      const provider = pick(config, "provider", "media.provider");
      return {
        ok: true,
        status: "degraded",
        message: provider
          ? `媒体插件进程健康；已配置供应商 ${provider}，但 v0.1 未实现真实调用`
          : "媒体插件进程健康；未配置媒体服务，所有媒体调用返回 blocked",
      };
    },
    "plugin.media.speak": async (params, ctx) => {
      requireText(params?.text, "text", 2_000);
      const config = await getConfig(ctx);
      ctx.log("media.speak 请求被拒绝：占位实现，不生成假音频");
      return blocked("media.speak", config);
    },
    "plugin.media.image": async (params, ctx) => {
      requireText(params?.prompt, "prompt", 2_000);
      const config = await getConfig(ctx);
      ctx.log("media.image 请求被拒绝：占位实现，不生成假图片");
      return blocked("media.image", config);
    },
  },
  onReady(_info, ctx) {
    ctx.log("媒体插件就绪（占位）：未配置时返回 blocked，不假成功");
  },
});

export const stats = () => runtime.stats();
export const _test = { blocked, pick };

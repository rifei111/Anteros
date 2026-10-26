/**
 * core.dashboard —— 只读看板。
 *
 * 数据来源只有两处：
 * 1) 本插件运行时统计（连接状态、心跳、授予能力、运行时长）；
 * 2) 内核通过 kernel.config.get 返回的**本插件配置**（成本摘要等只读值）。
 * 不读数据库、不写状态、不调用会改变世界的内核方法；面板是纯描述块 JSON，
 * 由客户端决定怎么画。
 *
 * 块类型（v0.1，客户端按 type 渲染，未知类型应忽略而不是报错）：
 * - { type:"heading", text }
 * - { type:"stat", label, value, hint? }
 * - { type:"text", text }
 * - { type:"list", items: string[] }
 * - { type:"divider" }
 */
import { createPlugin, fail } from "../_sdk/plugin-runtime.mjs";

const SUPPORTED_PANELS = ["overview", "plugins", "cost"];
const CONFIG_KEYS = [
  "cost.spentCny",
  "cost.monthlyBudgetCny",
  "dashboard.metrics",
  "dashboard.plugins",
];

let runtime;

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "未知";
  const totalSeconds = Math.floor(ms / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

function formatMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return `¥${n.toFixed(2)}`;
}

async function getConfig(ctx) {
  try {
    const result = await ctx.call("kernel.config.get", { keys: CONFIG_KEYS }, { timeoutMs: 5_000 });
    return result && typeof result.config === "object" && result.config !== null ? result.config : {};
  } catch {
    return {}; // 看板允许降级：拿不到配置就显示"未提供"，不能让面板整体失败
  }
}

function overviewBlocks(config) {
  const stats = runtime.stats();
  const spent = formatMoney(config["cost.spentCny"]);
  const budget = formatMoney(config["cost.monthlyBudgetCny"]);
  return [
    { type: "heading", text: "运行" },
    { type: "stat", label: "插件运行时长", value: formatDuration(stats.uptimeMs) },
    { type: "stat", label: "内核会话", value: stats.session ?? "未连接" },
    { type: "stat", label: "已授予能力", value: `${stats.grants.length} 项` },
    { type: "stat", label: "心跳失败次数", value: String(stats.heartbeatFailures), hint: "连续失败会被内核标记 degraded" },
    { type: "divider" },
    { type: "heading", text: "成本（只读）" },
    { type: "stat", label: "本月已花费", value: spent ?? "未提供" },
    { type: "stat", label: "月度预算", value: budget ?? "未提供" },
    { type: "divider" },
    { type: "text", text: "数据来自 kernel.config 与插件自身统计；看板只读，不读数据库、不写任何状态。" },
  ];
}

function pluginBlocks(config) {
  const list = config["dashboard.plugins"];
  if (Array.isArray(list) && list.length > 0) {
    const items = list.map((item) => {
      if (typeof item === "string") return item;
      const id = item && typeof item.id === "string" ? item.id : "unknown";
      const status = item && typeof item.status === "string" ? item.status : "未知";
      return `${id}：${status}`;
    });
    return [
      { type: "heading", text: "插件健康（内核快照）" },
      { type: "list", items },
      { type: "divider" },
      { type: "text", text: "快照由内核写入本插件配置；看板不直接查询内核注册表或数据库。" },
    ];
  }
  return [
    { type: "heading", text: "插件健康" },
    { type: "text", text: "内核未提供插件健康快照（dashboard.plugins 为空）。v0.1 的看板不直接读取数据库或内核内部状态。" },
  ];
}

function costBlocks(config) {
  const spent = formatMoney(config["cost.spentCny"]);
  const budget = formatMoney(config["cost.monthlyBudgetCny"]);
  const blocks = [
    { type: "heading", text: "成本摘要（只读）" },
    { type: "stat", label: "本月已花费", value: spent ?? "未提供" },
    { type: "stat", label: "月度预算", value: budget ?? "未提供" },
  ];
  if (spent && budget) {
    const ratio = Number(config["cost.spentCny"]) / Number(config["cost.monthlyBudgetCny"]);
    if (Number.isFinite(ratio) && ratio >= 0.8) {
      blocks.push({ type: "text", text: `已使用预算的 ${Math.round(ratio * 100)}%，接近上限时内核会限制主动行为。` });
    }
  }
  blocks.push({ type: "divider" });
  blocks.push({ type: "text", text: "成本数据由内核写入配置，看板只读展示；不包含任何密钥或对话内容。" });
  return blocks;
}

const plugin = createPlugin({
  id: "core.dashboard",
  capabilities: ["ui.panel"],
  handlers: {
    "plugin.health.check": () => ({ ok: true, status: "ok", message: "只读看板可用（overview/plugins/cost）" }),
    "plugin.ui.panel.render": async (params, ctx) => {
      const panelId = typeof params?.panelId === "string" && params.panelId ? params.panelId : "overview";
      if (!SUPPORTED_PANELS.includes(panelId)) {
        throw fail("EINVALID", `未知看板面板：${panelId}`, { hint: `支持：${SUPPORTED_PANELS.join("、")}` });
      }
      const config = await getConfig(ctx);
      let blocks;
      let title;
      if (panelId === "overview") {
        blocks = overviewBlocks(config);
        title = "Anteros 运行看板";
      } else if (panelId === "plugins") {
        blocks = pluginBlocks(config);
        title = "插件健康";
      } else {
        blocks = costBlocks(config);
        title = "成本摘要";
      }
      return { title, blocks };
    },
  },
  onReady(_info, ctx) {
    ctx.log("只读看板就绪（overview/plugins/cost）");
  },
});

runtime = plugin;
export const stats = () => runtime.stats();
export const _test = { formatDuration, formatMoney, SUPPORTED_PANELS };

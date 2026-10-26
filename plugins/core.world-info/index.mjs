/**
 * core.world-info —— 真实世界信息（时间 / 天气 / 新闻）。
 *
 * 三条铁律：
 * 1. 时间取自本机时钟与系统时区；农历用 Node 内置 Intl 的中国历法，节气用常见日期表近似，
 *    并明确标注"近似"，不假装是天文精确值。
 * 2. 天气只访问固定的 Open-Meteo 域名，且必须由用户配置经纬度；未配置、无网络、超时，
 *    一律 degraded + 可读原因。**绝不编造天气**。
 * 3. 新闻 v0.1 不抓取（避免任意 URL 抓取带来的版权/合规风险）；未配置源或已配置都 degraded，
 *    并说明原因。
 */
import { createPlugin, fail } from "../_sdk/plugin-runtime.mjs";

const CONFIG_KEYS = [
  "weather.latitude",
  "weather.longitude",
  "weather.timezone",
  "news.sourceUrl",
  "weather",
  "news",
];

const WEATHER_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const WEATHER_TIMEOUT_MS = 3_500;

/** 24 节气的常见公历日期（±1 天属正常，这里只做近似展示）。 */
const SOLAR_TERMS = [
  [1, 5, "小寒"], [1, 20, "大寒"], [2, 4, "立春"], [2, 19, "雨水"],
  [3, 5, "惊蛰"], [3, 20, "春分"], [4, 5, "清明"], [4, 20, "谷雨"],
  [5, 5, "立夏"], [5, 21, "小满"], [6, 6, "芒种"], [6, 21, "夏至"],
  [7, 7, "小暑"], [7, 23, "大暑"], [8, 7, "立秋"], [8, 23, "处暑"],
  [9, 8, "白露"], [9, 23, "秋分"], [10, 8, "寒露"], [10, 23, "霜降"],
  [11, 7, "立冬"], [11, 22, "小雪"], [12, 7, "大雪"], [12, 22, "冬至"],
];

const WMO_TEXT = [
  [0, 0, "晴"], [1, 1, "晴间多云"], [2, 2, "多云"], [3, 3, "阴"],
  [45, 48, "雾"], [51, 55, "毛毛雨"], [56, 57, "冻毛毛雨"],
  [61, 65, "雨"], [66, 67, "冻雨"], [71, 75, "雪"], [77, 77, "雪粒"],
  [80, 82, "阵雨"], [85, 86, "阵雪"], [95, 95, "雷暴"], [96, 99, "雷暴伴冰雹"],
];

const CN_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

function chineseDay(day) {
  if (day <= 0 || day > 31) return String(day);
  if (day <= 10) return day === 10 ? "十" : CN_DIGITS[day];
  if (day < 20) return `十${CN_DIGITS[day - 10]}`;
  if (day === 20) return "二十";
  if (day < 30) return `二十${CN_DIGITS[day - 20]}`;
  if (day === 30) return "三十";
  return `三十${CN_DIGITS[day - 30]}`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function localStamp(date) {
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return {
    text: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
    weekday: weekdays[date.getDay()],
    iso: date.toISOString(),
  };
}

function currentSolarTerm(date) {
  const today = { month: date.getMonth() + 1, day: date.getDate() };
  let current = null;
  for (const [month, day, name] of SOLAR_TERMS) {
    if (month < today.month || (month === today.month && day <= today.day)) {
      current = { name, month, day };
    }
  }
  if (!current) {
    // 1 月 5 日之前仍属上一年的冬至
    current = { name: "冬至", month: 12, day: 22, previousYear: true };
  }
  return current;
}

function lunarInfo(date) {
  try {
    const formatter = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const parts = formatter.formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
    const yearName = get("yearName");
    const month = get("month");
    const day = Number(get("day"));
    const relatedYear = get("relatedYear");
    if (!month || !Number.isFinite(day)) return null;
    return {
      text: `农历${yearName ? `${yearName}年` : ""}${month}${chineseDay(day)}`,
      yearName,
      month,
      day,
      relatedYear,
    };
  } catch {
    return null;
  }
}

function timeItems() {
  const now = new Date();
  const stamp = localStamp(now);
  const term = currentSolarTerm(now);
  const lunar = lunarInfo(now);
  const lunarText = lunar ? lunar.text : "农历信息不可用（系统 Intl 未提供中国历法）";
  const termText = `当前节气：${term.name}（自 ${pad(term.month)}-${pad(term.day)} 起，按常见日期表近似，非天文精确计算）`;

  return {
    items: [
      {
        title: "本机时间",
        summary: `${stamp.text}（${stamp.weekday}），时区 ${Intl.DateTimeFormat().resolvedOptions().timeZone ?? "未知"}`,
        fetchedTs: now.getTime(),
      },
      {
        title: "农历与节气",
        summary: `${lunarText}；${termText}`,
        fetchedTs: now.getTime(),
      },
    ],
    degraded: false,
  };
}

function readWeatherConfig(config) {
  const weather = config.weather && typeof config.weather === "object" ? config.weather : {};
  const latitude = Number(weather.latitude ?? config["weather.latitude"]);
  const longitude = Number(weather.longitude ?? config["weather.longitude"]);
  const timezone = String(weather.timezone ?? config["weather.timezone"] ?? "Asia/Shanghai");
  return { latitude, longitude, timezone };
}

function weatherText(code) {
  for (const [min, max, text] of WMO_TEXT) {
    if (code >= min && code <= max) return text;
  }
  return "未知天气";
}

async function weatherInfo(ctx) {
  const configResult = await ctx.call("kernel.config.get", { keys: CONFIG_KEYS }, { timeoutMs: 5_000 }).catch(() => null);
  const config = configResult && typeof configResult.config === "object" && configResult.config !== null ? configResult.config : {};
  const { latitude, longitude, timezone } = readWeatherConfig(config);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return {
      items: [],
      degraded: true,
      detail: "未配置天气数据源：请在插件配置中填写 weather.latitude / weather.longitude。未配置时不会编造天气。",
    };
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return { items: [], degraded: true, detail: "天气配置的经纬度超出合法范围，已拒绝请求" };
  }

  const url = new URL(WEATHER_ENDPOINT);
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set("current", "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m");
  url.searchParams.set("timezone", timezone);

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(WEATHER_TIMEOUT_MS) });
  } catch (err) {
    const reason = err?.name === "TimeoutError" ? `请求超时（${WEATHER_TIMEOUT_MS}ms）` : `网络不可用（${err?.name ?? "Error"}）`;
    return { items: [], degraded: true, detail: `天气服务不可用：${reason}。不会编造天气数据。` };
  }
  if (!response.ok) {
    return { items: [], degraded: true, detail: `天气服务返回 HTTP ${response.status}，本次不提供天气` };
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return { items: [], degraded: true, detail: "天气服务返回了无法解析的数据，本次不提供天气" };
  }
  const current = payload?.current;
  if (!current || typeof current.temperature_2m !== "number") {
    return { items: [], degraded: true, detail: "天气服务缺少 current 数据，本次不提供天气" };
  }
  const summary = `当前 ${current.temperature_2m}°C，${weatherText(Number(current.weather_code))}，湿度 ${current.relative_humidity_2m ?? "?"}%，风速 ${current.wind_speed_10m ?? "?"} km/h`;
  return {
    items: [{ title: "天气", summary, sourceUrl: "https://open-meteo.com/", fetchedTs: Date.now() }],
    degraded: false,
  };
}

function newsInfo(config) {
  const news = config.news && typeof config.news === "object" ? config.news : {};
  const sourceUrl = news.sourceUrl ?? config["news.sourceUrl"];
  if (!sourceUrl) {
    return {
      items: [],
      degraded: true,
      detail: "未配置新闻源：v0.1 不抓取新闻，也不会编造新闻。",
    };
  }
  return {
    items: [],
    degraded: true,
    detail: "新闻源已配置，但 v0.1 未接入新闻抓取（避免任意 URL 抓取与版权/合规风险）。",
  };
}

const runtime = createPlugin({
  id: "core.world-info",
  capabilities: ["world.info"],
  handlers: {
    "plugin.health.check": async (_params, ctx) => {
      try {
        await ctx.call("kernel.config.get", { keys: CONFIG_KEYS }, { timeoutMs: 3_000 });
        return { ok: true, status: "ok", message: "时间基于本机时钟可用；天气/新闻按配置降级，未配置时不返回数据" };
      } catch (err) {
        return { ok: true, status: "degraded", message: `时间仍可用，但读取配置失败：${err?.message ?? err}` };
      }
    },
    "plugin.world.info": async (params, ctx) => {
      const kind = typeof params?.kind === "string" ? params.kind : "time";
      if (kind === "time") return timeItems();
      if (kind === "weather") return weatherInfo(ctx);
      if (kind === "news") {
        const result = await ctx.call("kernel.config.get", { keys: CONFIG_KEYS }, { timeoutMs: 5_000 }).catch(() => null);
        const config = result && typeof result.config === "object" && result.config !== null ? result.config : {};
        return newsInfo(config);
      }
      throw fail("EINVALID", `不支持的 world.info kind：${kind}`, { hint: "支持 time / weather / news" });
    },
  },
  onReady(_info, ctx) {
    ctx.log("世界信息就绪：时间真实、天气仅 Open-Meteo、新闻不抓取");
  },
});

export const stats = () => runtime.stats();
export const _test = { currentSolarTerm, lunarInfo, chineseDay, weatherText, localStamp };

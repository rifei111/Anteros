/**
 * 契约版本与全局常量。
 *
 * `KERNEL_API` 是插件 manifest 里 `kernel_api` 的比对基准：主版本不匹配拒绝加载
 * （规范 6 §2.2 / §8）。改主版本 = 破坏性变更，必须同时给 migration 说明。
 */
export const APP_NAME = "Anteros";
export const APP_ID = "com.anteros.app";
export const KERNEL_API_VERSION = "1.0";

/** 产品/内核版本（package.json 的 version 由它对齐；健康面板与体检报告用它）。 */
export const KERNEL_VERSION = "0.10.1";

/** 声明文案版本：文案一改就要升级版本号，旧勾选自动失效重勾（草案 14.14.5）。 */
export const CONSENT_DOC_VERSION = "2026-10.1";

/** 内核与客户端、内核与插件之间的命名管道前缀（仅本机、仅当前会话）。 */
export const PIPE_PREFIX = "anteros-kernel";

/** 单帧上限 8MB（规范 6 §5）。 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** 心跳与调用超时默认值（规范 6 §4/§7）。 */
export const DEFAULT_HEARTBEAT_MS = 30_000;
export const DEFAULT_CALL_TIMEOUT_MS = 10_000;
export const CHANNEL_WRITE_TIMEOUT_MS = 90_000;
export const MAX_INFLIGHT_PER_PLUGIN = 8;

/** 危险操作二次确认 token 有效期（规范 1 §2.9 硬约束 1）。 */
export const CONFIRM_TOKEN_TTL_MS = 60_000;

/** 主动动作隔离窗口（规范 1 §3.1）。 */
export const ACTION_QUARANTINE_MS = 800;

/** 数据文件命名，全部落在用户数据目录内，不出本机（草案 14.15）。 */
export const DATA_DIR_NAME = "anteros-data";
export const DB_FILE_NAME = "anteros.sqlite";
export const MEDIA_DIR_NAME = "media";
export const EXPORT_DIR_NAME = "exports";

/**
 * 人格差异参数默认值（规范 1 §2.2）。
 * 冷启动时按先验采样并扰动，之后只以 η≈1e-3 极慢塑形（草案 2.4）。
 */
export const DEFAULT_TRAITS = {
  detailPref: 0.7,
  warmth: 0.6,
  initiative: 0.4,
  humor: 0.3,
  memoryD: 0.5,
  memoryTau: -6.0,
  memoryS: 0.4,
  reconstructRho: 0.15,
  emotionGain: 1.2,
  delayMedianMs: 4200,
  delaySigma: 0.65,
  burstMin: 1,
  burstMax: 3,
  typoRate: 0.02,
  mbti: null,
} as const;

/** 成本上限默认值（元/月）：成本上限是 owner 也不能越过的硬项（草案 2.8）。 */
export const DEFAULT_MONTHLY_BUDGET_CNY = 45;

/** 每关系私有习惯：真实重复 + 用户不反感才准进习惯表（草案 4.6）。 */
export const STYLE_HABIT_MIN_USES = 3;
/**
 * 系统健康 / 一键停用 / 优雅关闭（草案 14.6 合规第七条 + 14.15 单机闭环）。
 *
 * 红线：panic() 只停"对外通道"，App 内对话必须照常可用——所以这里不动 chat 服务，
 * 只把通道插件停掉并把主动打扰置为暂停。
 */
import path from "node:path";
import { KERNEL_API_VERSION, KERNEL_VERSION } from "@anteros/shared";
import type { SystemHealth } from "@anteros/shared";
import type { KernelDeps } from "../contracts.js";
import type { ChannelService } from "./channels.js";
import type { PluginService } from "./plugins.js";

const PROACTIVE_PAUSED_KEY = "system.proactivePaused";

/** 单机闭环必须向用户说清的四条代价（草案 14.15），用人话写。 */
const SINGLE_POINT_RISKS: readonly string[] = [
  "单机单点故障：这台电脑关机、磁盘损坏或系统重装，App 内的记忆与对话就没了——请定期导出备份，并把备份放到另一块磁盘。",
  "没有远程能力：不接任何云服务，AI 生成走你自己填的模型接口；模型服务不可用时，主动打扰和生成会暂停，但本地记忆仍可查看。",
  "没有多端同步：手机、平板、其它电脑看不到这份数据；换机只能靠导出/导入文件搬过去。",
  "通道能力依赖本机环境：外部通道要用本机的应用客户端，窗口被占用、锁屏或客户端升级都可能导致发送失败——失败会标记 unknown 并提示，不会偷偷重试。",
];

export interface SystemServiceParts {
  plugins: PluginService;
  channels: ChannelService;
}

export interface PanicResult {
  ok: boolean;
  message: string;
  disabledPlugins: string[];
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class SystemService {
  private readonly deps: KernelDeps;
  private readonly plugins: PluginService;
  private readonly channels: ChannelService;
  private readonly startedTs: number;
  private readonly dataDirPath: string;

  constructor(deps: KernelDeps, parts: SystemServiceParts) {
    this.deps = deps;
    this.plugins = parts.plugins;
    this.channels = parts.channels;
    this.startedTs = Date.now();
    const fromEnv = process.env.ANTEROS_DATA_DIR;
    this.dataDirPath =
      typeof fromEnv === "string" && fromEnv.trim().length > 0
        ? path.resolve(fromEnv)
        : this.plugins.dataDir;
  }

  // ── 健康 ─────────────────────────────────────────────────────────

  health(): SystemHealth {
    const infos = this.plugins.list();
    const channels = this.channels.list();

    const degraded = infos
      .filter((info) => info.status === "degraded" || info.status === "blocked" || info.status === "crashed")
      .map((info) => ({
        pluginId: info.id,
        reason:
          typeof info.lastError === "string" && info.lastError.length > 0
            ? info.lastError
            : `插件状态为 ${info.status}`,
      }));

    const now = Date.now();
    return {
      ok: degraded.length === 0,
      kernelVersion: KERNEL_VERSION,
      kernelApi: KERNEL_API_VERSION,
      startedTs: this.startedTs,
      uptimeMs: now - this.startedTs,
      dataDir: this.dataDirPath,
      dbPath: this.deps.db.path,
      memoryCount: this.memoryCount(),
      pluginCount: infos.length,
      externalChannelCount: channels.filter((channel) => channel.kind === "external" && channel.enabled).length,
      degraded,
      singlePointRisks: [...SINGLE_POINT_RISKS],
    };
  }

  dataDir(): string {
    return this.dataDirPath;
  }

  // ── 一键停用 ─────────────────────────────────────────────────────

  /**
   * 停掉全部通道类插件（含高危），并把主动打扰置为暂停；App 内对话不受影响。
   */
  async panic(): Promise<PanicResult> {
    let stopped: string[] = [];
    let restored = false;
    let detail = "";
    try {
      const result = await this.channels.panicStop();
      stopped = result.stopped;
      restored = result.restored;
      detail = result.message;
    } catch (error) {
      detail = errorText(error);
      this.deps.log.error(`一键停用失败：${detail}`);
    }

    try {
      this.writeSetting(PROACTIVE_PAUSED_KEY, "true");
    } catch (error) {
      this.deps.log.warn(`暂停主动打扰失败：${errorText(error)}`);
    }

    const parts: string[] = [];
    parts.push(stopped.length === 0 ? "没有正在运行的外部通道插件" : `已停用通道插件：${stopped.join("、")}`);
    parts.push(restored ? "通道宿主侧状态已还原" : "部分通道的宿主状态还原未确认，请检查对应客户端窗口");
    parts.push("App 内对话仍然可用；主动打扰已暂停");
    if (detail.length > 0) parts.push(detail);

    return { ok: true, message: parts.join("；"), disabledPlugins: stopped };
  }

  // ── 关闭 ─────────────────────────────────────────────────────────

  /** 优雅关闭：停止轮询、停插件、checkpoint；数据库由 app 层关闭。 */
  async shutdown(): Promise<void> {
    try {
      this.channels.stop();
      await this.plugins.shutdown();
    } catch (error) {
      this.deps.log.warn(`关闭插件宿主时出错：${errorText(error)}`);
    }
    try {
      this.deps.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (error) {
      this.deps.log.warn(`关闭前 checkpoint WAL 失败：${errorText(error)}`);
    }
  }

  // ── 内部 ─────────────────────────────────────────────────────────

  private memoryCount(): number {
    let total = 0;
    for (const table of ["memory_episodic", "memory_semantic", "memory_open_loops"]) {
      try {
        const row = this.deps.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"`);
        if (row && typeof row.n === "number") total += row.n;
      } catch {
        // 表不存在（未跑迁移）时忽略。
      }
    }
    return total;
  }

  private writeSetting(key: string, value: string): void {
    this.deps.db.run(
      "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
  }
}

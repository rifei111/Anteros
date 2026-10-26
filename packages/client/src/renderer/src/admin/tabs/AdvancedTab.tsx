import { useMemo, useState } from "react";
import { useConfirm } from "../../components/Modal";
import { formatDateTime, formatClock } from "../../lib/format";
import { invoke } from "../../lib/kernel";
import { clearLogs, pushToast, useAppState } from "../../lib/store";
import { LoadingLine, Section, reportError, useLoad } from "../helpers";

const ROLE_LABEL: Record<string, string> = {
  owner: "owner",
  member: "member",
  operator: "operator",
  system: "system",
};

function uptime(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} 小时 ${minutes} 分` : `${minutes} 分`;
}

function shortJson(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 80)}…` : value;
  try {
    const text = JSON.stringify(value);
    return text.length > 100 ? `${text.slice(0, 100)}…` : text;
  } catch {
    return "（无法显示）";
  }
}

const LEVEL_FILTERS: ReadonlyArray<{ id: "all" | "warn" | "error"; label: string }> = [
  { id: "all", label: "全部" },
  { id: "warn", label: "警告及以上" },
  { id: "error", label: "仅错误" },
];

/**
 * 高级面板：健康检查、审计日志、滚动日志、一键停用系统。
 * 日志只在这里，永远不进聊天气泡。
 */
export function AdvancedTab() {
  const state = useAppState();
  const confirm = useConfirm();
  const health = useLoad(() => invoke("system.health", {}), []);
  const audit = useLoad(() => invoke("audit.list", { limit: 50 }), []);
  const [level, setLevel] = useState<"all" | "warn" | "error">("all");
  const [busy, setBusy] = useState(false);

  const logs = useMemo(() => {
    const filtered = state.logs.filter((line) => {
      if (level === "all") return true;
      if (level === "warn") return line.level === "warn" || line.level === "error";
      return line.level === "error";
    });
    return filtered.slice(-200).reverse();
  }, [state.logs, level]);

  const panic = async (): Promise<void> => {
    const agreed = await confirm.ask({
      title: "停用所有插件与通道？",
      body: (
        <div>
          <p>会关闭所有插件与外部通道，留下本机聊天与管理面板。用于出问题时快速止血。</p>
          <p className="danger-text">这个操作会写审计日志；之后可以逐个重新启用。</p>
        </div>
      ),
      confirmLabel: "一键停用",
      danger: true,
    });
    if (!agreed) return;
    setBusy(true);
    try {
      const result = await invoke("system.panic", {});
      pushToast(
        "success",
        result.ok ? "已停用" : "停用未完成",
        `${result.message}${result.disabledPlugins.length > 0 ? ` 已停用 ${result.disabledPlugins.length} 个插件。` : ""}`,
      );
      health.reload();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const h = health.data;

  return (
    <div className="panel-stack">
      {confirm.node}

      <Section
        title="系统健康"
        hint="状态全部来自内核自检，不美化。"
        action={
          <button className="btn btn-ghost" onClick={() => health.reload()}>
            刷新
          </button>
        }
      >
        <LoadingLine loading={health.loading} error={health.error} />
        {h ? (
          <>
            <dl className="kv-grid">
              <dt>整体</dt>
              <dd>
                <span className={`badge ${h.ok ? "badge-ok" : "badge-warn"}`}>{h.ok ? "正常" : "有降级"}</span>
              </dd>
              <dt>内核</dt>
              <dd className="mono">
                v{h.kernelVersion} · KernelApi {h.kernelApi}
              </dd>
              <dt>运行时长</dt>
              <dd>{uptime(h.uptimeMs)}</dd>
              <dt>启动时间</dt>
              <dd>{formatDateTime(h.startedTs)}</dd>
              <dt>数据目录</dt>
              <dd className="mono">{h.dataDir}</dd>
              <dt>数据库</dt>
              <dd className="mono">{h.dbPath}</dd>
              <dt>记忆条数</dt>
              <dd>{h.memoryCount}</dd>
              <dt>插件数</dt>
              <dd>{h.pluginCount}</dd>
              <dt>外部通道数</dt>
              <dd>{h.externalChannelCount}</dd>
            </dl>
            {h.degraded.length > 0 ? (
              <div className="inline-error">
                降级：
                {h.degraded.map((entry) => `${entry.pluginId}（${entry.reason}）`).join("；")}
              </div>
            ) : null}
            {h.singlePointRisks.length > 0 ? (
              <>
                <h4 className="sub-title">单点风险</h4>
                <ul className="bullet-list danger-list">
                  {h.singlePointRisks.map((risk) => (
                    <li key={risk}>{risk}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        ) : null}
      </Section>

      <Section title="兜底：一键停用" hint="出问题时先把它的手拿开，再来查日志。">
        <div className="danger-box">
          <p className="prose">停用所有插件与外部通道；本机记忆和聊天记录保留。</p>
          <button className="btn btn-danger" onClick={() => void panic()} disabled={busy}>
            {busy ? "正在停用…" : "一键停用所有插件与通道"}
          </button>
        </div>
      </Section>

      <Section
        title="审计日志"
        hint="谁在什么时候改了什么，只追加不删除。"
        action={<button className="btn btn-ghost" onClick={() => audit.reload()}>刷新</button>}
      >
        <LoadingLine loading={audit.loading} error={audit.error} />
        {audit.data && audit.data.length > 0 ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>角色</th>
                <th>动作</th>
                <th>对象</th>
                <th>变更</th>
              </tr>
            </thead>
            <tbody>
              {audit.data.map((entry) => (
                <tr key={entry.id}>
                  <td className="mono">{formatDateTime(entry.ts)}</td>
                  <td>{ROLE_LABEL[entry.actorRole] ?? entry.actorRole}</td>
                  <td className="mono">{entry.action}</td>
                  <td>{entry.targetAgentId === null ? "—" : `#${entry.targetAgentId}`}</td>
                  <td className="mono muted">
                    {shortJson(entry.before)} → {shortJson(entry.after)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-note">还没有审计记录。</div>
        )}
      </Section>

      <Section
        title="内核日志"
        hint="滚动日志，最多保留 400 行；只在这里，不进聊天气泡。"
        action={
          <div className="row-actions">
            <select
              className="input select"
              value={level}
              onChange={(event) => setLevel(event.target.value as "all" | "warn" | "error")}
              aria-label="日志级别筛选"
            >
              {LEVEL_FILTERS.map((filter) => (
                <option key={filter.id} value={filter.id}>
                  {filter.label}
                </option>
              ))}
            </select>
            <button className="btn btn-ghost" onClick={() => clearLogs()}>
              清空
            </button>
          </div>
        }
      >
        {logs.length > 0 ? (
          <ul className="log-list">
            {logs.map((line, index) => (
              <li key={`${line.ts}-${index}`} className={`log-line log-${line.level}`}>
                <span className="log-time mono">{formatClock(line.ts)}</span>
                <span className="log-source mono">{line.source}</span>
                <span className="log-message">{line.message}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty-note">还没有日志。</div>
        )}
      </Section>
    </div>
  );
}

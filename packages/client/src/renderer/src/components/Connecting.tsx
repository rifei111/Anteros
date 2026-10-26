import { useAppState } from "../lib/store";

/**
 * 启动/连接态。
 * 只有主进程真实报告「已连上内核」才会往下走；这里永远不假装在线，
 * 失败原因（缺产物、退出码、管道错误）原样显示。
 */
export function Connecting() {
  const state = useAppState();
  const { connection, bootError, booting, kernelVersion, dataDir } = state;

  return (
    <div className="center-screen">
      <div className="center-card">
        <div className="brand-mark">A</div>
        <h1 className="brand-title">Anteros</h1>
        <p className="brand-sub">拟人智能体 · Windows 主客户端</p>

        {!connection.connected ? (
          <div className="boot-state">
            <div className="spinner" aria-hidden="true" />
            <div className="boot-message">{connection.message || "正在启动内核…"}</div>
            <div className="boot-hint">
              {booting
                ? "正在握手…"
                : "内核是本机独立进程；如果长时间停在这里，请检查是否已构建 packages/kernel/dist/kernel.mjs。"}
            </div>
            {bootError ? <div className="boot-error">{bootError}</div> : null}
            <button className="btn" onClick={() => globalThis.location.reload()}>
              重新尝试
            </button>
          </div>
        ) : (
          <div className="boot-state">
            <div className="boot-message">内核已连接</div>
            <div className="boot-hint">
              {kernelVersion ? `内核版本 ${kernelVersion}` : ""}
              {dataDir ? ` · 数据目录 ${dataDir}` : ""}
            </div>
            {bootError ? <div className="boot-error">{bootError}</div> : null}
          </div>
        )}

        <div className="center-foot">
          <span>v{state.appVersion}</span>
          <span>记忆与人格只存在这台电脑上</span>
        </div>
      </div>
    </div>
  );
}

import type { ChannelInfo } from "@anteros/shared";
import { useState } from "react";
import { useConfirm } from "../../components/Modal";
import { invoke } from "../../lib/kernel";
import { PLUGIN_STATUS_LABEL, labelOf } from "../../lib/labels";
import { pushToast } from "../../lib/store";
import { LoadingLine, Section, reportError, requestToken, useLoad } from "../helpers";

function channelRiskLabel(risk: ChannelInfo["capabilities"]["riskLevel"]): string {
  switch (risk) {
    case "none":
      return "无风险";
    case "gray":
      return "灰色地带";
    case "red":
      return "红色风险";
  }
}

function channelRiskClass(risk: ChannelInfo["capabilities"]["riskLevel"]): string {
  switch (risk) {
    case "none":
      return "badge badge-ok";
    case "gray":
      return "badge badge-warn";
    case "red":
      return "badge badge-danger";
  }
}

/**
 * 通道面板：只显示真实能力与宿主占用。
 * 红按钮「立即停用全部通道并还原」是兜底：一键把它的手从外部通道上拿开。
 */
export function ChannelsTab() {
  const loaded = useLoad(() => invoke("channels.list", {}), []);
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const channels = loaded.data ?? [];
  const externalCount = channels.filter((channel) => channel.kind === "external").length;

  const panicStop = async (): Promise<void> => {
    if (busy) return;
    const agreed = await confirm.ask({
      title: "立即停用全部通道并还原？",
      body: (
        <div>
          <p>会立刻停掉全部外部通道，并尝试还原宿主客户端的状态（草稿、租约、未发出的输入）。</p>
          <p className="danger-text">本机会话不受影响；停用后可以在这里重新启用。</p>
        </div>
      ),
      confirmLabel: "立即停用并还原",
      danger: true,
    });
    if (!agreed) return;
    setBusy(true);
    try {
      const token = await requestToken("channels.panicStop");
      const result = await invoke("channels.panicStop", { confirmToken: token });
      pushToast(
        result.restored ? "success" : "warn",
        result.restored ? "已停用并还原" : "已停用（还原未完成）",
        `${result.message}${result.stopped.length > 0 ? ` 停用：${result.stopped.join("、")}` : ""}`,
      );
      loaded.reload();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel-stack">
      {confirm.node}

      <Section
        title="外部通道"
        hint={`共 ${channels.length} 个通道，其中外部通道 ${externalCount} 个。通道是它接触外界的手，能力以真实宿主为准。`}
        action={
          <button className="btn btn-ghost" onClick={() => loaded.reload()}>
            刷新
          </button>
        }
      >
        <LoadingLine loading={loaded.loading} error={loaded.error} />
        <div className="card-grid">
          {channels.map((channel) => {
            const caps = channel.capabilities;
            return (
              <article key={`${channel.kind}:${channel.pluginId}`} className="card">
                <header className="card-head">
                  <div>
                    <div className="card-title">{channel.displayName}</div>
                    <div className="card-sub mono">
                      {channel.pluginId} · {channel.kind === "app" ? "本机会话" : "外部通道"}
                    </div>
                  </div>
                  <span className="badge badge-muted">{labelOf(PLUGIN_STATUS_LABEL, channel.status)}</span>
                </header>
                <dl className="kv-grid compact">
                  <dt>写路径就绪</dt>
                  <dd>{channel.writeReady ? "是" : "否"}</dd>
                  <dt>读可回填</dt>
                  <dd>{caps.readCanBackfill ? "可以（只读历史会补进记忆）" : "不可以"}</dd>
                  <dt>写确定性</dt>
                  <dd>{caps.writeIsDeterministic ? "确定（发出去就是发出去）" : "不确定（可能失败或重复）"}</dd>
                  <dt>真实 typing</dt>
                  <dd>{caps.typingIsReal ? "有真实输入状态" : "没有——所以不会假装正在输入"}</dd>
                  <dt>可撤回</dt>
                  <dd>{caps.canRecall ? "可以" : "不可以"}</dd>
                  <dt>宿主占用</dt>
                  <dd>{caps.hostOccupancyMs > 0 ? `${caps.hostOccupancyMs} ms/次` : "无"}</dd>
                  <dt>风险</dt>
                  <dd>
                    <span className={channelRiskClass(caps.riskLevel)}>{channelRiskLabel(caps.riskLevel)}</span>
                  </dd>
                </dl>
                {channel.health && !channel.health.ok ? (
                  <p className="danger-text">健康检查：{channel.health.message}</p>
                ) : (
                  <p className="muted">健康检查通过。</p>
                )}
              </article>
            );
          })}
        </div>
        {channels.length === 0 && !loaded.loading ? (
          <div className="empty-note">没有启用任何通道：它现在只能在这台电脑上和你说话。</div>
        ) : null}
      </Section>

      <Section title="一键停用（兜底）" hint="任何时候都能把它的手拿开。会写审计日志。">
        <div className="danger-box">
          <p className="prose">
            停用全部外部通道，并尝试还原宿主状态。之后它只会留在本机聊天框里，不会再去碰任何外部客户端。
          </p>
          <button className="btn btn-danger btn-lg" onClick={() => void panicStop()} disabled={busy}>
            {busy ? "正在停用…" : "立即停用全部通道并还原"}
          </button>
        </div>
        <ul className="bullet-list muted">
          <li>停用是即时的：正在进行的写操作会被取消，不会补发。</li>
          <li>还原失败会如实告诉你哪一步没成功，不会假装还原了。</li>
          <li>「灰色地带」的通道按风险提示，不推荐随手启用。</li>
        </ul>
      </Section>
    </div>
  );
}

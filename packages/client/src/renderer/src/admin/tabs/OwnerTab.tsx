import { useState } from "react";
import { humanizeError } from "../../lib/errors";
import { formatDateTime } from "../../lib/format";
import { invoke, revealFile } from "../../lib/kernel";
import { pushToast, useAppState } from "../../lib/store";
import { LoadingLine, Section, reportError, useLoad } from "../helpers";

const ROLE_LABEL: Record<string, string> = {
  owner: "owner（本机所有者）",
  member: "member（普通使用者）",
  operator: "operator（运维）",
};

/**
 * Owner 面板：只显示真实身份与真实路径。
 * owner 入口只存在于这台 Windows 客户端；这里没有「转让 owner」「云同步」之类的假选项。
 */
export function OwnerTab() {
  const state = useAppState();
  const owner = useLoad(() => invoke("owner.status", {}), []);
  const dirs = useLoad(() => invoke("system.dataDir", {}), []);
  const [busy, setBusy] = useState(false);

  const openDataDir = async (): Promise<void> => {
    try {
      const result = await invoke("system.dataDir", {});
      await revealFile(result.dbPath);
    } catch (error) {
      reportError(error);
    }
  };

  const exportBundle = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await invoke("export.bundle", {});
      pushToast("success", "已导出数据包", result.path);
      await revealFile(result.path);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const status = owner.data;
  const paths = dirs.data;

  return (
    <div className="panel-stack">
      <LoadingLine loading={owner.loading || dirs.loading} error={owner.error ?? dirs.error} />

      <Section title="身份" hint="身份来自本机内核，不来自网络。">
        <dl className="kv-grid">
          <dt>是否 owner</dt>
          <dd>{status ? (status.isOwner ? "是（本机所有者）" : "否") : "—"}</dd>
          <dt>角色</dt>
          <dd>{status ? (ROLE_LABEL[status.role] ?? status.role) : "—"}</dd>
          <dt>owner 账号是否已配置</dt>
          <dd>
            {status
              ? status.ownerWechatConfigured
                ? "已配置（构建期写入，界面不回显）"
                : "未配置（以本机 owner 身份运行）"
              : "—"}
          </dd>
          <dt>数据目录</dt>
          <dd className="mono">{paths?.path ?? state.dataDir ?? "—"}</dd>
          <dt>数据库</dt>
          <dd className="mono">{paths?.dbPath ?? "—"}</dd>
        </dl>
        <div className="row-actions">
          <button className="btn" onClick={() => void openDataDir()}>
            打开数据目录
          </button>
          <button className="btn" onClick={() => void exportBundle()} disabled={busy}>
            {busy ? "正在导出…" : "导出数据包"}
          </button>
          <button className="btn btn-ghost" onClick={() => { owner.reload(); dirs.reload(); }}>
            重新读取
          </button>
        </div>
      </Section>

      <Section title="owner 能做什么" hint="危险操作仍要二次确认，并写入审计日志。">
        <ul className="bullet-list">
          <li>启停插件、逐项授权能力（高危插件要二次确认 + 一次性 token）</li>
          <li>配置模型与月度预算；超出预算会硬拦截</li>
          <li>删除单条记忆 / 清空全部记忆（清空要 token）</li>
          <li>切换关系阶段与完全体模式；随时关闭完全体</li>
          <li>停用全部外部通道并还原宿主状态</li>
        </ul>
      </Section>

      <Section title="owner 也不能越过" hint="这四条不是权限问题，是产品红线。">
        <ul className="bullet-list danger-list">
          <li>安全危机处置：不做心理危机干预，也不扮演专业帮助</li>
          <li>法律与平台红线：不绕过风控、不做违规内容</li>
          <li>第三方隐私：不抓取、不推断与你无关的人</li>
          <li>未通过声明闸（九条）之前的任何使用</li>
        </ul>
      </Section>

      <Section title="本机专属" hint="不做多端同步，换机不迁移。">
        <p className="prose">
          owner 入口只存在于这台 Windows 主客户端。人格、记忆、密钥、成本记录都在本机数据目录里；
          内核是独立子进程，客户端崩溃重启不丢数据，但换一台电脑就是新的它。
        </p>
        {state.connection.kernelVersion ? (
          <p className="prose muted">
            当前内核 {state.connection.kernelVersion} · 客户端 v{state.appVersion} · 连接于
            {paths ? ` ${formatDateTime(Date.now())}` : " 未知"}
          </p>
        ) : null}
      </Section>
    </div>
  );
}

/** 供其它面板复用：读取并展示错误，避免每处都写 try/catch。 */
export function logUiError(error: unknown): void {
  const human = humanizeError(error);
  pushToast("error", human.title, human.hint);
}

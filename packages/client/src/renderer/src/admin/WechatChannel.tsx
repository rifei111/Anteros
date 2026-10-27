import type { WechatChannelStatus } from "@anteros/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useConfirm } from "../components/Modal";
import { invoke } from "../lib/kernel";
import { formatDateTime } from "../lib/format";
import { pushToast } from "../lib/store";
import { LoadingLine, Section, reportError, useLoad } from "./helpers";

const RISKS = [
  "它会读取本机微信数据库（只读，但确实是你的聊天数据）",
  "它会驱动微信界面代替我点按发送，发送时不要动鼠标键盘",
  "这类自动化可能违反微信使用条款，存在账号被限制的风险",
  "我只授权它跟白名单里的这一个会话通讯",
  "我随时可以关闭；关闭会立刻杀掉 Python 子进程",
];

const STATE_TEXT: Record<WechatChannelStatus["state"], string> = {
  off: "已关闭",
  starting: "正在启动",
  ready: "已就绪",
  degraded: "降级运行",
  blocked: "被阻断",
  error: "出错",
};

function stateClass(state: WechatChannelStatus["state"]): string {
  if (state === "ready") return "badge badge-ok";
  if (state === "starting") return "badge badge-warn";
  if (state === "off") return "badge badge-muted";
  return "badge badge-danger";
}

function checkClass(state: "ok" | "warn" | "fail"): string {
  if (state === "ok") return "badge badge-ok";
  if (state === "warn") return "badge badge-warn";
  return "badge badge-danger";
}

function checkText(state: "ok" | "warn" | "fail"): string {
  if (state === "ok") return "就绪";
  if (state === "warn") return "注意";
  return "缺东西";
}

/**
 * 内置微信通道面板（软件本体能力，不是插件）。
 *
 * 这块面板只在管理面板里出现，默认是关的：用户必须逐条勾完五条风险确认才能开启。
 * 开启后它读本机微信数据库、驱动微信界面发消息，只跟一个白名单会话说话。
 */
export function WechatChannelPanel() {
  const loaded = useLoad(() => invoke("channels.wechat.status", {}), []);
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [riskOpen, setRiskOpen] = useState(false);
  const [riskChecked, setRiskChecked] = useState<boolean[]>(() => RISKS.map(() => false));
  const [chatInput, setChatInput] = useState("");
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [doctorText, setDoctorText] = useState("");
  const [localLog, setLocalLog] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement | null>(null);

  const status = loaded.data ?? null;

  useEffect(() => {
    if (status && chatInput.length === 0) setChatInput(status.chatUsername);
  }, [status?.chatUsername]);

  // 安装依赖时内核会推 event.wechat.log；这里跟着刷新状态，日志跟着 installLog 走
  useEffect(() => {
    if (!status?.installing) return;
    const timer = setInterval(() => {
      void invoke("channels.wechat.status", {})
        .then((next) => {
          loaded.setData(next);
          setLocalLog(next.installLog);
        })
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [status?.installing]);

  useEffect(() => {
    if (localLog.length === 0 && status?.installLog) setLocalLog(status.installLog);
  }, [status?.installLog?.length]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [localLog.length]);

  const logLines = useMemo(() => localLog.slice(-200), [localLog]);
  const pythonMissing = useMemo(
    () => (status?.checks ?? []).some((check) => check.id === "python" && check.state === "fail"),
    [status?.checks],
  );
  const allRiskChecked = riskChecked.every(Boolean);

  const run = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    if (busy) return;
    setBusy(label);
    try {
      await action();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  };

  const installDeps = (): void => {
    setLocalLog([]);
    void run("install", async () => {
      const next = await invoke("channels.wechat.installDeps", {});
      loaded.setData(next);
      setLocalLog(next.installLog);
      pushToast(
        next.checks.some((check) => check.id === "wechatauto" && check.state === "ok") ? "success" : "warn",
        "依赖安装结束",
        "看下面的日志确认有没有报错；装完点「重新体检」再开通道。",
      );
    });
  };

  // 一键下载运行环境：便携版 Python + pip + wechatauto-replica，全落在数据目录里，不动系统
  const installRuntime = (): void => {
    setLocalLog([]);
    void run("runtime", async () => {
      const next = await invoke("channels.wechat.installRuntime", {});
      loaded.setData(next);
      setLocalLog(next.installLog);
      const ready = next.checks.every((check) => check.state !== "fail");
      pushToast(
        ready ? "success" : "warn",
        ready ? "运行环境已就绪" : "运行环境没装完",
        ready
          ? "Python 与 wechatauto 都在这台电脑的 Anteros 数据目录里，不占系统环境；现在可以直接开启通道。"
          : (next.lastError ?? "看日志最后几行，多半是网络被拦。"),
      );
    });
  };

  const enable = (): void => {
    void run("enable", async () => {
      const next = await invoke("channels.wechat.enable", { ackRisk: true, chatUsername: chatInput.trim() || undefined });
      loaded.setData(next);
      setRiskOpen(false);
      setRiskChecked(RISKS.map(() => false));
      if (next.running) {
        pushToast("success", "微信通道已开启", `现在只跟「${next.chatTitle ?? next.chatUsername}」说话。`);
      } else {
        pushToast("warn", "通道没跑起来", next.lastError ?? "看体检项里哪一项没过。");
      }
    });
  };

  const disable = async (): Promise<void> => {
    const agreed = await confirm.ask({
      title: "关闭微信通道？",
      body: (
        <div>
          <p>关闭会立刻杀掉 Python 子进程，之后它不会再读微信、也不会再往外发。</p>
          <p className="muted">只停通道，不删你的聊天记录，也不动 Anteros 的记忆。</p>
        </div>
      ),
      confirmLabel: "关闭通道",
      danger: true,
    });
    if (!agreed) return;
    void run("disable", async () => {
      const next = await invoke("channels.wechat.disable", {});
      loaded.setData(next);
      pushToast("success", "已关闭", "Python 子进程已经停了。");
    });
  };

  const saveChat = (): void => {
    void run("setChat", async () => {
      const next = await invoke("channels.wechat.setChat", { chatUsername: chatInput.trim() });
      loaded.setData(next);
      pushToast("success", "会话已保存", `现在只跟「${next.chatTitle ?? next.chatUsername}」说话。`);
    });
  };

  const doctor = (action: "diagnose-keys" | "dump-account"): void => {
    void run("doctor", async () => {
      const result = await invoke("channels.wechat.doctor", { action });
      setDoctorOpen(true);
      setDoctorText(result.output);
    });
  };

  const copyDoctor = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(doctorText);
      pushToast("success", "已复制", "可以直接贴给我看。");
    } catch {
      pushToast("warn", "复制失败", "手动选中文本复制吧。");
    }
  };

  return (
    <Section
      title="微信（内置通道）"
      hint="这是软件本体的一条通道，不是插件：默认关闭，开启后会读本机微信数据、驱动微信界面发消息。"
      action={
        <div className="row-gap">
          <span className={stateClass(status?.state ?? "off")}>{STATE_TEXT[status?.state ?? "off"]}</span>
          <button
            className="btn btn-ghost"
            onClick={() => loaded.reload()}
            disabled={busy !== null}
          >
            重新体检
          </button>
        </div>
      }
    >
      {confirm.node}
      <LoadingLine loading={loaded.loading} error={loaded.error} />

      {status ? (
        <div className="wechat-panel">
          <div className="wechat-head">
            <div>
              <div className="wechat-line">
                <strong>{status.running ? "正在运行" : status.enabled ? "已开启但没跑起来" : "未开启"}</strong>
                {status.account ? <span className="muted">账号 {status.account.nickname ?? status.account.wxid}</span> : null}
                {status.chatTitle ?? status.chatUsername ? (
                  <span className="muted">只跟「{status.chatTitle ?? status.chatUsername}」说话</span>
                ) : null}
              </div>
              <div className="wechat-line muted">
                {status.pythonPath ? `Python：${status.pythonPath}` : "还没找到 64 位 Python"}
                {status.sidecarVersion ? ` · sidecar ${status.sidecarVersion}` : ""}
                {status.wechatautoVersion ? ` · wechatauto ${status.wechatautoVersion}` : " · wechatauto 未安装"}
                {status.lastCheckTs ? ` · 上次体检 ${formatDateTime(status.lastCheckTs)}` : ""}
              </div>
            </div>
            <div className="row-gap">
              <span className={status.canRead ? "badge badge-ok" : "badge badge-muted"}>
                读 {status.canRead ? "就绪" : "未就绪"}
              </span>
              <span className={status.canSend ? "badge badge-ok" : "badge badge-muted"}>
                发 {status.canSend ? "就绪" : "未就绪"}
              </span>
              {(status.inboundCount > 0 || status.outboundCount > 0) && (
                <span className="badge badge-muted">
                  收 {status.inboundCount} · 发 {status.outboundCount}
                </span>
              )}
            </div>
          </div>

          {pythonMissing ? (
            <div className="wechat-block">
              <div className="wechat-block-title">先准备运行环境</div>
              <p>
                点下面这个按钮，Anteros 自己下载一份便携版 Python 到数据目录，再用它装
                wechatauto-replica。<strong>不装系统 Python、不改 PATH、不写注册表</strong>，卸载时删目录即可。
              </p>
              <div className="row-gap">
                <button className="btn btn-primary" onClick={installRuntime} disabled={busy !== null || status.installing}>
                  {status.installing ? "正在下载并安装…" : "一键下载运行环境"}
                </button>
                <span className="muted small">约 11MB Python + 100~200MB 依赖，看网速</span>
              </div>
              <p className="muted small">
                也可以自己装：64 位 Python 3.10+ 并勾选 <code>Add python.exe to PATH</code>，然后重新体检。
                <button
                  className="btn btn-link"
                  onClick={() => void window.open("https://www.python.org/downloads/windows/", "_blank")}
                >
                  打开下载页
                </button>
              </p>
              <p className="muted small">另外还需要：装微信 4.x 桌面版并先登录（通道要读它的数据库、驱动它的界面）。</p>
            </div>
          ) : null}

          <div className="wechat-checks">
            {(status.checks ?? []).map((check) => (
              <div key={check.id} className="wechat-check">
                <span className={checkClass(check.state)}>{checkText(check.state)}</span>
                <div>
                  <div className="wechat-check-label">{check.label}</div>
                  <div className="muted small">{check.message}</div>
                  {check.hint ? <div className="muted small">怎么办：{check.hint}</div> : null}
                </div>
              </div>
            ))}
          </div>

          {status.lastError ? <p className="danger-text">上次失败：{status.lastError}</p> : null}

          <div className="wechat-actions">
            <button className="btn" onClick={installDeps} disabled={busy !== null || status.installing}>
              {status.installing ? "正在安装依赖…" : "安装运行依赖"}
            </button>
            <button className="btn btn-ghost" onClick={installRuntime} disabled={busy !== null || status.installing}>
              下载运行环境
            </button>
            {status.enabled ? (
              <button className="btn btn-danger" onClick={() => void disable()} disabled={busy !== null}>
                关闭通道
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => setRiskOpen(true)} disabled={busy !== null}>
                开启微信通道
              </button>
            )}
            <button
              className="btn btn-ghost"
              onClick={() => setDoctorOpen((open) => !open)}
              disabled={!status.running}
            >
              {doctorOpen ? "收起诊断" : "诊断"}
            </button>
          </div>

          {localLog.length > 0 || status.installing ? (
            <div className="wechat-install-log mono" ref={logRef}>
              {logLines.length === 0 ? <div className="muted">等 pip 输出…</div> : null}
              {logLines.map((line, index) => (
                <div key={`${index}-${line.slice(0, 12)}`}>{line}</div>
              ))}
            </div>
          ) : null}

          <div className="wechat-chat-row">
            <label className="field-label">只跟这一个会话说话</label>
            <div className="row-gap">
              <input
                className="input"
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                placeholder="filehelper（文件传输助手）或 wxid_…"
              />
              <button className="btn btn-ghost" onClick={saveChat} disabled={busy !== null || chatInput.trim().length === 0}>
                保存
              </button>
            </div>
            <p className="muted small">
              默认 <code>filehelper</code> 是「文件传输助手」——最安全：既不会发错人，也能看到它发出来的东西。
            </p>
          </div>

          {doctorOpen ? (
            <div className="wechat-block">
              <div className="wechat-block-title">诊断</div>
              <div className="row-gap">
                <button className="btn btn-ghost" onClick={() => doctor("diagnose-keys")} disabled={busy !== null}>
                  导出诊断信息
                </button>
                <button className="btn btn-ghost" onClick={() => doctor("dump-account")} disabled={busy !== null}>
                  导出账号信息
                </button>
                <button className="btn btn-ghost" onClick={() => void copyDoctor()} disabled={doctorText.length === 0}>
                  复制
                </button>
              </div>
              <textarea className="wechat-doctor mono" readOnly value={doctorText} rows={12} placeholder="点上面两个按钮拿诊断信息" />
            </div>
          ) : null}
        </div>
      ) : null}

      {riskOpen ? (
        <div className="wechat-block risk-box">
          <div className="wechat-block-title">开启之前，请逐条确认</div>
          <div className="risk-list">
            {RISKS.map((risk, index) => (
              <label key={risk} className="risk-item">
                <input
                  type="checkbox"
                  className="risk-checkbox"
                  checked={riskChecked[index] ?? false}
                  onChange={(event) => {
                    const next = [...riskChecked];
                    next[index] = event.target.checked;
                    setRiskChecked(next);
                  }}
                />
                <span>{risk}</span>
              </label>
            ))}
          </div>
          <div className="row-gap">
            <button
              className="btn btn-primary"
              onClick={enable}
              disabled={!allRiskChecked || busy !== null}
            >
              {busy === "enable" ? "正在开启…" : "确认开启"}
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                setRiskOpen(false);
                setRiskChecked(RISKS.map(() => false));
              }}
              disabled={busy !== null}
            >
              我先不开
            </button>
          </div>
          <p className="muted small">
            五条都勾上才能开。Anteros 不做注入、不做内存改写、不做协议逆向：这里用的是第三方开源库
            wechatauto-replica 自己公开的接口。
          </p>
        </div>
      ) : null}
    </Section>
  );
}
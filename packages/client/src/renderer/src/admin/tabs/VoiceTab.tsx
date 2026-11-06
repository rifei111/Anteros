/**
 * 「声音」面板：语音能不能用、用谁说、说什么声音，全在这一栏里配完。
 *
 * 以前这些参数只能去「插件」里改一段 JSON，用户根本不知道要填什么（2026-11-02 反馈）。
 * 这里把"生效必须的参数"摊开成控件：供应商、密钥、音色、语速、语气强度，外加一句试听。
 *
 * 三条原则：
 * 1. 密钥永远不回显，只显示「已录入 / 未录入」；保存后立刻重新读插件状态。
 * 2. 音色列表由内核去问供应商（客户端不碰密钥），拉不到就把原因写在下面。
 * 3. 试听走 `media.preview`：不进对话、不占语音档位，但成本照实记账。
 */
import type { VoiceOption } from "@anteros/shared";
import { useEffect, useRef, useState } from "react";
import { invoke } from "../../lib/kernel";
import { pushToast } from "../../lib/store";
import { LoadingLine, Section, reportError, useLoad } from "../helpers";

const MEDIA_PLUGIN_ID = "core.media";
const PROVIDER_LABEL: Record<string, string> = {
  breezeblue: "BreezeBlue（默认，只有合成）",
  openai: "OpenAI 兼容（自建 / 别家）",
};

export function VoiceTab() {
  const status = useLoad(() => invoke("media.status", {}), []);
  const plugins = useLoad(() => invoke("plugins.list", {}), []);
  const soundcard = useLoad(() => invoke("channels.wechat.soundcardStatus", {}), []);
  const [busy, setBusy] = useState(false);
  // 一键装虚拟声卡是独立动作：装的时候只锁这一块，别把整页输入都禁掉。
  const [installing, setInstalling] = useState(false);
  // 下载驱动包与安装分开：先下到数据目录，再由用户点安装（安装要弹 UAC）。
  const [downloading, setDownloading] = useState(false);
  const [installMessage, setInstallMessage] = useState<string>("");
  const [installWarn, setInstallWarn] = useState(false);
  const [voices, setVoices] = useState<VoiceOption[] | null>(null);
  const [voicesMessage, setVoicesMessage] = useState<string>("");
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [breezeKey, setBreezeKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewCost, setPreviewCost] = useState<string>("");
  const [trialText, setTrialText] = useState("嗯，我在。你听得清吗？");
  const urlRef = useRef<string | null>(null);
  // 外部通道（微信那种语音条）的开关与自检：以前这个开关只藏在通道页，
  // 用户在这一页把「语音」开到 always 也发不出语音条，只会看到一句「没开」。
  const [externalVoiceEnabled, setExternalVoiceEnabled] = useState<boolean | null>(null);
  const [externalVoiceReady, setExternalVoiceReady] = useState<boolean>(false);
  const [externalVoiceMessage, setExternalVoiceMessage] = useState<string>("");

  const info = plugins.data?.find((item) => item.id === MEDIA_PLUGIN_ID) ?? null;
  const config = (info?.config ?? {}) as Record<string, unknown>;
  const provider = typeof config.provider === "string" ? config.provider : "breezeblue";
  const currentVoiceId =
    provider === "breezeblue"
      ? (typeof config.breezeVoiceId === "string" ? config.breezeVoiceId : "")
      : (typeof config.voice === "string" ? config.voice : "");

  // 播放用的 blob URL 要自己回收，不然每试听一次漏一块内存。
  useEffect(() => {
    return () => {
      if (urlRef.current !== null) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  // 进来先读一次外部通道的语音条状态（不强制自检，避免每次打开面板都播一遍测试音）
  useEffect(() => {
    void refreshExternalVoice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveConfig = async (patch: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    try {
      await invoke("plugins.config.put", { id: MEDIA_PLUGIN_ID, config: { ...config, ...patch } });
      plugins.reload();
      // 改完参数要让插件重启一次，health 才会按新密钥/新配置重算。
      await invoke("plugins.restart", { id: MEDIA_PLUGIN_ID }).catch(() => null);
      status.reload();
      pushToast("success", "已保存", "插件会重启一次并按新参数重新检测。");
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const saveSecret = async (name: string, value: string, clear: () => void): Promise<void> => {
    if (value.trim() === "") {
      pushToast("warn", "没填内容", "密钥是空的，什么都没保存。");
      return;
    }
    setBusy(true);
    try {
      await invoke("plugins.secret.put", { id: MEDIA_PLUGIN_ID, name, value: value.trim() });
      clear();
      plugins.reload();
      await invoke("plugins.restart", { id: MEDIA_PLUGIN_ID }).catch(() => null);
      status.reload();
      pushToast("success", "密钥已存进本机", "只在这台机器的密钥库里，不会出现在日志和导出里。");
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const loadVoices = async (): Promise<void> => {
    setLoadingVoices(true);
    setVoicesMessage("");
    try {
      const result = await invoke("media.voices", {});
      setVoices(result.voices);
      setVoicesMessage(result.message ?? "");
      if (!result.ok && result.voices.length === 0) pushToast("warn", "没拿到音色列表", result.message ?? "供应商没返回音色。");
    } catch (error) {
      reportError(error);
    } finally {
      setLoadingVoices(false);
    }
  };

  const trial = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await invoke("media.preview", { text: trialText });
      if (!result.ok || result.audioBase64 === undefined) {
        pushToast("error", "试听没成", result.reason ?? "合成失败。");
        return;
      }
      const bytes = Uint8Array.from(atob(result.audioBase64), (char) => char.charCodeAt(0));
      const blob = new Blob([bytes], { type: result.mime ?? "audio/mpeg" });
      if (urlRef.current !== null) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setPreviewUrl(url);
      setPreviewCost(
        `这次约 ¥${(result.costCny ?? 0).toFixed(4)}${result.durMs !== undefined ? ` · ${(result.durMs / 1000).toFixed(1)} 秒` : ""}`,
      );
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  async function refreshExternalVoice(force = false): Promise<void> {
    try {
      const state = await invoke("channels.wechat.status", {});
      setExternalVoiceEnabled(state.voiceOutbound === true);
      setExternalVoiceReady(state.voiceReady === true);
      if (force) {
        const probe = await invoke("channels.wechat.voiceStatus", { force: true });
        setExternalVoiceReady(probe.ok === true);
        setExternalVoiceMessage(probe.message ?? "");
      }
    } catch {
      // 通道没开、或者这台机器没装微信：这一块显示成「不可用」，不报错打断整页
      setExternalVoiceEnabled(false);
      setExternalVoiceReady(false);
    }
  }

  const toggleExternalVoice = async (enabled: boolean): Promise<void> => {
    setBusy(true);
    try {
      const state = await invoke("channels.wechat.setVoiceOutbound", { enabled });
      setExternalVoiceEnabled(state.voiceOutbound === true);
      setExternalVoiceReady(state.voiceReady === true);
      if (enabled) pushToast("success", "外部通道的语音条已开", "下一条回复会发成语音条；合成失败仍会退回发文字。");
      else pushToast("info", "已关掉外部通道语音条", "之后回文字。");
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const downloadSoundcard = async (): Promise<void> => {
    setDownloading(true);
    setInstallMessage("");
    setInstallWarn(false);
    try {
      const result = await invoke("channels.wechat.downloadSoundcard", {});
      setInstallMessage(result.message);
      setInstallWarn(result.ok === false);
      // 下好之后 bundled 会翻成 true：徽章与按钮文案跟着变。
      soundcard.reload();
    } catch (error) {
      reportError(error);
    } finally {
      setDownloading(false);
    }
  };

  const installSoundcard = async (): Promise<void> => {
    setInstalling(true);
    setInstallMessage("");
    setInstallWarn(false);
    try {
      const result = await invoke("channels.wechat.installSoundcard", {});
      setInstallMessage(result.message);
      setInstallWarn(result.ok === false || result.needsAdmin === true);
      // 装完（哪怕要重启）设备表可能已经变了：立刻再问一次，徽章跟着翻。
      soundcard.reload();
    } catch (error) {
      reportError(error);
    } finally {
      setInstalling(false);
    }
  };

  const card = soundcard.data;
  const currentVoiceLabel =
    currentVoiceId === ""
      ? "自动挑（第一次合成时问问供应商）"
      : (voices?.find((item) => item.id === currentVoiceId)?.name ?? currentVoiceId);

  return (
    <div className="panel-stack">
      <LoadingLine loading={status.loading || plugins.loading} error={status.error ?? plugins.error} />

      <Section title="现在能不能出声" hint="这行字来自插件真打一次接口的结果，不是「密钥非空就算就绪」。">
        <div className="voice-mode-row">
          <span className={`badge ${status.data?.speakReady ? "badge-ok" : "badge-warn"}`}>
            {status.data?.speakReady ? "合成可用" : "合成不可用"}
          </span>
          <span className={`badge ${status.data?.listenReady ? "badge-ok" : "badge-warn"}`}>
            {status.data?.listenReady ? "识别可用" : "识别不可用"}
          </span>
          <button className="btn btn-sm btn-ghost" onClick={() => status.reload()} disabled={busy}>
            重新检测
          </button>
        </div>
        <p className="muted">{status.data?.message ?? "还没读到语音状态。"}</p>
        <p className="muted">
          它什么时候开口用语音，在「表达与完全体」里那三档（只用文字 / 看场合 / 能开口就开口）。
        </p>
      </Section>

      <Section
        title="虚拟声卡（微信发语音条的前提）"
        hint="微信只收系统麦克风里的声音，所以要把合成出来的声音送进一块虚拟声卡。"
      >
        <LoadingLine loading={soundcard.loading} error={soundcard.error} />
        <div className="voice-mode-row">
          <span className={`badge ${card?.installed === true ? "badge-ok" : "badge-warn"}`}>
            {card?.installed === true ? "已安装" : "未安装"}
          </span>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => soundcard.reload()}
            disabled={soundcard.loading || installing}
          >
            重新检测
          </button>
        </div>
        {card === null ? null : card.installed ? (
          <>
            {card.playbackDevice !== undefined ? (
              <p className="voice-device">播放端：{card.playbackDevice}</p>
            ) : null}
            {card.captureDevice !== undefined ? (
              <p className="voice-device">录音端：{card.captureDevice}</p>
            ) : null}
          </>
        ) : (
          <>
            <p className="muted">{card.message}</p>
            <div className="voice-mode-row">
              <button
                className="btn btn-sm"
                onClick={() => void downloadSoundcard()}
                disabled={downloading || installing}
              >
                {downloading ? "正在下载…" : "下载驱动包"}
              </button>
              <button
                className="btn btn-sm btn-primary"
                onClick={() => void installSoundcard()}
                disabled={downloading || installing}
              >
                {installing ? "正在安装…" : "一键安装虚拟声卡"}
              </button>
            </div>
            {card.bundled === true ? (
              <p className="muted">这个安装包已经带着驱动包，直接点安装就行，不联网也能装。</p>
            ) : (
              <p className="muted">
                这个安装包没带驱动。点「下载驱动包」会从 vb-audio.com 下（约 1 MB）到本机数据目录，
                下好再点安装；装的时候才需要联管理员权限。
              </p>
            )}
          </>
        )}
        {installMessage !== "" ? (
          <p className={`muted${installWarn ? " warn-text" : ""}`}>{installMessage}</p>
        ) : null}
        <p className="muted">安装会弹一次 Windows 管理员确认窗；装完要重启微信、再重启本应用。</p>
      </Section>

      <Section title="用谁的语音" hint="BreezeBlue 只做合成；识别要另配一个 OpenAI 兼容的服务。">
        <div className="voice-mode-row">
          {(["breezeblue", "openai"] as const).map((id) => (
            <button
              key={id}
              className={`btn btn-sm${provider === id ? " btn-primary" : " btn-ghost"}`}
              disabled={busy}
              onClick={() => void saveConfig({ provider: id })}
            >
              {PROVIDER_LABEL[id]}
            </button>
          ))}
        </div>
      </Section>

      <Section title="密钥" hint="只存本机加密库；界面上永远读不回来，只显示有没有。">
        <div className="voice-field">
          <label>
            BreezeBlue 密钥（breeze.api_key）
            <span className={`badge ${info?.presentSecrets?.includes("breeze.api_key") ? "badge-ok" : "badge-warn"}`}>
              {info?.presentSecrets?.includes("breeze.api_key") ? "已录入" : "未录入"}
            </span>
          </label>
          <div className="voice-inline">
            <input
              type="password"
              placeholder="粘贴 brz_ 开头的密钥"
              value={breezeKey}
              onChange={(event) => setBreezeKey(event.target.value)}
            />
            <button
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={() => void saveSecret("breeze.api_key", breezeKey, () => setBreezeKey(""))}
            >
              保存
            </button>
          </div>
          <p className="muted">BreezeBlue 只有合成，没有识别；它的密钥不能拿来转写。</p>
        </div>

        <div className="voice-field">
          <label>
            OpenAI 兼容密钥（media.api_key，识别用）
            <span className={`badge ${info?.presentSecrets?.includes("media.api_key") ? "badge-ok" : "badge-warn"}`}>
              {info?.presentSecrets?.includes("media.api_key") ? "已录入" : "未录入"}
            </span>
          </label>
          <div className="voice-inline">
            <input
              type="password"
              placeholder="识别服务的密钥"
              value={openaiKey}
              onChange={(event) => setOpenaiKey(event.target.value)}
            />
            <button
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={() => void saveSecret("media.api_key", openaiKey, () => setOpenaiKey(""))}
            >
              保存
            </button>
          </div>
          <p className="muted">要「听得出你说什么」才需要这一项；只让它说话可以不填。</p>
        </div>
      </Section>

      <Section title="音色" hint="这是「生效必须」的那一项：没选音色，BreezeBlue 合成不出来。">
        <div className="voice-mode-row">
          <button className="btn btn-sm" onClick={() => void loadVoices()} disabled={loadingVoices || busy}>
            {loadingVoices ? "正在问供应商…" : "拉取音色列表"}
          </button>
          <span className="muted">当前：{currentVoiceLabel}</span>
        </div>
        {voicesMessage !== "" ? <p className="muted">{voicesMessage}</p> : null}
        {voices !== null && voices.length > 0 ? (
          <div className="voice-mode-row">
            {voices.map((voice) => (
              <button
                key={voice.id}
                className={`btn btn-sm${currentVoiceId === voice.id ? " btn-primary" : " btn-ghost"}`}
                disabled={busy}
                onClick={() =>
                  void saveConfig(provider === "breezeblue" ? { breezeVoiceId: voice.id } : { voice: voice.id })
                }
                title={voice.id}
              >
                {voice.name}
                {voice.language !== undefined ? ` · ${voice.language}` : ""}
              </button>
            ))}
          </div>
        ) : null}
        <div className="voice-inline">
          <input
            placeholder="也可以直接粘 voice_id（voc_ 开头）"
            defaultValue={currentVoiceId}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (value === currentVoiceId) return;
              void saveConfig(provider === "breezeblue" ? { breezeVoiceId: value } : { voice: value });
            }}
          />
          <button
            className="btn btn-sm btn-ghost"
            disabled={busy}
            onClick={() => void saveConfig(provider === "breezeblue" ? { breezeVoiceId: "" } : { voice: "" })}
          >
            清空（自动挑）
          </button>
        </div>
        <p className="muted">自动挑只用一次，挑中的会记在本机；以后不用再问供应商。</p>
      </Section>

      <Section title="怎么念" hint="语速与语气强度都进合成请求；语气强度只对 BreezeBlue 有效。">
        <div className="voice-grid">
          <label>
            语速（0.5–2.0）
            <input
              type="number"
              step="0.05"
              min="0.5"
              max="2"
              defaultValue={typeof config.rate === "number" ? config.rate : 1}
              onBlur={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value)) void saveConfig({ rate: Math.min(2, Math.max(0.5, value)) });
              }}
            />
          </label>
          <label>
            语气强度 guidance（1–10）
            <input
              type="number"
              step="0.5"
              min="1"
              max="10"
              defaultValue={typeof config.breezeGuidanceScale === "number" ? config.breezeGuidanceScale : 4}
              onBlur={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value)) void saveConfig({ breezeGuidanceScale: Math.min(10, Math.max(1, value)) });
              }}
            />
          </label>
        </div>
        <div className="voice-field">
          <label>额外的语气要求（可留空）</label>
          <div className="voice-inline">
            <input
              placeholder="例如：语速偏慢，尾音轻一点"
              defaultValue={typeof config.breezeInstructions === "string" ? config.breezeInstructions : ""}
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (value !== (typeof config.breezeInstructions === "string" ? config.breezeInstructions : "")) {
                  void saveConfig({ breezeInstructions: value });
                }
              }}
            />
          </div>
        </div>
      </Section>

      <Section title="试听" hint="走的是真合成链路，会按字计一笔很小成本（约 ¥0.001 级别）。">
        <div className="voice-inline">
          <input value={trialText} onChange={(event) => setTrialText(event.target.value)} maxLength={60} />
          <button className="btn btn-sm btn-primary" onClick={() => void trial()} disabled={busy}>
            {busy ? "合成中…" : "说一句试试"}
          </button>
        </div>
        <p className="muted">
          从这版开始，长句子会先拆成一句一句合成再拼起来：一条语音最长一句话，避免长文本把合成搞崩。
        </p>
        {previewUrl !== null ? (
          <div className="voice-field">
            <audio src={previewUrl} controls autoPlay />
            <p className="muted">
              {previewCost}
              {previewCost === "" ? "" : "（记进了成本账；不满意就改上面的参数再试一次）"}
            </p>
          </div>
        ) : null}
      </Section>

      <Section
        title="外部通道也发语音条"
        hint="目前是微信：它把合成的语音播进虚拟声卡、再按住微信的语音键，微信自己编码成语音条发出去。默认关闭。"
      >
        <div className="voice-mode-row">
          <span className={`badge ${externalVoiceEnabled === true ? "badge-ok" : "badge-warn"}`}>
            {externalVoiceEnabled === true ? "已开启" : "未开启"}
          </span>
          <span className={`badge ${externalVoiceReady ? "badge-ok" : "badge-warn"}`}>
            {externalVoiceReady ? "声卡自检通过" : "声卡自检没过"}
          </span>
          <button className="btn btn-sm btn-ghost" onClick={() => void refreshExternalVoice(true)} disabled={busy}>
            重新自检
          </button>
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            checked={externalVoiceEnabled === true}
            disabled={busy}
            onChange={(event) => void toggleExternalVoice(event.target.checked)}
          />
          在外部通道里也发语音条（打开时会先做一次声卡自检）
        </label>
        <p className="muted">
          开之前要装好 VB-CABLE，并把系统默认录音设备设成「CABLE Output」。自检就是往 CABLE Input 播一段测试音、
          同时录回来听有没有声音，没通过就不让开，否则发出去的是房间里的真实声音。
        </p>
        {externalVoiceMessage !== "" ? <p className="muted">{externalVoiceMessage}</p> : null}
      </Section>
    </div>
  );
}
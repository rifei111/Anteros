import { useState } from "react";
import { useConfirm } from "../../components/Modal";
import { formatBytes } from "../../lib/format";
import { invoke, pickFile, revealFile } from "../../lib/kernel";
import { applyProactiveSummary, pushToast } from "../../lib/store";
import { LoadingLine, Section, reportError, requestToken, useLoad } from "../helpers";

const BUNDLE_FILTERS = [{ name: "Anteros 数据包", extensions: ["zip", "anteros"] }];

interface ResetOptions {
  keepApiKey: boolean;
  keepRuntime: boolean;
  keepPlugins: boolean;
}

/**
 * 数据面板：路径、导出/导入、重置记忆、整体重置、卸载。
 *
 * 三个"删东西"的按钮边界必须说清：
 * - 重置记忆：忘掉你（长期记忆 + 未闭合话题 + 叙事 + 默认清对话），人设与插件不动；
 * - 整体重置：这台电脑上的它回到出厂（可选保留密钥 / 运行环境 / 插件配置）；
 * - 卸载：卸载软件本体，可选要不要把数据一起删。
 */
export function DataTab() {
  const dirs = useLoad(() => invoke("system.dataDir", {}), []);
  const stats = useLoad(() => invoke("memory.stats", {}), []);
  const confirm = useConfirm();
  const [busy, setBusy] = useState<"export" | "import" | "reset-memory" | "reset-data" | "uninstall" | null>(null);
  const [keepChat, setKeepChat] = useState(true);
  const [keepOptions, setKeepOptions] = useState<ResetOptions>({ keepApiKey: true, keepRuntime: true, keepPlugins: true });
  const [keepDataOnUninstall, setKeepDataOnUninstall] = useState(true);

  const openDir = async (): Promise<void> => {
    try {
      const result = await invoke("system.dataDir", {});
      await revealFile(result.path);
    } catch (error) {
      reportError(error);
    }
  };

  const exportBundle = async (): Promise<void> => {
    if (busy) return;
    setBusy("export");
    try {
      const result = await invoke("export.bundle", {});
      pushToast("success", "已导出数据包", `${result.path}（${formatBytes(result.bytes)}）`);
      await revealFile(result.path);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  };

  const importBundle = async (): Promise<void> => {
    if (busy) return;
    let path: string | null = null;
    try {
      path = await pickFile({ title: "选择 Anteros 数据包", mode: "open", filters: BUNDLE_FILTERS });
    } catch (error) {
      reportError(error);
      return;
    }
    if (path === null) return;
    const agreed = await confirm.ask({
      title: "导入并覆盖当前数据？",
      body: (
        <div>
          <p className="mono">{path}</p>
          <p className="danger-text">
            导入会覆盖当前这台电脑上的记忆、人格与配置；导入完成前不要关客户端。导入后建议重启客户端让内核重新加载。
          </p>
        </div>
      ),
      confirmLabel: "导入",
      danger: true,
    });
    if (!agreed) return;
    setBusy("import");
    try {
      const result = await invoke("import.bundle", { path });
      pushToast("success", result.imported ? "已导入" : "导入未生效", result.message);
      dirs.reload();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  };

  /** 重置记忆：先给数字，再要 token，最后真的清（默认连对话一起清）。 */
  const resetMemory = async (): Promise<void> => {
    if (busy) return;
    const total = stats.data ? stats.data.total : 0;
    const agreed = await confirm.ask({
      title: "重置记忆？",
      body: (
        <div>
          <p>
            会清掉它记住的 {total} 条记忆、未闭合话题和叙事槽位
            {keepChat ? "，并清空全部聊天记录（推荐：只清记忆它会从聊天记录里重新想起来）" : "，但保留聊天记录"}。
          </p>
          <p className="danger-text">不可撤销。人格设定、插件、你的密钥都保留。</p>
        </div>
      ),
      confirmLabel: "重置记忆",
      danger: true,
    });
    if (!agreed) return;
    setBusy("reset-memory");
    try {
      const token = await requestToken("memory.reset");
      const result = await invoke("memory.reset", { confirmToken: token, keepChat });
      pushToast(
        "success",
        "记忆已重置",
        `清掉记忆 ${result.memories} 条、话题 ${result.openLoops} 条、对话 ${result.messages} 条`,
      );
      stats.reload();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  };

  /** 整体重置：这台电脑上的它回到出厂。 */
  const resetData = async (): Promise<void> => {
    if (busy) return;
    const agreed = await confirm.ask({
      title: "整体重置？",
      body: (
        <div>
          <p>会清空本机上的记忆、对话、成本账本、审计记录、日历与关系状态。</p>
          <p className="danger-text">
            保留项：{[
              keepOptions.keepApiKey ? "密钥与模型设置" : null,
              keepOptions.keepRuntime ? "运行环境（Python、插件运行环境）" : null,
              keepOptions.keepPlugins ? "插件及其配置" : null,
            ]
              .filter(Boolean)
              .join("、") || "什么都不留"}
          </p>
          <p className="muted">不可撤销。想留个底就先导出一份数据包。</p>
        </div>
      ),
      confirmLabel: "整体重置",
      danger: true,
    });
    if (!agreed) return;
    setBusy("reset-data");
    try {
      const token = await requestToken("system.resetData");
      const result = await invoke("system.resetData", { confirmToken: token, ...keepOptions });
      const rows = Object.values(result.tables).reduce((sum, value) => sum + value, 0);
      pushToast("success", "已整体重置", `清掉 ${rows} 行数据、${result.removedDirs.length} 个目录`);
      stats.reload();
      applyProactiveSummary(null);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  };

  /** 卸载：交给安装包的卸载程序；数据目录留不留由复选框决定。 */
  const uninstall = async (): Promise<void> => {
    if (busy) return;
    const agreed = await confirm.ask({
      title: "卸载 Anteros？",
      body: (
        <div>
          <p>
            {keepDataOnUninstall
              ? "只卸载程序本身，数据目录会留着：重装以后它还记得你。"
              : "程序和数据一起删：记忆、密钥、日志、运行环境都会被删掉，无法恢复。"}
          </p>
          <p className="danger-text">卸载会关闭当前窗口。</p>
        </div>
      ),
      confirmLabel: "卸载",
      danger: true,
    });
    if (!agreed) return;
    setBusy("uninstall");
    try {
      if (!window.anteros?.uninstaller) {
        pushToast("warn", "这只在安装版里可用", "开发模式下没有卸载程序，用安装包安装的版本才有。");
        return;
      }
      const result = await window.anteros.uninstaller.run({ keepData: keepDataOnUninstall });
      if (!result.started) {
        pushToast("warn", "没有找到卸载程序", result.message);
        return;
      }
      pushToast("info", "卸载程序已启动", "按提示完成卸载即可，窗口会自动关闭。");
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="panel-stack">
      {confirm.node}

      <Section
        title="数据目录"
        hint="人格、记忆、密钥、成本记录都在这一个目录里，没有云端副本。"
        action={
          <div className="row-actions">
            <button className="btn btn-ghost" onClick={() => dirs.reload()}>
              刷新
            </button>
            <button className="btn" onClick={() => void openDir()}>
              打开数据目录
            </button>
          </div>
        }
      >
        <LoadingLine loading={dirs.loading} error={dirs.error} />
        {dirs.data ? (
          <dl className="kv-grid">
            <dt>数据目录</dt>
            <dd className="mono">{dirs.data.path}</dd>
            <dt>数据库文件</dt>
            <dd className="mono">{dirs.data.dbPath}</dd>
          </dl>
        ) : null}
        <p className="prose muted">
          换一台电脑就是新的它：这里不做多端同步，也不做自动迁移。要搬走就导出数据包，再在新机器上导入。
        </p>
      </Section>

      <Section title="备份" hint="导出一个压缩数据包，包含 SQLite 数据库与配置。">
        <div className="row-actions">
          <button className="btn btn-primary" onClick={() => void exportBundle()} disabled={busy === "export"}>
            {busy === "export" ? "正在导出…" : "导出数据包"}
          </button>
          <span className="muted">导出的包里有密钥，别随手发给别人。</span>
        </div>
      </Section>

      <Section title="恢复" hint="覆盖式导入，会替换当前数据。">
        <div className="danger-box">
          <p className="prose">
            导入会用数据包里的内容替换当前记忆、人格与配置。这是危险操作，导入前会再确认一次。
          </p>
          <button className="btn btn-danger" onClick={() => void importBundle()} disabled={busy === "import"}>
            {busy === "import" ? "正在导入…" : "从数据包导入…"}
          </button>
        </div>
      </Section>

      <Section
        title="重置记忆"
        hint="让它忘掉你：长期记忆、未闭合话题、叙事槽位一起清，人格与插件不动。"
      >
        <div className="danger-box">
          <p className="prose">
            只删记忆条目是不够的：聊天记录还在，它会从上下文里重新"想起来"。
            {stats.data ? `当前有 ${stats.data.total} 条记忆（其中 ${stats.data.pinned} 条是被钉住的红线/重要事实）。` : ""}
          </p>
          <label className="check-row">
            <input type="checkbox" checked={keepChat} onChange={(event) => setKeepChat(event.target.checked)} />
            <span>同时清空聊天记录（推荐：不勾的话它会从聊天记录里想起来）</span>
          </label>
          <button className="btn btn-danger" onClick={() => void resetMemory()} disabled={busy === "reset-memory"}>
            {busy === "reset-memory" ? "正在重置…" : "重置记忆"}
          </button>
        </div>
      </Section>

      <Section title="整体重置" hint="这台电脑上的它回到出厂：记忆、对话、账本、审计、日程、关系全部清空。">
        <div className="danger-box">
          <p className="prose">下面三项是可选的保留项；不勾就一起删。删掉的一般都能重新配，但记忆删了就找不回来。</p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={keepOptions.keepApiKey}
              onChange={(event) => setKeepOptions({ ...keepOptions, keepApiKey: event.target.checked })}
            />
            <span>保留 API Key 与模型设置（不用重新填地址和密钥）</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={keepOptions.keepRuntime}
              onChange={(event) => setKeepOptions({ ...keepOptions, keepRuntime: event.target.checked })}
            />
            <span>保留运行环境（便携 Python、插件运行环境，省一次下载）</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={keepOptions.keepPlugins}
              onChange={(event) => setKeepOptions({ ...keepOptions, keepPlugins: event.target.checked })}
            />
            <span>保留插件及其配置</span>
          </label>
          <button className="btn btn-danger" onClick={() => void resetData()} disabled={busy === "reset-data"}>
            {busy === "reset-data" ? "正在重置…" : "整体重置"}
          </button>
        </div>
      </Section>

      <Section title="卸载" hint="卸载程序；数据留不留由你决定。">
        <div className="danger-box">
          <label className="check-row">
            <input
              type="checkbox"
              checked={keepDataOnUninstall}
              onChange={(event) => setKeepDataOnUninstall(event.target.checked)}
            />
            <span>保留数据（记忆、密钥、运行环境；重装后它还记得你）</span>
          </label>
          <button className="btn btn-danger" onClick={() => void uninstall()} disabled={busy === "uninstall"}>
            {busy === "uninstall" ? "正在启动卸载…" : "卸载 Anteros"}
          </button>
        </div>
      </Section>
    </div>
  );
}
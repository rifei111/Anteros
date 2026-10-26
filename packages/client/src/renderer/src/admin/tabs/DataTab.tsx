import { useState } from "react";
import { useConfirm } from "../../components/Modal";
import { formatBytes } from "../../lib/format";
import { invoke, pickFile, revealFile } from "../../lib/kernel";
import { pushToast } from "../../lib/store";
import { LoadingLine, Section, reportError, useLoad } from "../helpers";

const BUNDLE_FILTERS = [{ name: "Anteros 数据包", extensions: ["zip", "anteros"] }];

/**
 * 数据面板：路径、导出、导入。
 * 数据只在本机；导入是覆盖式，必须二次确认。
 */
export function DataTab() {
  const dirs = useLoad(() => invoke("system.dataDir", {}), []);
  const confirm = useConfirm();
  const [busy, setBusy] = useState<"export" | "import" | null>(null);

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

      <Section title="清空" hint="删记忆在「记忆」标签里；这里不重复放危险按钮。">
        <p className="prose muted">
          「记忆」面板可以删单条或清空全部（清空需要一次性确认 token）。清空人格设定不在界面上提供——它属于红线：
          删了它就等于换了一个人，我们不做这种按钮。
        </p>
      </Section>
    </div>
  );
}

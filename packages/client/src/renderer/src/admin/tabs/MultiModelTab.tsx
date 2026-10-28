/**
 * 多模型面板：模型清单（各自地址/密钥）+ 任务类别路由 + 聊天框当前模型。
 *
 * 为什么单开一页：模型比「一个 Base URL + 一个 Key」复杂得多——文本用便宜的、
 * 抽取用快的、看图另配。这里管的是"哪类活交给谁"，聊天框顶上的选择器只管"这次跟谁聊"。
 *
 * 红线：密钥只写不读；列表里只显示"已保存/未保存"。
 */
import { useState } from "react";
import type { ModelCatalog, ModelEntry, ModelTaskKind } from "@anteros/shared";
import { Modal, useConfirm } from "../../components/Modal";
import { formatDateTime } from "../../lib/format";
import { invoke } from "../../lib/kernel";
import { applyModelCatalog, pushToast } from "../../lib/store";
import { LoadingLine, Section, reportError, useLoad } from "../helpers";

const KIND_LABEL: Record<ModelTaskKind, string> = {
  reply: "对话回复",
  proactive: "主动消息",
  extract: "记忆抽取",
  world: "世界信息",
  narrative: "叙事整理",
  persona: "人设编译",
  audio: "语音",
  image: "生图",
  vision: "看图",
};

const KINDS: ModelTaskKind[] = ["reply", "proactive", "extract", "world", "narrative", "persona", "audio", "image", "vision"];

interface Draft {
  id: string | null;
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  kinds: ModelTaskKind[];
}

const EMPTY_DRAFT: Draft = { id: null, label: "", baseUrl: "", model: "", apiKey: "", kinds: ["reply"] };

export function MultiModelTab() {
  const loaded = useLoad(() => invoke("models.list", {}), []);
  const confirm = useConfirm();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState<string | null>(null);
  const catalog = loaded.data;
  const entries = catalog?.entries ?? [];

  const applyCatalog = (next: ModelCatalog): void => {
    applyModelCatalog(next);
    loaded.reload();
  };

  const openNew = (): void => setDraft({ ...EMPTY_DRAFT });

  const openEdit = (entry: ModelEntry): void =>
    setDraft({
      id: entry.id,
      label: entry.label,
      baseUrl: entry.baseUrl,
      model: entry.model,
      apiKey: "",
      kinds: entry.kinds,
    });

  const save = async (): Promise<void> => {
    if (!draft) return;
    setSaving(true);
    try {
      const result = await invoke("models.upsert", {
        id: draft.id,
        label: draft.label,
        baseUrl: draft.baseUrl,
        model: draft.model,
        kinds: draft.kinds,
        // 留空表示"不改密钥"；编辑时想清空要显式点「清除密钥」
        apiKey: draft.apiKey.trim().length > 0 ? draft.apiKey.trim() : undefined,
      });
      applyCatalog(result.catalog);
      setDraft(null);
      pushToast("success", "已保存", `${result.entry.label}（${result.entry.model}）`);
    } catch (error) {
      reportError(error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (entry: ModelEntry): Promise<void> => {
    const ok = await confirm.ask({
      title: `删除模型「${entry.label}」？`,
      body: <p>会同时清掉它在本机保存的密钥；绑定了它的任务类别会回到主模型。</p>,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await invoke("models.remove", { id: entry.id });
      applyCatalog(result.catalog);
      pushToast("success", "已删除", entry.label);
    } catch (error) {
      reportError(error);
    }
  };

  const probe = async (entry: ModelEntry): Promise<void> => {
    setProbing(entry.id);
    try {
      const result = await invoke("models.probe", { id: entry.id });
      pushToast(result.ok ? "success" : "error", result.ok ? "连接正常" : "连接失败", `${entry.label}：${result.message}`);
      loaded.reload();
    } catch (error) {
      reportError(error);
    } finally {
      setProbing(null);
    }
  };

  const setRoute = async (kind: ModelTaskKind, modelId: string): Promise<void> => {
    try {
      const result = await invoke("models.setRoute", { kind, modelId: modelId.length > 0 ? modelId : null });
      applyCatalog(result.catalog);
    } catch (error) {
      reportError(error);
    }
  };

  const toggleKind = (kind: ModelTaskKind): void => {
    setDraft((current) => {
      if (!current) return current;
      const has = current.kinds.includes(kind);
      return { ...current, kinds: has ? current.kinds.filter((item) => item !== kind) : [...current.kinds, kind] };
    });
  };

  return (
    <div className="panel-stack">
      {confirm.node}
      <LoadingLine loading={loaded.loading} error={loaded.error} />

      <Section
        title="模型清单"
        hint="每个模型自己一套地址、模型名和密钥。密钥只在本机加密保存，保存后不再显示。"
        action={
          <button className="btn btn-primary" onClick={openNew}>
            新增模型
          </button>
        }
      >
        {entries.length === 0 ? (
          <div className="empty-note">
            还没有额外模型。主模型在「模型」页配置；这里可以再加几个，把不同任务分给不同模型。
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>名字</th>
                <th>模型</th>
                <th>能接的活</th>
                <th>密钥</th>
                <th>最近结果</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <div>{entry.label}</div>
                    <div className="muted small">{entry.baseUrl}</div>
                  </td>
                  <td className="mono small">{entry.model}</td>
                  <td className="small">
                    {entry.kinds.length === 0 ? <span className="muted">仅手动选择</span> : entry.kinds.map((kind) => KIND_LABEL[kind] ?? kind).join("、")}
                  </td>
                  <td className="small">{entry.apiKeyConfigured ? "已保存" : <span className="danger-text">未保存</span>}</td>
                  <td className="small">
                    {entry.lastError ? (
                      <span className="danger-text">{entry.lastError}</span>
                    ) : entry.lastOkTs ? (
                      <span className="muted">{formatDateTime(entry.lastOkTs)} 通</span>
                    ) : (
                      <span className="muted">没测过</span>
                    )}
                  </td>
                  <td className="row-actions">
                    <button className="btn btn-ghost" onClick={() => void probe(entry)} disabled={probing === entry.id}>
                      {probing === entry.id ? "测试中…" : "测试"}
                    </button>
                    <button className="btn btn-ghost" onClick={() => openEdit(entry)}>
                      编辑
                    </button>
                    <button className="btn btn-ghost danger-text" onClick={() => void remove(entry)}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="哪类任务用哪个模型" hint="没绑定的类别回落到主模型；聊天框顶部还能临时换一次对话用的模型。">
        <div className="grid-2">
          {KINDS.map((kind) => (
            <label className="field-row" key={kind}>
              <span className="field-label">{KIND_LABEL[kind]}</span>
              <select
                value={catalog?.routes[kind] ?? ""}
                onChange={(event) => void setRoute(kind, event.target.value)}
              >
                <option value="">主模型（{catalog?.primary.model ?? "未配置"}）</option>
                {entries
                  .filter((entry) => entry.enabled)
                  .map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}（{entry.model}）
                    </option>
                  ))}
              </select>
            </label>
          ))}
        </div>
        <p className="muted small">
          音频 / 生图 / 看图这三类需要支持对应能力的模型接口；不配就是不支持，不会假装能画。
        </p>
      </Section>

      {draft ? (
        <Modal
          title={draft.id ? "编辑模型" : "新增模型"}
          onClose={() => setDraft(null)}
          wide
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setDraft(null)} disabled={saving}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
                {saving ? "保存中…" : "保存"}
              </button>
            </>
          }
        >
          <div className="form-stack">
            <label className="field-row">
              <span className="field-label">名字</span>
              <input
                value={draft.label}
                placeholder="例如 deepseek-chat、qwen-vl"
                onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              />
            </label>
            <label className="field-row">
              <span className="field-label">接口地址</span>
              <input
                value={draft.baseUrl}
                placeholder="https://api.deepseek.com/v1"
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
              />
            </label>
            <label className="field-row">
              <span className="field-label">模型名</span>
              <input
                value={draft.model}
                placeholder="deepseek-chat"
                onChange={(event) => setDraft({ ...draft, model: event.target.value })}
              />
            </label>
            <label className="field-row">
              <span className="field-label">API Key</span>
              <input
                type="password"
                value={draft.apiKey}
                placeholder={draft.id ? "留空表示不改" : "sk-…"}
                onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
              />
            </label>
            <div className="field-row">
              <span className="field-label">能接的活</span>
              <div className="check-row">
                {KINDS.map((kind) => (
                  <label className="check-chip" key={kind}>
                    <input type="checkbox" checked={draft.kinds.includes(kind)} onChange={() => toggleKind(kind)} />
                    <span>{KIND_LABEL[kind]}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
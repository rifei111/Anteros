import type { Importance, MemoryItem, MemoryKind } from "@anteros/shared";
import { useEffect, useRef, useState } from "react";
import { useConfirm } from "../../components/Modal";
import { formatDateTime, formatPercent, formatRelative, truncate } from "../../lib/format";
import { invoke, revealFile } from "../../lib/kernel";
import { focusMemory, reloadChatView, refreshSnapshot } from "../../lib/app";
import { IMPORTANCE_LABEL, KIND_LABEL, labelOf } from "../../lib/labels";
import { pushToast } from "../../lib/store";
import { LoadingLine, Section, reportError, requestToken, useLoad } from "../helpers";

const KIND_FILTERS: ReadonlyArray<{ id: "all" | MemoryKind; label: string }> = [
  { id: "all", label: "全部" },
  { id: "episodic", label: "情节记忆" },
  { id: "semantic", label: "结构事实" },
  { id: "open_loop", label: "未闭合话题" },
];

const IMPORTANCE_FILTERS: ReadonlyArray<{ id: "all" | Importance; label: string }> = [
  { id: "all", label: "全部重要性" },
  { id: "redline", label: "红线" },
  { id: "important", label: "重要" },
  { id: "detail", label: "细节" },
];

function memoryTitle(item: MemoryItem): string {
  if (item.text) return truncate(item.text.replace(/\s+/g, " "), 72);
  if (item.topic) return item.topic;
  if (item.slotKey) return item.slotKey;
  return `#${item.id}`;
}

/**
 * 记忆台账：统计 + 分类/重要性筛选 + 搜索 + 详情抽屉 + 单条删除 / 清空。
 * 清空必须 confirm.token；删除数量以内核返回为准，界面不自己算。
 */
export function MemoryTab() {
  const confirm = useConfirm();
  const stats = useLoad(() => invoke("memory.stats", {}), []);
  const [kind, setKind] = useState<"all" | MemoryKind>("all");
  const [importance, setImportance] = useState<"all" | Importance>("all");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [pinned, setPinned] = useState<MemoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState(false);
  // 清空时默认连聊天记录一起清：只删记忆条目的话，它从对话上下文里照样想得起来
  const [clearChatOnDelete, setClearChatOnDelete] = useState(true);
  const requestSeq = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 240);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    setLoading(true);
    const run = async (): Promise<void> => {
      try {
        if (debouncedQuery.length > 0) {
          const result = await invoke("memory.search", { query: debouncedQuery, topK: 50 });
          if (seq !== requestSeq.current) return;
          setItems(result.items);
          setPinned(result.pinned);
          setTotal(result.items.length);
        } else {
          const params: { kind?: MemoryKind; importance?: Importance; limit: number; offset: number } = {
            limit: 50,
            offset: 0,
          };
          if (kind !== "all") params.kind = kind;
          if (importance !== "all") params.importance = importance;
          const result = await invoke("memory.list", params);
          if (seq !== requestSeq.current) return;
          setItems(result.items);
          setPinned([]);
          setTotal(result.total);
        }
      } catch (error) {
        if (seq === requestSeq.current) reportError(error);
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    };
    void run();
  }, [kind, importance, debouncedQuery]);

  const loadMore = async (): Promise<void> => {
    if (loadingMore || debouncedQuery.length > 0 || items.length >= total) return;
    setLoadingMore(true);
    try {
      const params: { kind?: MemoryKind; importance?: Importance; limit: number; offset: number } = {
        limit: 50,
        offset: items.length,
      };
      if (kind !== "all") params.kind = kind;
      if (importance !== "all") params.importance = importance;
      const result = await invoke("memory.list", params);
      setItems((previous) => {
        const seen = new Set(previous.map((item) => item.id));
        return [...previous, ...result.items.filter((item) => !seen.has(item.id))];
      });
      setTotal(result.total);
    } catch (error) {
      reportError(error);
    } finally {
      setLoadingMore(false);
    }
  };

  const deleteOne = async (item: MemoryItem): Promise<void> => {
    const agreed = await confirm.ask({
      title: "删除这条记忆？",
      body: (
        <div>
          <p>{memoryTitle(item)}</p>
          <p className="danger-text">删掉之后它就想不起来了；删的是本机数据，不能从别处恢复。</p>
        </div>
      ),
      confirmLabel: "删除",
      danger: true,
    });
    if (!agreed) return;
    try {
      await invoke("memory.delete", { id: item.id });
      setItems((previous) => previous.filter((entry) => entry.id !== item.id));
      setTotal((previous) => Math.max(0, previous - 1));
      stats.reload();
      pushToast("success", "已删除", "内核已确认删除。");
    } catch (error) {
      reportError(error);
    }
  };

  const deleteAll = async (): Promise<void> => {
    const agreed = await confirm.ask({
      title: "清空全部记忆？",
      body: (
        <div>
          <p>会删掉这台电脑上的所有情节记忆、结构事实与未闭合话题；人格设定会保留。</p>
          <p>
            {clearChatOnDelete
              ? "同时清空聊天记录（推荐：只删记忆的话，它会从聊天记录里重新想起这些事）。"
              : "保留聊天记录——它仍然会从对话上下文里想起这些事。"}
          </p>
          <p className="danger-text">这个操作不可撤销，删除数量由内核返回。</p>
        </div>
      ),
      confirmLabel: "清空全部",
      danger: true,
    });
    if (!agreed) return;
    setBusy(true);
    try {
      if (clearChatOnDelete) {
        // 走重置记忆这条：记忆 + 对话一起清，界面上的旧消息也一起清掉
        const resetToken = await requestToken("memory.reset");
        const reset = await invoke("memory.reset", { confirmToken: resetToken, keepChat: false });
        setItems([]);
        setPinned([]);
        setTotal(0);
        await reloadChatView();
        await refreshSnapshot();
        stats.reload();
        pushToast("success", "已清空", `删掉记忆 ${reset.memories} 条、对话 ${reset.messages} 条。`);
      } else {
        const token = await requestToken("memory.deleteAll");
        const result = await invoke("memory.deleteAll", { confirmToken: token });
        setItems([]);
        setPinned([]);
        setTotal(0);
        stats.reload();
        pushToast("success", "已清空", `内核删除了 ${result.deleted} 条记忆。聊天记录还在，它还能从对话里想起这些事。`);
      }
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const exportMemory = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await invoke("memory.export", {});
      pushToast("success", "记忆已导出", result.path);
      await revealFile(result.path);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const statsData = stats.data;

  return (
    <div className="panel-stack">
      {confirm.node}

      <Section
        title="记忆统计"
        hint="记忆只写在本机；删了就真的没了。"
        action={
          <div className="row-actions">
            <button className="btn btn-ghost" onClick={() => stats.reload()}>
              刷新
            </button>
            <button className="btn" onClick={() => void exportMemory()} disabled={busy}>
              导出记忆
            </button>
          </div>
        }
      >
        <LoadingLine loading={stats.loading} error={stats.error} />
        {statsData ? (
          <div className="stat-grid">
            <div className="stat-card">
              <div className="stat-value">{statsData.total}</div>
              <div className="stat-label">总条数</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{statsData.episodic}</div>
              <div className="stat-label">情节记忆</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{statsData.semantic}</div>
              <div className="stat-label">结构事实</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{statsData.openLoops}</div>
              <div className="stat-label">未闭合话题</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{statsData.persona}</div>
              <div className="stat-label">人格设定</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{statsData.pinned}</div>
              <div className="stat-label">钉住的证据层</div>
            </div>
          </div>
        ) : null}
      </Section>

      <Section
        title="记忆列表"
        hint={
          debouncedQuery.length > 0
            ? `搜索「${debouncedQuery}」：${items.length} 条命中（只搜本机，不用网络）`
            : `共 ${total} 条；点击一行看详情。`
        }
        action={
          <div className="row-tight">
            <label className="check-row compact">
              <input
                type="checkbox"
                checked={clearChatOnDelete}
                onChange={(event) => setClearChatOnDelete(event.target.checked)}
              />
              <span>连聊天记录一起清</span>
            </label>
            <button className="btn btn-danger-ghost" onClick={() => void deleteAll()} disabled={busy || total === 0}>
              {busy ? "处理中…" : "清空全部"}
            </button>
          </div>
        }
      >
        <div className="filter-row">
          <input
            className="input"
            placeholder="搜索本机记忆（人物、话题、事实…）"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="filter-row">
          <div className="segmented">
            {KIND_FILTERS.map((filter) => (
              <button
                key={filter.id}
                className={`seg-btn ${kind === filter.id ? "active" : ""}`}
                onClick={() => setKind(filter.id)}
                type="button"
              >
                {filter.label}
              </button>
            ))}
          </div>
          <div className="segmented">
            {IMPORTANCE_FILTERS.map((filter) => (
              <button
                key={filter.id}
                className={`seg-btn ${importance === filter.id ? "active" : ""}`}
                onClick={() => setImportance(filter.id)}
                type="button"
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        {loading ? <div className="empty-note">正在读取…</div> : null}

        {pinned.length > 0 && debouncedQuery.length > 0 ? (
          <>
            <div className="search-group-title">钉住的证据层</div>
            <ul className="memory-list">
              {pinned.map((item) => (
                <li key={`pinned-${item.id}`} className="memory-item pinned">
                  <button className="memory-item-main" onClick={() => focusMemory(item)} type="button">
                    <span className={`badge ${item.kind === "persona" ? "badge-warn" : "badge-ok"}`}>
                      {labelOf(KIND_LABEL, item.kind)}
                    </span>
                    <span className="memory-item-text">{memoryTitle(item)}</span>
                    <span className="memory-item-meta muted">
                      {item.source} · {formatDateTime(item.createdAt)}
                    </span>
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => void deleteOne(item)} aria-label="删除这条记忆">
                    删除
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        <ul className="memory-list">
          {items.map((item) => (
            <li key={item.id} className="memory-item">
              <button className="memory-item-main" onClick={() => focusMemory(item)} type="button">
                <span className={`badge kind-${item.kind}`}>{labelOf(KIND_LABEL, item.kind)}</span>
                <span className="memory-item-text">{memoryTitle(item)}</span>
                <span className="memory-item-meta muted">
                  {labelOf(IMPORTANCE_LABEL, item.importance)} · 置信 {formatPercent(item.confidence)} ·
                  {item.lastAccessTs ? ` 想起于 ${formatRelative(item.lastAccessTs)}` : " 还没想起过"} · {item.source}
                </span>
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => void deleteOne(item)} aria-label="删除这条记忆">
                删除
              </button>
            </li>
          ))}
        </ul>

        {items.length === 0 && !loading ? (
          <div className="empty-note">
            {debouncedQuery.length > 0 ? "没有命中：没记住就是没记住，不会编一个答案。" : "这里还是空的。"}
          </div>
        ) : null}

        {debouncedQuery.length === 0 && items.length < total ? (
          <button className="btn btn-ghost" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? "加载中…" : `加载更多（还剩 ${total - items.length} 条）`}
          </button>
        ) : null}
      </Section>
    </div>
  );
}

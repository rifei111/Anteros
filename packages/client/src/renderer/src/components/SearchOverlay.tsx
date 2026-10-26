import { useEffect, useRef, useState } from "react";
import type { MemoryItem } from "@anteros/shared";
import { closeSearch, focusMemory } from "../lib/app";
import { humanizeError } from "../lib/errors";
import { formatDateTime, formatPercent, truncate } from "../lib/format";
import { invoke } from "../lib/kernel";
import { IMPORTANCE_LABEL, KIND_LABEL, labelOf } from "../lib/labels";
import { useAppState } from "../lib/store";
import { CloseIcon, SearchIcon } from "./Icons";

function itemText(item: MemoryItem): string {
  if (typeof item.text === "string" && item.text.length > 0) return item.text;
  if (typeof item.topic === "string" && item.topic.length > 0) return item.topic;
  if (typeof item.slotKey === "string" && item.slotKey.length > 0) return item.slotKey;
  if (item.value === undefined || item.value === null) return "（无正文）";
  return typeof item.value === "string" ? item.value : "（结构化值）";
}

/**
 * 本机记忆搜索浮层：调用 `memory.search`，结果只是内核返回的真实记忆。
 * 不显示"猜你想搜"，也不构造摘要。
 */
export function SearchOverlay() {
  const state = useAppState();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [pinned, setPinned] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setItems([]);
      setPinned([]);
      setError(null);
      setLoading(false);
      return;
    }
    const seq = ++requestSeq.current;
    setLoading(true);
    const timer = globalThis.setTimeout(() => {
      void invoke("memory.search", { query: trimmed, topK: 30 })
        .then((result) => {
          if (seq !== requestSeq.current) return;
          setItems(result.items);
          setPinned(result.pinned);
          setError(null);
        })
        .catch((caught: unknown) => {
          if (seq !== requestSeq.current) return;
          const human = humanizeError(caught);
          setError(human.hint ? `${human.title}（${human.hint}）` : human.title);
        })
        .finally(() => {
          if (seq === requestSeq.current) setLoading(false);
        });
    }, 220);
    return () => {
      globalThis.clearTimeout(timer);
    };
  }, [query]);

  const open = (item: MemoryItem): void => {
    focusMemory(item);
    closeSearch();
  };

  return (
    <div className="overlay-mask" onMouseDown={(event) => event.target === event.currentTarget && closeSearch()}>
      <div className="search-panel" role="dialog" aria-modal="true" aria-label="搜索本机记忆">
        <div className="search-head">
          <SearchIcon />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索本机记忆：人、事、约定、偏好…"
            aria-label="搜索本机记忆"
          />
          <button className="icon-btn" onClick={() => closeSearch()} aria-label="关闭搜索">
            <CloseIcon />
          </button>
        </div>

        <div className="search-body">
          {query.trim().length === 0 ? (
            <div className="empty-note">
              只搜这台电脑上的记忆（{state.health ? `${state.health.memoryCount} 条` : "若干"}）。搜不到就是没记住，不会编一个答案。
            </div>
          ) : null}

          {loading ? <div className="empty-note">正在检索…</div> : null}
          {error ? <div className="inline-error">{error}</div> : null}

          {pinned.length > 0 ? (
            <>
              <div className="search-group-title">钉住的证据层</div>
              {pinned.map((item) => (
                <button className="memory-row pinned" key={`pinned-${item.id}`} onClick={() => open(item)}>
                  <div className="memory-row-main">
                    <div className="memory-row-text">{truncate(itemText(item), 90)}</div>
                    <div className="memory-row-meta">
                      {labelOf(KIND_LABEL, item.kind)} · {labelOf(IMPORTANCE_LABEL, item.importance)} ·{" "}
                      置信度 {formatPercent(item.confidence)}
                    </div>
                  </div>
                </button>
              ))}
            </>
          ) : null}

          {items.length > 0 ? <div className="search-group-title">检索结果</div> : null}
          {items.map((item) => (
            <button className="memory-row" key={item.id} onClick={() => open(item)}>
              <div className="memory-row-main">
                <div className="memory-row-text">{truncate(itemText(item), 90)}</div>
                <div className="memory-row-meta">
                  {labelOf(KIND_LABEL, item.kind)} · {labelOf(IMPORTANCE_LABEL, item.importance)}
                  {typeof item.recallProbability === "number"
                    ? ` · 想起概率 ${formatPercent(item.recallProbability)}`
                    : ""}
                  {" · "}
                  {formatDateTime(item.createdAt)}
                </div>
              </div>
            </button>
          ))}

          {!loading && query.trim().length > 0 && items.length === 0 && pinned.length === 0 && !error ? (
            <div className="empty-note">没有匹配的记忆。</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

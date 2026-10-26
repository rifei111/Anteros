import { useEffect, useState } from "react";
import type { MemoryItem } from "@anteros/shared";
import { humanizeError } from "../lib/errors";
import { formatDateTime, formatPercent } from "../lib/format";
import { invoke } from "../lib/kernel";
import { focusMemory, pushToast } from "../lib/store";
import { IMPORTANCE_LABEL, KIND_LABEL, labelOf } from "../lib/labels";
import { CloseIcon, TrashIcon } from "./Icons";

function memoryText(item: MemoryItem): string {
  if (typeof item.text === "string" && item.text.length > 0) return item.text;
  if (typeof item.topic === "string" && item.topic.length > 0) return item.topic;
  if (typeof item.slotKey === "string" && item.slotKey.length > 0) return item.slotKey;
  if (item.value === undefined || item.value === null) return "（无正文）";
  try {
    return typeof item.value === "string" ? item.value : JSON.stringify(item.value);
  } catch {
    return "（无法展示的值）";
  }
}

/** 单条记忆详情抽屉：显示来源、置信度、最后想起时间、激活强度，可删除单条。 */
export function MemoryDetail({ item }: { item: MemoryItem }) {
  const [current, setCurrent] = useState<MemoryItem>(item);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setCurrent(item);
    let alive = true;
    void invoke("memory.get", { id: item.id })
      .then((result) => {
        if (alive && result.item) setCurrent(result.item);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [item]);

  const remove = async (): Promise<void> => {
    if (deleting) return;
    setDeleting(true);
    try {
      const result = await invoke("memory.delete", { id: current.id });
      if (result.deleted) {
        pushToast("success", "已删除这条记忆");
        focusMemory(null);
      } else {
        pushToast("warn", "内核没有删除这条记忆");
      }
    } catch (error) {
      const human = humanizeError(error);
      pushToast("error", human.title, human.hint);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="drawer-mask" onMouseDown={(event) => event.target === event.currentTarget && focusMemory(null)}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="记忆详情">
        <header className="drawer-head">
          <div>
            <div className="drawer-title">记忆详情</div>
            <div className="drawer-sub">
              #{current.id} · {labelOf(KIND_LABEL, current.kind)} · {labelOf(IMPORTANCE_LABEL, current.importance)}
            </div>
          </div>
          <button className="icon-btn" onClick={() => focusMemory(null)} aria-label="关闭">
            <CloseIcon />
          </button>
        </header>

        <div className="drawer-body">
          <div className="memory-text">{memoryText(current)}</div>

          <dl className="kv-grid">
            <dt>来源</dt>
            <dd>{current.source || "—"}</dd>
            <dt>置信度</dt>
            <dd>{formatPercent(current.confidence)}</dd>
            <dt>显著度</dt>
            <dd>{formatPercent(current.salience)}</dd>
            <dt>最后想起</dt>
            <dd>{formatDateTime(current.lastAccessTs)}</dd>
            <dt>想起次数</dt>
            <dd>{current.accessCount}</dd>
            <dt>激活强度</dt>
            <dd>{typeof current.activation === "number" ? current.activation.toFixed(3) : "—"}</dd>
            <dt>想起概率</dt>
            <dd>{typeof current.recallProbability === "number" ? formatPercent(current.recallProbability) : "—"}</dd>
            <dt>创建时间</dt>
            <dd>{formatDateTime(current.createdAt)}</dd>
            {current.entities.length > 0 ? (
              <>
                <dt>实体</dt>
                <dd>{current.entities.join("、")}</dd>
              </>
            ) : null}
            {current.kind === "open_loop" ? (
              <>
                <dt>是否开放</dt>
                <dd>{current.open ? "是" : "否"}</dd>
              </>
            ) : null}
          </dl>
        </div>

        <footer className="drawer-foot">
          <button className="btn btn-danger-ghost" onClick={() => void remove()} disabled={deleting}>
            <TrashIcon /> {deleting ? "正在删除…" : "删除这条记忆"}
          </button>
        </footer>
      </aside>
    </div>
  );
}

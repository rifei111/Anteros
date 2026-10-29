import { useEffect, useState } from "react";
import { invoke } from "../lib/kernel";
import type { MemoryItem } from "@anteros/shared";

/**
 * 聊天框上方的「它对这条对话的记忆」条。
 * 记忆按对话线分开存（app 主会话 / 微信某个人 / 某个群），这里只显示当前这条线。
 */
export function MemoryStrip({ conversation }: { conversation: string }) {
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setItems(null);
    void invoke("memory.list", { conversation, limit: 8 })
      .then((result) => {
        if (alive) setItems(result.items.filter((item) => item.kind === "episodic").slice(0, 8));
      })
      .catch(() => {
        if (alive) setItems([]);
      });
    return () => {
      alive = false;
    };
  }, [conversation]);

  if (items === null) return null;
  if (items.length === 0) {
    return (
      <div className="memory-strip memory-strip-empty">
        <span className="memory-strip-title">它对这条对话还没记住什么</span>
      </div>
    );
  }

  return (
    <div className={open ? "memory-strip memory-strip-open" : "memory-strip"}>
      <button className="memory-strip-head" onClick={() => setOpen(!open)} type="button">
        <span className="memory-strip-title">它记得关于这条对话的 {items.length} 件事</span>
        <span className="memory-strip-toggle">{open ? "收起" : "展开"}</span>
      </button>
      {open ? (
        <ul className="memory-strip-list">
          {items.map((item) => (
            <li key={item.id}>{item.text}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

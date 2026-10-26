import { useEffect } from "react";
import { closeAdmin, closeSearch } from "../lib/app";
import { useAppState } from "../lib/store";
import { AdminDrawer } from "../admin/AdminDrawer";
import { ChatPane } from "./ChatPane";
import { SearchOverlay } from "./SearchOverlay";
import { Sidebar } from "./Sidebar";

/**
 * 主界面骨架：左侧会话列表 + 右侧聊天区，搜索浮层与管理面板叠在上面。
 * Esc 依次关闭搜索浮层 / 管理面板（不关闭聊天本身）。
 */
export function ChatShell() {
  const state = useAppState();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (state.searchOpen) {
        closeSearch();
        return;
      }
      if (state.adminOpen) closeAdmin();
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => {
      globalThis.removeEventListener("keydown", onKeyDown);
    };
  }, [state.adminOpen, state.searchOpen]);

  return (
    <div className="shell">
      <Sidebar />
      <ChatPane />
      {state.searchOpen ? <SearchOverlay /> : null}
      {state.adminOpen ? <AdminDrawer /> : null}
    </div>
  );
}

import { useEffect } from "react";
import { startApp } from "./lib/app";
import { useAppState } from "./lib/store";
import { ChatShell } from "./components/ChatShell";
import { Connecting } from "./components/Connecting";
import { ConsentGate } from "./components/ConsentGate";
import { Onboarding } from "./components/Onboarding";
import { ToastStack } from "./components/Toast";
import { MemoryDetail } from "./components/MemoryDetail";

/**
 * 根组件：按阶段切换 启动页 / 声明闸 / 首次引导 / 聊天主界面。
 * 管理面板与搜索浮层是聊天主界面的一部分，记忆详情抽屉全局唯一。
 */
export function App() {
  const state = useAppState();

  useEffect(() => startApp(), []);

  return (
    <div className="app-root">
      {state.phase === "connecting" ? <Connecting /> : null}
      {state.phase === "consent" ? <ConsentGate /> : null}
      {state.phase === "onboarding" ? <Onboarding /> : null}
      {state.phase === "ready" ? <ChatShell /> : null}

      {state.memoryFocus ? <MemoryDetail item={state.memoryFocus} /> : null}
      <ToastStack />
    </div>
  );
}

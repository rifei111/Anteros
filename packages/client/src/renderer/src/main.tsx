import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { applyTheme, readThemeChoice } from "./lib/theme";
import "./styles.css";

// 首帧之前就把主题写进 <html data-theme>，否则深色用户会看到一帧亮色。
applyTheme(readThemeChoice());

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}
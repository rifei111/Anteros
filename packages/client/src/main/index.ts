/**
 * Electron 主进程入口。
 *
 * 职责：
 * 1. 单实例锁与窗口生命周期（默认 1180×780，最小 960×640，无原生菜单栏）
 * 2. 启动 / 守护内核子进程（`KernelClient`），内核事件转发给渲染进程
 * 3. 渲染进程 → 内核的 IPC 桥（所有内核调用都收在这里，页面拿不到管道名与 token）
 *
 * 数据目录：默认 `app.getPath("userData")`，即 %APPDATA%\\Anteros；
 * 可用 `ANTEROS_DATA_DIR` 覆盖（自检/CI 隔离数据，内核也认这个 env）。
 * 人格与记忆只存在这台电脑上。
 * 插件目录：开发期用仓库内 plugins/，打包后用 resources/plugins（electron-builder extraResources）。
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { IPC_CHANNEL, type IpcResult } from "../common/protocol";
import { KernelCallError, KernelClient } from "./kernel-client";

const WINDOW_WIDTH = 1180;
const WINDOW_HEIGHT = 780;
const MIN_WINDOW_WIDTH = 960;
const MIN_WINDOW_HEIGHT = 640;

/**
 * 自检（smoke）模式：只有显式设置环境变量才生效，默认行为完全不变。
 * - `ANTEROS_SMOKE_SCREENSHOT=<绝对路径.png>`：自动走完指定视图后截图写盘并退出。
 * - `ANTEROS_SMOKE_VIEW=consent|chat|admin`：截图哪个视图（默认 consent）。
 *   consent = 停在声明闸；chat = 勾完九条、选预设、进聊天；
 *   admin = 进聊天后打开管理面板。chat/admin 走的是真实 UI 点击，不是接口注入。
 * - `ANTEROS_SMOKE_SKIP_CONSENT=1`：仅用于 consent 视图——声明闸未过也照常截图，不勾选、不绕过闸。
 */
type SmokeView = "consent" | "chat" | "admin";

const SMOKE_SCREENSHOT_PATH =
  typeof process.env.ANTEROS_SMOKE_SCREENSHOT === "string" && process.env.ANTEROS_SMOKE_SCREENSHOT.length > 0
    ? process.env.ANTEROS_SMOKE_SCREENSHOT
    : null;
const SMOKE_SKIP_CONSENT = process.env.ANTEROS_SMOKE_SKIP_CONSENT === "1";
const SMOKE_VIEW: SmokeView =
  process.env.ANTEROS_SMOKE_VIEW === "chat"
    ? "chat"
    : process.env.ANTEROS_SMOKE_VIEW === "admin"
      ? "admin"
      : "consent";
const SMOKE_SETTLE_MS = 2_000;
const SMOKE_TIMEOUT_MS = 20_000;

/** 数据目录可用 ANTEROS_DATA_DIR 覆盖（自检隔离数据，不污染 %APPDATA%\\Anteros）。 */
function resolveDataDir(): string {
  const override = process.env.ANTEROS_DATA_DIR;
  if (typeof override === "string" && override.trim().length > 0) return override;
  return app.getPath("userData");
}

/** 必须在 whenReady 之前设置，userData 才会是 %APPDATA%\\Anteros。 */
app.setName("Anteros");
if (process.platform === "win32") {
  app.setAppUserModelId("com.anteros.app");
}

let mainWindow: BrowserWindow | null = null;
let kernel: KernelClient | null = null;
let quitting = false;

function toFailure(error: unknown): IpcResult<never> {
  if (error instanceof KernelCallError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.hint ? { hint: error.hint } : {}),
        ...(error.detail ? { detail: error.detail } : {}),
      },
    };
  }
  if (error instanceof Error) {
    return { ok: false, error: { code: "EUNKNOWN", message: error.message } };
  }
  return { ok: false, error: { code: "EUNKNOWN", message: "未知错误" } };
}

function broadcast(method: string, params: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    window.webContents.send(IPC_CHANNEL.event, method, params);
  }
}

function registerIpcHandlers(client: KernelClient): void {
  ipcMain.handle(IPC_CHANNEL.invoke, async (_event, method: unknown, params: unknown) => {
    if (typeof method !== "string" || method.length === 0) {
      return { ok: false, error: { code: "EINVALID", message: "方法名不合法" } } satisfies IpcResult<never>;
    }
    try {
      const result = await client.invoke(method, params ?? {});
      return { ok: true, result } satisfies IpcResult<unknown>;
    } catch (error) {
      return toFailure(error);
    }
  });

  ipcMain.handle(IPC_CHANNEL.connection, () => client.getState());

  ipcMain.handle(IPC_CHANNEL.appInfo, () => ({
    version: app.getVersion(),
    platform: process.platform,
    userDataPath: client.getDataDir(),
  }));

  ipcMain.handle(
    IPC_CHANNEL.pickFile,
    async (
      _event,
      options: unknown,
    ): Promise<string | null> => {
      const parsed = options as
        | { title?: string; mode?: "open" | "save"; filters?: Array<{ name: string; extensions: string[] }> }
        | undefined;
      const title = typeof parsed?.title === "string" ? parsed.title : "选择文件";
      const filters = Array.isArray(parsed?.filters) ? parsed.filters : undefined;
      if (parsed?.mode === "save") {
        const result = await dialog.showSaveDialog({ title, filters });
        return result.canceled ? null : result.filePath ?? null;
      }
      const result = await dialog.showOpenDialog({
        title,
        filters,
        properties: ["openFile"],
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
  );

  ipcMain.handle(IPC_CHANNEL.revealFile, async (_event, filePath: unknown) => {
    if (typeof filePath !== "string" || filePath.length === 0) return;
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle(IPC_CHANNEL.quitApp, () => {
    quitGracefully(0);
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    title: "Anteros",
    backgroundColor: "#edf0f2",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  window.setMenuBarVisibility(false);

  window.once("ready-to-show", () => {
    window.show();
    scheduleSmokeScreenshot(window);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    const isDevServer =
      typeof process.env.ELECTRON_RENDERER_URL === "string" &&
      url.startsWith(process.env.ELECTRON_RENDERER_URL);
    if (!isDevServer && !url.startsWith("file://")) {
      event.preventDefault();
    }
  });

  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function scriptInPage(window: BrowserWindow, script: string): Promise<unknown> {
  return window.webContents.executeJavaScript(script, true);
}

/** 轮询页面里的表达式，直到为真；用于等真实 UI 状态切换（不伪造等待）。 */
async function waitForPage(window: BrowserWindow, predicate: string, what: string): Promise<void> {
  const deadline = Date.now() + SMOKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) throw new Error("窗口已关闭");
    const ready = await scriptInPage(window, `Boolean(${predicate})`).catch(() => false);
    if (ready === true) return;
    await sleep(250);
  }
  throw new Error(`等待「${what}」超时`);
}

/**
 * 真实 UI 路线：逐条勾完九条 → 进入 → 选预设 → 开始聊天。
 * 全是真实的 DOM 点击（走组件自己的 handler），不做接口注入，也不跳过声明闸。
 */
async function driveToChat(window: BrowserWindow): Promise<void> {
  await waitForPage(
    window,
    `document.querySelector(".consent-card, .onboarding-card, .chat")`,
    "首屏（声明闸/引导/聊天）",
  );

  const hasConsentGate = await scriptInPage(window, `Boolean(document.querySelector(".consent-card"))`);
  if (hasConsentGate === true) {
    const checked = await scriptInPage(
      window,
      `(() => {
        const boxes = Array.from(document.querySelectorAll(".consent-list input[type=checkbox]"));
        for (const box of boxes) box.click();
        return boxes.length;
      })()`,
    );
    console.warn(`[anteros] 自检：已勾选声明 ${String(checked)} 条`);
    await waitForPage(
      window,
      `(() => { const b = document.querySelector(".consent-actions .btn-primary"); return Boolean(b) && !b.disabled; })()`,
      "「进入」按钮可用",
    );
    await scriptInPage(window, `(document.querySelector(".consent-actions .btn-primary")?.click(), true)`);
    await waitForPage(window, `!document.querySelector(".consent-card")`, "离开声明闸");
  }

  await waitForPage(window, `document.querySelector(".onboarding-card, .chat")`, "引导或聊天界面");
  const hasOnboarding = await scriptInPage(window, `Boolean(document.querySelector(".onboarding-card"))`);
  if (hasOnboarding === true) {
    await scriptInPage(
      window,
      `(() => { const card = document.querySelector(".preset-card"); if (card) card.click(); return Boolean(card); })()`,
    );
    await sleep(400);
    await waitForPage(
      window,
      `(() => { const b = document.querySelector(".onboarding-foot .btn-primary"); return Boolean(b) && !b.disabled; })()`,
      "「开始聊天」按钮可用",
    );
    await scriptInPage(window, `(document.querySelector(".onboarding-foot .btn-primary")?.click(), true)`);
    await waitForPage(window, `document.querySelector(".chat")`, "聊天界面");
  }
}

async function openAdminPanel(window: BrowserWindow): Promise<void> {
  await scriptInPage(
    window,
    `(() => {
      const gear = Array.from(document.querySelectorAll("button")).find((b) =>
        ((b.getAttribute("aria-label") || "") + (b.getAttribute("title") || "")).includes("管理面板"));
      if (gear) gear.click();
      return Boolean(gear);
    })()`,
  );
  await waitForPage(window, `document.querySelector(".admin-drawer")`, "管理面板");
}

async function captureSmokeScreenshot(window: BrowserWindow, targetPath: string): Promise<void> {
  const image = await window.webContents.capturePage();
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, image.toPNG());
  console.warn(`[anteros] 自检截图已写入 ${targetPath}`);
}

function scheduleSmokeScreenshot(window: BrowserWindow): void {
  const targetPath = SMOKE_SCREENSHOT_PATH;
  if (!targetPath) return;
  if (SMOKE_VIEW === "consent" && SMOKE_SKIP_CONSENT) {
    console.warn("[anteros] 自检模式：声明闸未过也照常截图（不勾选，也不绕过声明闸本身）");
  }
  const timer = setTimeout(() => {
    void (async () => {
      try {
        if (SMOKE_VIEW !== "consent") {
          await driveToChat(window);
          if (SMOKE_VIEW === "admin") await openAdminPanel(window);
        }
        await sleep(SMOKE_SETTLE_MS);
        await captureSmokeScreenshot(window, targetPath);
      } catch (error) {
        console.error("[anteros] 自检流程失败，仍尝试截图：", error);
        try {
          await captureSmokeScreenshot(window, targetPath);
        } catch (captureError) {
          console.error("[anteros] 自检截图失败:", captureError);
        }
      } finally {
        quitGracefully(0);
      }
    })();
  }, 800);
  timer.unref();
}

function quitGracefully(exitCode: number): void {
  if (quitting) return;
  quitting = true;
  const client = kernel;
  kernel = null;
  if (!client) {
    app.exit(exitCode);
    return;
  }
  void client
    .shutdown()
    .catch(() => undefined)
    .finally(() => {
      app.exit(exitCode);
    });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    // Windows 客户端不提供原生菜单栏（自绘在页面内）
    Menu.setApplicationMenu(null);

    // 默认 %APPDATA%\Anteros；可用 ANTEROS_DATA_DIR 覆盖（自检/CI 隔离数据）
    const dataDir = resolveDataDir();
    // 开发期：仓库根 plugins/；打包后：resources/plugins
    const pluginsDir = app.isPackaged
      ? join(process.resourcesPath, "plugins")
      : join(__dirname, "../../../../plugins");

    const client = new KernelClient({ dataDir, pluginsDir });
    kernel = client;
    client.onEvent((method, params) => {
      broadcast(method, params);
    });

    registerIpcHandlers(client);

    mainWindow = createWindow();
    client.start();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length > 0) return;
      mainWindow = createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") quitGracefully(0);
  });

  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitGracefully(0);
  });
}

/**
 * Electron 主进程入口。
 *
 * 职责：
 * 1. 单实例锁与窗口生命周期（默认 1180×780，最小 960×640，无原生菜单栏）
 * 2. 启动 / 守护内核子进程（`KernelClient`），内核事件转发给渲染进程
 * 3. 渲染进程 → 内核的 IPC 桥（所有内核调用都收在这里，页面拿不到管道名与 token）
 *
 * 数据目录：`app.getPath("userData")`，即 %APPDATA%\\Anteros —— 人格与记忆只存在这台电脑上。
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
 * - `ANTEROS_SMOKE_SCREENSHOT=<绝对路径.png>`：窗口就绪 5 秒后截图写盘并退出。
 * - `ANTEROS_SMOKE_SKIP_CONSENT=1`：仅标记"这是自检运行，声明闸未过也照常截图"。
 *   它不会勾选、不会绕过声明闸——首启时截到的就是声明闸本身。
 */
const SMOKE_SCREENSHOT_PATH =
  typeof process.env.ANTEROS_SMOKE_SCREENSHOT === "string" && process.env.ANTEROS_SMOKE_SCREENSHOT.length > 0
    ? process.env.ANTEROS_SMOKE_SCREENSHOT
    : null;
const SMOKE_SKIP_CONSENT = process.env.ANTEROS_SMOKE_SKIP_CONSENT === "1";
const SMOKE_DELAY_MS = 5_000;

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

function scheduleSmokeScreenshot(window: BrowserWindow): void {
  const targetPath = SMOKE_SCREENSHOT_PATH;
  if (!targetPath) return;
  if (SMOKE_SKIP_CONSENT) {
    console.warn("[anteros] 自检模式：声明闸未过也照常截图（不勾选，也不绕过声明闸本身）");
  }
  const timer = setTimeout(() => {
    void (async () => {
      try {
        const image = await window.webContents.capturePage();
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, image.toPNG());
        console.warn(`[anteros] 自检截图已写入 ${targetPath}`);
      } catch (error) {
        console.error("[anteros] 自检截图失败:", error);
      } finally {
        quitGracefully(0);
      }
    })();
  }, SMOKE_DELAY_MS);
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

    // %APPDATA%\Anteros —— 与内核 ANTEROS_DATA_DIR 同一个目录
    const dataDir = app.getPath("userData");
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

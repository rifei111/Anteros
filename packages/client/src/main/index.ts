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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { IPC_CHANNEL, UNINSTALL_METHOD, UPDATE_EVENT_CHANNEL, UPDATE_METHODS, type IpcResult } from "../common/protocol";
import { KernelCallError, KernelClient } from "./kernel-client";
import { runUninstaller } from "./uninstall";
import { AppUpdater, type UpdateStatus } from "./updater";

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
/** 自检用：把面板可见文本与更新状态写成 JSON，方便无头核对（截图看不了时靠它）。 */
const SMOKE_REPORT_PATH = (process.env.ANTEROS_SMOKE_REPORT ?? "").trim();

/** 自检用：`check` 只检查更新，`download` 检查并真的下载（验证增量更新链路）。 */
const SMOKE_UPDATE = (process.env.ANTEROS_SMOKE_UPDATE ?? "").trim();
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

/** 渲染层报错收集（自检时写进报告，平时只看控制台）。 */
const rendererLogs: string[] = [];
/** 自检时额外点开的页签文本（如「人格」）；留空就等于老行为。 */
const SMOKE_TAB = (process.env.ANTEROS_SMOKE_TAB ?? "").trim();
/** 自检时填进「人格」页签的人设原文并点一次「编译成人格内核」，用来验证这条链路真能跑。 */
const SMOKE_PERSONA_TEXT = (process.env.ANTEROS_SMOKE_PERSONA_TEXT ?? "").trim();
/** 自检时点开的按钮文案（例如「录入密钥」「授权」），用来把弹窗截进图里。 */
const SMOKE_CLICK = (process.env.ANTEROS_SMOKE_CLICK ?? "").trim();
/** 自检时发出去的测试消息（chat 视图），用来确认一条消息只渲染一次。 */
const SMOKE_SEND = (process.env.ANTEROS_SMOKE_SEND ?? "").trim();

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
let updater: AppUpdater | null = null;
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

/** 更新状态推给所有窗口（不含窗口句柄，避免窗口销毁后报错）。 */
function broadcastUpdate(status: UpdateStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    window.webContents.send(UPDATE_EVENT_CHANNEL, status);
  }
}

function registerUpdaterHandlers(): void {
  ipcMain.handle(UPDATE_METHODS.status, () => updater?.getStatus() ?? null);
  ipcMain.handle(UPDATE_METHODS.check, async () => (updater ? await updater.check() : null));
  ipcMain.handle(UPDATE_METHODS.download, async () => (updater ? await updater.download() : null));
  ipcMain.handle(UPDATE_METHODS.install, () => updater?.install() ?? null);
}

/** 启动时建更新器：它只读 resources/app-update.yml（打包后）或 ANTEROS_UPDATE_FEED（联调）。 */
function startUpdater(): void {
  if (updater) return;
  const feedUrl = (process.env.ANTEROS_UPDATE_FEED ?? "").trim();
  updater = new AppUpdater({
    onStatus: (status) => broadcastUpdate(status),
    feedUrl: feedUrl.length > 0 ? feedUrl : null,
    logFile: join(app.getPath("userData"), "updater.log"),
  });
  updater.init();
  registerUpdaterHandlers();
}

/** 卸载：卸载程序在安装目录里；`keepData=false` 时先删数据目录再交给 NSIS。 */
function registerUninstallHandler(): void {
  ipcMain.handle(UNINSTALL_METHOD, (_event, options: unknown) => {
    const keepData = Boolean((options as { keepData?: boolean } | null)?.keepData ?? true);
    const result = runUninstaller({ keepData, dataDir: resolveDataDir() });
    console.log(`[uninstall] keepData=${keepData} → ${result.started ? result.uninstaller : result.message}`);
    return { started: result.started, message: result.message };
  });
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

  // 人设文档这类纯文本：路径只能来自系统对话框，渲染层拿不到任意路径
  ipcMain.handle(IPC_CHANNEL.readTextFile, async (_event, options: unknown) => {
    const parsed = options as { title?: string; filters?: Array<{ name: string; extensions: string[] }> } | undefined;
    const result = await dialog.showOpenDialog({
      title: typeof parsed?.title === "string" ? parsed.title : "打开文本文件",
      filters: Array.isArray(parsed?.filters) ? parsed.filters : undefined,
      properties: ["openFile"],
    });
    const filePath = result.canceled ? null : result.filePaths[0] ?? null;
    if (filePath === null) return null;
    const text = await readFile(filePath, "utf8");
    return { path: filePath, text };
  });

  ipcMain.handle(IPC_CHANNEL.saveTextFile, async (_event, text: unknown, options: unknown) => {
    const parsed = options as
      | { title?: string; defaultName?: string; filters?: Array<{ name: string; extensions: string[] }> }
      | undefined;
    const result = await dialog.showSaveDialog({
      title: typeof parsed?.title === "string" ? parsed.title : "保存文本文件",
      defaultPath: typeof parsed?.defaultName === "string" ? parsed.defaultName : undefined,
      filters: Array.isArray(parsed?.filters) ? parsed.filters : undefined,
    });
    const filePath = result.canceled ? null : result.filePath ?? null;
    if (filePath === null) return null;
    await writeFile(filePath, typeof text === "string" ? text : "", "utf8");
    return filePath;
  });
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

  // 渲染层的报错别丢在控制台里：自检时落进报告，平时进日志，报障时能直接查。
  // Electron 45 的签名还是数字 level：0=verbose 1=info 2=warning 3=error
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const name = level >= 3 ? "error" : level === 2 ? "warning" : null;
    if (name === null) return;
    const line1 = `[renderer] ${name}: ${message} (${sourceId}:${line})`;
    console.warn(line1);
    if (SMOKE_REPORT_PATH) rendererLogs.push(line1);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    const line1 = `[renderer] 进程退出：${details.reason} (exitCode=${details.exitCode})`;
    console.warn(line1);
    if (SMOKE_REPORT_PATH) rendererLogs.push(line1);
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
  await openAdminTab(window);
}

/**
 * 自检时切到指定页签（`ANTEROS_SMOKE_TAB=人格`）。
 * 只是点击真实按钮，不预设任何状态；找不到就保持默认页签。
 */
async function openAdminTab(window: BrowserWindow): Promise<void> {
  const label = SMOKE_TAB;
  if (label.length === 0) return;
  await scriptInPage(
    window,
    `(() => {
      const wanted = ${JSON.stringify(label)};
      const tab = Array.from(document.querySelectorAll(".admin-nav .admin-tab"))
        .find((b) => (b.textContent || "").trim() === wanted);
      if (tab) tab.click();
      return Boolean(tab);
    })()`,
  );
  await sleep(600);
  await clickSmokeButton(window);
  await fillPersonaAndCompile(window);
}

/** 自检用：点一个文案里带指定字样的按钮（例如「录入密钥」「授权」），用来截到弹窗。 */
async function clickSmokeButton(window: BrowserWindow): Promise<void> {
  if (SMOKE_CLICK.length === 0) return;
  // 用 | 串多步（例如「授权|确认授权|授权」），每步优先点当前弹窗里的按钮
  for (const text of SMOKE_CLICK.split("|").map((item) => item.trim()).filter((item) => item.length > 0)) {
    // 「#fill=xxxx」这一步不点按钮，往当前弹窗的第一个输入框里填值（密钥弹窗要它）
    if (text.startsWith("#fill=")) {
      const value = text.slice("#fill=".length);
      await scriptInPage(
        window,
        `(() => {
          const input = document.querySelector(".modal input.input, .modal input");
          if (!input) return false;
          const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          setValue.call(input, ${JSON.stringify(value)});
          input.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        })()`,
      );
      await sleep(500);
      continue;
    }
    // 「#type=选择器=值」：不点按钮，往指定输入框/文本域里填值（React onChange 要真 input 事件）
    if (text.startsWith("#type=")) {
      const spec = text.slice("#type=".length);
      const split = spec.indexOf("=");
      const selector = spec.slice(0, split);
      const value = spec.slice(split + 1);
      await scriptInPage(
        window,
        `(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element) return false;
          const proto = element.tagName === "TEXTAREA"
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          const setValue = Object.getOwnPropertyDescriptor(proto, "value").set;
          setValue.call(element, ${JSON.stringify(value)});
          element.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        })()`,
      );
      await sleep(400);
      continue;
    }
    // 「#scrollsel=选择器」：把指定元素滚到视野中间（比按文字找更准）
    if (text.startsWith("#scrollsel=")) {
      await scriptInPage(
        window,
        `(() => {
          const element = document.querySelector(${JSON.stringify(text.slice("#scrollsel=".length))});
          if (!element) return false;
          element.scrollIntoView({ block: "center" });
          return true;
        })()`,
      );
      await sleep(500);
      continue;
    }
    // 「#scroll=某段文字」：把含这段文字的元素滚到视野中间，方便截图
    if (text.startsWith("#scroll=")) {
      const wanted = text.slice("#scroll=".length);
      await scriptInPage(
        window,
        `(() => {
          const wanted = ${JSON.stringify(wanted)};
          const element = Array.from(document.querySelectorAll(".admin-panel *"))
            .find((item) => (item.textContent || "").includes(wanted) && item.children.length <= 3);
          if (!element) return false;
          element.scrollIntoView({ block: "center" });
          return true;
        })()`,
      );
      await sleep(500);
      continue;
    }
    const clicked = await scriptInPage(
      window,
      `(() => {
        const raw = ${JSON.stringify(text)};
        const [rowHint, wanted] = raw.includes(">") ? raw.split(">").map((item) => item.trim()) : ["", raw];
        const scopes = [];
        if (rowHint.length > 0) {
          const row = Array.from(document.querySelectorAll("tr")).find((item) =>
            (item.textContent || "").includes(rowHint),
          );
          if (row) scopes.push(row);
        }
        const modals = Array.from(document.querySelectorAll(".modal"));
        for (const modal of modals) scopes.push(modal);
        scopes.push(document.querySelector(".admin-panel") || document.body);
        for (const scope of scopes) {
          const button = Array.from(scope.querySelectorAll("button")).find(
            (item) => (item.textContent || "").trim() === wanted && !item.disabled,
          );
          if (button) {
            button.click();
            return true;
          }
        }
        return false;
      })()`,
    );
    console.warn(`[anteros] 自检点击「${text}」：${clicked === true ? "成功" : "没找到"}`);
    await sleep(1_400);
  }
}

/** 自检用：往人设输入框里写一段话并点「编译成人格内核」（真实 input 事件，走 React onChange）。 */
async function fillPersonaAndCompile(window: BrowserWindow): Promise<void> {
  if (SMOKE_PERSONA_TEXT.length === 0) return;
  await scriptInPage(
    window,
    `(() => {
      const text = ${JSON.stringify(SMOKE_PERSONA_TEXT)};
      const area = document.querySelector(".admin-panel textarea");
      if (!area) return false;
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setValue.call(area, text);
      area.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`,
  );
  await sleep(400);
  await scriptInPage(
    window,
    `(() => {
      const button = Array.from(document.querySelectorAll(".admin-panel button"))
        .find((b) => (b.textContent || "").includes("编译成人格内核"));
      if (button) button.click();
      return Boolean(button);
    })()`,
  );
  await sleep(6_000);
  // 编译结果里最关键的是数值内核那一段，自检截屏把它滚到视野里
  await scriptInPage(
    window,
    `(() => {
      const grid = document.querySelector(".param-grid") || document.querySelector(".blueprint-note");
      if (!grid) return false;
      grid.scrollIntoView({ block: "center" });
      return true;
    })()`,
  );
  await sleep(500);
}

async function captureSmokeScreenshot(window: BrowserWindow, targetPath: string): Promise<void> {
  const image = await window.webContents.capturePage();
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, image.toPNG());
  console.warn(`[anteros] 自检截图已写入 ${targetPath}`);
}

/** 自检用：往输入框写一句话并点发送，用来肉眼确认「一条消息只出现一次」。 */
async function sendSmokeMessage(window: BrowserWindow): Promise<void> {
  if (SMOKE_SEND.length === 0) return;
  await waitForPage(window, `document.querySelector(".composer-input")`, "输入框");
  await scriptInPage(
    window,
    `(() => {
      const text = ${JSON.stringify(SMOKE_SEND)};
      const input = document.querySelector(".composer-input");
      if (!input) return false;
      const proto = window.HTMLTextAreaElement.prototype;
      const setValue = Object.getOwnPropertyDescriptor(proto, "value").set;
      setValue.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`,
  );
  await sleep(300);
  await scriptInPage(
    window,
    `(() => {
      const button = document.querySelector(".composer .send-btn");
      if (button) button.click();
      return Boolean(button);
    })()`,
  );
  // 等内核把回复分条发完（本地回声也有打字节奏），截图才有完整一来一回
  await sleep(12_000);
}

/**
 * 自检用：走一遍真实的应用内更新（检查 → 下载），把状态打到日志。
 * 不装、不重启：安装那一步必须由人点，这里只证明「能查到新版并下载下来」。
 */
async function driveUpdateFlow(window: BrowserWindow): Promise<void> {
  if (SMOKE_UPDATE !== "check" && SMOKE_UPDATE !== "download") return;
  const checked = await scriptInPage(
    window,
    `(async () => {
      const api = window.anteros && window.anteros.updates;
      if (!api) return { ok: false, message: "页面里没有更新桥" };
      const status = await api.check();
      return {
        ok: true,
        state: status ? status.state : null,
        version: status ? status.version : null,
        current: status ? status.currentVersion : null,
        message: status ? status.message : null,
      };
    })()`,
  );
  console.warn(`[anteros] 自检·检查更新：${JSON.stringify(checked)}`);
  await sleep(1_500);
  if (SMOKE_UPDATE !== "download") return;

  await scriptInPage(
    window,
    `(async () => {
      const api = window.anteros && window.anteros.updates;
      if (!api) return false;
      await api.download();
      return true;
    })()`,
  );

  const deadline = Date.now() + 180_000;
  let last = "";
  while (Date.now() < deadline) {
    const status = await scriptInPage(
      window,
      `(async () => {
        const api = window.anteros && window.anteros.updates;
        const status = api ? await api.status() : null;
        return status
          ? { state: status.state, percent: status.percent, version: status.version, message: status.message, transferred: status.transferred, total: status.total }
          : null;
      })()`,
    );
    const line = JSON.stringify(status);
    if (line !== last) {
      console.warn(`[anteros] 自检·下载更新：${line}`);
      last = line;
    }
    const state = (status as { state?: string } | null)?.state;
    if (state === "downloaded" || state === "error" || state === "not-available") return;
    await sleep(1_000);
  }
  console.warn("[anteros] 自检·下载更新：等待超时");
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
          if (SMOKE_VIEW === "admin") {
            await openAdminPanel(window);
            await driveUpdateFlow(window);
          } else await sendSmokeMessage(window);
        }
        await sleep(SMOKE_SETTLE_MS);
        await writeSmokeReport(window);
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

/** 自检用：把当前面板文本与更新状态落盘，便于在没有图形界面时核对结果。 */
async function writeSmokeReport(window: BrowserWindow): Promise<void> {
  if (!SMOKE_REPORT_PATH) return;
  try {
    const report = await scriptInPage(
      window,
      `(async () => {
        const api = window.anteros && window.anteros.updates;
        const status = api ? await api.status() : null;
        const panel = document.querySelector(".admin-panel");
        return {
          updateStatus: status,
          panelText: (panel ? panel.innerText : document.body.innerText || "").slice(0, 4000),
        };
      })()`,
    );
    const merged = { ...(report as Record<string, unknown>), rendererLogs: rendererLogs.slice(-40) };
    writeFileSync(SMOKE_REPORT_PATH, JSON.stringify(merged, null, 2), "utf8");
    console.warn(`[anteros] 自检报告已写：${SMOKE_REPORT_PATH}`);
  } catch (error) {
    console.error("[anteros] 自检报告失败:", error);
  }
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

/**
 * 单实例锁：正常使用时不允许多开（同一个数据目录抢 SQLite 会出事）。
 * 自检/排障时可用 ANTEROS_ALLOW_MULTI_INSTANCE=1 关掉锁，配合独立的 ANTEROS_DATA_DIR 跑第二份。
 */
const allowMultiInstance = process.env.ANTEROS_ALLOW_MULTI_INSTANCE === "1";
const gotLock = allowMultiInstance ? true : app.requestSingleInstanceLock();
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
    // 内置微信通道的 sidecar 目录：打包后在 resources/integrations，开发期在仓库根 integrations
  // （开发期不能用 app.getAppPath()：跑 out/main/index.cjs 时它指向脚本目录，算出来会差两级）
  process.env.ANTEROS_WECHAT_SIDECAR_DIR = app.isPackaged
    ? join(process.resourcesPath, "integrations", "wechatauto-sidecar")
    : join(__dirname, "..", "..", "..", "..", "integrations", "wechatauto-sidecar");
  const pluginsDir = app.isPackaged
      ? join(process.resourcesPath, "plugins")
      : join(__dirname, "../../../../plugins");

    const client = new KernelClient({ dataDir, pluginsDir });
    kernel = client;
    client.onEvent((method, params) => {
      broadcast(method, params);
    });

    registerIpcHandlers(client);
    registerUninstallHandler();
    startUpdater();

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

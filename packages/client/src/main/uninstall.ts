/**
 * 卸载：把"卸载程序本身"和"删不删数据"分开。
 *
 * 为什么不用注册表找卸载项：NSIS 卸载器就摆在安装目录里（`Uninstall Anteros.exe`），
 * 认文件名比认 GUID 稳，也不会误碰别的应用。
 * 为什么数据默认保留：卸载是"软件不要了"，不是"记忆不要了"；想连数据一起删要自己勾。
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { spawn } from "node:child_process";

export interface UninstallOptions {
  keepData: boolean;
  /** 数据目录（`%APPDATA%\Anteros` 这一类），keepData=false 时整个删掉 */
  dataDir: string;
}

export interface UninstallResult {
  started: boolean;
  message: string;
  uninstaller?: string;
}

/** 安装目录里那个 `Uninstall xxx.exe`（开发模式下不存在）。 */
export function findUninstaller(): string | null {
  if (!app.isPackaged) return null;
  const dir = path.dirname(app.getPath("exe"));
  try {
    const candidate = readdirSync(dir).find((name) => /^uninstall.*\.exe$/i.test(name));
    return candidate ? path.join(dir, candidate) : null;
  } catch {
    return null;
  }
}

export function runUninstaller(options: UninstallOptions): UninstallResult {
  const uninstaller = findUninstaller();
  if (!uninstaller) {
    return {
      started: false,
      message: app.isPackaged
        ? "没在安装目录里找到卸载程序（可能是绿色版或手动解压的目录）。可以直接删掉安装目录，数据目录在设置里能看到路径。"
        : "当前是开发模式（没有打包），没有卸载程序。开发模式下直接关掉进程即可。",
    };
  }

  if (!options.keepData) {
    // 先把数据删掉，再交给 NSIS：卸载器只会删自己装的文件，不会替我们清 %APPDATA%
    const targets = [options.dataDir, path.join(app.getPath("appData"), "Anteros")];
    for (const target of new Set(targets)) {
      if (!existsSync(target)) continue;
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        // 文件可能正被占用（内核 SQLite），卸载器跑完用户还能手动删；不因此中断卸载
      }
    }
  }

  // `/S` 是 NSIS 的静默参数：不弹向导，直接卸载
  const child = spawn(uninstaller, ["/S"], { detached: true, stdio: "ignore" });
  child.unref();
  setTimeout(() => app.quit(), 800);
  return { started: true, message: "卸载程序已启动", uninstaller };
}
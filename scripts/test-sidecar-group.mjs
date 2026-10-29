/**
 * 群聊解析自测：找一份能用的 Python 跑 sidecar 的纯函数测试。
 * 找不到 Python 就跳过（安装引导里已经讲清楚了，不用把这里变红灯）。
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const appData = process.env.APPDATA ?? "";
const candidates = [
  process.env.ANTEROS_SIDECAR_PYTHON,
  appData ? `${appData}\\Anteros\\wechat-runtime\\python-3.11.9\\python.exe` : null,
  "python",
  "python3",
].filter((item) => typeof item === "string" && item.length > 0);

const script = "integrations/wechatauto-sidecar/test_sidecar_group.py";
const python = candidates.find((item) => item === "python" || item === "python3" || existsSync(item));
if (!python) {
  console.log("[test-sidecar] 本机没有可用的 Python，跳过群聊解析测试");
  process.exit(0);
}
const result = spawnSync(python, [script], { stdio: "inherit", encoding: "utf8" });
if (result.error) {
  console.log("[test-sidecar] 启动 " + python + " 失败，跳过：" + result.error.message);
  process.exit(0);
}
process.exit(result.status ?? 1);
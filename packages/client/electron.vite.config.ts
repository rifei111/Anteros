import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

/**
 * 三份产物：
 * - main：强制 CJS 且后缀 .cjs —— Electron 45 的 ESM 主进程对 `electron` 具名导出
 *   （BrowserWindow 等）不兼容（SyntaxError: does not provide an export named ...），
 *   所以主进程也走 CJS，最稳。package.json main 指向 out/main/index.cjs
 * - preload：强制 CJS 且后缀 .cjs —— sandbox:true 的 preload 不能是 ESM；
 *   electron-vite 在 type=module 的项目里默认输出 [name].mjs，这里显式覆盖
 * - renderer：React 19；@anteros/shared 指向源码，类型与值都从同一处来
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    resolve: {
      alias: {
        "@renderer": resolve(__dirname, "src/renderer/src"),
        "@anteros/shared": resolve(__dirname, "../shared/src/index.ts"),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
  },
});

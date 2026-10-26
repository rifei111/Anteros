import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

/**
 * 三份产物：
 * - main：ESM（package.json type=module）→ out/main/index.js
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

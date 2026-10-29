import { defineConfig } from "vitest/config";

// 统一测试配置：内核是纯 TS，客户端组件测试要 JSX（automatic runtime）。
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    include: ["packages/**/test/**/*.test.{ts,tsx}"],
    environment: "node",
    restoreMocks: true,
  },
});
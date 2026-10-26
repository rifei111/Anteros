/**
 * preload 注入的全局桥类型声明（渲染层唯一能看到的"原生能力"）。
 * 实现见 src/preload/index.ts；契约见 @anteros/shared 的 ClientBridge。
 */

import type { ExtendedClientBridge } from "../common/protocol";

declare global {
  interface Window {
    anteros?: ExtendedClientBridge;
  }
}

export {};

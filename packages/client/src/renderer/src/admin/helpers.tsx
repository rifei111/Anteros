/**
 * 管理面板共用的小工具：数据加载、错误上报、二次确认 token、文案映射。
 *
 * 这里只做 UI 侧的簿记；所有真数据都来自 `invoke()`（KernelApi），
 * 危险操作先拿 `confirm.token`（60 秒一次性），再由内核自己校验。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { humanizeError } from "../lib/errors";
import { invoke } from "../lib/kernel";
import { pushToast } from "../lib/store";

export interface Loaded<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** 通用只读加载：挂载与依赖变化时重新请求，失败给人话并 toast。 */
export function useLoad<T>(loader: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loaderRef
      .current()
      .then((value) => {
        if (!alive) return;
        setData(value);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!alive) return;
        const human = humanizeError(caught);
        const message = human.hint ? `${human.title}（${human.hint}）` : human.title;
        setError(message);
        pushToast("error", human.title, human.hint);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  return { data, loading, error, reload: () => setTick((value) => value + 1) };
}

/** 把任意错误变成一条顶部 toast（不弹原生 alert）。 */
export function reportError(error: unknown): void {
  const human = humanizeError(error);
  pushToast("error", human.title, human.hint);
}

/** 取一次性确认 token；调用方必须先做过二次确认。 */
export async function requestToken(action: string, target?: string): Promise<string> {
  const params = target === undefined ? { action } : { action, target };
  const result = await invoke("confirm.token", params);
  return result.token;
}

export const PLUGIN_KIND_LABEL: Record<string, string> = {
  channel: "通道",
  provider: "模型服务",
  processor: "处理器",
  media: "媒体",
  world: "世界信息",
  ui: "界面",
  ops: "运维",
};

const PERMISSION_TEXT: Record<string, string> = {
  "channel.read": "读取外部通道的消息（只读，可回填历史）",
  "channel.history": "回填外部通道的历史消息",
  "channel.send": "代它往外部通道发消息（写路径，要租约）",
  "channel.write": "往外部通道发消息（写路径，要租约）",
  "channel.lease": "占用通道写权限（拟人操作与真人操作互斥）",
  "channel.media": "下载 / 上传媒体文件",
  "llm.generate": "调用大模型生成回复（会计入成本）",
  "extract.memory": "把对话提炼成记忆",
  "media.speak": "合成语音（TTS）",
  "media.image": "生成图片",
  "world.info": "读取世界 / 环境信息",
  "ui.panel": "在管理面板里渲染自定义界面",
  "kernel.events": "订阅内核事件流",
  "kernel.config": "读写内核配置",
  "ui.foreground": "读取前台窗口标题（判断你是否在忙）",
  "memory.read": "读取本机记忆",
  "memory.write": "写入 / 修改本机记忆",
  llm: "调用大模型（会计入成本）",
  net: "访问网络",
  fs: "读写本机文件",
  ui: "在管理面板里渲染自定义界面",
  notify: "发系统通知",
};

/** 带参数的权限（`fs.read:路径` 这类），按前缀翻成人话。 */
const PARAMETERIZED_PERMISSION: { prefix: string; describe: (argument: string) => string }[] = [
  { prefix: "fs.read:", describe: (path) => `读取本机文件：${path}` },
  { prefix: "fs.write:", describe: (path) => `写入本机文件：${path}` },
  { prefix: "proc.read:", describe: (name) => `读取进程内存：${name}` },
  { prefix: "proc.patch:", describe: (name) => `改写进程内存：${name}` },
  { prefix: "net.allow:", describe: (host) => `联网访问：${host}` },
  { prefix: "secrets.read:", describe: (name) => `读取本机密钥：${name}` },
];

/** 「能碰什么」的人话解释；未知项保留原始声明，不替它美化。 */
export function describePermission(permission: string): string {
  const direct = PERMISSION_TEXT[permission];
  if (direct !== undefined) return direct;
  for (const item of PARAMETERIZED_PERMISSION) {
    if (permission.startsWith(item.prefix)) {
      return item.describe(permission.slice(item.prefix.length));
    }
  }
  return `${permission}（按插件声明执行）`;
}

export interface SectionProps {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}

export function Section({ title, hint, action, children }: SectionProps) {
  return (
    <section className="admin-section">
      <div className="admin-section-head">
        <div>
          <h3 className="admin-section-title">{title}</h3>
          {hint ? <p className="admin-section-hint">{hint}</p> : null}
        </div>
        {action ? <div className="admin-section-action">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function LoadingLine({ loading, error }: { loading: boolean; error: string | null }) {
  if (error) return <div className="inline-error">{error}</div>;
  if (loading) return <div className="empty-note">正在读取…</div>;
  return null;
}

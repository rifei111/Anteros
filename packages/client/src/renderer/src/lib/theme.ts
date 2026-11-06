/**
 * 主题：跟随系统 / 亮 / 暗。
 *
 * 只改渲染层的显示，不碰内核、不写数据库：主题是这台机器上「这支界面怎么显示」的偏好，
 * 所以存在 localStorage 里，键名 anteros.theme。取不到就按跟随系统处理。
 */
export type ThemeChoice = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "anteros.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export const THEME_OPTIONS: ReadonlyArray<{ id: ThemeChoice; label: string; hint: string }> = [
  { id: "system", label: "跟随系统", hint: "Windows 换成深色时，界面跟着换" },
  { id: "light", label: "亮色", hint: "纸面：暖白底、墨色字" },
  { id: "dark", label: "深色", hint: "晚上用：近黑底、暖白字" },
];

export function readThemeChoice(): ThemeChoice {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // 本地存储不可用（极少见）：不报错，按跟随系统。
  }
  return "system";
}

export function systemTheme(): ResolvedTheme {
  return window.matchMedia?.(DARK_QUERY).matches ? "dark" : "light";
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  return choice === "system" ? systemTheme() : choice;
}

/** 把解析后的主题写到 <html data-theme="…">，返回实际生效的那个。 */
export function applyTheme(choice: ThemeChoice): ResolvedTheme {
  const resolved = resolveTheme(choice);
  const root = document.documentElement;
  // 换主题时把过渡关掉一帧：否则 background 的 0.12s 过渡会在「隐藏窗口」里
  // 冻在起始色上（Chromium 暂停隐藏页的动画），恢复窗口前颜色是旧主题的。
  root.classList.add("no-transitions");
  root.dataset.theme = resolved;
  void root.offsetWidth;
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => root.classList.remove("no-transitions"));
  });
  return resolved;
}

export function writeThemeChoice(choice: ThemeChoice): ResolvedTheme {
  try {
    window.localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // 写不进去也不影响本次生效。
  }
  return applyTheme(choice);
}

/** 系统主题变化时回调；返回取消订阅的函数。 */
export function watchSystemTheme(onChange: () => void): () => void {
  const media = window.matchMedia?.(DARK_QUERY);
  if (!media) return () => {};
  const handler = (): void => onChange();
  media.addEventListener("change", handler);
  return () => media.removeEventListener("change", handler);
}
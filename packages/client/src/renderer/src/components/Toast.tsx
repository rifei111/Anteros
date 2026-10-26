import { dismissToast, useAppState } from "../lib/store";

/** 顶部 toast 栈：所有 invoke 失败都走这里，不弹原生 alert。 */
export function ToastStack() {
  const state = useAppState();
  if (state.toasts.length === 0) return null;

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {state.toasts.map((toast) => (
        <div className={`toast toast-${toast.level}`} key={toast.id}>
          <div className="toast-main">
            <div className="toast-title">{toast.title}</div>
            {toast.detail ? <div className="toast-detail">{toast.detail}</div> : null}
          </div>
          <button className="toast-close" onClick={() => dismissToast(toast.id)} aria-label="关闭提示">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

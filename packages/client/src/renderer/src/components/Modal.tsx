import { useCallback, useRef, useState, type ReactNode } from "react";

export interface ModalProps {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  /**
   * 压在其他模态之上（z-index 95 而不是 90）。
   * 二次确认永远要盖住触发它的那个弹窗，否则按钮点不到。
   */
  top?: boolean;
}

/** 通用模态（无原生 alert/confirm，全部自绘）。 */
export function Modal({ title, children, footer, onClose, wide = false, top = false }: ModalProps) {
  return (
    <div
      className={top ? "modal-mask modal-mask-top" : "modal-mask"}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <span className="modal-title">{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

/**
 * 二次确认：返回 boolean，由调用方决定是否再去拿 confirm.token。
 * 危险操作的 token 只在内核侧签发（60 秒一次性），前端不缓存。
 */
export function useConfirm(): { ask: (options: ConfirmOptions) => Promise<boolean>; node: ReactNode } {
  const [pending, setPending] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const ask = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setPending(options);
    });
  }, []);

  const settle = useCallback((value: boolean): void => {
    const resolver = resolverRef.current;
    resolverRef.current = null;
    setPending(null);
    resolver?.(value);
  }, []);

  const node = pending ? (
    <Modal
      title={pending.title}
      top
      onClose={() => settle(false)}
      footer={
        <>
          <button className="btn" onClick={() => settle(false)}>
            {pending.cancelLabel ?? "取消"}
          </button>
          <button
            className={`btn ${pending.danger ? "btn-danger" : "btn-primary"}`}
            onClick={() => settle(true)}
          >
            {pending.confirmLabel ?? "确认"}
          </button>
        </>
      }
    >
      <div className="confirm-body">{pending.body}</div>
    </Modal>
  ) : null;

  return { ask, node };
}

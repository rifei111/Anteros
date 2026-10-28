import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: string;
}

/**
 * 兜底：任何一处渲染抛错，都不要变成白屏。
 *
 * 白屏对用户来说等于"软件坏了"，还没法自助恢复；这里把错误摊开给人看，
 * 并把错误写进控制台（打包版也会被主进程落盘），下次报障时能直接查。
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, info: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 保留组件栈：比错误消息更能定位是哪块面板
    console.error("[anteros] 界面渲染失败：", error, info.componentStack);
    this.setState({ info: info.componentStack ?? "" });
  }

  private reload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash-screen">
        <div className="crash-card">
          <h1>这个界面没能画出来</h1>
          <p className="muted">
            程序本身还在跑，你的数据和记忆没动。点下面重新加载就能回到聊天；如果每次都出在同一个地方，
            把下面这段错误复制给我，我照着修。
          </p>
          <pre className="crash-detail">{`${error.name}: ${error.message}`}</pre>
          {this.state.info ? <pre className="crash-detail muted">{this.state.info.trim().slice(0, 1200)}</pre> : null}
          <div className="crash-actions">
            <button className="btn btn-lg" onClick={this.reload}>
              重新加载
            </button>
          </div>
        </div>
      </div>
    );
  }
}
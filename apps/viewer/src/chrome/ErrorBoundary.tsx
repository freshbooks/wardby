import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Defaults to reloading the webview. */
  onReload?: () => void;
}

interface State {
  error: Error | null;
}

/** Keeps a rendering bug from blanking the whole window: shows it and offers a reload. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("viewer crashed", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="gate" role="alert">
        <h2>Something went wrong</h2>
        <p className="error">{this.state.error.message}</p>
        <div className="gate-actions">
          <button type="button" className="primary" onClick={this.props.onReload ?? (() => window.location.reload())}>
            Reload
          </button>
        </div>
      </section>
    );
  }
}

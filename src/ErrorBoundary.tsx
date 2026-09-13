import { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  message: string | null;
}

// A render throw would otherwise unmount the whole tree and take the agent's queue
// with it. Uploaded JSON is validated at the parse boundary, so this is the net for
// what that validation does not anticipate.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("LabelCheck failed to render a case.", error, info);
  }

  render(): ReactNode {
    if (this.state.message === null) return this.props.children;
    return (
      <main className="empty-state" role="alert">
        <h1>Something went wrong displaying this case</h1>
        <p>
          No verification result is shown, so nothing here should be treated as a compliance decision.
          Reload the page to return to the sample cases, then re-upload the file that triggered this.
        </p>
        <p className="error-detail">{this.state.message}</p>
        <button className="secondary-button" type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </main>
    );
  }
}

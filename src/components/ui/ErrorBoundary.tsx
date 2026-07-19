import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "./Button";

type ErrorBoundaryProps = { children: ReactNode };
type ErrorBoundaryState = { error: Error | null };

/** Last-resort catch for uncaught render errors — without this, any exception
 * deep in the tree (a bad call/room state, a null ref) unmounts the whole app
 * to a blank window with no way back short of a manual restart. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled error in render tree:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-bg-primary p-8 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-danger/10 text-danger">
          <AlertTriangle size={22} aria-hidden="true" />
        </span>
        <div>
          <p className="text-sm font-medium text-text-primary">Something went wrong</p>
          <p className="mt-1 max-w-sm text-xs text-text-secondary">
            Colloquium hit an unexpected error and needs to restart this view. Your messages and
            calls aren't affected.
          </p>
        </div>
        <Button size="sm" onClick={() => this.setState({ error: null })}>
          Reload
        </Button>
      </div>
    );
  }
}

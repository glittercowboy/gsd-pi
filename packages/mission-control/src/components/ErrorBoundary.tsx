import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * React class component error boundary.
 * Catches uncaught render errors in the subtree and renders a fallback UI
 * instead of a white screen of death.
 *
 * Note: React class components are required for error boundaries in React 19.
 * This is the ONE allowed exception to the functional-component convention.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }): void {
    console.error("[ErrorBoundary] Uncaught render error:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="flex h-screen flex-col items-center justify-center gap-4 bg-navy-base text-white">
          <p className="text-sm text-gray-400">Something went wrong.</p>
          <button
            onClick={() => window.location.reload()}
            className="rounded px-4 py-2 text-sm bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/20 transition-colors"
          >
            Refresh
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

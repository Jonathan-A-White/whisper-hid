import { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("App crashed:", error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  handleClearAndReload = () => {
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
    try {
      const req = indexedDB.deleteDatabase("whisper-keyboard");
      req.onsuccess = () => window.location.reload();
      req.onerror = () => window.location.reload();
    } catch {
      window.location.reload();
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-black flex items-center justify-center p-8">
          <div className="text-center max-w-sm">
            <h1 className="text-xl font-bold text-red-400 mb-4">
              Something went wrong
            </h1>
            <p className="text-gray-400 text-sm mb-6">
              {this.state.error?.message || "An unexpected error occurred."}
            </p>
            <div className="space-y-3">
              <button
                onClick={this.handleReset}
                className="w-full bg-gray-800 text-white rounded px-4 py-2 text-sm"
              >
                Try Again
              </button>
              <button
                onClick={this.handleClearAndReload}
                className="w-full bg-red-900 text-red-200 rounded px-4 py-2 text-sm"
              >
                Clear Data &amp; Reload
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

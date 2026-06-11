'use client';

import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: React.ReactNode;
  fallbackTitle?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class TaskBoardErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[TaskBoardErrorBoundary] Caught error:', error, info);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center flex-1 gap-4 p-8">
          <div className="flex items-center gap-3 text-amber-400">
            <AlertTriangle className="w-6 h-6 flex-shrink-0" />
            <h2 className="text-lg font-semibold">
              {this.props.fallbackTitle ?? 'Something went wrong'}
            </h2>
          </div>
          <p className="text-slate-400 text-sm text-center max-w-md">
            The task board encountered an error. The rest of the app is still working.
          </p>
          {this.state.error && (
            <pre className="text-xs text-slate-500 bg-slate-800 rounded-lg px-4 py-3 max-w-lg w-full overflow-auto max-h-32">
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={this.handleReset}
            className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-sm rounded-lg border border-slate-600 transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

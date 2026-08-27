import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Optional fallback renderer; defaults to a simple error card. */
  fallback?: (error: Error, reset: () => void) => ReactNode
}

interface State {
  error: Error | null
}

/**
 * Catches rendering errors in the child tree and shows a fallback UI instead
 * of a blank screen. The "Retry" button remounts children by incrementing an
 * internal key.
 *
 * Place at the app root (main.tsx) and optionally around risky subtrees
 * (markdown rendering, MCP server panels).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Log to console for debugging; in production this could go to a reporter.
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  private reset = () => this.setState({ error: null })

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset)
      }
      return (
        <div className="error-boundary">
          <div className="error-boundary-card">
            <h2>Something went wrong</h2>
            <pre>{this.state.error.message}</pre>
            <button className="btn btn-primary" onClick={this.reset}>
              Retry
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

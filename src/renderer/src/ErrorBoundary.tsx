import { Component, type ReactNode } from 'react'

interface State {
  error: Error | null
}

// 렌더러 예외가 앱 전체를 빈 화면으로 만들지 않게 하는 최후 방어선
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, fontFamily: 'monospace' }}>
          <h2>⚠️ Renderer error</h2>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
            {this.state.error.stack ?? String(this.state.error)}
          </pre>
          <button onClick={() => location.reload()}>Reload</button>
        </div>
      )
    }
    return this.props.children
  }
}

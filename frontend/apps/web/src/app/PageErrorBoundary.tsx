import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * 单个 section 崩溃时的兜底 —— 没有它 React 会卸载整棵树,表现为整页黑屏。
 * 只包住 <Outlet />,header / 侧边栏 / 底部导航仍然可用;AppShell 用
 * location.pathname 做 key,切到别的页面会自动重置。
 */
export class PageErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('page crashed:', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6">
        <div className="text-sm font-medium text-destructive">
          页面加载失败 / Failed to load this page
        </div>
        <div className="mt-1 break-all text-xs text-muted-foreground">
          {this.state.error.message}
        </div>
        <button
          type="button"
          className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
          onClick={() => window.location.reload()}
        >
          刷新重试 / Reload
        </button>
      </div>
    )
  }
}

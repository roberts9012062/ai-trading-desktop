import { useSyncExternalStore, type ReactNode } from 'react'
import { Navigate, Link } from 'react-router-dom'
import { desktopLoginRequired, desktopSessionLocalOnly, onDesktopLoginChange } from '@/lib/desktop-login-session'
import { useAuthStore } from '@/stores/auth'

/** Block the layout itself, so cached credentials cannot mount private pages
 * or start their effects while this launch is waiting for a manual login. */
export function DesktopSessionGate({ children }: { children: ReactNode }): React.JSX.Element {
  const required = useSyncExternalStore(onDesktopLoginChange, desktopLoginRequired, () => true)
  const token = useAuthStore(state => state.accessToken)
  return required || !token ? <Navigate to="/login" replace /> : <>{children}</>
}

export function DesktopSessionNotice(): React.JSX.Element | null {
  const local = useSyncExternalStore(onDesktopLoginChange, desktopSessionLocalOnly, () => false)
  if (!local) return null
  return <div role="status" className="px-3 py-2 text-xs bg-amber-500/10 text-amber-400">本机离线会话 · 新建或重新启动任务需先 <Link to="/login" className="underline">服务器登录</Link></div>
}

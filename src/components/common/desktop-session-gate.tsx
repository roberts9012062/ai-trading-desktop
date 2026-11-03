import { useSyncExternalStore, type ReactNode } from 'react'
import { Navigate, Link } from 'react-router-dom'
import { desktopLoginRequired, desktopSessionLocalOnly, onDesktopLoginChange } from '@/lib/desktop-login-session'
import { useAuthStore } from '@/stores/auth'
import {hostSession,onHostSessionChange} from '@/lib/taskhost-client'
import {desktopSessionUsesTaskHost} from '@/lib/desktop-login-session'

/** Block the layout itself, so cached credentials cannot mount private pages
 * or start their effects while this launch is waiting for a manual login. */
export function DesktopSessionGate({ children, allowTaskHost=true }: { children: ReactNode;allowTaskHost?:boolean }): React.JSX.Element {
  const required = useSyncExternalStore(onDesktopLoginChange, desktopLoginRequired, () => true)
  const token = useAuthStore(state => state.accessToken)
  const loaded = useAuthStore(state => state.loaded)
  const host = useSyncExternalStore(onHostSessionChange,hostSession,hostSession)
  if (!required && desktopSessionUsesTaskHost()) {
    if (!host || host.mode==='server' && Date.parse(host.expiresAt)<=Date.now()) return <Navigate to="/login" replace />
    if(!loaded)return <div role="status" className="p-6 text-sm">正在恢复本地配置…</div>
    return allowTaskHost ? <>{children}</> : <Navigate to="/dashboard" replace />
  }
  return required || !token ? <Navigate to="/login" replace /> : <>{children}</>
}

export function DesktopSessionNotice(): React.JSX.Element | null {
  const local = useSyncExternalStore(onDesktopLoginChange, desktopSessionLocalOnly, () => false)
  const host = useSyncExternalStore(onHostSessionChange,hostSession,hostSession)
  if (host) return <div role="status" className="px-3 py-2 text-xs bg-emerald-500/10 text-emerald-400">{host.mode==='server'?'任务服务器已连接 · 原有页面与本地配置可继续使用':'单机模式 · 浏览本地页面和已有托管任务，新建任务需连接服务器'} · <Link to="/task-hosting" className="underline">打开任务托管</Link></div>
  if (!local) return null
  return <div role="status" className="px-3 py-2 text-xs bg-amber-500/10 text-amber-400">本机离线会话 · 新建或重新启动任务需先 <Link to="/login" className="underline">服务器登录</Link></div>
}

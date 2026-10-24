import { useEffect } from "react"
import { isTauri } from '@tauri-apps/api/core'
import { requireDesktopLogin } from '@/lib/desktop-login-session'
import { BrowserRouter } from "react-router-dom"
import { FontSizeProvider } from "@/components/common/font-size-provider"
import { attachErrorReporting, silentCheckForUpdate } from "@/lib/updater"
import { AppRoutes } from "./router"
import { DesktopFrame } from "@/components/common/desktop-titlebar"
import { RealtimeHost } from '@/components/common/realtime-host'
import { attachExecutionRuntime } from '@/lib/execution-runtime'

/** 根组件:对应原 Next 根 layout(FontSizeProvider + 全局路由 + 更新/错误上报) */
export default function App() {
  useEffect(() => {
    const lock = () => requireDesktopLogin()
    let disposed = false, unlisten: (() => void) | undefined
    window.addEventListener('desktop-login-required', lock)
    if (isTauri()) void import('@tauri-apps/api/event').then(events => events.listen('desktop-login-required', lock)).then(stop => {
      if (disposed) stop(); else unlisten = stop
    }).catch(() => {})
    return () => { disposed = true; unlisten?.(); window.removeEventListener('desktop-login-required', lock) }
  }, [])
  useEffect(()=>attachExecutionRuntime(),[])
  useEffect(() => {
    // 崩溃/错误落盘立即挂;更新检查延时静默(仅检测,新版本在
    // 侧边栏「检查更新」处以绿色版本号提醒,由用户点击后走弹窗流程)
    attachErrorReporting()
    const timer = setTimeout(() => {
      void silentCheckForUpdate()
    }, 10_000)
    return () => clearTimeout(timer)
  }, [])

  return (
    <BrowserRouter>
      <FontSizeProvider />
      <RealtimeHost />
      <DesktopFrame><AppRoutes /></DesktopFrame>
    </BrowserRouter>
  )
}

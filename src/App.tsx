import { useEffect } from "react"
import { BrowserRouter } from "react-router-dom"
import { FontSizeProvider } from "@/components/common/font-size-provider"
import { attachErrorReporting, silentCheckForUpdate } from "@/lib/updater"
import { AppRoutes } from "./router"
import { DesktopMinimizeDialog } from "@/components/common/desktop-minimize-dialog"

/** 根组件:对应原 Next 根 layout(FontSizeProvider + 全局路由 + 更新/错误上报) */
export default function App() {
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
      <DesktopMinimizeDialog />
      <AppRoutes />
    </BrowserRouter>
  )
}

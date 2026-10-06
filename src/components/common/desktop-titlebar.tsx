import { useEffect, useState, type ReactNode } from "react"
import { isTauri, invoke } from "@tauri-apps/api/core"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { ArrowDownToLine, Copy, Minus, Square, X } from "lucide-react"
import { BrandLogo } from "./brand-logo"

/** Global frame keeps window controls available on login and every app route. */
export function DesktopFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <DesktopTitlebar />
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  )
}

export function DesktopTitlebar() {
  const desktop = isTauri()
  const [maximized, setMaximized] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!desktop) return
    let disposed = false
    let unlisten: (() => void) | undefined
    const window = getCurrentWindow()
    const syncMaximized = () => {
      void window.isMaximized().then(value => {
        if (!disposed) setMaximized(value)
      }).catch(() => {})
    }
    syncMaximized()
    void window.onResized(syncMaximized).then(stop => {
      if (disposed) stop()
      else unlisten = stop
    }).catch(() => {})
    return () => { disposed = true; unlisten?.() }
  }, [desktop])

  if (!desktop) return null

  async function control(command: string) {
    if (busy) return
    setBusy(true)
    setError("")
    try {
      await invoke(command)
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  const buttonClass = "flex h-full w-11 shrink-0 items-center justify-center text-[var(--text-secondary)] transition-colors hover:bg-white/10 hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--primary)] disabled:opacity-40"
  return (
    <header aria-label="窗口控制" className="relative z-[100] flex h-9 shrink-0 select-none items-center border-b border-[var(--border)] bg-[var(--bg-secondary)]">
      <div
        data-testid="window-drag-region"
        className="flex h-full min-w-0 flex-1 items-center gap-2 px-3"
        onMouseDown={event => {
          if (event.button !== 0) return
          event.preventDefault()
          if (event.detail === 2) void control("desktop_toggle_maximize")
          else void getCurrentWindow().startDragging().catch(cause => setError(String(cause)))
        }}
      >
        <BrandLogo size={22} />
        <span className="truncate text-xs text-[var(--text-secondary)]">周期领航 · CyclePilot</span>
      </div>
      <button type="button" title="收起到托盘（后台运行）" aria-label="收起到托盘" disabled={busy} className={`${buttonClass} hover:text-[var(--primary)]`} onClick={() => void control("desktop_hide_to_tray")}>
        <ArrowDownToLine className="h-4 w-4" />
      </button>
      <button type="button" title="最小化" aria-label="最小化" disabled={busy} className={buttonClass} onClick={() => void control("desktop_minimize_window")}>
        <Minus className="h-4 w-4" />
      </button>
      <button type="button" title={maximized ? "还原窗口" : "最大化"} aria-label={maximized ? "还原窗口" : "最大化"} disabled={busy} className={buttonClass} onClick={() => void control("desktop_toggle_maximize")}>
        {maximized ? <Copy className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
      </button>
      <button type="button" title="关闭" aria-label="关闭" disabled={busy} className={`${buttonClass} hover:!bg-red-600 hover:!text-white`} onClick={() => void control("desktop_close_window")}>
        <X className="h-4 w-4" />
      </button>
      {error && (
        <div role="alert" className="absolute right-2 top-10 flex max-w-md items-center gap-3 rounded-md border border-red-500/30 bg-[var(--bg-secondary)] px-3 py-2 text-xs text-red-400 shadow-lg">
          <span>{error}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setError("")}><X className="h-3.5 w-3.5" /></button>
        </div>
      )}
    </header>
  )
}

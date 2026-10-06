"use client"

import { useEffect, useState } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { Minus, PanelBottomClose } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"

/** The native Windows minimize button opens this choice on every app page. */
export function DesktopMinimizeDialog(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isTauri()) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void listen("desktop-minimize-requested", () => {
      setError(null)
      setOpen(true)
    }).then(async (stop) => {
      if (disposed) { stop(); return }
      unlisten = stop
      await invoke("desktop_set_minimize_prompt_ready", { ready: true })
      // Cover unmount during the native handshake as well as during listen().
      if (disposed) await invoke("desktop_set_minimize_prompt_ready", { ready: false })
    }).catch((cause) => console.warn("最小化选择初始化失败", cause))
    return () => {
      disposed = true
      unlisten?.()
      void invoke("desktop_set_minimize_prompt_ready", { ready: false }).catch(() => {})
    }
  }, [])

  if (!isTauri()) return null

  const choose = async (command: "desktop_hide_to_tray" | "desktop_minimize_window"): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await invoke(command)
      setOpen(false)
    } catch (cause) {
      setError(`操作失败：${String(cause)}`)
    } finally {
      setBusy(false)
    }
  }

  const optionClass = "flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)] px-4 py-4 text-left transition-colors hover:border-[var(--primary)] hover:bg-[var(--bg-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-50 cursor-pointer"
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next) }}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle>选择最小化方式</DialogTitle>
          <DialogDescription>两种方式都会保持程序运行。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <button type="button" disabled={busy} onClick={() => void choose("desktop_minimize_window")} className={optionClass}>
            <Minus className="h-5 w-5 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
            <span><span className="block text-sm font-medium text-[var(--text-primary)]">正常最小化</span><span className="block mt-1 text-xs text-[var(--text-muted)]">保留任务栏图标，点击任务栏恢复窗口</span></span>
          </button>
          <button type="button" disabled={busy} onClick={() => void choose("desktop_hide_to_tray")} className={optionClass}>
            <PanelBottomClose className="h-5 w-5 shrink-0 text-[var(--primary)]" aria-hidden="true" />
            <span><span className="block text-sm font-medium text-[var(--text-primary)]">收起到托盘</span><span className="block mt-1 text-xs text-[var(--text-muted)]">隐藏窗口，点击右下角托盘图标恢复</span></span>
          </button>
        </div>
        {error && <p role="alert" className="text-xs text-[var(--accent-danger)]">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}

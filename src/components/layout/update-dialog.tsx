"use client"

/**
 * 软件更新弹窗(仅 Tauri 桌面端,由侧边栏「检查更新」控件唤起)。
 *
 * 流程:打开即显示当前版本并检查 →
 *   有新版 → 展示新版本号 + 更新内容(latest.json 的 notes)→「下载更新」
 *   → 下载进度条 → 下载完成询问「是否立即安装并重启」→ 确认后安装并重启;
 *   无新版/失败 → 提示,可重新检查。下载/安装中禁止关闭弹窗。
 */

import { useCallback, useEffect, useState } from "react"
import { CheckCircle2, Download, Loader2, RefreshCw } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  type DownloadProgress,
} from "@/lib/updater"
import { useUpdateStore } from "@/stores/update"

type Phase =
  | "checking" // 检查中
  | "latest" // 已是最新
  | "available" // 发现新版本,待下载
  | "downloading" // 下载中
  | "downloaded" // 已下载,待确认安装
  | "installing" // 安装中(随后自动重启)
  | "error" // 检查/下载/安装失败

const GREEN = "var(--accent-success, #22c55e)"

function formatMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatReleaseDate(iso?: string): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function UpdateDialog({
  open,
  onOpenChange,
  currentVersion,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 兜底版本号(getVersion());检查到更新时以 update.currentVersion 为准 */
  currentVersion: string
}): React.JSX.Element {
  const update = useUpdateStore((s) => s.update)
  const [phase, setPhase] = useState<Phase>("checking")
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [errorMsg, setErrorMsg] = useState("")

  const runCheck = useCallback(async () => {
    setPhase("checking")
    setErrorMsg("")
    try {
      const found = await checkForUpdate()
      if (!found) {
        // 清单回滚等场景:服务端已不提供更新,清掉绿标等残留状态
        useUpdateStore.getState().setAvailableUpdate(null)
        setPhase("latest")
        return
      }
      useUpdateStore.getState().setAvailableUpdate(found)
      // 同版本已下载过时 setAvailableUpdate 保留旧资源(downloaded 仍为 true)
      const st = useUpdateStore.getState()
      setPhase(st.update && st.downloaded ? "downloaded" : "available")
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
      setPhase("error")
    }
  }, [])

  useEffect(() => {
    if (!open) {
      // 关闭复位;下次打开按 store 状态决定直接进入哪一步
      setPhase("checking")
      setProgress(null)
      setErrorMsg("")
      return
    }
    const st = useUpdateStore.getState()
    if (st.update && st.downloaded) setPhase("downloaded")
    else if (st.update) setPhase("available")
    else void runCheck()
  }, [open, runCheck])

  async function handleDownload(): Promise<void> {
    const target = useUpdateStore.getState().update
    if (!target) return
    setPhase("downloading")
    setProgress(null)
    setErrorMsg("")
    try {
      await downloadUpdate(target, setProgress)
      useUpdateStore.getState().setDownloaded(true)
      setPhase("downloaded")
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
      setPhase("error")
    }
  }

  async function handleInstall(): Promise<void> {
    const target = useUpdateStore.getState().update
    if (!target) return
    setPhase("installing")
    setErrorMsg("")
    try {
      await installUpdate(target)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
      setPhase("error")
    }
  }

  function requestClose(next: boolean): void {
    // 下载/安装不可中断,期间禁止关闭弹窗
    if (!next && (phase === "downloading" || phase === "installing")) return
    onOpenChange(next)
  }

  const version = update?.currentVersion || currentVersion
  const releaseDate = formatReleaseDate(update?.date)
  const pct =
    progress && progress.contentLength > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.contentLength) * 100))
      : null

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>软件更新</DialogTitle>
          <DialogDescription>
            当前版本 <span className="font-mono">{version ? `v${version}` : "…"}</span>
          </DialogDescription>
        </DialogHeader>

        {phase === "checking" && (
          <div className="flex flex-col items-center gap-2 py-6 text-sm text-[var(--text-secondary)]">
            <Loader2 className="w-6 h-6 animate-spin text-[var(--primary)]" />
            正在检查更新…
          </div>
        )}

        {phase === "latest" && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 py-2 text-sm" style={{ color: GREEN }}>
              <CheckCircle2 className="w-5 h-5" />
              已是最新版本
            </div>
            <Button variant="outline" size="sm" onClick={() => void runCheck()}>
              <RefreshCw className="w-3.5 h-3.5" />
              重新检查
            </Button>
          </div>
        )}

        {(phase === "available" || phase === "downloading" || phase === "downloaded") && update && (
          <div className="space-y-3">
            <div className="flex items-end justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm text-[var(--text-secondary)]">最新版本</span>
                <span className="text-base font-semibold font-mono" style={{ color: GREEN }}>
                  v{update.version}
                </span>
              </div>
              {releaseDate && (
                <span className="text-xs text-[var(--text-muted)]">发布于 {releaseDate}</span>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="text-xs text-[var(--text-muted)]">更新内容</div>
              <div className="max-h-40 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-3 text-sm leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap break-words">
                {update.body?.trim() || "(本次更新未附说明)"}
              </div>
            </div>

            {phase === "available" && (
              <Button className="w-full" onClick={() => void handleDownload()}>
                <Download className="w-4 h-4" />
                下载更新
              </Button>
            )}

            {phase === "downloading" && (
              <div className="space-y-2">
                <div className="h-2 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
                  <div
                    className={cn(
                      "h-full rounded-full bg-[var(--primary)] transition-[width] duration-150",
                      pct === null && "w-full animate-pulse",
                    )}
                    style={pct === null ? undefined : { width: `${pct}%` }}
                  />
                </div>
                <div className="text-center text-xs text-[var(--text-secondary)]">
                  {pct !== null && progress
                    ? `${pct}% · ${formatMB(progress.downloaded)} / ${formatMB(progress.contentLength)}`
                    : `下载中…${progress ? ` 已下载 ${formatMB(progress.downloaded)}` : ""}`}
                </div>
                <div className="text-center text-[11px] text-[var(--text-muted)]">
                  正在下载更新包,请勿关闭应用
                </div>
              </div>
            )}

            {phase === "downloaded" && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm" style={{ color: GREEN }}>
                  <CheckCircle2 className="w-5 h-5" />
                  更新包下载完成,是否立即安装并重启应用?
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => requestClose(false)}
                  >
                    稍后再说
                  </Button>
                  <Button className="flex-1" onClick={() => void handleInstall()}>
                    立即安装并重启
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {phase === "installing" && (
          <div className="flex flex-col items-center gap-2 py-6 text-sm text-[var(--text-secondary)]">
            <Loader2 className="w-6 h-6 animate-spin text-[var(--primary)]" />
            正在安装更新,应用将自动重启…
          </div>
        )}

        {phase === "error" && (
          <div className="space-y-4">
            <div className="rounded-md border border-[var(--accent-danger)]/30 bg-[var(--accent-danger)]/10 p-3 text-sm text-[var(--accent-danger)] break-all">
              {errorMsg || "更新操作失败"}
            </div>
            <Button variant="outline" size="sm" onClick={() => void runCheck()}>
              <RefreshCw className="w-3.5 h-3.5" />
              重试
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

"use client"

/**
 * 侧边栏「检查更新」控件(仅 Tauri 桌面端渲染,浏览器 dev 返回 null)。
 *
 * - 点击按钮:打开更新弹窗(显示当前版本,检查新版→更新内容→下载进度→确认安装)
 * - 发现新版本时(启动静默检查或上次检查):按钮区域出现绿色版本号提醒,
 *   折叠态为绿色角标点
 * - 齿轮:代理设置面板 —— 默认代理 / 直连 / 自定义,存 localStorage
 */

import { useEffect, useState } from "react"
import { RefreshCw, Settings2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { DEFAULT_UPDATE_PROXY, getUpdateProxy, setUpdateProxy } from "@/lib/updater"
import { useUpdateStore } from "@/stores/update"
import { UpdateDialog } from "./update-dialog"

/** 代理输入框当前值的三种来源展示 */
type ProxyMode = "default" | "direct" | "custom"

const GREEN = "var(--accent-success, #22c55e)"

export function UpdateControl({ collapsed }: { collapsed: boolean }): React.JSX.Element | null {
  const isTauri = Boolean(typeof window !== "undefined" && window.__TAURI_INTERNALS__)
  const [version, setVersion] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [proxyInput, setProxyInput] = useState("")
  const [proxyMode, setProxyMode] = useState<ProxyMode>("default")
  const [proxySaved, setProxySaved] = useState("")
  const pendingUpdate = useUpdateStore((s) => s.update)
  const newVersion = pendingUpdate?.version

  useEffect(() => {
    if (!isTauri) return
    void import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then(setVersion)
      .catch(() => {})
    syncProxyState()
  }, [isTauri])

  function syncProxyState(): void {
    const current = getUpdateProxy()
    const stored = localStorage.getItem("qh_update_proxy")
    setProxyMode(
      stored === null ? "default" : stored === "" ? "direct" : "custom",
    )
    setProxyInput(current ?? "")
  }

  function openUpdateDialog(): void {
    setPanelOpen(false)
    setDialogOpen(true)
  }

  function handleSaveProxy(mode: ProxyMode): void {
    if (mode === "default") setUpdateProxy(undefined)
    else if (mode === "direct") setUpdateProxy("")
    else {
      const v = proxyInput.trim()
      if (!/^https?:\/\/.+/i.test(v)) {
        setProxySaved("✗ 地址需以 http:// 或 https:// 开头")
        return
      }
      setUpdateProxy(v)
    }
    syncProxyState()
    setProxySaved("✓ 已保存")
  }

  if (!isTauri) return null

  return (
    <div className="px-2 pb-1 border-t border-[var(--border)] pt-2">
      {/* 折叠态:仅一个刷新图标按钮 + 新版本绿点角标 */}
      {collapsed ? (
        <button
          type="button"
          onClick={openUpdateDialog}
          title={newVersion ? `发现新版本 v${newVersion},点击更新` : "检查更新"}
          className={cn(
            "relative w-full flex items-center justify-center p-2 rounded-md transition-colors cursor-pointer",
            newVersion
              ? "hover:text-[var(--text-primary)]"
              : "text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]",
          )}
          style={newVersion ? { color: GREEN } : undefined}
        >
          <RefreshCw className="w-4 h-4" />
          {newVersion && (
            <span
              className="absolute top-1 right-1 w-2 h-2 rounded-full animate-pulse"
              style={{ backgroundColor: GREEN }}
            />
          )}
        </button>
      ) : (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={openUpdateDialog}
            className={cn(
              "flex-1 flex items-center justify-center gap-1.5 h-8 rounded-md border text-xs transition-colors cursor-pointer",
              newVersion
                ? "border-[var(--accent-success,#22c55e)]/40 hover:border-[var(--accent-success,#22c55e)]"
                : "border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--primary)]/50 hover:text-[var(--primary)]",
            )}
          >
            {newVersion ? (
              <span
                className="flex items-center gap-1.5 font-medium"
                style={{ color: GREEN }}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full animate-pulse"
                  style={{ backgroundColor: GREEN }}
                />
                发现新版本
              </span>
            ) : (
              <>
                <RefreshCw className="w-3.5 h-3.5" />
                检查更新
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => setPanelOpen((v) => !v)}
            title="更新代理设置"
            className="p-1.5 rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>
          {/* 新版本:绿色版本号提醒;平时:当前版本 */}
          {newVersion ? (
            <button
              type="button"
              onClick={openUpdateDialog}
              title={`新版本 v${newVersion}(当前 v${version || "?"}),点击查看`}
              className="text-[10px] font-medium font-mono shrink-0 cursor-pointer hover:underline"
              style={{ color: GREEN }}
            >
              v{newVersion}
            </button>
          ) : (
            version && (
              <span className="text-[10px] text-[var(--text-muted)] shrink-0">
                v{version}
              </span>
            )
          )}
        </div>
      )}

      {panelOpen && (
        <div className="mt-2 rounded-md border border-[var(--border)] p-2.5 space-y-2">
          <div className="text-[11px] text-[var(--text-muted)]">更新代理(拉取 GitHub 安装包用)</div>
          <div className="grid grid-cols-3 gap-1.5">
            {(
              [
                ["default", "默认"],
                ["direct", "直连"],
                ["custom", "自定义"],
              ] as [ProxyMode, string][]
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => handleSaveProxy(m)}
                className={cn(
                  "h-7 rounded-md border text-[11px] transition-colors cursor-pointer",
                  proxyMode === m
                    ? "border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--primary)]"
                    : "border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--primary)]/50",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            value={proxyInput}
            onChange={(e) => setProxyInput(e.target.value)}
            placeholder="http://用户:密码@地址:端口"
            className="w-full h-7 px-2 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] text-[11px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--primary)]/60"
          />
          {proxyMode === "custom" && (
            <button
              type="button"
              onClick={() => handleSaveProxy("custom")}
              className="w-full h-7 rounded-md bg-[var(--primary)] text-white text-[11px] cursor-pointer"
            >
              保存自定义代理
            </button>
          )}
          {proxySaved && (
            <div className="text-[11px] text-[var(--text-muted)]">{proxySaved}</div>
          )}
          <div className="text-[10px] text-[var(--text-muted)] leading-relaxed">
            默认代理:
            {DEFAULT_UPDATE_PROXY.replace(/\/\/.*@/, "//***@")}
            ;代理失败会自动回退直连。
          </div>
        </div>
      )}

      <UpdateDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        currentVersion={version}
      />
    </div>
  )
}

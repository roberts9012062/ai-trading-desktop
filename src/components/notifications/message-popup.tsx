"use client"

/**
 * 右下角消息弹窗
 *
 * - 监听 notifications store 的 popup，非空时滑入显示
 * - 10 秒后自动 dismiss
 * - 内容：类别徽标 + 标题 + 正文（截断 2 行）+ 已读按钮
 * - 位置 right-6 bottom-24：避开 FloatingAssistant 浮空按钮（默认 right:24 bottom:24）
 */

import { useEffect } from "react"
import { X, Check } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn, formatShanghaiTime } from "@/lib/utils"
import { useNotificationsStore } from "@/stores/notifications"
import type { MessageCategory } from "@/types"

/** 类别对应 Badge 文案 + 变体（颜色：system 蓝/risk 红/trade 绿/fund 琥珀） */
const CATEGORY_CFG: Record<
  MessageCategory,
  { label: string; variant: "default" | "destructive" | "up" | "outline" }
> = {
  system: { label: "系统", variant: "default" },
  risk: { label: "风控", variant: "destructive" },
  trade: { label: "交易", variant: "up" },
  fund: { label: "资金", variant: "outline" },
}

/** 自动消失延时 */
const AUTO_DISMISS_MS = 10_000

export function MessagePopup(): React.JSX.Element {
  const popup = useNotificationsStore((s) => s.popup)
  const dismissPopup = useNotificationsStore((s) => s.dismissPopup)
  const markRead = useNotificationsStore((s) => s.markRead)

  // popup 变化时重置 10s 定时器自动关闭
  useEffect(() => {
    if (!popup) return
    const timer = setTimeout(() => {
      dismissPopup()
    }, AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [popup, dismissPopup])

  const visible = Boolean(popup)
  const cfg = popup ? CATEGORY_CFG[popup.category] : null

  return (
    <div
      className={cn(
        // 右下角浮窗，z-50 略低于 FloatingAssistant 的 z-[90]，位于其上方避免遮住浮窗操作
        "fixed right-6 bottom-24 z-50 w-80 max-w-[calc(100vw-3rem)]",
        "rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] shadow-2xl",
        "transition-all duration-300 ease-out",
        visible
          ? "translate-x-0 opacity-100 pointer-events-auto"
          : "translate-x-6 opacity-0 pointer-events-none",
      )}
      role="alert"
      aria-live="polite"
    >
      {popup && cfg && (
        <div className="p-3 space-y-2">
          {/* 头部：类别徽标 + 关闭按钮 */}
          <div className="flex items-center justify-between">
            <Badge variant={cfg.variant} className="text-[10px]">
              {cfg.label}
            </Badge>
            <button
              type="button"
              onClick={dismissPopup}
              className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
              aria-label="关闭"
              title="关闭"
            >
              <X size={14} />
            </button>
          </div>

          {/* 标题 */}
          <p className="text-sm font-medium text-[var(--text-primary)] line-clamp-1">
            {popup.title}
          </p>

          {/* 正文：最多 2 行 */}
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed line-clamp-2">
            {popup.content}
          </p>

          {/* 时间 + 已读按钮 */}
          <div className="flex items-center justify-between pt-1">
            <span className="font-num text-[10px] text-[var(--text-muted)]">
              {formatShanghaiTime(popup.createdAt)}
            </span>
            <button
              type="button"
              onClick={() => void markRead(popup.id)}
              className="flex items-center gap-1 text-xs text-[var(--primary)] hover:opacity-80 transition-opacity cursor-pointer"
            >
              <Check size={12} />
              已读
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

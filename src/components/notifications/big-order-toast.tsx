"use client"

/**
 * 大单预警右下角弹窗（transient，不入库）
 *
 * 与 MessagePopup 独立：大单命中阈值时由 WS 事件触发，
 * 在右下角堆叠显示，单条 10 秒自动消失，使用用户自选色高亮。
 */

import { useEffect } from "react"
import { X, TrendingUp, TrendingDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { useBigOrderToastStore } from "@/stores/big-order-toast"
import { marketTickDirectionLabel } from "@/lib/trade-labels"
import { contractName } from "@/lib/contract-names"

const AUTO_DISMISS_MS = 10_000

/** 单条大单提醒卡片 */
function ToastCard({
  toast,
  onDismiss,
}: {
  toast: { id: number; symbol: string; direction: "buy" | "sell"; volume: number; price: number | null; color: string }
  onDismiss: (id: number) => void
}): React.JSX.Element {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [toast.id, onDismiss])

  const isBuy = toast.direction === "buy"
  const Icon = isBuy ? TrendingUp : TrendingDown

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn(
        "w-80 max-w-[calc(100vw-3rem)] rounded-lg border shadow-2xl",
        "bg-[var(--bg-secondary)] transition-all duration-300 ease-out",
        "animate-[fadeIn_0.3s_ease-in]",
      )}
      style={{ borderColor: toast.color }}
    >
      <div className="p-3 space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Icon className="h-3.5 w-3.5" style={{ color: toast.color }} />
            <span
              className="text-xs font-bold"
              style={{ color: toast.color }}
            >
              大单提醒
            </span>
          </div>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
            aria-label="关闭"
          >
            <X size={14} />
          </button>
        </div>
        <p className="text-sm font-bold text-[var(--text-primary)]">
          {contractName(toast.symbol)}
          <span
            className="ml-2"
            style={{ color: toast.color }}
          >
            {marketTickDirectionLabel(toast.direction)}
          </span>
        </p>
        <p className="text-xs text-[var(--text-secondary)]">
          单笔增量
          <span
            className="font-num font-bold ml-1"
            style={{ color: toast.color }}
          >
            {toast.volume}
          </span>
          手
          {toast.price != null && (
            <span className="ml-2 text-[var(--text-muted)]">
              @ {toast.price}
            </span>
          )}
        </p>
      </div>
    </div>
  )
}

export function BigOrderToastPopup(): React.JSX.Element {
  const toasts = useBigOrderToastStore((s) => s.toasts)
  const dismiss = useBigOrderToastStore((s) => s.dismiss)

  if (toasts.length === 0) return <></>

  // 与 MessagePopup 错开：定位在消息弹窗上方区域，新条目向下堆叠
  return (
    <div className="fixed right-6 bottom-44 z-50 flex flex-col gap-2 items-end">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={dismiss} />
      ))}
    </div>
  )
}

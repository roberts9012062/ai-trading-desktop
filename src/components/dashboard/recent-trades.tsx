"use client"

import {
  isBullishActionLabel,
  paperActionLabel,
} from "@/lib/trade-labels"
import { usePaperTradingStore } from "@/stores/paper-trading"
import { cn } from "@/lib/utils"

/** 格式化时间 */
function fmtTime(iso: string | null): string {
  if (!iso) return "--"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(11, 19) || iso
  return d.toLocaleTimeString("zh-CN", { hour12: false })
}

/** 数量（基础币，小数位最多 4） */
function fmtQty(q: number): string {
  return Number(q || 0).toLocaleString("zh-CN", { maximumFractionDigits: 4 })
}

/** 价格自适应精度 */
function fmtPx(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return "--"
  return p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(2) : p.toFixed(4)
}

/** 最近成交 —— 双模式：实盘=镜像订单（含了结回补）/ 虚拟盘=模拟成交 */
export function RecentTrades(): React.JSX.Element {
  const loaded = usePaperTradingStore((s) => s.loaded)
  const orders = usePaperTradingStore((s) => s.orders)

  const trades = orders
    .filter((o) => o.status === "filled")
    .sort(
      (a, b) =>
        new Date(b.filled_at || b.updated_at || b.created_at).getTime() -
        new Date(a.filled_at || a.updated_at || a.created_at).getTime()
    )
    .slice(0, 12)

  if (!loaded) {
    return (
      <div className="py-6 text-center text-sm text-[var(--text-muted)]">
        加载中…
      </div>
    )
  }

  if (trades.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-[var(--text-muted)]">
        暂无成交
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {trades.map((trade) => {
        const action = paperActionLabel(trade.direction, trade.offset)
        const closePnl = Number(trade.realized_pnl || 0)
        const showPnl =
          trade.offset === "close" && trade.realized_pnl != null && closePnl !== 0
        return (
          <div
            key={trade.id}
            className="flex items-center justify-between py-1.5 px-3 text-sm"
          >
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-[var(--text-muted)] font-num text-xs shrink-0">
                {fmtTime(trade.filled_at || trade.updated_at)}
              </span>
              <span className="text-[var(--text-primary)] truncate">
                {trade.symbol}
              </span>
              <span
                className={cn(
                  "text-xs shrink-0",
                  isBullishActionLabel(action) ? "text-up" : "text-down"
                )}
              >
                {action}
              </span>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-[var(--text-muted)] font-num">
                {fmtQty(Number(trade.filled_qty || trade.quantity))}
              </span>
              <span className="font-num text-[var(--text-primary)]">
                {fmtPx(Number(trade.price))}
              </span>
              {showPnl && (
                <span
                  className={cn(
                    "font-num text-xs w-14 text-right",
                    closePnl > 0 ? "text-up" : "text-down"
                  )}
                >
                  {closePnl > 0 ? "+" : ""}
                  {closePnl.toFixed(2)}
                </span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

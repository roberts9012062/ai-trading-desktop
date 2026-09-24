"use client"

import { useCallback, useEffect, useState } from "react"
import { getPaperOrders, type PaperOrderItem } from "@/lib/paper-api"
import {
  isBullishActionLabel,
  paperActionLabel,
} from "@/lib/trade-labels"
import { cn } from "@/lib/utils"

/** 格式化时间 */
function fmtTime(iso: string | null): string {
  if (!iso) return "--"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(11, 19) || iso
  return d.toLocaleTimeString("zh-CN", { hour12: false })
}

/** 最近成交 —— 已成交模拟委托 */
export function RecentTrades(): React.JSX.Element {
  const [trades, setTrades] = useState<PaperOrderItem[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const data = await getPaperOrders("filled", 12, 0)
      setTrades(data.items || [])
    } catch {
      setTrades([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, 12000)
    return () => clearInterval(timer)
  }, [load])

  if (loading) {
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
                  isBullishActionLabel(action) ? "text-up" : "text-down",
                )}
              >
                {action}
              </span>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-[var(--text-muted)]">
                {trade.filled_qty || trade.quantity}手
              </span>
              <span className="font-num text-[var(--text-primary)]">
                {trade.price}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

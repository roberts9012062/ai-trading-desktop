"use client"

import { useCallback, useEffect, useState } from "react"
import { getPaperPositions, type PaperPositionItem } from "@/lib/paper-api"
import { useMarketStore } from "@/stores/market"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"

/** 用最新价估算浮动盈亏 */
function estimatePnl(pos: PaperPositionItem, last: number | undefined): number {
  if (last == null || !Number.isFinite(last) || last <= 0) {
    return Number(pos.realized_pnl) || 0
  }
  const mult = Number(pos.multiplier) || 1
  const qty = Number(pos.quantity) || 0
  const avg = Number(pos.avg_price) || 0
  if (pos.direction === "long") {
    return (last - avg) * qty * mult
  }
  return (avg - last) * qty * mult
}

/** 持仓概览 —— 模拟持仓 + WS 最新价 */
export function PositionOverview(): React.JSX.Element {
  const [positions, setPositions] = useState<PaperPositionItem[]>([])
  const [loading, setLoading] = useState(true)
  const quotes = useMarketStore((s) => s.quotes)
  const initWebSocket = useMarketStore((s) => s.initWebSocket)

  const load = useCallback(async () => {
    try {
      const data = await getPaperPositions()
      setPositions(data.items || [])
    } catch {
      setPositions([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    initWebSocket()
    load()
    const timer = setInterval(load, 10000)
    return () => clearInterval(timer)
  }, [load, initWebSocket])

  if (loading) {
    return (
      <div className="py-8 text-center text-sm text-[var(--text-muted)]">
        加载中…
      </div>
    )
  }

  if (positions.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-[var(--text-muted)]">
        暂无持仓
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {positions.map((p) => {
        const q = quotes[p.symbol]
        const last = q?.last_price
        const pnl = estimatePnl(p, last)
        const isUp = pnl >= 0
        return (
          <div
            key={p.id}
            className="flex items-center justify-between py-2 px-3 rounded-md hover:bg-[var(--bg-tertiary)] transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-medium text-[var(--text-primary)] truncate">
                {p.symbol}
              </span>
              <Badge variant={p.direction === "long" ? "up" : "down"}>
                {p.direction === "long" ? "多" : "空"}
              </Badge>
              <span className="text-xs text-[var(--text-muted)]">
                {p.quantity}手
              </span>
            </div>
            <div className="text-right shrink-0">
              <div
                className={cn(
                  "font-num text-sm font-medium",
                  isUp ? "text-up" : "text-down",
                )}
              >
                {isUp ? "+" : ""}
                {pnl.toFixed(2)}
              </div>
              <div className="text-[10px] text-[var(--text-muted)] font-num">
                均 {p.avg_price}
                {last != null ? ` · 现 ${last}` : ""}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

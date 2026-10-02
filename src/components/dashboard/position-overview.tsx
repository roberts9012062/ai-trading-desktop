"use client"

import { useEffect } from "react"
import { useMarketStore } from "@/stores/market"
import { usePaperTradingStore } from "@/stores/paper-trading"
import { positionPnl } from "@/lib/position-pnl"
import { cn } from "@/lib/utils"
import { perpSymbol } from "@/lib/perp-symbol"
import { Badge } from "@/components/ui/badge"

/** 价格自适应精度：≥1000→1 位；≥1→2 位；<1→4 位（微价格币不丢精度） */
function fmtPx(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return "--"
  return p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(2) : p.toFixed(4)
}

/** 数量（基础币，小数位最多 4） */
function fmtQty(q: number): string {
  return Number(q || 0).toLocaleString("zh-CN", { maximumFractionDigits: 4 })
}

/** 持仓概览 —— 双模式：实盘=交易所真实持仓 / 虚拟盘=模拟持仓，WS 最新价辅助 */
export function PositionOverview(): React.JSX.Element {
  const positions = usePaperTradingStore((s) => s.positions)
  const loaded = usePaperTradingStore((s) => s.loaded)
  const mode = usePaperTradingStore((s) => s.mode)
  const quotes = useMarketStore((s) => s.quotes)
  const initWebSocket = useMarketStore((s) => s.initWebSocket)

  useEffect(() => {
    initWebSocket()
  }, [initWebSocket])

  if (!loaded) {
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
        const last = quotes[p.symbol]?.last_price
        const pnl = positionPnl(p, mode, last)
        const isUp = pnl >= 0
        const lev = Number(p.leverage ?? 0)
        return (
          <div
            key={p.id}
            className="flex items-center justify-between py-2 px-3 rounded-md hover:bg-[var(--bg-tertiary)] transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-medium text-[var(--text-primary)] truncate">
                {p.symbol_name || perpSymbol(p.symbol)}
              </span>
              <Badge variant={p.direction === "long" ? "up" : "down"}>
                {p.direction === "long" ? "多" : "空"}
              </Badge>
              {lev > 0 && (
                <span className="text-[10px] text-[var(--text-muted)] font-num shrink-0">
                  {lev}x
                </span>
              )}
              <span className="text-xs text-[var(--text-muted)] font-num shrink-0">
                {fmtQty(p.quantity)}
              </span>
            </div>
            <div className="text-right shrink-0">
              <div
                className={cn(
                  "font-num text-sm font-medium",
                  isUp ? "text-up" : "text-down"
                )}
              >
                {isUp ? "+" : ""}
                {pnl.toFixed(2)}
              </div>
              <div className="text-[10px] text-[var(--text-muted)] font-num">
                均 {fmtPx(Number(p.avg_price))}
                {last != null ? ` · 现 ${fmtPx(Number(last))}` : ""}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

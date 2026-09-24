"use client"

/**
 * 交易页左侧持仓合约列表 —— 有持仓的合约去重展示
 *
 * 买单成交后对应合约出现在这里（手动单/AI 任务/量化任务皆入），
 * 点击行切换 K 线合约；无任何持仓时显示空状态。
 */

import { useEffect, useMemo } from "react"
import { cn, formatPrice } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { useAppStore } from "@/stores/app"
import { useMarketStore } from "@/stores/market"
import { usePaperTradingStore } from "@/stores/paper-trading"
import { broadcastContractChange } from "@/hooks/sync"
import { getCurrentKlinePeriod } from "@/components/market/kline/current-period"
import { prefetchKlineHistory } from "@/components/market/kline/use-kline-history"

interface PositionContractRow {
  symbol: string
  name: string
  /** 多空净手数（正=净多，负=净空） */
  net: number
}

function quoteOf(
  quotes: Record<string, { last_price?: number; decimal_places?: number | null }>,
  symbol: string
): { last_price?: number; decimal_places?: number | null } | undefined {
  return quotes[symbol] ?? quotes[symbol.toLowerCase()] ?? quotes[symbol.toUpperCase()]
}

export function PositionContractList(): React.JSX.Element {
  const positions = usePaperTradingStore((s) => s.positions)
  const refresh = usePaperTradingStore((s) => s.refresh)
  const quotes = useMarketStore((s) => s.quotes)
  const activeContract = useAppStore((s) => s.activeContract)

  // 进入页面立即拉一次；3s 轮询保证买单成交（含 AI 任务）后及时出现
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 3000)
    return () => clearInterval(timer)
  }, [refresh])

  const rows = useMemo<PositionContractRow[]>(() => {
    const bySymbol = new Map<string, PositionContractRow>()
    for (const p of positions) {
      if (!p.symbol || !(p.quantity > 0)) continue
      const key = p.symbol.toLowerCase()
      const row =
        bySymbol.get(key) ??
        { symbol: p.symbol, name: p.symbol_name || p.symbol, net: 0 }
      row.net += p.direction === "short" ? -p.quantity : p.quantity
      bySymbol.set(key, row)
    }
    return [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol))
  }, [positions])

  const handleSelect = (symbol: string) => {
    useAppStore.getState().setActiveContract(symbol)
    broadcastContractChange(symbol)
    const period = getCurrentKlinePeriod()
    prefetchKlineHistory([symbol], period)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-[var(--border)]">
        <span className="text-xs font-medium text-[var(--text-secondary)]">
          持仓合约
        </span>
        <span className="ml-2 text-[10px] text-[var(--text-muted)]">
          点击切换 K 线
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="flex-1 flex items-center justify-center px-4">
          <p className="text-xs text-[var(--text-muted)] text-center leading-5">
            暂无持仓
            <br />
            买入成交后合约会出现在这里
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {rows.map((row) => {
            const q = quoteOf(quotes, row.symbol)
            const isActive = activeContract === row.symbol
            const isLong = row.net >= 0
            return (
              <button
                key={row.symbol}
                onClick={() => handleSelect(row.symbol)}
                className={cn(
                  "w-full text-left px-3 py-2 border-b border-[var(--border)]",
                  "transition-colors hover:bg-[var(--bg-tertiary)]/50",
                  isActive && "bg-[var(--primary)]/10"
                )}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="text-xs font-medium truncate">{row.symbol}</span>
                  <Badge variant={isLong ? "up" : "down"} className="text-[10px] h-5 shrink-0">
                    {isLong ? "多" : "空"} {Math.abs(row.net)}
                  </Badge>
                </div>
                <div className="flex items-center justify-between gap-1 mt-0.5">
                  <span className="text-[10px] text-[var(--text-muted)] truncate">
                    {row.name}
                  </span>
                  <span className="text-[10px] text-[var(--text-secondary)] shrink-0">
                    {q?.last_price
                      ? formatPrice(q.last_price, q.decimal_places ?? 0)
                      : "--"}
                  </span>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

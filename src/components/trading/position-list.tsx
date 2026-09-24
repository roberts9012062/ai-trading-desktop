"use client"

/**
 * 交易页底部持仓表 —— 点击行切 K 线并进入平仓
 */

import { useEffect } from "react"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/stores/app"
import { useMarketStore } from "@/stores/market"
import { usePaperTradingStore } from "@/stores/paper-trading"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table"
import type { PaperPositionItem } from "@/lib/paper-api"

function quoteOf(
  quotes: Record<string, { last_price?: number }>,
  symbol: string
): { last_price?: number } | undefined {
  return quotes[symbol] ?? quotes[symbol.toLowerCase()] ?? quotes[symbol.toUpperCase()]
}

/** 持仓明细 —— 点击行切 K 线并进入平仓；市价平=最新价立刻平 */
export function PositionDetailTable(): React.JSX.Element {
  const positions = usePaperTradingStore((s) => s.positions)
  const quotes = useMarketStore((s) => s.quotes)
  const closePosition = usePaperTradingStore((s) => s.closePosition)
  const submitting = usePaperTradingStore((s) => s.submitting)
  const refresh = usePaperTradingStore((s) => s.refresh)
  const activeContract = useAppStore((s) => s.activeContract)
  const selectPositionForClose = useAppStore((s) => s.selectPositionForClose)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleCloseNow = (pos: PaperPositionItem) => {
    const q = quoteOf(quotes, pos.symbol)
    const price = q?.last_price ?? Number(pos.avg_price)
    if (!price || price <= 0) {
      usePaperTradingStore.setState({ error: "无有效现价，无法市价平仓" })
      return
    }
    selectPositionForClose(
      pos.symbol,
      pos.direction === "short" ? "short" : "long",
      pos.available_quantity
    )
    void closePosition(pos, price, "market", pos.available_quantity)
  }

  const handleRowSelect = (pos: PaperPositionItem) => {
    selectPositionForClose(
      pos.symbol,
      pos.direction === "short" ? "short" : "long",
      pos.available_quantity
    )
  }

  return (
    <div>
      <div className="px-3 py-2 border-b border-[var(--border)]">
        <span className="text-xs font-medium text-[var(--text-secondary)]">
          持仓明细
        </span>
        <span className="ml-2 text-[10px] text-[var(--text-muted)]">
          点击行切换 K 线并进入平仓
        </span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs">合约</TableHead>
            <TableHead className="text-xs">方向</TableHead>
            <TableHead className="text-xs font-num">均价</TableHead>
            <TableHead className="text-xs font-num">数量</TableHead>
            <TableHead className="text-xs font-num">现价</TableHead>
            <TableHead className="text-xs font-num">浮盈</TableHead>
            <TableHead className="text-xs">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {positions.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={7}
                className="text-center text-[var(--text-muted)] py-4 text-xs"
              >
                暂无持仓
              </TableCell>
            </TableRow>
          ) : (
            positions.map((p) => {
              const quote = quoteOf(quotes, p.symbol)
              const current = quote?.last_price ?? 0
              const mult = p.multiplier || 10
              let pnl = 0
              if (current > 0) {
                if (p.direction === "long") {
                  pnl = (current - p.avg_price) * p.quantity * mult
                } else {
                  pnl = (p.avg_price - current) * p.quantity * mult
                }
              }
              const isUp = pnl >= 0
              const active =
                p.symbol.toLowerCase() === activeContract.toLowerCase()
              return (
                <TableRow
                  key={p.id}
                  className={cn(
                    "cursor-pointer hover:bg-[var(--bg-tertiary)]/50",
                    active && "bg-[var(--primary)]/10"
                  )}
                  onClick={() => handleRowSelect(p)}
                >
                  <TableCell className="text-xs font-medium">{p.symbol}</TableCell>
                  <TableCell>
                    <Badge
                      variant={p.direction === "long" ? "up" : "down"}
                      className="text-[10px]"
                    >
                      {p.direction === "long" ? "多" : "空"}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-num text-xs">{p.avg_price}</TableCell>
                  <TableCell className="font-num text-xs">{p.quantity}</TableCell>
                  <TableCell className="font-num text-xs">
                    {current > 0 ? current : "--"}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "font-num text-xs font-medium",
                      isUp ? "text-up" : "text-down"
                    )}
                  >
                    {current > 0
                      ? `${isUp ? "+" : ""}${pnl.toFixed(0)}`
                      : "--"}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-[10px] h-6 text-[var(--accent-warn)]"
                      disabled={submitting || p.available_quantity <= 0}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleCloseNow(p)
                      }}
                    >
                      市价平
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })
          )}
        </TableBody>
      </Table>
    </div>
  )
}

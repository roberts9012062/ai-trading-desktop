"use client"

/**
 * 交易页底部委托表 —— 点击行切换 K 线到该合约
 */

import { useEffect } from "react"
import { paperActionLabel } from "@/lib/trade-labels"
import { cn, formatShanghaiTime } from "@/lib/utils"
import { useAppStore } from "@/stores/app"
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
import { Loader2 } from "lucide-react"
import type { PaperOrderItem } from "@/lib/paper-api"

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: "挂单中",
    filled: "已成交",
    cancelled: "已撤",
    rejected: "拒绝",
  }
  return map[status] ?? status
}

/** 委托列表 —— 点击行切换 K 线到该合约 */
export function OrderList(): React.JSX.Element {
  const orders = usePaperTradingStore((s) => s.orders)
  const loading = usePaperTradingStore((s) => s.loading)
  const submitting = usePaperTradingStore((s) => s.submitting)
  const refresh = usePaperTradingStore((s) => s.refresh)
  const cancel = usePaperTradingStore((s) => s.cancel)
  const cancelAllPending = usePaperTradingStore((s) => s.cancelAllPending)
  const activeContract = useAppStore((s) => s.activeContract)
  const selectTradeSymbol = useAppStore((s) => s.selectTradeSymbol)

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, 10_000)
    return () => clearInterval(timer)
  }, [refresh])

  const pending = orders.filter((o) => o.status === "pending")
  const recent = orders.filter((o) => o.status !== "pending").slice(0, 20)
  const display: PaperOrderItem[] = [...pending, ...recent]

  return (
    <div>
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
        <span className="text-xs font-medium text-[var(--text-secondary)]">
          委托 {pending.length > 0 ? `(待成${pending.length})` : ""}
        </span>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs h-6"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : "刷新"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs h-6 text-[var(--accent-danger)]"
            disabled={submitting || pending.length === 0}
            onClick={() => void cancelAllPending()}
          >
            一键全撤
          </Button>
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs">时间</TableHead>
            <TableHead className="text-xs">合约</TableHead>
            <TableHead className="text-xs">方向</TableHead>
            <TableHead className="text-xs font-num">委托价</TableHead>
            <TableHead className="text-xs font-num">量</TableHead>
            <TableHead className="text-xs">状态</TableHead>
            <TableHead className="text-xs">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {display.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={7}
                className="text-center text-[var(--text-muted)] py-4 text-xs"
              >
                暂无委托
              </TableCell>
            </TableRow>
          ) : (
            display.map((order) => {
              const active =
                order.symbol.toLowerCase() === activeContract.toLowerCase()
              return (
                <TableRow
                  key={order.id}
                  className={cn(
                    "cursor-pointer hover:bg-[var(--bg-tertiary)]/50",
                    active && "bg-[var(--primary)]/10"
                  )}
                  onClick={() => selectTradeSymbol(order.symbol)}
                >
                  <TableCell className="font-num text-xs text-[var(--text-muted)]">
                    {formatShanghaiTime(order.created_at, "time")}
                  </TableCell>
                  <TableCell className="text-xs font-medium">
                    {order.symbol}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        paperActionLabel(order.direction, order.offset) ===
                        "买多"
                          ? "up"
                          : "down"
                      }
                      className="text-[10px]"
                    >
                      {paperActionLabel(order.direction, order.offset)}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-num text-xs">{order.price}</TableCell>
                  <TableCell className="font-num text-xs">
                    {order.filled_qty}/{order.quantity}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">
                      {statusLabel(order.status)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {order.status === "pending" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs h-6 text-[var(--accent-danger)]"
                        disabled={submitting}
                        onClick={(e) => {
                          e.stopPropagation()
                          void cancel(order.id)
                        }}
                      >
                        撤单
                      </Button>
                    ) : (
                      <span className="text-[10px] text-[var(--text-muted)]">
                        —
                      </span>
                    )}
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

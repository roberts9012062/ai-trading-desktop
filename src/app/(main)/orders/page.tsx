"use client"

import { useEffect, useMemo } from "react"
import { usePaperTradingStore } from "@/stores/paper-trading"
import { formatShanghaiTime } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
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
import { paperActionLabel } from "@/lib/trade-labels"

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const map: Record<
    string,
    { label: string; variant: "default" | "outline" | "up" | "destructive" }
  > = {
    pending: { label: "挂单中", variant: "default" },
    partially_filled: { label: "部分成交", variant: "default" },
    filled: { label: "全部成交", variant: "up" },
    cancelled: { label: "已撤单", variant: "destructive" },
    rejected: { label: "已拒绝", variant: "outline" },
    error: { label: "下单异常", variant: "outline" },
  }
  const cfg = map[status] ?? { label: status, variant: "outline" as const }
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>
}

function dirLabel(o: PaperOrderItem): string {
  return paperActionLabel(o.direction, o.offset)
}

/** 订单管理 —— 挂单 / 历史 / 成交 */
export default function OrdersPage(): React.JSX.Element {
  const orders = usePaperTradingStore((s) => s.orders)
  const loading = usePaperTradingStore((s) => s.loading)
  const submitting = usePaperTradingStore((s) => s.submitting)
  const lastMessage = usePaperTradingStore((s) => s.lastMessage)
  const error = usePaperTradingStore((s) => s.error)
  const refresh = usePaperTradingStore((s) => s.refresh)
  const cancel = usePaperTradingStore((s) => s.cancel)
  const cancelAllPending = usePaperTradingStore((s) => s.cancelAllPending)
  const clearMessage = usePaperTradingStore((s) => s.clearMessage)

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, 10_000)
    return () => clearInterval(timer)
  }, [refresh])

  /** 仍在挂单中（含部分成交，剩余量还在挂） */
  const isOpenStatus = (o: PaperOrderItem): boolean =>
    o.status === "pending" || o.status === "partially_filled"

  const pending = useMemo(
    () => orders.filter((o) => isOpenStatus(o)),
    [orders]
  )
  const history = useMemo(
    () => orders.filter((o) => !isOpenStatus(o)),
    [orders]
  )
  const fills = useMemo(
    () => orders.filter((o) => o.status === "filled"),
    [orders]
  )

  return (
    <div className="flex flex-col h-full p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-sm font-medium text-[var(--text-primary)]">
            订单
          </p>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            当前挂单 · 历史委托 · 成交记录（7×24 实时刷新）
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1"
          disabled={loading}
          onClick={() => void refresh()}
        >
          {loading && <Loader2 className="w-3 h-3 animate-spin" />}
          刷新
        </Button>
      </div>

      {(error || lastMessage) && (
        <div
          className={
            error
              ? "mb-2 text-xs rounded px-3 py-2 bg-[var(--accent-danger)]/10 text-[var(--accent-danger)]"
              : "mb-2 text-xs rounded px-3 py-2 bg-[var(--accent-up)]/10 text-[var(--accent-up)]"
          }
        >
          {error ?? lastMessage}
          <button
            type="button"
            className="ml-2 underline cursor-pointer"
            onClick={() => clearMessage()}
          >
            关闭
          </button>
        </div>
      )}

      <Tabs defaultValue="pending" className="flex flex-col h-full">
        <TabsList>
          <TabsTrigger value="pending">
            当前挂单{pending.length > 0 ? ` (${pending.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="history">历史委托</TabsTrigger>
          <TabsTrigger value="trades">成交记录</TabsTrigger>
        </TabsList>

        <TabsContent value="pending" className="flex-1 overflow-auto mt-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-[var(--text-muted)]">
              挂单会在 K 线上显示价格线；撤单后线同步消失
            </p>
            <Button
              variant="destructive"
              size="sm"
              disabled={submitting || pending.length === 0}
              onClick={() => void cancelAllPending()}
            >
              一键全撤
            </Button>
          </div>
          <OrderTable
            rows={pending}
            showCancel
            submitting={submitting}
            emptyText="暂无挂单。可在交易页用限价/市价下单。"
            onCancel={(id) => void cancel(id)}
          />
        </TabsContent>

        <TabsContent value="history" className="flex-1 overflow-auto mt-3">
          <OrderTable
            rows={history}
            showCancel={false}
            submitting={false}
            emptyText="暂无历史委托"
          />
        </TabsContent>

        <TabsContent value="trades" className="flex-1 overflow-auto mt-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>成交时间</TableHead>
                <TableHead>合约</TableHead>
                <TableHead>方向</TableHead>
                <TableHead>成交价</TableHead>
                <TableHead>成交量</TableHead>
                <TableHead>手续费</TableHead>
                <TableHead>平仓盈亏</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fills.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center text-[var(--text-muted)] py-8"
                  >
                    暂无成交
                  </TableCell>
                </TableRow>
              ) : (
                fills.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="font-num text-xs text-[var(--text-muted)]">
                      {formatShanghaiTime(o.filled_at ?? o.updated_at)}
                    </TableCell>
                    <TableCell>{o.symbol}</TableCell>
                    <TableCell>
                      <Badge variant={o.direction === "buy" ? "up" : "down"}>
                        {dirLabel(o)}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-num">{o.price}</TableCell>
                    <TableCell className="font-num">{o.filled_qty}</TableCell>
                    <TableCell className="font-num">{o.fee}</TableCell>
                    <TableCell
                      className={
                        o.realized_pnl >= 0
                          ? "font-num text-up"
                          : "font-num text-down"
                      }
                    >
                      {o.realized_pnl !== 0
                        ? `${o.realized_pnl >= 0 ? "+" : ""}${o.realized_pnl}`
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function OrderTable(props: {
  rows: PaperOrderItem[]
  showCancel: boolean
  submitting: boolean
  emptyText: string
  onCancel?: (id: string) => void
}): React.JSX.Element {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>时间</TableHead>
          <TableHead>合约</TableHead>
          <TableHead>方向</TableHead>
          <TableHead>类型</TableHead>
          <TableHead>委托价</TableHead>
          <TableHead>委托量</TableHead>
          <TableHead>已成交</TableHead>
          <TableHead>冻结保证金</TableHead>
          <TableHead>状态</TableHead>
          {props.showCancel && <TableHead>操作</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.rows.length === 0 ? (
          <TableRow>
            <TableCell
              colSpan={props.showCancel ? 10 : 9}
              className="text-center text-[var(--text-muted)] py-8"
            >
              {props.emptyText}
            </TableCell>
          </TableRow>
        ) : (
          props.rows.map((o) => (
            <TableRow key={o.id}>
              <TableCell className="font-num text-xs text-[var(--text-muted)]">
                {formatShanghaiTime(o.created_at)}
              </TableCell>
              <TableCell className="text-sm">{o.symbol}</TableCell>
              <TableCell>
                <Badge variant={o.direction === "buy" ? "up" : "down"}>
                  {dirLabel(o)}
                </Badge>
              </TableCell>
              <TableCell className="text-xs text-[var(--text-secondary)]">
                {o.order_type === "limit" ? "限价" : "市价"}
              </TableCell>
              <TableCell className="font-num text-sm">{o.price}</TableCell>
              <TableCell className="font-num text-sm">{o.quantity}</TableCell>
              <TableCell className="font-num text-sm">{o.filled_qty}</TableCell>
              <TableCell className="font-num text-sm text-[var(--text-muted)]">
                {o.frozen_margin > 0 ? o.frozen_margin.toLocaleString() : "—"}
              </TableCell>
              <TableCell>
                <StatusBadge status={o.status} />
              </TableCell>
              {props.showCancel && (
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-6 text-[var(--accent-danger)]"
                    disabled={
                      props.submitting ||
                      (o.status !== "pending" && o.status !== "partially_filled")
                    }
                    onClick={() => props.onCancel?.(o.id)}
                  >
                    撤单
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )
}

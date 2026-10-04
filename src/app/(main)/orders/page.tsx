"use client"

import { NumericInput } from "@/components/ui/numeric-input"
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
import React, { useEffect, useMemo, useState } from "react"
import type { PaperOrderItem } from "@/lib/paper-api"
import { paperActionLabel } from "@/lib/trade-labels"
import { amendLiveOrderApi, getStoredVenue } from "@/lib/live-api"
import { canCancelLiveOrder } from "@/lib/live-order-merge"

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
    unconfirmed: { label: "待对账", variant: "outline" },
  }
  const cfg = map[status] ?? { label: status, variant: "outline" as const }
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>
}

function dirLabel(o: PaperOrderItem): string {
  return paperActionLabel(o.direction, o.offset)
}

/** 保证金模式标签（virtual 订单无 → 空串） */
function mmLabel(mode: string | null | undefined): string {
  return mode === "isolated" ? "逐仓" : mode === "cross" ? "全仓" : ""
}

/** 杠杆口径的保证金/名义价值（virtual 旧订单无杠杆 → null 不展示） */
function leveragedAmounts(o: PaperOrderItem): {
  lev: number
  margin: number | null
  notional: number | null
} {
  const lev = Number(o.leverage ?? 0)
  const notional = Number(o.price || 0) * Number(o.quantity || 0)
  if (lev <= 0 || !Number.isFinite(notional) || notional <= 0) {
    return { lev, margin: null, notional: notional > 0 ? notional : null }
  }
  return { lev, margin: notional / lev, notional }
}

/** 订单管理 —— 挂单 / 历史 / 成交 */
export default function OrdersPage(): React.JSX.Element {
  const orders = usePaperTradingStore((s) => s.orders)
  const mode = usePaperTradingStore((s) => s.mode)
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
              普通委托与条件单同步显示；条件单请在所属任务或交易所管理
            </p>
            <Button
              variant="destructive"
              size="sm"
              disabled={submitting || !pending.some(o => mode !== "live" || canCancelLiveOrder(o))}
              onClick={() => void cancelAllPending()}
            >
              {mode === "live" ? "全撤普通委托" : "一键全撤"}
            </Button>
          </div>
          <OrderTable
            rows={pending}
            showCancel
            submitting={submitting}
            emptyText={error ? "挂单查询失败，无法确认当前挂单，请刷新重试。" : "暂无未成交的普通委托或未触发的条件单。"}
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
                <TableHead>杠杆</TableHead>
                <TableHead>本金(U)</TableHead>
                <TableHead>杠杆后(U)</TableHead>
                <TableHead>手续费</TableHead>
                <TableHead>平仓盈亏</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fills.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={10}
                    className="text-center text-[var(--text-muted)] py-8"
                  >
                    暂无成交
                  </TableCell>
                </TableRow>
              ) : (
                fills.map((o) => {
                  const amt = leveragedAmounts(o)
                  return (
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
                    <TableCell className="font-num">
                      {amt.lev > 0 ? `${amt.lev}x` : "—"}
                      {mmLabel(o.margin_mode) && (
                        <span className="ml-1 text-[10px] text-[var(--text-muted)]">
                          ·{mmLabel(o.margin_mode)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="font-num">
                      {amt.margin != null
                        ? amt.margin.toLocaleString("zh-CN", { maximumFractionDigits: 2 })
                        : "—"}
                    </TableCell>
                    <TableCell className="font-num">
                      {amt.notional != null
                        ? amt.notional.toLocaleString("zh-CN", { maximumFractionDigits: 2 })
                        : "—"}
                    </TableCell>
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
                  )
                })
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
  // 实盘改单：改价/改量不撤重挂（保留排队位置）
  const mode = usePaperTradingStore((s) => s.mode)
  const refresh = usePaperTradingStore((s) => s.refresh)
  const [amendFor, setAmendFor] = useState<string | null>(null)
  const [newPrice, setNewPrice] = useState("")
  const [newQty, setNewQty] = useState("")
  const [amendMsg, setAmendMsg] = useState<string | null>(null)
  const [amendBusy, setAmendBusy] = useState(false)
  const showAmend = props.showCancel && mode === "live"

  async function doAmend(o: PaperOrderItem): Promise<void> {
    if (o.order_kind === "algo" || o.can_amend === false) return
    const px = Number(newPrice) || null
    const qty = Number(newQty) || null
    if (!px && !qty) {
      setAmendMsg("新价格与新数量至少填一个")
      return
    }
    setAmendBusy(true)
    setAmendMsg(null)
    try {
      await amendLiveOrderApi({
        venue: getStoredVenue(),
        order_id: o.exchange_order_id || o.id,
        symbol: o.symbol,
        new_price: px && px > 0 ? px : null,
        new_qty: qty && qty > 0 ? qty : null,
      })
      setAmendMsg(`改单成功：${o.symbol}`)
      setAmendFor(null)
      await refresh()
    } catch (e) {
      setAmendMsg(e instanceof Error ? e.message : "改单失败")
    } finally {
      setAmendBusy(false)
    }
  }

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
          <TableHead>杠杆</TableHead>
          <TableHead>本金(U)</TableHead>
          <TableHead>杠杆后(U)</TableHead>
          <TableHead>冻结保证金</TableHead>
          <TableHead>状态</TableHead>
          {props.showCancel && <TableHead>操作</TableHead>}
          {showAmend && <TableHead>改单</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.rows.length === 0 ? (
          <TableRow>
            <TableCell
              colSpan={props.showCancel ? (showAmend ? 14 : 13) : 12}
              className="text-center text-[var(--text-muted)] py-8"
            >
              {props.emptyText}
            </TableCell>
          </TableRow>
        ) : (
          props.rows.map((o) => {
            const amt = leveragedAmounts(o)
            return (
            <React.Fragment key={o.id}>
            <TableRow>
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
                {({limit:"限价",market:"市价",trigger:"触发进场",conditional:"止盈/止损",oco:"止盈止损 OCO",move_order_stop:"移动止盈止损"} as Record<string,string>)[o.order_type] ?? o.order_type}
              </TableCell>
              <TableCell className="font-num text-sm">
                {o.order_kind === "algo" ? <div className="text-xs space-y-1">
                  {o.trigger_price != null && <div>触发 {o.trigger_price}</div>}
                  {o.tp_price != null && <div className="text-[var(--accent-up)]">止盈 {o.tp_price}</div>}
                  {o.sl_price != null && <div className="text-[var(--accent-danger)]">止损 {o.sl_price}</div>}
                  {o.trigger_price == null && o.tp_price == null && o.sl_price == null && <div>动态触发</div>}
                </div> : o.price}
              </TableCell>
              <TableCell className="font-num text-sm">{o.close_fraction === 1 ? "全部持仓" : o.quantity}</TableCell>
              <TableCell className="font-num text-sm">{o.filled_qty}</TableCell>
              <TableCell className="font-num text-sm">
                {amt.lev > 0 ? `${amt.lev}x` : "—"}
                {mmLabel(o.margin_mode) && (
                  <span className="ml-1 text-[10px] text-[var(--text-muted)]">
                    ·{mmLabel(o.margin_mode)}
                  </span>
                )}
              </TableCell>
              <TableCell className="font-num text-sm">
                {amt.margin != null
                  ? amt.margin.toLocaleString("zh-CN", { maximumFractionDigits: 2 })
                  : "—"}
              </TableCell>
              <TableCell className="font-num text-sm">
                {amt.notional != null
                  ? amt.notional.toLocaleString("zh-CN", { maximumFractionDigits: 2 })
                  : "—"}
              </TableCell>
              <TableCell className="font-num text-sm text-[var(--text-muted)]">
                {o.frozen_margin > 0 ? o.frozen_margin.toLocaleString() : "—"}
              </TableCell>
              <TableCell>
                <StatusBadge status={o.status} />
              </TableCell>
              {props.showCancel && (
                <TableCell>
                  {o.order_kind === "algo" ? <span className="text-xs text-[var(--text-muted)]">条件单保护</span> : <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-6 text-[var(--accent-danger)]"
                    disabled={
                      props.submitting ||
                      o.can_cancel === false ||
                      (o.status !== "pending" && o.status !== "partially_filled")
                    }
                    onClick={() => props.onCancel?.(o.id)}
                  >
                    撤单
                  </Button>}
                </TableCell>
              )}
              {showAmend && (
                <TableCell>
                  {o.order_kind === "algo" ? <span className="text-xs text-[var(--text-muted)]">任务自动管理</span> : <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-6"
                    disabled={o.can_amend === false || (o.status !== "pending" && o.status !== "partially_filled")}
                    onClick={() => {
                      setAmendFor(amendFor === o.id ? null : o.id)
                      setNewPrice(String(o.price || ""))
                      setNewQty(String(o.quantity || ""))
                      setAmendMsg(null)
                    }}
                  >
                    {amendFor === o.id ? "收起" : "改单"}
                  </Button>}
                </TableCell>
              )}
            </TableRow>
            {showAmend && amendFor === o.id && (
              <TableRow>
                <TableCell colSpan={11} className="bg-[var(--bg-tertiary)]/40">
                  <div className="flex items-center gap-2 py-1 flex-wrap">
                    <span className="text-xs text-[var(--text-secondary)]">
                      {o.symbol} 改单（保留排队位置）
                    </span>
                    <NumericInput
                      type="number"
                      step="any"
                      min="0"
                      placeholder="新价格"
                      value={newPrice}
                      onChange={(e) => setNewPrice(e.target.value)}
                      className="w-28 h-7 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-xs font-num"
                    />
                    <NumericInput
                      type="number"
                      step="any"
                      min="0"
                      placeholder="新数量"
                      value={newQty}
                      onChange={(e) => setNewQty(e.target.value)}
                      className="w-28 h-7 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-xs font-num"
                    />
                    <Button validateNumbers size="sm" disabled={amendBusy} onClick={() => void doAmend(o)}>
                      {amendBusy ? "提交中…" : "确认改单"}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setAmendFor(null)}>
                      取消
                    </Button>
                    {amendMsg && (
                      <span className="text-[11px] text-[var(--text-secondary)]">{amendMsg}</span>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            )}
            </React.Fragment>
            )
          })
        )}
      </TableBody>
    </Table>
  )
}

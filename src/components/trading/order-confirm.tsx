"use client"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Loader2 } from "lucide-react"
import type { OrderDirection } from "@/types"

/** 下单确认弹窗 */
export function OrderConfirmDialog(props: {
  contract: string
  direction: OrderDirection
  price: string
  quantity: string
  estimate: { margin: number; fee: number; total: number } | null
  leverage?: number | null
  notional?: number | null
  tpPrice?: number | null
  slPrice?: number | null
  submitting: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const dirLabel =
    props.direction === "buy"
      ? "买多开仓"
      : props.direction === "sell"
        ? "卖空开仓"
        : "平仓"
  const dirColor =
    props.direction === "buy"
      ? "text-up"
      : props.direction === "sell"
        ? "text-down"
        : "text-[var(--text-muted)]"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[320px] rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-5 shadow-xl">
        <h3 className="text-base font-semibold text-[var(--text-primary)] mb-1">
          确认模拟下单
        </h3>
        <p className="text-[11px] text-[var(--text-muted)] mb-4">
          虚拟资金下单；限价挂单可在盘前挂出，开盘到价自动成交
        </p>
        <div className="space-y-2 text-sm">
          <Row label="合约" value={props.contract} />
          <div className="flex justify-between">
            <span className="text-[var(--text-muted)]">方向</span>
            <span className={cn("font-semibold", dirColor)}>{dirLabel}</span>
          </div>
          <Row label="价格" value={props.price} mono />
          <Row label="数量" value={String(props.quantity)} mono />
          {props.leverage ? <Row label="杠杆" value={`${props.leverage}x`} mono /> : null}
          {props.notional ? (
            <Row
              label="名义价值"
              value={`${props.notional.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} USDT`}
              mono
            />
          ) : null}
          {props.tpPrice ? <Row label="止盈" value={String(props.tpPrice)} mono /> : null}
          {props.slPrice ? <Row label="止损" value={String(props.slPrice)} mono /> : null}
          {props.estimate && (
            <>
              <Row
                label="保证金"
                value={`${props.estimate.margin.toLocaleString()} USDT`}
                mono
              />
              <Row
                label="手续费"
                value={`${props.estimate.fee.toLocaleString()} USDT`}
                mono
              />
            </>
          )}
        </div>
        <div className="flex gap-2 mt-5">
          <Button
            variant="outline"
            className="flex-1"
            disabled={props.submitting}
            onClick={props.onCancel}
          >
            取消
          </Button>
          <Button
            className="flex-1 gap-1"
            disabled={props.submitting}
            onClick={props.onConfirm}
          >
            {props.submitting && (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            )}
            确认
          </Button>
        </div>
      </div>
    </div>
  )
}

function Row(props: {
  label: string
  value: string
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="flex justify-between">
      <span className="text-[var(--text-muted)]">{props.label}</span>
      <span
        className={cn(
          "text-[var(--text-primary)]",
          props.mono && "font-num"
        )}
      >
        {props.value}
      </span>
    </div>
  )
}

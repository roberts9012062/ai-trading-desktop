"use client"

/**
 * 下单面板子组件：顶栏 / 类型切换 / 方向 / 价格区
 */

import { cn } from "@/lib/utils"
import type { PriceMode } from "@/components/trading/lib/order-price"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { OrderDirection, OrderType } from "@/types"

export function HeaderBar(props: {
  isOpen: boolean
  profileLabel: string | undefined
  activeContract: string
  contractName: string
  lastPrice: number
  bidPrice: number
  askPrice: number
  decimals: number
  change: number
}): React.JSX.Element {
  return (
    <>
      <div
        className={cn(
          "px-3 py-1 text-[10px] border-b border-[var(--border)]",
          props.isOpen
            ? "bg-[var(--primary)]/10 text-[var(--primary)]"
            : "bg-[var(--accent-warn)]/15 text-[var(--accent-warn)]"
        )}
      >
        {props.isOpen
          ? `模拟交易 · 交易中 · ${props.profileLabel ?? ""}`
          : "休市 · 可挂限价单，开盘到价自动成交"}
      </div>
      <div className="px-3 py-2 border-b border-[var(--border)]">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-[var(--text-primary)]">
            {props.activeContract}
          </span>
          <span
            className={cn(
              "font-num text-sm",
              props.change >= 0 ? "text-up" : "text-down"
            )}
          >
            {props.lastPrice > 0
              ? props.lastPrice.toFixed(props.decimals)
              : "--"}
          </span>
        </div>
        <div className="flex gap-3 mt-0.5 text-[10px] text-[var(--text-muted)] font-num">
          <span>
            买一{" "}
            <span className="text-up">
              {props.bidPrice > 0
                ? props.bidPrice.toFixed(props.decimals)
                : "--"}
            </span>
          </span>
          <span>
            卖一{" "}
            <span className="text-down">
              {props.askPrice > 0
                ? props.askPrice.toFixed(props.decimals)
                : "--"}
            </span>
          </span>
        </div>
        <span className="text-xs text-[var(--text-muted)]">
          {props.contractName}
        </span>
      </div>
    </>
  )
}

export function OrderTypeTabs(props: {
  orderType: OrderType
  isOpen: boolean
  onChange: (v: OrderType) => void
}): React.JSX.Element {
  const value =
    !props.isOpen && props.orderType === "market"
      ? "limit"
      : props.orderType === "conditional"
        ? "limit"
        : props.orderType
  return (
    <Tabs
      value={value}
      onValueChange={(v) => {
        if (!props.isOpen && v === "market") return
        props.onChange(v as OrderType)
      }}
    >
      <TabsList className="w-full">
        <TabsTrigger value="limit" className="flex-1 text-xs">
          限价
        </TabsTrigger>
        <TabsTrigger
          value="market"
          className="flex-1 text-xs"
          disabled={!props.isOpen}
        >
          市价
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
}

export function PriceModeTabs(props: {
  priceMode: PriceMode
  onChange: (m: PriceMode) => void
}): React.JSX.Element {
  return (
    <div className="flex gap-1">
      <Button
        size="sm"
        variant={props.priceMode === "opponent" ? "default" : "outline"}
        className="flex-1 h-7 text-xs"
        onClick={() => props.onChange("opponent")}
      >
        对手价
      </Button>
      <Button
        size="sm"
        variant={props.priceMode === "manual" ? "default" : "outline"}
        className="flex-1 h-7 text-xs"
        onClick={() => props.onChange("manual")}
      >
        指定价
      </Button>
    </div>
  )
}

export function DirButtons(props: {
  direction: OrderDirection
  onChange: (d: OrderDirection) => void
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-3 gap-1.5 px-3 mt-3">
      {(
        [
          ["buy", "买多", "buy"],
          ["sell", "卖空", "sell"],
          ["close", "平仓", "close"],
        ] as const
      ).map(([dir, label, variant]) => (
        <Button
          key={dir}
          variant={variant}
          size="sm"
          className={cn(props.direction !== dir && "opacity-40")}
          onClick={() => props.onChange(dir)}
        >
          {label}
        </Button>
      ))}
    </div>
  )
}

export function PriceBlock(props: {
  orderType: OrderType
  priceMode: PriceMode
  effectiveDir: OrderDirection
  priceNum: number
  decimals: number
  lastPrice: number
  manualPrice: string
  onManual: (v: string) => void
}): React.JSX.Element {
  if (props.orderType === "market") {
    return (
      <p className="text-[10px] text-[var(--text-muted)]">
        市价参考{" "}
        {props.lastPrice > 0 ? props.lastPrice.toFixed(props.decimals) : "--"}
      </p>
    )
  }
  if (props.priceMode === "opponent") {
    return (
      <div className="rounded-md bg-[var(--bg-tertiary)]/60 px-2.5 py-2">
        <div className="flex justify-between items-center">
          <span className="text-xs text-[var(--text-muted)]">
            {props.effectiveDir === "buy" ? "对手价(卖一)" : "对手价(买一)"}
          </span>
          <span
            className={cn(
              "font-num text-base font-semibold",
              props.effectiveDir === "buy" ? "text-down" : "text-up"
            )}
          >
            {props.priceNum > 0
              ? props.priceNum.toFixed(props.decimals)
              : "--"}
          </span>
        </div>
        <p className="text-[10px] text-[var(--text-muted)] mt-1">
          随盘口变动 · 点下单即按当前对手价委托
        </p>
      </div>
    )
  }
  return (
    <div className="space-y-1">
      <Label className="text-xs">指定价格</Label>
      <Input
        type="number"
        value={props.manualPrice}
        onChange={(e) => props.onManual(e.target.value)}
        className="font-num h-8 text-sm"
        placeholder="输入委托价"
      />
    </div>
  )
}

export function InfoRow(props: {
  label: string
  value: string
}): React.JSX.Element {
  return (
    <div className="flex justify-between text-xs text-[var(--text-muted)]">
      <span>{props.label}</span>
      <span className="font-num">{props.value}</span>
    </div>
  )
}

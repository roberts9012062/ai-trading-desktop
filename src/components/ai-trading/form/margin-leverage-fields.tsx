"use client"

/**
 * r20 保证金/杠杆任务仓位参数（量化 / AI 交易 / 编辑共用）
 * 单位 USDT（可小数）；数量 = 保证金 × 杠杆 ÷ 价格 自动换算，不再按手数。
 */

import { useEffect, useState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { fetchFundingSource, type FundingSourceInfo } from "@/lib/ai-trading-api"

export interface MarginLeverageValue {
  /** 每笔保证金 USDT */
  marginPerTrade: number
  /** 杠杆 1-100 */
  leverage: number
  /** 保证金模式 cross 全仓 / isolated 逐仓 */
  marginMode: "cross" | "isolated"
}

/** 保证金 + 杠杆 + 保证金模式 + 自动数量预览（数量预览需传最新价）
 * budgetOnly=true：半仓/全仓/资金比例模式，保证金由预算比例决定，只露杠杆。 */
export function MarginLeverageFields(props: {
  value: MarginLeverageValue
  onChange: (v: MarginLeverageValue) => void
  /** 最新价（来自行情 quote），用于数量预览 */
  lastPrice?: number
  /** 滚仓模式时标签改为「每层保证金」 */
  scaleIn?: boolean
  /** 只调杠杆（保证金=预算比例） */
  budgetOnly?: boolean
}): React.JSX.Element {
  const { value, onChange, lastPrice, scaleIn, budgetOnly } = props
  const qty =
    lastPrice && lastPrice > 0 && value.marginPerTrade > 0
      ? (value.marginPerTrade * value.leverage) / lastPrice
      : 0
  const notional = value.marginPerTrade * value.leverage
  return (
    <div className="space-y-2">
      {!budgetOnly && (
        <div className="space-y-1">
          <Label className="text-xs">
            {scaleIn ? "每层保证金（USDT）" : "每笔保证金（USDT）"}
          </Label>
          <Input
            type="number"
            min={1}
            step="any"
            value={value.marginPerTrade}
            onChange={(e) =>
              onChange({ ...value, marginPerTrade: Math.max(1, Number(e.target.value) || 1) })
            }
            className="font-num h-9 text-sm"
            placeholder="如 100"
          />
        </div>
      )}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className="text-xs">杠杆</Label>
          <span className="font-num text-xs text-[var(--primary)] font-semibold">
            {value.leverage}x
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            type="range"
            min={1}
            max={100}
            step={1}
            value={value.leverage}
            onChange={(e) =>
              onChange({ ...value, leverage: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })
            }
            className="h-1.5 flex-1 accent-[var(--primary)]"
          />
          {[5, 10, 20, 50, 100].map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onChange({ ...value, leverage: v })}
              className={cn(
                "px-1.5 h-6 text-[10px] rounded border transition-colors shrink-0",
                value.leverage === v
                  ? "border-[var(--primary)] text-[var(--primary)] bg-[var(--primary)]/10"
                  : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)]",
              )}
            >
              {v}x
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">保证金模式</Label>
        <div className="grid grid-cols-2 gap-1.5">
          {(
            [
              { v: "cross" as const, label: "全仓", hint: "账户共享保证金" },
              { v: "isolated" as const, label: "逐仓", hint: "仓位独立强平线" },
            ]
          ).map(({ v, label, hint }) => (
            <button
              key={v}
              type="button"
              onClick={() => onChange({ ...value, marginMode: v })}
              className={cn(
                "h-9 rounded-md border text-left px-2 transition-colors",
                value.marginMode === v
                  ? "border-[var(--primary)] bg-[var(--primary)]/10"
                  : "border-[var(--border)] hover:bg-[var(--bg-tertiary)]",
              )}
            >
              <span
                className={cn(
                  "block text-xs font-medium",
                  value.marginMode === v
                    ? "text-[var(--primary)]"
                    : "text-[var(--text-secondary)]",
                )}
              >
                {label}
              </span>
              <span className="block text-[10px] text-[var(--text-muted)]">
                {hint}
              </span>
            </button>
          ))}
        </div>
        <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
          全仓=全部仓位共用账户保证金，单仓无独立强平价；逐仓=该仓锁定自己的保证金，
          浮亏击穿即强平该仓（交易所按此口径执行，回测同口径模拟）。
        </p>
      </div>
      <div className="flex items-center justify-between text-[10px] text-[var(--text-muted)]">
        <span>{budgetOnly ? "数量 = 预算保证金×杠杆 ÷ 价格" : "自动数量 = 保证金×杠杆 ÷ 价格"}</span>
        <span className="font-num">
          {qty > 0 ? `${qty.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")} 币` : "--"}
          {notional > 0 && (
            <span className="ml-1">
              （名义 {notional.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} USDT）
            </span>
          )}
        </span>
      </div>
    </div>
  )
}

/** 任务资金源徽标：绑定实盘 API → 交易所 USDT；否则站内账户 */
export function useFundingSource(open: boolean): {
  info: FundingSourceInfo | null
  reload: () => void
} {
  const [info, setInfo] = useState<FundingSourceInfo | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void fetchFundingSource()
      .then((r) => {
        if (!cancelled) setInfo(r)
      })
      .catch(() => {
        if (!cancelled) setInfo(null)
      })
    return () => {
      cancelled = true
    }
  }, [open, nonce])
  return { info, reload: () => setNonce((n) => n + 1) }
}

/** 资金源展示条 */
export function FundingSourceBadge(props: {
  info: FundingSourceInfo | null
  onReload: () => void
}): React.JSX.Element | null {
  const { info, onReload } = props
  if (!info) return null
  const live = info.source === "live" && info.bound
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-[11px]",
        live
          ? "border-[var(--accent-warn)]/40 bg-[var(--accent-warn)]/5"
          : "border-[var(--border)] bg-[var(--bg-tertiary)]",
      )}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full shrink-0",
            live ? "bg-[var(--accent-warn)]" : "bg-[var(--primary)]",
          )}
        />
        <span className="text-[var(--text-secondary)] shrink-0">任务资金源</span>
        <span className="font-medium truncate">
          {live
            ? `${info.venue_name || (info.venue || "").toUpperCase()} 实盘${info.demo ? "（模拟）" : ""}`
            : "站内账户"}
        </span>
        <span className="font-num text-[var(--text-primary)] shrink-0">
          {live
            ? info.balance_usdt != null
              ? `${info.balance_usdt.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} USDT`
              : "读取失败"
            : `${info.site_balance_usdt.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} USDT`}
        </span>
      </div>
      <button
        type="button"
        onClick={onReload}
        className="text-[10px] text-[var(--text-muted)] hover:text-[var(--primary)] shrink-0"
      >
        刷新
      </button>
    </div>
  )
}

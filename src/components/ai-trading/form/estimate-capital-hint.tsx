"use client"

/**
 * AI 任务仓位资金估算提示
 * 根据 symbol + 手数估算所需资金，与 AI 资金仓对比，不足时提示并可一键调足
 */

import { useEffect, useState } from "react"
import {
  estimatePositionCapital,
  type EstimateCapitalResult,
} from "@/lib/ai-trading-api"

interface EstimateCapitalHintProps {
  symbol: string
  qty: number
  allocatedCapital: number
  onAdjustCapital: (v: number) => void
}

/** 估算提示行 */
export function EstimateCapitalHint(
  props: EstimateCapitalHintProps,
): React.JSX.Element | null {
  const { symbol, qty, allocatedCapital, onAdjustCapital } = props
  const [data, setData] = useState<EstimateCapitalResult | null>(null)

  useEffect(() => {
    const sym = (symbol || "").trim().toLowerCase()
    const q = Math.max(1, Math.min(10000, Math.floor(qty || 0)))
    if (!sym || q <= 0) {
      setData(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const r = await estimatePositionCapital(sym, q)
        if (!cancelled) setData(r)
      } catch {
        if (!cancelled) setData(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [symbol, qty])

  if (!data) return null
  if (!data.total_needed || !data.per_hand_margin) {
    return (
      <p className="text-[10px] text-[var(--text-muted)]">
        暂无 {symbol} 最新价，无法估算所需资金
      </p>
    )
  }

  const need = data.total_needed
  const enough = allocatedCapital >= need
  const fmt = (v: number): string =>
    v.toLocaleString("zh-CN", { maximumFractionDigits: 0 })

  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg-tertiary)]/40 px-2.5 py-1.5 text-[11px] space-y-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[var(--text-muted)]">
        <span>
          单手保证金{" "}
          <span className="font-num text-[var(--text-secondary)]">
            ¥{fmt(data.per_hand_margin)}
          </span>
        </span>
        <span>
          最新价{" "}
          <span className="font-num text-[var(--text-secondary)]">
            {data.last_price}
          </span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className="text-[var(--text-muted)]">
          {qty} 手约需{" "}
          <span className="font-num text-[var(--text-primary)]">¥{fmt(need)}</span>
        </span>
        <span className="text-[var(--text-muted)]">
          AI 资金仓{" "}
          <span className="font-num text-[var(--text-secondary)]">
            ¥{fmt(allocatedCapital)}
          </span>
        </span>
        {enough ? (
          <span className="text-up">充足</span>
        ) : (
          <span className="text-down">
            不足（缺 ¥{fmt(need - allocatedCapital)}）
          </span>
        )}
      </div>
      {!enough && (
        <button
          type="button"
          onClick={() => onAdjustCapital(Math.ceil(need / 1000) * 1000)}
          className="text-[10px] px-2 py-0.5 rounded border border-[var(--primary)]/40 bg-[var(--primary)]/10 text-[var(--primary)] hover:bg-[var(--primary)]/20"
        >
          资金仓调到 ¥{fmt(Math.ceil(need / 1000) * 1000)}
        </button>
      )}
    </div>
  )
}

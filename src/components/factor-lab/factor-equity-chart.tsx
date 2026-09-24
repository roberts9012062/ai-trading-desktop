"use client"

/**
 * 因子资金曲线 —— SVG 自绘（红=资金，灰=价格）
 */

import { useMemo } from "react"
import type { EquityPoint } from "@/lib/factor-lab-api"

interface FactorEquityChartProps {
  curve: EquityPoint[]
}

const W = 640
const H = 260
const PAD = 10

/** 资金曲线与价格叠加图 */
export function FactorEquityChart({
  curve,
}: FactorEquityChartProps): React.JSX.Element {
  const view = useMemo(() => {
    if (curve.length < 2) return null
    const eqs = curve.map((c) => c.equity)
    const prices = curve.map((c) => c.price)
    const minEq = Math.min(...eqs)
    const maxEq = Math.max(...eqs)
    const minP = Math.min(...prices)
    const maxP = Math.max(...prices)
    const spanEq = Math.max(1e-9, maxEq - minEq)
    const spanP = Math.max(1e-9, maxP - minP)
    const n = curve.length
    const x = (i: number) => PAD + (i / (n - 1)) * (W - 2 * PAD)
    const yEq = (v: number) => PAD + (1 - (v - minEq) / spanEq) * (H - 2 * PAD)
    const yP = (v: number) => PAD + (1 - (v - minP) / spanP) * (H - 2 * PAD)
    const eqPath = curve
      .map((c, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${yEq(c.equity).toFixed(1)}`)
      .join(" ")
    const pricePath = curve
      .map((c, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${yP(c.price).toFixed(1)}`)
      .join(" ")
    return { eqPath, pricePath, minEq, maxEq }
  }, [curve])

  if (!view) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-xs text-[var(--text-muted)]">
        选择上方公式查看资金曲线
      </div>
    )
  }
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
      <div className="flex justify-between text-[11px] text-[var(--text-muted)] mb-1">
        <span>
          <span className="inline-block w-3 h-px bg-[var(--accent-up)] align-middle mr-1" />
          资金
          <span className="inline-block w-3 h-px bg-[var(--text-muted)] align-middle mr-1 ml-3" />
          价格
        </span>
        <span className="font-num">
          {view.minEq.toFixed(0)} ~ {view.maxEq.toFixed(0)}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        preserveAspectRatio="none"
        style={{ height: H }}
      >
        <path d={view.pricePath} stroke="rgba(156,163,175,0.45)" strokeWidth={1} fill="none" />
        <path d={view.eqPath} stroke="var(--accent-up)" strokeWidth={1.5} fill="none" />
      </svg>
    </div>
  )
}

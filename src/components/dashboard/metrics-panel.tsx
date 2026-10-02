"use client"

import { useMemo } from "react"
import { useMarketStore } from "@/stores/market"
import { usePaperTradingStore } from "@/stores/paper-trading"
import { positionPnl } from "@/lib/position-pnl"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { OkxPnlCalendar } from "@/components/dashboard/okx-pnl-calendar"
import { cn } from "@/lib/utils"

function fmtMoney(v: number): string {
  if (!Number.isFinite(v)) return "--"
  return Math.abs(v) >= 100000
    ? v.toLocaleString("zh-CN", { maximumFractionDigits: 0 })
    : v.toLocaleString("zh-CN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
}

function pnlColor(v: number): string {
  return v > 0 ? "text-up" : v < 0 ? "text-down" : "text-[var(--text-primary)]"
}

/** 单元格：标签 + 数值 + 副文案 */
function MetricCell({
  label,
  value,
  valueClass,
  sub,
  className,
}: {
  label: string
  value: string
  valueClass: string
  sub: string
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn("min-w-0 px-1", className)}>
      <div className="text-[11px] text-[var(--text-muted)]">{label}</div>
      <div
        className={cn(
          "font-num text-lg font-semibold truncate mt-0.5",
          valueClass
        )}
      >
        {value}
      </div>
      <div className="text-[10px] text-[var(--text-muted)] truncate mt-0.5">
        {sub}
      </div>
    </div>
  )
}

/** 数据看板 —— 今日已实现盈利 / 持仓浮动盈亏 / 多空持仓比 / 保证金占用（双模式） */
export function MetricsPanel(): React.JSX.Element {
  const mode = usePaperTradingStore((s) => s.mode)
  const loaded = usePaperTradingStore((s) => s.loaded)
  const positions = usePaperTradingStore((s) => s.positions)
  const orders = usePaperTradingStore((s) => s.orders)
  const account = usePaperTradingStore((s) => s.account)
  const quotes = useMarketStore((s) => s.quotes)

  /** 今日（本地自然日）已实现盈利：已成交平仓单合计 */
  const todayRealized = useMemo(() => {
    const dayStart = new Date()
    dayStart.setHours(0, 0, 0, 0)
    let sum = 0
    let count = 0
    for (const o of orders) {
      if (o.offset !== "close" || o.status !== "filled") continue
      const t = new Date(o.filled_at || o.updated_at || o.created_at).getTime()
      if (!Number.isFinite(t) || t < dayStart.getTime()) continue
      sum += Number(o.realized_pnl || 0)
      count += 1
    }
    return { sum, count }
  }, [orders])

  /** 持仓浮动盈亏合计 + 多空结构（按保证金权重）+ 保证金占用 */
  const posStats = useMemo(() => {
    let unreal = 0
    let longMargin = 0
    let shortMargin = 0
    let longCount = 0
    let shortCount = 0
    let marginUsed = 0
    for (const p of positions) {
      unreal += positionPnl(p, mode, quotes[p.symbol]?.last_price)
      const m = Number(p.margin) || 0
      marginUsed += m
      if (p.direction === "short") {
        shortMargin += m
        shortCount += 1
      } else {
        longMargin += m
        longCount += 1
      }
    }
    return {
      unreal,
      longMargin,
      shortMargin,
      longCount,
      shortCount,
      marginUsed,
    }
  }, [positions, mode, quotes])

  const equity = Number(account?.total_equity || 0)
  const marginPct = equity > 0 ? (posStats.marginUsed / equity) * 100 : null

  /** 多空持仓比展示：按保证金权重 */
  const ls = useMemo(() => {
    const total = posStats.longMargin + posStats.shortMargin
    if (posStats.longCount + posStats.shortCount === 0) {
      return { text: "--", sub: "暂无持仓", longPct: 0 }
    }
    if (total <= 0) {
      // 无保证金数据（虚拟盘早期数据）退化为按持仓数
      const lt = posStats.longCount + posStats.shortCount
      const pct = Math.round((posStats.longCount / lt) * 100)
      return {
        text: `${pct}% : ${100 - pct}%`,
        sub: `多 ${posStats.longCount} · 空 ${posStats.shortCount}（按笔数）`,
        longPct: pct,
      }
    }
    const longPct = (posStats.longMargin / total) * 100
    if (posStats.shortMargin <= 0) {
      return { text: "全多", sub: `多 ${posStats.longCount} · 空 0（按保证金）`, longPct: 100 }
    }
    if (posStats.longMargin <= 0) {
      return { text: "全空", sub: `多 0 · 空 ${posStats.shortCount}（按保证金）`, longPct: 0 }
    }
    return {
      text: `${(posStats.longMargin / posStats.shortMargin).toFixed(2)} : 1`,
      sub: `多 ${posStats.longCount} · 空 ${posStats.shortCount}（按保证金）`,
      longPct: Math.round(longPct),
    }
  }, [posStats])

  const cells = [
    {
      label: "今日已实现盈利",
      value: `${todayRealized.sum > 0 ? "+" : ""}${fmtMoney(todayRealized.sum)}`,
      valueClass: pnlColor(todayRealized.sum),
      sub:
        todayRealized.count > 0
          ? `今日平仓 ${todayRealized.count} 笔`
          : "今日暂无平仓",
    },
    {
      label: "持仓浮动盈亏",
      value: `${posStats.unreal > 0 ? "+" : ""}${fmtMoney(posStats.unreal)}`,
      valueClass: pnlColor(posStats.unreal),
      sub: positions.length > 0 ? `${positions.length} 个持仓` : "暂无持仓",
    },
    {
      label: "多空持仓比",
      value: ls.text,
      valueClass: "text-[var(--text-primary)]",
      sub: ls.sub,
    },
    {
      label: "保证金占用",
      value: fmtMoney(posStats.marginUsed),
      valueClass: "text-[var(--text-primary)]",
      sub:
        marginPct != null
          ? `占权益 ${marginPct.toFixed(1)}%`
          : `共 ${positions.length} 个持仓`,
    },
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle>数据看板{loaded ? "" : "（加载中…）"}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 rounded-lg bg-[var(--bg-tertiary)]/50 px-2 py-3">
          {cells.map((c, i) => (
            <MetricCell
              key={c.label}
              label={c.label}
              value={c.value}
              valueClass={c.valueClass}
              sub={c.sub}
              className={
                i > 0 ? "border-l border-[var(--border)]/60 pl-3" : undefined
              }
            />
          ))}
        </div>
        {/* 多空保证金分布条 */}
        {ls.longPct > 0 && ls.longPct < 100 && (
          <div className="mt-2 flex items-center gap-2 px-2">
            <div className="flex-1 h-1.5 rounded-full overflow-hidden flex bg-[var(--bg-secondary)]">
              <div className="bg-red-500/70" style={{ width: `${ls.longPct}%` }} />
              <div
                className="bg-emerald-500/70"
                style={{ width: `${100 - ls.longPct}%` }}
              />
            </div>
            <span className="text-[10px] text-[var(--text-muted)] font-num shrink-0">
              多 {ls.longPct}% / 空 {100 - ls.longPct}%
            </span>
          </div>
        )}

        {/* OKX 盈亏日历：本地直连账单 → 月度汇总 + 九宫格日盈亏 + 累计曲线 */}
        <OkxPnlCalendar />
      </CardContent>
    </Card>
  )
}

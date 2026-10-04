"use client"

import { useEffect, useMemo, useState } from "react"
import { useMarketStore } from "@/stores/market"
import { usePaperTradingStore } from "@/stores/paper-trading"
import { positionPnl } from "@/lib/position-pnl"
import { getDailyPnlApi } from "@/lib/live-api"
import { dailyNetPnl, paperTodayNetPnl } from "@/lib/daily-net-pnl"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
      <div title={sub} className="text-[10px] text-[var(--text-muted)] truncate mt-0.5">
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

  // 实盘今日盈亏：OKX 成交明细口径（与下方收益分析九宫格同源同数——
  // 镜像单合计会因 realized_pnl 缺失/不含手续费/漏手动单而对不上）
  const [okxToday, setOkxToday] = useState<{
    net: number
    win: number
    loss: number
    fee: number
    funding: number
    trades: number
  } | null>(null)
  useEffect(() => {
    if (mode !== "live") {
      setOkxToday(null)
      return
    }
    let alive = true
    const load = async () => {
      try {
        const bj = new Date(Date.now() + 8 * 3600_000)
          .toISOString()
          .slice(0, 10)
        const res = await getDailyPnlApi("okx", 7)
        if (!alive) return
        const row = (res.days ?? []).find((d) => d.date === bj)
        setOkxToday(
          row
            ? {
                net: dailyNetPnl(row),
                win: row.win_pnl ?? 0,
                loss: row.loss_pnl ?? 0,
                fee: row.fee_cost ?? row.fee ?? 0,
                funding: row.funding ?? 0,
                trades: row.trades,
              }
            : res.summary ? { net: 0, win: 0, loss: 0, fee: 0, funding: 0, trades: 0 } : null
        )
      } catch {
        /* 无权威费用数据时显示占位，避免把镜像毛盈亏冒充净利润 */
        if (alive) setOkxToday(null)
      }
    }
    load()
    const timer = setInterval(load, 60_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [mode])

  /** 北京自然日扣费净利润：包含当日开/平仓手续费和已结算资金费。 */
  const todayRealized = useMemo(() => {
    if (mode === "live" && okxToday !== null) {
      return {
        sum: okxToday.net,
        count: okxToday.trades,
        win: okxToday.win,
        loss: okxToday.loss,
        fee: okxToday.fee,
        funding: okxToday.funding,
      }
    }
    if (mode === "live") return { sum: NaN, count: 0, win: null, loss: null, fee: 0, funding: 0 }
    return paperTodayNetPnl(orders)
  }, [mode, okxToday, orders])

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
      label: "今日平仓净利润",
      value: `${todayRealized.sum > 0 ? "+" : ""}${fmtMoney(todayRealized.sum)}`,
      valueClass: pnlColor(todayRealized.sum),
      sub:
        mode === "live" && todayRealized.win !== null
          ? todayRealized.count > 0
            ? `已计手续费 ${fmtMoney(todayRealized.fee)} · 资金费 ${todayRealized.funding > 0 ? "+" : ""}${fmtMoney(todayRealized.funding)}`
            : `已扣费 · 资金费 ${todayRealized.funding > 0 ? "+" : ""}${fmtMoney(todayRealized.funding)}`
          : mode === "live"
            ? "交易所净利润暂不可用"
            : `今日平仓 ${todayRealized.count} 笔 · 已计手续费 ${fmtMoney(todayRealized.fee)}`,
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
      </CardContent>
    </Card>
  )
}

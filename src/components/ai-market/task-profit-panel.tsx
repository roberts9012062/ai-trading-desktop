"use client";

/**
 * AI 看盘行情 —— 底部「任务总收益」面板（柱状图版）
 *
 * 概览行：总收益（已实现+浮盈）+ 已实现 + 浮盈 + 胜率。
 * 柱状图两种模式（点击切换，时间从左到右）：
 * - 开单收益：每笔平仓一柱（该笔已实现盈亏，盈红亏绿）
 * - 累计收益：权益序列每点一柱（当时累计总收益，含浮动）
 *
 * 已实现收益取权益序列最后一点（服务端累计），不能用任务列表的
 * cash_delta —— 那是「当前持仓浮盈」，无持仓时恒为 0。
 * 平仓明细不再列出（右下「交易记录」面板已有），悬停柱子看单笔详情。
 */

import { useEffect, useMemo, useState } from "react"
import { cn, formatDisplayTime } from "@/lib/utils"
import {
  fetchEquitySeries,
  type EquityPoint,
} from "@/lib/ai-trading-api"
import {
  formatProfitAmount,
  PROFIT_DOWN_COLOR,
  PROFIT_UP_COLOR,
} from "@/components/ai-trading/profit/profit-bar-data"
import { livePnl } from "@/components/ai-trading/task-list-helpers"
import { useAiMarketStore } from "@/stores/ai-market"
import { useMarketStore } from "@/stores/market"

type ChartMode = "perClose" | "cumulative"

interface CloseBar {
  id: string
  time: string
  direction: string
  qty: number
  price: number
  pnl: number
}

/** 从交易记录提取平仓柱（时间升序，最多最近 50 笔交易内的平仓） */
function buildCloseBars(
  trades: Record<string, unknown>[],
): CloseBar[] {
  const bars: CloseBar[] = []
  for (const row of trades) {
    if (String(row.offset ?? "") !== "close") continue
    if (String(row.status ?? "") !== "filled") continue
    const pnl = Number(row.realized_pnl ?? 0)
    if (!Number.isFinite(pnl)) continue
    bars.push({
      id: String(row.id ?? ""),
      time: String(row.filled_at || row.created_at || ""),
      direction: String(row.direction ?? ""),
      qty: Number(row.filled_qty ?? row.quantity ?? 0),
      price: Number(row.price ?? 0),
      pnl,
    })
  }
  return bars.reverse()
}

/** 平仓方向 → 买平/卖平 */
function closeSideLabel(direction: string): string {
  return direction === "buy" ? "买平" : "卖平"
}

interface ChartBar {
  key: string
  value: number
  hint: string
}

export function TaskProfitPanel(): React.JSX.Element {
  const tasks = useAiMarketStore((s) => s.tasks)
  const selectedTaskId = useAiMarketStore((s) => s.selectedTaskId)
  const trades = useAiMarketStore((s) => s.trades)
  const recordsSeq = useAiMarketStore((s) => s.recordsSeq)
  const quotes = useMarketStore((s) => s.quotes)

  const task = useMemo(
    () => tasks.find((t) => t.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId],
  )
  const taskId = task?.id ?? ""

  // 权益序列（累计收益柱 + 已实现汇总）。trades/recordsSeq 变化即记录
  // 刷新（运行任务 15s 轮询、预警命中），随之重拉保持图表最新。
  const [equity, setEquity] = useState<EquityPoint[]>([])
  useEffect(() => {
    let cancelled = false
    if (!taskId) {
      setEquity([])
      return
    }
    fetchEquitySeries([taskId], 500)
      .then((r) => {
        if (!cancelled) setEquity(r.series?.[taskId] ?? [])
      })
      .catch(() => {
        if (!cancelled) setEquity([])
      })
    return () => {
      cancelled = true
    }
  }, [taskId, trades, recordsSeq])

  const [mode, setMode] = useState<ChartMode>("perClose")
  const closeBars = useMemo(() => buildCloseBars(trades), [trades])

  const bars: ChartBar[] = useMemo(() => {
    if (mode === "perClose") {
      return closeBars.map((b) => ({
        key: b.id,
        value: b.pnl,
        hint: `${formatDisplayTime(b.time)} ${closeSideLabel(b.direction)} ${b.qty}手@${b.price}　${formatProfitAmount(b.pnl)}`,
      }))
    }
    return equity.map((p, i) => {
      const total = Number(p.cash_delta)
      return {
        key: `${p.ts}-${i}`,
        value: total,
        hint: `${formatDisplayTime(p.ts)} 累计 ${formatProfitAmount(total)}（已实现 ${formatProfitAmount(Number(p.realized_pnl))}）`,
      }
    })
  }, [mode, closeBars, equity])

  const quote = task
    ? quotes[task.symbol] ??
      quotes[task.symbol.toLowerCase()] ??
      quotes[task.symbol.toUpperCase()]
    : undefined
  const pnl = task ? livePnl(task, quote?.last_price) : null
  const unrealized = pnl?.hasPosition ? pnl.pnl : 0
  // 已实现：权益序列最后一点（服务端累计）；序列不可用时退回平仓柱合计
  const realized =
    equity.length > 0
      ? Number(equity[equity.length - 1].realized_pnl)
      : closeBars.reduce((s, b) => s + b.pnl, 0)
  const total = realized + unrealized

  // 胜率用服务端统计（任务级 win/loss/count，不受记录 50 条截断影响）
  const winCount = Number(task?.win_count ?? 0)
  const lossCount = Number(task?.loss_count ?? 0)
  const tradeCount = Number(task?.trade_count ?? 0)
  const winRate =
    task?.win_rate != null ? Math.round(Number(task.win_rate)) : null

  // 柱状图几何：零轴位置按正负极值比例分配，盈柱向上红、亏柱向下绿
  const { baselineTopPct, scalePct } = useMemo(() => {
    let maxPos = 0
    let minNeg = 0
    for (const b of bars) {
      if (b.value > maxPos) maxPos = b.value
      if (b.value < minNeg) minNeg = b.value
    }
    const range = maxPos - minNeg
    if (range <= 0) return { baselineTopPct: maxPos > 0 ? 100 : 0, scalePct: 0 }
    return {
      baselineTopPct: (maxPos / range) * 100,
      scalePct: 100 / range,
    }
  }, [bars])

  const timeLabel = (idx: 0 | 1): string => {
    if (mode === "perClose") {
      if (closeBars.length === 0) return ""
      return formatDisplayTime(
        idx === 0 ? closeBars[0].time : closeBars[closeBars.length - 1].time,
      )
    }
    if (equity.length === 0) return ""
    return formatDisplayTime(
      idx === 0 ? equity[0].ts : equity[equity.length - 1].ts,
    )
  }

  return (
    <div className="flex h-full flex-col bg-[var(--bg-secondary)]">
      {/* 概览：任务名 + 图表模式切换 + 总收益/已实现/浮盈/胜率 */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-[var(--border)] flex-wrap shrink-0">
        <span className="text-xs font-semibold text-[var(--text-primary)] truncate max-w-[160px]">
          {task ? task.name : "任务总收益"}
        </span>
        <div className="flex items-center gap-0.5 rounded-md border border-[var(--border)] p-0.5 shrink-0">
          <button
            type="button"
            onClick={() => setMode("perClose")}
            className={cn(
              "px-2 py-0.5 rounded text-[10px] transition-colors cursor-pointer",
              mode === "perClose"
                ? "bg-[var(--primary)]/15 text-[var(--primary)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
            )}
          >
            开单收益
          </button>
          <button
            type="button"
            onClick={() => setMode("cumulative")}
            className={cn(
              "px-2 py-0.5 rounded text-[10px] transition-colors cursor-pointer",
              mode === "cumulative"
                ? "bg-[var(--primary)]/15 text-[var(--primary)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
            )}
          >
            累计收益
          </button>
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs text-[var(--text-muted)] flex-wrap">
          <span
            className={cn(
              "font-num font-bold text-sm shrink-0",
              total > 0 ? "text-up" : total < 0 ? "text-down" : "",
            )}
          >
            总收益 {formatProfitAmount(total)}
          </span>
          <span>
            已实现{" "}
            <span
              className={cn(
                "font-num font-semibold",
                realized > 0 ? "text-up" : realized < 0 ? "text-down" : "",
              )}
            >
              {formatProfitAmount(realized)}
            </span>
          </span>
          <span>
            浮盈{" "}
            <span
              className={cn(
                "font-num font-semibold",
                unrealized > 0 ? "text-up" : unrealized < 0 ? "text-down" : "",
              )}
            >
              {formatProfitAmount(unrealized)}
            </span>
          </span>
          {tradeCount > 0 && (
            <span>
              胜{winCount} 亏{lossCount}
              {winRate != null && ` · 胜率 ${winRate}%`}
            </span>
          )}
        </div>
      </div>

      {/* 柱状图 */}
      <div className="flex-1 min-h-0 px-2 pt-2">
        {!task && (
          <p className="text-xs text-[var(--text-muted)] text-center py-10">
            左侧选择一个任务查看收益
          </p>
        )}
        {task && bars.length === 0 && (
          <p className="text-xs text-[var(--text-muted)] text-center py-10">
            {mode === "perClose" ? "暂无平仓收益" : "暂无权益数据"}
          </p>
        )}
        {bars.length > 0 && (
          <div className="relative h-[calc(100%-14px)]">
            <div
              className="absolute left-0 right-0 h-px bg-[var(--border)] z-10 pointer-events-none"
              style={{ top: `${baselineTopPct}%` }}
            />
            <div className="absolute inset-0 flex items-stretch gap-px overflow-x-auto">
              {bars.map((b) => {
                const hPct = Math.max(
                  Math.abs(b.value) * scalePct,
                  0.8,
                )
                return (
                  <div
                    key={b.key}
                    className="relative flex-1 min-w-[2px] cursor-default"
                    title={b.hint}
                  >
                    {b.value >= 0 ? (
                      <div
                        className="absolute left-[15%] right-[15%] rounded-t-sm"
                        style={{
                          bottom: `${100 - baselineTopPct}%`,
                          height: `${hPct}%`,
                          backgroundColor: PROFIT_UP_COLOR,
                        }}
                      />
                    ) : (
                      <div
                        className="absolute left-[15%] right-[15%] rounded-b-sm"
                        style={{
                          top: `${baselineTopPct}%`,
                          height: `${hPct}%`,
                          backgroundColor: PROFIT_DOWN_COLOR,
                        }}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* 时间轴提示：首尾时间 + 柱数 */}
      {bars.length > 0 && (
        <div className="flex items-center justify-between px-3 pb-1 text-[9px] text-[var(--text-muted)] shrink-0">
          <span className="font-num">{timeLabel(0)}</span>
          <span>
            {mode === "perClose"
              ? `${bars.length} 笔平仓`
              : `${bars.length} 个权益点`}
            　时间 →
          </span>
          <span className="font-num">{timeLabel(1)}</span>
        </div>
      )}
    </div>
  )
}

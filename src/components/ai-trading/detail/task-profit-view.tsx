"use client"

/**
 * 任务收益视图（收藏夹详情只读版）
 *
 * 已运行时长（运行中每秒跳动）+ 总收益/已实现/浮盈/胜率概览；
 * 两张柱状图：累计收益（权益序列逐点，周期任务≈每15分钟一根）、
 * 总收益（每笔平仓）。任务运行中每 15s 轮询动态更新；结束则静态，
 * 权益序列服务端累计，下次开启自然接续末尾递增。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import {
  fetchEquitySeries,
  getAITradingTask,
  listAITradingTrades,
  type AITradingTask,
  type EquityPoint,
} from "@/lib/ai-trading-api"
import {
  formatProfitAmount,
  PROFIT_DOWN_COLOR,
  PROFIT_UP_COLOR,
} from "@/components/ai-trading/profit/profit-bar-data"
import { livePnl } from "@/components/ai-trading/task-list-helpers"

const POLL_MS = 15_000

/** 已运行时长文案：累计秒数，运行中加当前段实时增量 */
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return `${d}天${h}时${m}分`
  if (h > 0) return `${h}时${m}分${sec}秒`
  if (m > 0) return `${m}分${sec}秒`
  return `${sec}秒`
}

/** 从平仓单提取每笔收益（时间升序） */
function buildCloseBars(
  trades: Record<string, unknown>[],
): Array<{ id: string; pnl: number }> {
  const bars: Array<{ id: string; pnl: number }> = []
  for (const row of trades) {
    if (String(row.offset ?? "") !== "close") continue
    if (String(row.status ?? "") !== "filled") continue
    const pnl = Number(row.realized_pnl ?? 0)
    if (!Number.isFinite(pnl)) continue
    bars.push({ id: String(row.id ?? ""), pnl })
  }
  return bars.reverse()
}

/** 共用柱状图（零轴按正负极值自适应，盈红亏绿） */
function BarChart({
  bars,
  emptyText,
  barHint,
}: {
  bars: Array<{ key: string; value: number; hint: string }>
  emptyText: string
  barHint?: (v: number) => string
}): React.JSX.Element {
  const geom = useMemo(() => {
    let maxPos = 0
    let minNeg = 0
    for (const b of bars) {
      if (b.value > maxPos) maxPos = b.value
      if (b.value < minNeg) minNeg = b.value
    }
    const range = maxPos - minNeg
    if (range <= 0)
      return { baselineTopPct: maxPos > 0 ? 100 : 0, scalePct: 0 }
    return { baselineTopPct: (maxPos / range) * 100, scalePct: 100 / range }
  }, [bars])

  if (bars.length === 0) {
    return (
      <p className="text-xs text-[var(--text-muted)] text-center py-6">
        {emptyText}
      </p>
    )
  }

  return (
    <div className="relative h-[110px]">
      <div
        className="absolute left-0 right-0 h-px bg-[var(--border)] z-10 pointer-events-none"
        style={{ top: `${geom.baselineTopPct}%` }}
      />
      <div className="absolute inset-0 flex items-stretch gap-px overflow-x-auto">
        {bars.map((b) => {
          const hPct = Math.max(Math.abs(b.value) * geom.scalePct, 0.8)
          return (
            <div
              key={b.key}
              className="relative flex-1 min-w-[2px] cursor-default"
              title={barHint ? barHint(b.value) : b.hint}
            >
              {b.value >= 0 ? (
                <div
                  className="absolute left-[15%] right-[15%] rounded-t-sm"
                  style={{
                    bottom: `${100 - geom.baselineTopPct}%`,
                    height: `${hPct}%`,
                    backgroundColor: PROFIT_UP_COLOR,
                  }}
                />
              ) : (
                <div
                  className="absolute left-[15%] right-[15%] rounded-b-sm"
                  style={{
                    top: `${geom.baselineTopPct}%`,
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
  )
}

export function TaskProfitView({ taskId }: { taskId: string }): React.JSX.Element {
  const [task, setTask] = useState<AITradingTask | null>(null)
  const [equity, setEquity] = useState<EquityPoint[]>([])
  const [trades, setTrades] = useState<Record<string, unknown>[]>([])
  const [tick, setTick] = useState(0)
  const mountedRef = useRef(true)

  const running = task?.status === "running"

  const reload = useCallback(async () => {
    try {
      const t = await getAITradingTask(taskId)
      if (!mountedRef.current) return
      setTask(t)
      // 结束态任务数据固定，取一次即可；运行中随轮询刷新
      const [eq, tr] = await Promise.all([
        fetchEquitySeries([taskId], 2000),
        listAITradingTrades(taskId, 100, 0),
      ])
      if (!mountedRef.current) return
      setEquity(eq.series?.[taskId] ?? [])
      setTrades(tr.items ?? [])
    } catch {
      // 静默保留旧数据
    }
  }, [taskId])

  useEffect(() => {
    mountedRef.current = true
    void reload()
    return () => {
      mountedRef.current = false
    }
  }, [reload])

  // 运行中：每 15s 轮询任务/权益/交易；结束时停
  const status = task?.status
  useEffect(() => {
    if (status !== "running") return
    const timer = setInterval(() => void reload(), POLL_MS)
    return () => clearInterval(timer)
  }, [status, reload])

  // 运行中：每秒跳动已运行时长
  useEffect(() => {
    if (status !== "running") return
    const timer = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [status])
  useEffect(() => {
    if (!running) setTick(0)
  }, [running])

  const closeBars = useMemo(() => buildCloseBars(trades), [trades])

  const realized =
    equity.length > 0
      ? Number(equity[equity.length - 1].realized_pnl)
      : closeBars.reduce((s, b) => s + b.pnl, 0)
  const pnl = task ? livePnl(task, undefined) : null
  const unrealized = pnl?.hasPosition ? pnl.pnl : 0
  const total = realized + unrealized

  // 已运行时长 = 累计秒数 + 运行中当前段增量（run_started_at 起）
  const runtimeSeconds = useMemo(() => {
    void tick
    const base = Number(task?.runtime_seconds ?? 0)
    if (running && task?.run_started_at) {
      const started = new Date(task.run_started_at).getTime()
      if (Number.isFinite(started)) {
        return base + Math.max(0, (Date.now() - started) / 1000)
      }
    }
    return base
  }, [task, running, tick])

  const winCount = Number(task?.win_count ?? 0)
  const lossCount = Number(task?.loss_count ?? 0)
  const tradeCount = Number(task?.trade_count ?? 0)
  const winRate =
    task?.win_rate != null ? Number(task.win_rate).toFixed(1) : null

  return (
    <div className="space-y-3">
      {/* 概览：时长 + 收益数字 + 胜率 */}
      <div className="flex items-center gap-3 flex-wrap text-xs">
        <span className="text-[var(--text-muted)]">
          已运行{" "}
          <span className="font-num font-semibold text-[var(--text-primary)]">
            {task ? formatDuration(runtimeSeconds) : "—"}
          </span>
          {running && (
            <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse align-middle" />
          )}
        </span>
        <span
          className={cn(
            "font-num text-sm font-bold",
            total > 0 ? "text-up" : total < 0 ? "text-down" : "",
          )}
        >
          总收益 {formatProfitAmount(total)}
        </span>
        <span className="text-[var(--text-muted)]">
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
        <span className="text-[var(--text-muted)]">
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
          <span className="text-[var(--text-muted)]">
            胜{winCount} 亏{lossCount}
            {winRate != null && ` · 胜率 ${winRate}%`}
          </span>
        )}
      </div>

      {/* 累计收益：权益序列逐点（15m 任务即每 15 分钟一根） */}
      <div>
        <p className="text-[11px] text-[var(--text-secondary)] font-medium pb-1">
          累计收益
          <span className="text-[var(--text-muted)] font-normal">
            （{equity.length} 个权益点 · 时间从左到右）
          </span>
        </p>
        <BarChart
          bars={equity.map((p, i) => ({
            key: `${p.ts}-${i}`,
            value: Number(p.cash_delta),
            hint: `累计 ${formatProfitAmount(Number(p.cash_delta))}（已实现 ${formatProfitAmount(Number(p.realized_pnl))}）`,
          }))}
          emptyText="暂无权益数据"
        />
      </div>

      {/* 总收益：每笔平仓一柱 */}
      <div>
        <p className="text-[11px] text-[var(--text-secondary)] font-medium pb-1">
          总收益
          <span className="text-[var(--text-muted)] font-normal">
            （每笔平仓一柱 · 共 {closeBars.length} 笔）
          </span>
        </p>
        <BarChart
          bars={closeBars.map((b) => ({
            key: b.id,
            value: b.pnl,
            hint: `平仓 ${formatProfitAmount(b.pnl)}`,
          }))}
          emptyText="暂无平仓收益"
        />
      </div>
    </div>
  )
}

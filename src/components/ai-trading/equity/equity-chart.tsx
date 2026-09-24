"use client"

/**
 * AI 模型收益对比 —— 精确折线 + 零轴 + 末端徽章 + 图例 hover 高亮
 */

import { useEffect, useMemo, useRef, useState } from "react"
import type {
  AITradingTask,
  EquityPoint,
  ProfitCloseBar,
} from "@/lib/ai-trading-api"
import { EquityEndBadges } from "./equity-end-badges"
import { EquityLegend } from "./equity-legend"
import { taskHasOpenPosition, taskLivePnl } from "./equity-data"
import {
  getTradeSessionRange,
  type EquityAxisMode,
  type TradeSessionRange,
} from "./equity-session"
import { useEquityChart } from "./use-equity-chart"

interface EquityChartProps {
  tasks: AITradingTask[]
  series: Record<string, EquityPoint[]>
  /** 总收益榜数据源（透传给图例「总收益榜」Tab） */
  profitBars?: ProfitCloseBar[]
}

function formatPnl(v: number): string {
  const sign = v >= 0 ? "+" : ""
  return `${sign}${v.toFixed(2)}`
}

/** 多任务收益对比图（仅当前持仓的任务；空仓不进入对比） */
export function EquityChart({
  tasks,
  series,
  profitBars = [],
}: EquityChartProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [highlightTaskId, setHighlightTaskId] = useState<string | null>(null)
  const [session, setSession] = useState<TradeSessionRange | null>(null)
  // 加密货币 7×24：横轴统一标准自然日 00:00→24:00（原 live 沿用期货夜盘 21:00→15:00 已废弃）
  const axisMode: EquityAxisMode = "virtual"

  const chartTasks = useMemo(
    () => tasks.filter(taskHasOpenPosition),
    [tasks],
  )

  useEffect(() => {
    setSession(getTradeSessionRange(Date.now(), axisMode))
  }, [axisMode])

  const lastValues = useMemo(() => {
    const map = new Map<string, number>()
    for (const task of chartTasks) {
      map.set(task.id, taskLivePnl(task, series[task.id] ?? []))
    }
    return map
  }, [chartTasks, series])

  const leader = useMemo(() => {
    if (chartTasks.length === 0) return null
    let best = chartTasks[0]
    let bestV = lastValues.get(best.id) ?? 0
    for (const t of chartTasks) {
      const v = lastValues.get(t.id) ?? 0
      if (v > bestV) {
        best = t
        bestV = v
      }
    }
    return { task: best, value: bestV }
  }, [chartTasks, lastValues])

  const { badges, chartWidth, chartHeight } = useEquityChart({
    containerRef,
    tasks: chartTasks,
    series,
    lastValues,
    leaderId: leader?.task.id ?? null,
    highlightTaskId,
    axisMode,
  })

  const axisBadge = "横轴:00:00→24:00"
  const hint =
    !session
      ? " · 正在同步交易时段"
      : " · 标准时间自然日（UTC+8），过 24 点切下一日并从 0 点重跑；悬停模型卡片可高亮走势"

  return (
    <div className="relative rounded-2xl border border-[var(--border)] overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0 opacity-90"
        style={{
          background:
            "radial-gradient(120% 80% at 10% 0%, rgba(59,130,246,0.08), transparent 50%), radial-gradient(90% 70% at 90% 100%, rgba(168,85,247,0.07), transparent 55%), linear-gradient(180deg, rgba(15,17,21,0.4) 0%, var(--bg-secondary) 40%)",
        }}
      />

      <div className="relative p-3 md:p-4">
        <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold tracking-wide text-[var(--text-primary)]">
                AI 模型收益对比
              </h3>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-sky-500/30 bg-sky-500/10 text-sky-300">
                {axisBadge}
              </span>
            </div>
            <p className="text-[11px] text-[var(--text-muted)] mt-1">
              {session?.label ?? "交易时段加载中"}
              {hint}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {leader && (
              <div className="hidden sm:flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border border-[var(--border)] bg-[var(--bg-tertiary)]/80">
                <span className="text-[var(--text-muted)]">领先</span>
                <span className="text-[var(--text-primary)] font-medium max-w-[100px] truncate">
                  {leader.task.model_display_name || leader.task.name}
                </span>
                <span
                  className={`font-num font-semibold ${
                    leader.value >= 0 ? "text-up" : "text-down"
                  }`}
                >
                  {formatPnl(leader.value)}
                </span>
              </div>
            )}
            <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400/90 px-2 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              实时
            </span>
          </div>
        </div>

        <div
          className="relative rounded-xl border border-white/5 bg-black/20"
          style={{ minHeight: chartHeight }}
        >
          <div
            ref={containerRef}
            className="w-full relative z-0"
            style={{ minHeight: chartHeight }}
          />
          <div className="absolute inset-0 z-10 pointer-events-none">
            <EquityEndBadges
              tasks={tasks}
              layouts={badges}
              chartHeight={chartHeight}
              chartWidth={chartWidth || 800}
              highlightTaskId={highlightTaskId}
            />
          </div>
          {chartTasks.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none gap-1 z-20">
              <span className="text-sm text-[var(--text-secondary)]">
                {tasks.length === 0
                  ? "还没有运行中的任务"
                  : "暂无持仓任务"}
              </span>
              <span className="text-[11px] text-[var(--text-muted)]">
                {tasks.length === 0
                  ? "创建 AI / 量化任务后，各模型收益将以曲线对比"
                  : "仅展示当前持仓的任务；空仓不进入对比"}
              </span>
            </div>
          )}
        </div>

        <EquityLegend
          tasks={chartTasks}
          series={series}
          profitBars={profitBars}
          highlightTaskId={highlightTaskId}
          onHighlightChange={setHighlightTaskId}
        />
      </div>
    </div>
  )
}

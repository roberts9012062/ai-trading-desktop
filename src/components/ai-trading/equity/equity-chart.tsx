"use client"

import { useMemo, useState } from "react"
import type { AITradingTask, EquityPoint, ProfitCloseBar } from "@/lib/ai-trading-api"
import { EquityLegend } from "./equity-legend"
import { EquityWavePlot } from "./equity-wave-plot"
import { wavePositionKey, wavePositionStatus, type EquityTraces } from "./equity-wave-data"

interface EquityChartProps {
  tasks: AITradingTask[]
  series: Record<string, EquityPoint[]>
  traces?: EquityTraces
  profitBars?: ProfitCloseBar[]
}

/** Current-position waves are actual observations, independent of cumulative profit statistics. */
export function EquityChart({ tasks, series, traces = {}, profitBars = [] }: EquityChartProps): React.JSX.Element {
  const [highlightTaskId, setHighlightTaskId] = useState<string | null>(null)
  const chartTasks = useMemo(() => tasks.filter(t => wavePositionStatus(t) !== "flat" && traces[t.id]?.positionKey === wavePositionKey(t) && traces[t.id]?.samples.length > 0), [tasks, traces])
  const values = useMemo(() => new Map(chartTasks.map(t => [t.id, traces[t.id].samples.at(-1)!.value])), [chartTasks, traces])
  const leader = chartTasks.reduce<AITradingTask | null>((best, task) => !best || values.get(task.id)! > values.get(best.id)! ? task : best, null)
  const pointCount = chartTasks.reduce((count, task) => count + traces[task.id].samples.length, 0)
  const activeHighlight = chartTasks.some(t => t.id === highlightTaskId) ? highlightTaskId : null

  return <div className="relative rounded-2xl border border-[var(--border)] overflow-hidden">
    <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(90% 70% at 5% 0%, rgba(59,130,246,.07), transparent 70%), linear-gradient(180deg, transparent, var(--bg-secondary))" }} />
    <div className="relative p-3 md:p-4">
      <div className="mb-4 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">AI 模型收益对比</h3>
            <span className="rounded-full border border-sky-500/25 bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-300">贝塞尔持仓波段</span>
          </div>
          <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">持仓期间留痕 · 完整平仓清除 · 跨日延续 · 仅真实采样，数据中断处留空</p>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          {leader && <div className="hidden sm:flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-tertiary)]/70 px-3 py-1">
            <span className="text-[var(--text-muted)]">浮盈领先</span>
            <span className="max-w-[120px] truncate text-[var(--text-primary)]">{leader.model_display_name || leader.name}</span>
            <span className={`font-num font-semibold ${values.get(leader.id)! >= 0 ? "text-up" : "text-down"}`}>{values.get(leader.id)!.toFixed(2)} USDT</span>
          </div>}
          <span className="text-[var(--text-muted)]">{pointCount} 个采样点</span>
        </div>
      </div>
      <EquityWavePlot tasks={chartTasks} traces={traces} highlightTaskId={activeHighlight} />
      <EquityLegend tasks={chartTasks} series={series} values={values} profitBars={profitBars} highlightTaskId={activeHighlight} onHighlightChange={setHighlightTaskId} />
    </div>
  </div>
}

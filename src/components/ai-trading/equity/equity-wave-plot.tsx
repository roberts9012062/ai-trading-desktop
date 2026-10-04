"use client"

import { useId, useMemo, useRef, useState, useEffect } from "react"
import type { AITradingTask } from "@/lib/ai-trading-api"
import { resolveSeriesColor } from "@/lib/provider-avatar"
import { EquityEndBadges } from "./equity-end-badges"
import { formatBj } from "./equity-time"
import { wavePath, waveTimeRange, type EquityTraces, type WaveSample } from "./equity-wave-data"

const HEIGHT = 340
const TOP = 28, BOTTOM = 48, LEFT = 18, RIGHT = 80
function money(value: number): string { return `${value > 0 ? "+" : ""}${value.toFixed(2)}` }
function timeText(time: number, long = false): string {
  return formatBj(time / 1000, { ...(long ? { month: "2-digit", day: "2-digit" } as const : {}), hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
}
/** SVG x coordinates are proportional to actual observation time, including uneven intervals. */
export function EquityWavePlot({ tasks, traces, highlightTaskId }: {
  tasks: AITradingTask[]; traces: EquityTraces; highlightTaskId: string | null
}): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  const [hover, setHover] = useState<{ taskId: string; sample: WaveSample } | null>(null)
  const clipId = useId().replace(/:/g, "")
  useEffect(() => {
    if (!container.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)))
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])

  const model = useMemo(() => {
    const samples = tasks.flatMap(t => traces[t.id]?.samples ?? [])
    const range = waveTimeRange(samples)
    let low = 0, high = 0
    for (const point of samples) { low = Math.min(low, point.value); high = Math.max(high, point.value) }
    const pad = Math.max(.1, (high - low) * .15)
    low -= pad; high += pad
    const x = (time: number) => LEFT + (time - range.from) / (range.to - range.from) * (width - LEFT - RIGHT)
    const y = (value: number) => TOP + (high - value) / (high - low) * (HEIGHT - TOP - BOTTOM)
    const lines = tasks.map((task, i) => {
      const points = traces[task.id]?.samples ?? []
      const color = resolveSeriesColor(task.model_id, task.provider_name, task.model_display_name, i)
      return { task, points, color, path: wavePath(points, x, y) }
    })
    return { range, low, high, x, y, lines, count: samples.length }
  }, [tasks, traces, width])

  const badges = model.lines.flatMap(line => {
    const last = line.points.at(-1)
    return last ? [{ taskId: line.task.id, left: model.x(last.time), top: model.y(last.value), value: last.value, color: line.color }] : []
  })
  const activeHover = hover && model.lines.find(line => line.task.id === hover.taskId && line.points.some(p => p.time === hover.sample.time && p.value === hover.sample.value))
  const longAxis = model.range.to - model.range.from >= 86400000

  return <div ref={container} className="relative rounded-xl border border-white/5 bg-black/20 overflow-hidden" data-testid="equity-wave-plot">
    <svg width="100%" height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label="当前持仓浮动盈亏贝塞尔波段图，单位 USDT"
      onPointerLeave={() => setHover(null)}
      onPointerMove={event => {
        if (!model.count) return
        const rect = event.currentTarget.getBoundingClientRect()
        const mx = (event.clientX - rect.left) * width / rect.width, my = event.clientY - rect.top
        let best: { taskId: string; sample: WaveSample; distance: number } | null = null
        for (const line of model.lines) {
          if (highlightTaskId && line.task.id !== highlightTaskId) continue
          const points = line.points
          let a = 0, b = points.length
          while (a < b) { const m = (a + b) >> 1; if (model.x(points[m].time) < mx) a = m + 1; else b = m }
          for (const index of [a - 1, a]) {
            const sample = points[index]
            if (!sample) continue
            const distance = Math.hypot(model.x(sample.time) - mx, (model.y(sample.value) - my) * .3)
            if (!best || distance < best.distance) best = { taskId: line.task.id, sample, distance }
          }
        }
        setHover(best ? { taskId: best.taskId, sample: best.sample } : null)
      }}>
      <defs><clipPath id={clipId}><rect x={LEFT - 4} y={TOP - 6} width={width - LEFT - RIGHT + 8} height={HEIGHT - TOP - BOTTOM + 12} /></clipPath></defs>
      {[0, 1, 2, 3, 4].map(i => {
        const value = model.low + (model.high - model.low) * i / 4, y = model.y(value)
        return <g key={`y${i}`}><line x1={LEFT} x2={width - RIGHT} y1={y} y2={y} stroke="rgba(148,163,184,.10)" /><text x={width - RIGHT + 12} y={y + 4} fill="var(--text-muted)" fontSize={11} fontFamily="monospace">{value.toFixed(2)}</text></g>
      })}
      <line x1={LEFT} x2={width - RIGHT} y1={model.y(0)} y2={model.y(0)} stroke="rgba(148,163,184,.45)" strokeDasharray="4 5" />
      <text x={width - RIGHT + 12} y={18} fill="var(--text-muted)" fontSize={10}>浮盈 USDT</text>
      {(width < 520 ? [0, .5, 1] : [0, .25, .5, .75, 1]).map((fraction, i) => {
        const t = model.range.from + (model.range.to - model.range.from) * fraction, x = model.x(t)
        return <g key={`x${i}`}><line x1={x} x2={x} y1={TOP} y2={HEIGHT - BOTTOM} stroke="rgba(148,163,184,.06)" />{model.count > 0 && <text x={x} y={HEIGHT - 20} textAnchor={fraction === 0 ? "start" : fraction === 1 ? "end" : "middle"} fill="var(--text-muted)" fontSize={10}>{timeText(t, longAxis)}</text>}</g>
      })}
      <g clipPath={`url(#${clipId})`}>
        {[...model.lines].sort((a, b) => Number(a.task.id === highlightTaskId) - Number(b.task.id === highlightTaskId)).map(line => <g key={line.task.id} opacity={highlightTaskId && highlightTaskId !== line.task.id ? .2 : 1}>
          <path data-testid="equity-wave-path" data-task-id={line.task.id} data-sample-count={line.points.length} d={line.path} fill="none" stroke={line.color} strokeWidth={highlightTaskId === line.task.id ? 3 : 2.2} strokeLinecap="round" strokeLinejoin="round" />
          {line.points.filter((_, i) => i === 0 || i === line.points.length - 1 || line.points[i].breakBefore).map(point => <circle key={point.time} cx={model.x(point.time)} cy={model.y(point.value)} r={3} fill={line.color} stroke="var(--bg-secondary)" strokeWidth={1.5} />)}
        </g>)}
      </g>
      {activeHover && hover && <g>
        <line x1={model.x(hover.sample.time)} x2={model.x(hover.sample.time)} y1={TOP} y2={HEIGHT - BOTTOM} stroke="rgba(148,163,184,.4)" strokeDasharray="3 4" />
        <circle cx={model.x(hover.sample.time)} cy={model.y(hover.sample.value)} r={5} fill={activeHover.color} stroke="var(--bg-secondary)" strokeWidth={2} />
      </g>}
    </svg>
    <EquityEndBadges tasks={tasks} layouts={badges} chartHeight={HEIGHT - BOTTOM} chartWidth={width} highlightTaskId={highlightTaskId} />
    {activeHover && hover && <div role="status" className="pointer-events-none absolute z-50 top-2 max-w-[calc(100%-20px)] rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-xs shadow-xl" style={{ left: Math.min(Math.max(10, model.x(hover.sample.time) - 90), Math.max(10, width - 250)) }}>
      <div className="truncate text-[var(--text-primary)]">{activeHover.task.model_display_name || activeHover.task.name}</div>
      <div className="mt-1 text-[var(--text-muted)]">{timeText(hover.sample.time, true)} · <span style={{ color: activeHover.color }}>{money(hover.sample.value)} USDT</span></div>
    </div>}
    {!model.count && <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2">
      <span className="text-sm text-[var(--text-secondary)]">暂无持仓收益轨迹</span>
      <span className="text-xs text-[var(--text-muted)]">开仓后实时留痕，完整平仓后清除该笔轨迹</span>
    </div>}
    {model.count > 0 && model.lines.every(line => line.points.length <= 1) && <div className="pointer-events-none absolute bottom-12 left-4 text-[11px] text-[var(--text-muted)]">已记录首个真实收益点，等待后续采样形成波段</div>}
  </div>
}

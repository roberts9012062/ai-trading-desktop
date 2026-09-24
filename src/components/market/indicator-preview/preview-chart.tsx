"use client"

/**
 * 指标参数示意图组件（discuss/2026-08-31-指标参数示意图设计.md）
 *
 * 迷你 lightweight-charts 实例：主图蜡烛 + 当前 tab 指标。数据优先用
 * 调用方传入的真实 K 线（去重清洗后截尾，参数改动即时重算重绘，行情
 * 推送也会实时反映）；无数据时回落固定合成序列。highlight = { key, seq }
 * 时对应图形元素呼吸闪烁约 2 秒（seq 递增用于同键重触发）。
 */

import { useEffect, useMemo, useRef } from "react"
import { createChart, type IChartApi } from "lightweight-charts"
import type { IndicatorConfig } from "@/types/indicator"
import type { KlineBar, KlinePeriod } from "@/types"
import {
  dedupeBarsByChartTime,
  sanitizeBars,
} from "@/components/market/kline/utils"
import { PREVIEW_BARS } from "./preview-data"
import { renderIndicatorPreview, type PreviewRenderResult } from "./preview-render"

/** 真实数据最多展示的尾部根数：够指标预热，迷你图宽度下形态可辨 */
const MAX_BARS = 240

interface IndicatorPreviewChartProps {
  config: IndicatorConfig
  /** 当前设置弹窗激活的 tab（ma/boll/macd/rsi/jdk/pivot/strength） */
  tab: string
  /** 高亮触发（key 词表见 preview-render；seq 变化即重闪） */
  highlight: { key: string; seq: number } | null
  /** 真实 K 线（行情页/回测页传入；空或缺失回落合成序列） */
  bars?: KlineBar[] | null
  /** 真实数据周期（时间轴归一口径；回落序列固定按日线） */
  period?: KlinePeriod
}

export function IndicatorPreviewChart({
  config,
  tab,
  highlight,
  bars,
  period,
}: IndicatorPreviewChartProps): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const renderRef = useRef<PreviewRenderResult | null>(null)

  const isReal = Boolean(bars && bars.length > 0 && period && period !== "tick")
  // 清洗（同图表主链：图表时间键去重 + 无效 OHLC 过滤）后截尾，控制渲染量
  const data = useMemo(() => {
    if (!isReal) return PREVIEW_BARS
    return sanitizeBars(dedupeBarsByChartTime(bars!, period!)).slice(-MAX_BARS)
  }, [isReal, bars, period])
  const dataPeriod = isReal ? period! : ("1d" as const)

  // 图表实例：创建一次
  useEffect(() => {
    if (!boxRef.current) return
    const chart = createChart(boxRef.current, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: "#9ca3af",
        panes: { separatorColor: "#3a3a40", enableResize: false },
      },
      grid: {
        vertLines: { color: "rgba(148,163,184,0.08)" },
        horzLines: { color: "rgba(148,163,184,0.08)" },
      },
      rightPriceScale: { visible: false },
      timeScale: { visible: false },
      handleScale: false,
      handleScroll: false,
      crosshair: { mode: 0 },
    })
    chartRef.current = chart
    return () => {
      chart.remove()
      chartRef.current = null
      renderRef.current = null
    }
  }, [])

  // 指标重绘：tab、任一参数或数据变化即全量重算（截尾后重绘代价毫秒级；
  // 真实数据的 forming bar 推送同样走这里，实时反映最新行情）
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    renderRef.current?.dispose()
    renderRef.current = renderIndicatorPreview(chart, config, tab, data, dataPeriod)
  }, [config, tab, data, dataPeriod])

  // 闪烁联动：约 2 秒呼吸（260ms × 8 次），结束恢复底色。
  // pulse 可能持有已被重绘 dispose 的 series（参数/行情推送触发），吞掉异常
  useEffect(() => {
    const key = highlight?.key ?? ""
    const seq = highlight?.seq ?? 0
    if (!key || seq === 0) return
    const pulses = renderRef.current?.targets.get(key)
    if (!pulses || pulses.length === 0) return
    const fire = (on: boolean) => {
      for (const pulse of pulses) {
        try {
          pulse(on)
        } catch {
          /* series 已随重绘销毁 */
        }
      }
    }
    let on = false
    const timer = window.setInterval(() => {
      on = !on
      fire(on)
    }, 260)
    const stop = window.setTimeout(() => {
      window.clearInterval(timer)
      fire(false)
    }, 2080)
    return () => {
      window.clearInterval(timer)
      window.clearTimeout(stop)
      fire(false)
    }
  }, [highlight?.key, highlight?.seq])

  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-[var(--text-secondary)]">
        指标示意图
        <span className="ml-2 text-[10px] font-normal text-[var(--text-muted)]">
          {isReal
            ? `真实行情最近 ${data.length} 根 · 改参数即时重绘`
            : "固定合成序列 · 改参数即时重绘"}
        </span>
      </div>
      <div
        ref={boxRef}
        className="h-[300px] rounded-md border border-[var(--border)] bg-[var(--bg-tertiary)]/40"
      />
      <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
        点击左侧参数时，示意图中受该参数影响的图形元素会闪烁提示。
      </p>
    </div>
  )
}

"use client"

/**
 * AI 生成 K 线 · 边推边决策回放驱动器
 *
 * 按 2-5 秒/根逐根把 K 线推进图表（series.update），
 * 每根收盘后调 step 接口让策略决策，买卖点实时画在图上。
 * 回放结束调 finish 接口用后端 compute_metrics 算最终指标，
 * 然后复用 <BacktestReportView> 展示完整报告。
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useDisplayStore } from "@/stores/display"
import { Button } from "@/components/ui/button"
import { Loader2, Pause, Play, FastForward, RotateCcw, Settings2 } from "lucide-react"
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
} from "lightweight-charts"
import {
  stepBacktestApi,
  finishBacktestApi,
  type BacktestBar,
  type BacktestReport,
  type SyntheticAccountSnapshot,
  type SyntheticGenerateResponse,
  type SyntheticStepResponse,
} from "@/lib/backtest-api"
import type { SyntheticReplayConfig } from "@/components/backtest/synthetic-panel"
import { formatChartTime, chineseTickMarkFormatter } from "@/components/market/kline/utils"
import type { KlinePeriod } from "@/types"
import { BacktestReportView } from "@/components/backtest/backtest-report"
import { IndicatorSettingsDialog } from "@/components/market/indicator-settings-dialog"
import { useBacktestIndicatorStore } from "@/stores/backtest-indicator"
import {
  bindAllIndicatorData,
  pushVolumeBar,
  updateIndicatorLastPoints,
  useIndicatorSeries,
} from "@/components/backtest/use-indicator-series"

interface SyntheticReplayProps {
  config: SyntheticReplayConfig
  onReset: () => void
}

type Phase = "ready" | "playing" | "paused" | "finishing" | "done"

function asPeriod(timeframe: string): KlinePeriod {
  const t = timeframe as KlinePeriod
  if (t === "1m" || t === "5m" || t === "15m" || t === "30m" || t === "60m" || t === "1d") {
    return t
  }
  return "1d"
}

/** 把后端 step 返回的成交追加为图表 marker */
function stepToMarker(
  step: SyntheticStepResponse,
  period: KlinePeriod,
): SeriesMarker<Time> | null {
  if (!step.executed) return null
  const action = String(step.decision.action || "").toLowerCase()
  const time = formatChartTime(period, String(step.decision.time || "")) as Time
  if (action === "open_long") {
    return { time, position: "belowBar", shape: "arrowUp", color: "#ef4444", text: "多", size: 1.5 }
  }
  if (action === "open_short") {
    return { time, position: "belowBar", shape: "arrowDown", color: "#22c55e", text: "空", size: 1.5 }
  }
  if (action === "close") {
    return { time, position: "belowBar", shape: "circle", color: "#3b82f6", text: "平", size: 1.5 }
  }
  return null
}

export function SyntheticReplay({
  config,
  onReset,
}: SyntheticReplayProps): React.JSX.Element {
  const { generated, strategyType, strategyParams, modelRowId, symbol,
    symbolName, timeframe, sideMode, fixedQty, initialCash, riskStyle,
    customPromptEnabled, customPrompt, closeRules, stopRules, speedMs,
    decisionModelRowId } = config

  const bars = generated.bars
  const period = asPeriod(timeframe)

  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [chartState, setChartState] = useState<IChartApi | null>(null)
  const [candleSeriesState, setCandleSeriesState] = useState<ISeriesApi<"Candlestick"> | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const indicatorRefs = useIndicatorSeries({
    chart: chartState,
    candleSeries: candleSeriesState,
    period,
  })
  const indicatorConfig = useBacktestIndicatorStore((s) => s.config)

  // 状态
  const [phase, setPhase] = useState<Phase>("ready")
  const [cursor, setCursor] = useState(0) // 已推到的 bar 索引（含）
  const [accountSnap, setAccountSnap] = useState<SyntheticAccountSnapshot | null>(null)
  const [equityCurve, setEquityCurve] = useState<Array<{
    time: string; equity: number; cash: number; unrealized: number
  }>>([])
  const [trades, setTrades] = useState<SyntheticStepResponse["decision"][]>([])
  const [markers, setMarkers] = useState<SeriesMarker<Time>[]>([])
  const [report, setReport] = useState<BacktestReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [aiCalls, setAiCalls] = useState(0)
  // 决策模型限频锚点：最近一次真实调用 Jev 的时刻（epoch ms）
  const lastDecisionAtRef = useRef<number | null>(null)

  // 持久引用（避免 setInterval 闭包过期）
  const cursorRef = useRef(0)
  const snapRef = useRef<SyntheticAccountSnapshot | null>(null)
  const eqRef = useRef<typeof equityCurve>([])
  const tradesRef = useRef<typeof trades>([])
  const markersRef = useRef<SeriesMarker<Time>[]>([])
  const aiCallsRef = useRef(0)
  const phaseRef = useRef<Phase>("ready")
  const inFlightRef = useRef(false)
  const barsRef = useRef<BacktestBar[]>(bars)

  // K线涨跌颜色（显示设置自定义）
  const candleUp = useDisplayStore((s) => s.candleUp)
  const candleDown = useDisplayStore((s) => s.candleDown)

  useEffect(() => { barsRef.current = bars }, [bars])
  useEffect(() => { phaseRef.current = phase }, [phase])
  useEffect(() => { cursorRef.current = cursor }, [cursor])
  useEffect(() => { snapRef.current = accountSnap }, [accountSnap])
  useEffect(() => { eqRef.current = equityCurve }, [equityCurve])
  useEffect(() => { tradesRef.current = trades }, [trades])
  useEffect(() => { markersRef.current = markers }, [markers])
  useEffect(() => { aiCallsRef.current = aiCalls }, [aiCalls])

  // 初始化图表
  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      height: 420,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#9ca3af",
      },
      grid: {
        vertLines: { color: "#2e2e33" },
        horzLines: { color: "#2e2e33" },
      },
      rightPriceScale: { borderColor: "#3a3a40" },
      timeScale: {
        borderColor: "#3a3a40",
        timeVisible: period !== "1d",
        barSpacing: 14,
        minBarSpacing: 4,
        tickMarkFormatter: chineseTickMarkFormatter,
      },
      crosshair: {
        vertLine: { color: "#6b7280", labelBackgroundColor: "#3b82f6" },
        horzLine: { color: "#6b7280", labelBackgroundColor: "#3b82f6" },
      },
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: candleUp,
      downColor: candleDown,
      borderUpColor: candleUp,
      borderDownColor: candleDown,
      wickUpColor: candleUp,
      wickDownColor: candleDown,
    })
    series.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.18 } })
    chart.timeScale().fitContent()
    chartRef.current = chart
    seriesRef.current = series
    setChartState(chart)
    setCandleSeriesState(series)

    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth })
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      setChartState(null)
      setCandleSeriesState(null)
    }
  }, [period, candleUp, candleDown])

  // 推一根 bar 到图表 + 调 step 决策
  const advanceOne = useCallback(async (): Promise<boolean> => {
    if (inFlightRef.current) return false
    const nextIdx = cursorRef.current + 1
    if (nextIdx >= barsRef.current.length) return false
    if (phaseRef.current !== "playing") return false

    inFlightRef.current = true
    const bar = barsRef.current[nextIdx]
    const series = seriesRef.current
    if (series) {
      // 增量推一根（lightweight-charts v5 series.update）
      series.update({
        time: formatChartTime(period, bar.time) as Time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })
    }
    // 同步推成交量 + 更新指标末点（MA/BOLL/MACD/RSI/KDJ）
    const visibleBarsPre = barsRef.current.slice(0, nextIdx + 1)
    pushVolumeBar(indicatorRefs, bar, period)
    updateIndicatorLastPoints(indicatorRefs, visibleBarsPre, period)

    const visibleBars = visibleBarsPre
    try {
      const step = await stepBacktestApi({
        bars_so_far: visibleBars,
        account_snapshot: snapRef.current,
        strategy_type: strategyType,
        strategy_params: strategyParams,
        side_mode: sideMode,
        fixed_qty: fixedQty,
        initial_cash: initialCash,
        risk_style: riskStyle,
        custom_prompt_enabled: customPromptEnabled,
        custom_prompt: customPrompt,
        close_rules: closeRules,
        stop_rules: stopRules,
        max_hold_days: 10,
        model_row_id: modelRowId,
        decision_model_row_id: decisionModelRowId,
        decision_min_interval_ms: speedMs,
        last_decision_at: lastDecisionAtRef.current,
        symbol,
        symbol_name: symbolName,
        timeframe,
      })
      lastDecisionAtRef.current = step.decision_called_at ?? null

      // 更新账户 + 权益曲线
      snapRef.current = step.account_snapshot
      setAccountSnap(step.account_snapshot)
      eqRef.current = [...eqRef.current, step.equity_point]
      setEquityCurve(eqRef.current)

      // 记录成交 + marker
      if (step.executed) {
        tradesRef.current = [...tradesRef.current, step.decision]
        setTrades(tradesRef.current)
        const m = stepToMarker(step, period)
        if (m) {
          const ms = [...markersRef.current, m].sort((a, b) => {
            const ta = typeof a.time === "number" ? a.time : String(a.time)
            const tb = typeof b.time === "number" ? b.time : String(b.time)
            return ta < tb ? -1 : ta > tb ? 1 : 0
          })
          markersRef.current = ms
          setMarkers(ms)
          // 重新设置 markers（v5 插件每次返回新实例）
          if (series) {
            try {
              createSeriesMarkers(series, ms)
            } catch {
              // markers 失败不影响 K 线
            }
          }
        }
      }
      if (step.source === "ai" || step.source === "decision") {
        aiCallsRef.current += 1
        setAiCalls(aiCallsRef.current)
      }

      cursorRef.current = nextIdx
      setCursor(nextIdx)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : "决策失败")
      setPhase("paused")
      phaseRef.current = "paused"
      return false
    } finally {
      inFlightRef.current = false
    }
  }, [period, strategyType, strategyParams, sideMode, fixedQty, initialCash,
    riskStyle, customPromptEnabled, customPrompt, closeRules, stopRules,
    modelRowId, symbol, symbolName, timeframe])

  // 播放循环
  useEffect(() => {
    if (phase !== "playing") return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async (): Promise<void> => {
      if (stopped || phaseRef.current !== "playing") return
      const ok = await advanceOne()
      if (!ok) {
        // 推完了或暂停
        if (cursorRef.current + 1 >= barsRef.current.length) {
          setPhase("finishing")
          phaseRef.current = "finishing"
        }
        return
      }
      timer = setTimeout(tick, speedMs)
    }
    timer = setTimeout(tick, 100)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [phase, speedMs, advanceOne])

  // 完成时算最终报告
  useEffect(() => {
    if (phase !== "finishing" || report) return
    let stopped = false
    void (async () => {
      try {
        // 用最后一根 bar 的价格平掉残留仓位（与历史回测一致）
        const lastBar = barsRef.current[barsRef.current.length - 1]
        const finalSnap = snapRef.current
        const rep = await finishBacktestApi({
          equity_curve: eqRef.current,
          trades: tradesRef.current,
          account_snapshot: finalSnap,
          initial_cash: initialCash,
          bars: barsRef.current,
          strategy_type: strategyType,
          ai_calls: aiCallsRef.current,
          timeframe,
          symbol,
          symbol_name: symbolName,
        })
        if (!stopped) {
          setReport(rep)
          setPhase("done")
          phaseRef.current = "done"
        }
      } catch (err) {
        if (!stopped) {
          setError(err instanceof Error ? err.message : "指标计算失败")
          setPhase("paused")
          phaseRef.current = "paused"
        }
      }
    })()
    return () => { stopped = true }
  }, [phase, report, initialCash, strategyType])

  // 开始播放
  function handleStart(): void {
    if (phase !== "ready" && phase !== "paused") return
    setError(null)
    // 首次播放：先 setData 第一根作为初始
    if (phase === "ready" && seriesRef.current && cursorRef.current === 0) {
      const first = bars[0]
      seriesRef.current.setData([{
        time: formatChartTime(period, first.time) as Time,
        open: first.open, high: first.high, low: first.low, close: first.close,
      }])
      // 初始化成交量首根 + 指标首点
      pushVolumeBar(indicatorRefs, first, period)
      updateIndicatorLastPoints(indicatorRefs, [first], period)
    }
    setPhase("playing")
    phaseRef.current = "playing"
  }

  function handlePause(): void {
    setPhase("paused")
    phaseRef.current = "paused"
  }

  // 跳到结束：一次性渲染全部 K 线 + 串行 step 决策（不逐根更新图表）
  async function handleSkipToEnd(): Promise<void> {
    if (phase === "finishing" || phase === "done") return
    setPhase("playing")
    phaseRef.current = "playing"
    setError(null)

    const allBars = barsRef.current
    const series = seriesRef.current

    // 1) 一次性渲染全部 K 线 + 成交量 + 指标（避免逐根 update 把图表搞崩）
    if (series) {
      const candleData = allBars
        .filter((b) => b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0)
        .map((b) => ({
          time: formatChartTime(period, b.time) as Time,
          open: b.open, high: b.high, low: b.low, close: b.close,
        }))
      series.setData(candleData)
      bindAllIndicatorData(indicatorRefs, allBars, period)
    }

    // 2) 从当前 cursor+1 开始串行调 step（账户状态必须逐根推进）
    //    但不更新图表（图表已在步骤1画完）
    let snap = snapRef.current
    const eq: typeof eqRef.current = [...eqRef.current]
    const tradesAcc: typeof tradesRef.current = [...tradesRef.current]
    const markersAcc: typeof markersRef.current = [...markersRef.current]
    let aiCalls = aiCallsRef.current

    for (let i = cursorRef.current + 1; i < allBars.length; i++) {
      if (phaseRef.current !== "playing") break
      const visible = allBars.slice(0, i + 1)
      try {
        const step = await stepBacktestApi({
          bars_so_far: visible,
          account_snapshot: snap,
          strategy_type: strategyType,
          strategy_params: strategyParams,
          side_mode: sideMode,
          fixed_qty: fixedQty,
          initial_cash: initialCash,
          risk_style: riskStyle,
          custom_prompt_enabled: customPromptEnabled,
          custom_prompt: customPrompt,
          close_rules: closeRules,
          stop_rules: stopRules,
          max_hold_days: 10,
          model_row_id: modelRowId,
          decision_model_row_id: decisionModelRowId,
          decision_min_interval_ms: speedMs,
          last_decision_at: lastDecisionAtRef.current,
          symbol,
          symbol_name: symbolName,
          timeframe,
        })
        lastDecisionAtRef.current = step.decision_called_at ?? null
        snap = step.account_snapshot
        eq.push(step.equity_point)
        if (step.executed) {
          tradesAcc.push(step.decision)
          const m = stepToMarker(step, period)
          if (m) markersAcc.push(m)
        }
        if (step.source === "ai" || step.source === "decision") aiCalls += 1
      } catch (err) {
        setError(err instanceof Error ? err.message : "决策失败")
        setPhase("paused")
        phaseRef.current = "paused"
        return
      }
    }

    // 3) 一次性更新所有状态 + markers
    snapRef.current = snap
    setAccountSnap(snap)
    eqRef.current = eq
    setEquityCurve(eq)
    tradesRef.current = tradesAcc
    setTrades(tradesAcc)
    markersRef.current = markersAcc
    setMarkers(markersAcc)
    aiCallsRef.current = aiCalls
    setAiCalls(aiCalls)
    cursorRef.current = allBars.length - 1
    setCursor(allBars.length - 1)

    // 4) 一次性设置所有成交标记
    if (series) {
      try {
        const sortedMarkers = [...markersAcc].sort((a, b) => {
          const ta = typeof a.time === "number" ? a.time : String(a.time)
          const tb = typeof b.time === "number" ? b.time : String(b.time)
          return ta < tb ? -1 : ta > tb ? 1 : 0
        })
        createSeriesMarkers(series, sortedMarkers)
      } catch {
        // markers 失败不影响 K 线
      }
    }

    if (cursorRef.current + 1 >= allBars.length) {
      setPhase("finishing")
      phaseRef.current = "finishing"
    }
  }

  const progress = bars.length > 0 ? Math.round(((cursor + 1) / bars.length) * 100) : 0
  const showReport = phase === "done" && report

  return (
    <div className="space-y-3">
      {/* 顶部信息条 */}
      <div className="flex items-center justify-between flex-wrap gap-2 text-xs">
        <div className="text-[var(--text-muted)]">
          AI 合成 K 线 · {generated.script.regime} · {generated.meta.num_bars} 根 ·{" "}
          {generated.meta.ref_price.toFixed(0)} 起
          {aiCalls > 0 && ` · AI ${aiCalls} 次`}
        </div>
        <div className="text-[var(--text-muted)]">
          {cursor + 1} / {bars.length}（{progress}%）
        </div>
      </div>

      {/* 进度条 */}
      <div className="h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
        <div
          className="h-full bg-sky-500 transition-all"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* 图表 */}
      {!showReport && (
        <div className="rounded-xl border border-[var(--border)] p-3">
          {/* 指标徽章 + 设置入口 */}
          <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              {indicatorConfig.maLines.map((ma) => (
                <span key={ma.period} className="px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                  MA{ma.period}
                </span>
              ))}
              {indicatorConfig.boll.enabled && (
                <span className="px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">BOLL</span>
              )}
              {indicatorConfig.macd.enabled && (
                <span className="px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">MACD</span>
              )}
              {indicatorConfig.rsi.enabled && (
                <span className="px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">RSI</span>
              )}
              {indicatorConfig.jdk.enabled && (
                <span className="px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">KDJ</span>
              )}
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 className="w-3.5 h-3.5 mr-1" />
              指标设置
            </Button>
          </div>
          <div ref={containerRef} className="w-full" />
          <div className="flex flex-wrap gap-3 text-[11px] text-[var(--text-muted)] px-1 mt-2">
            <span className="inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-[#ef4444]" />
              做多（红↑）
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-[#22c55e]" />
              做空（绿↓）
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-[#3b82f6]" />
              平仓（蓝●）
            </span>
          </div>
          <IndicatorSettingsDialog
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            useStore={useBacktestIndicatorStore}
            bars={bars}
            period={period}
          />
        </div>
      )}

      {/* 实时账户卡 */}
      {!showReport && accountSnap && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <AccountCard label="权益" value={accountSnap.equity.toLocaleString()} />
          <AccountCard label="现金" value={accountSnap.cash.toLocaleString()} />
          <AccountCard
            label="浮动盈亏"
            value={accountSnap.equity - accountSnap.cash > 0 ? `+${(accountSnap.equity - accountSnap.cash).toFixed(2)}` : (accountSnap.equity - accountSnap.cash).toFixed(2)}
            tone={(accountSnap.equity - accountSnap.cash) >= 0 ? "up" : "down"}
          />
          <AccountCard
            label="已实现"
            value={accountSnap.realized_pnl.toFixed(2)}
            tone={accountSnap.realized_pnl >= 0 ? "up" : "down"}
          />
        </div>
      )}

      {/* 控制按钮 */}
      {!showReport && (
        <div className="flex gap-2 flex-wrap">
          {(phase === "ready" || phase === "paused") && (
            <Button size="sm" onClick={handleStart}>
              <Play className="w-4 h-4 mr-1" />
              {phase === "ready" ? "开始回放" : "继续"}
            </Button>
          )}
          {phase === "playing" && (
            <Button size="sm" variant="outline" onClick={handlePause}>
              <Pause className="w-4 h-4 mr-1" />
              暂停
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleSkipToEnd()}
            disabled={phase === "finishing" || phase === "done"}
          >
            <FastForward className="w-4 h-4 mr-1" />
            跳到结束
          </Button>
          {phase !== "finishing" && (
            <Button size="sm" variant="ghost" onClick={onReset}>
              <RotateCcw className="w-4 h-4 mr-1" />
              重新生成
            </Button>
          )}
          {phase === "finishing" && (
            <div className="flex items-center text-xs text-sky-300">
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
              计算指标中…
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="text-sm text-[var(--accent-danger)]">{error}</div>
      )}

      {/* 最终报告（复用历史回测报告视图） */}
      {showReport && report && (
        <div className="space-y-3">
          <BacktestReportView report={report} />
          <Button size="sm" variant="outline" onClick={onReset}>
            <RotateCcw className="w-4 h-4 mr-1" />
            重新生成 K 线
          </Button>
        </div>
      )}
    </div>
  )
}

function AccountCard({
  label, value, tone,
}: {
  label: string
  value: string
  tone?: "up" | "down"
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-tertiary)]/40 px-3 py-2">
      <div className="text-[11px] text-[var(--text-muted)]">{label}</div>
      <div className={`mt-1 text-sm font-semibold font-num ${
        tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-[var(--text-primary)]"
      }`}>
        {value}
      </div>
    </div>
  )
}

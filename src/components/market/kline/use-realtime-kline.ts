"use client"

/**
 * 实时 K 线 / 分时线增量更新
 *
 * 双通道保证「每秒最新」：
 * 1) WS kline:realtime — 完整 OHLC forming bar
 * 2) WS quote.last_price — 无 kline 推送时仍驱动最新 close（切品种/缓存命中场景）
 *
 * 历史序列可走长缓存；当前 bar 永远不靠历史 TTL。
 * 已收盘 rt bar 由 realtime/accumulator.ts 随 WS 帧同步累积（不经
 * React 调度，后台标签节流不丢根）；本 hook 只在渲染期读取尾部做合并、
 * 写图表与重算指标，并在尾段出现时间跳变缺口时回调 onRtGap 触发单周期
 * force 重拉自愈。纯函数见 realtime/buffer.ts 与 realtime/accumulator.ts。
 */

import { useEffect, useRef, type MutableRefObject, type RefObject } from "react"
import type {
  IChartApi,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  Time,
} from "lightweight-charts"
import { useMarketStore } from "@/stores/market"
import type { IndicatorConfig } from "@/types/indicator"
import type { KlineBar, KlinePeriod } from "@/types"
import type { BollSeriesRefs } from "./indicators/main"
import type { SubIndicatorHandle, SubIndicatorId } from "./indicators/registry"
import { normalizeBarTime } from "./utils"
import {
  detectTailGap,
  mergeTailWithHistory,
  readRtTail,
  rtAccKey,
} from "./realtime/accumulator"
import {
  patchBarWithPrice,
  realtimeBarFresh,
  applyBarToSeries,
  isOldestDataError,
} from "./realtime/buffer"
import {
  recoverSeriesData,
  updateAllIndicators,
  type IndicatorUpdateRefs,
} from "./realtime/update"
import { scrollToLatestHalfEmpty } from "./utils"

/** 缺口自愈 force 重拉最小间隔（防历史持续滞后时反复打后端） */
const GAP_REFETCH_THROTTLE_MS = 30_000

export function useRealtimeKline(props: {
  seriesRef: MutableRefObject<ISeriesApi<"Candlestick"> | null>
  volumeRef: MutableRefObject<ISeriesApi<"Histogram"> | null>
  tickSeriesRef: MutableRefObject<ISeriesApi<"Line"> | null>
  maSeriesRef: MutableRefObject<ISeriesApi<"Line">[]>
  bollSeriesRef: MutableRefObject<BollSeriesRefs>
  subHandlesRef: MutableRefObject<Map<SubIndicatorId, SubIndicatorHandle>>
  pivotMarkersRef: MutableRefObject<ISeriesMarkersPluginApi<Time> | null>
  mainApiRef: RefObject<IChartApi | null>
  currentBars: KlineBar[]
  period: KlinePeriod
  activeContract: string
  config: IndicatorConfig
  isNearLatest: MutableRefObject<boolean>
  lastRealtimeTime: MutableRefObject<string | null>
  tickDataRef: MutableRefObject<{ time: number; value: number }[]>
  /** 尾段检测到缺根（时间跳变超 2 个周期）时回调，调用方触发单周期强刷 */
  onRtGap?: () => void
}): void {
  const {
    seriesRef,
    volumeRef,
    tickSeriesRef,
    maSeriesRef,
    bollSeriesRef,
    subHandlesRef,
    pivotMarkersRef,
    mainApiRef,
    currentBars,
    period,
    activeContract,
    config,
    isNearLatest,
    lastRealtimeTime,
    tickDataRef,
    onRtGap,
  } = props

  const klineRealtime = useMarketStore((s) => s.klineRealtime)
  const quotes = useMarketStore((s) => s.quotes)
  // 已处理过的缺口签名：重拉后缺口进入历史序列即不再出现，同签名不重复触发
  const gapSeenRef = useRef<Set<string>>(new Set())
  const lastGapRefetchAtRef = useRef(0)
  // oldest 拒绝自愈节流时间戳
  const lastRecoverAtRef = useRef(0)

  /** 组装指标更新所需的引用集合（refs 稳定，随用随组） */
  const indicatorRefs = (): IndicatorUpdateRefs => ({
    seriesRef,
    volumeRef,
    maSeriesRef,
    bollSeriesRef,
    subHandlesRef,
    pivotMarkersRef,
    config,
  })

  /** 尾段缺口自愈：新签名 + 节流通过才真正触发强刷（失败由下个签名/30s 后重试兜底） */
  const maybeHealGap = (signature: string | null): void => {
    if (!signature || !onRtGap) return
    if (gapSeenRef.current.has(signature)) return
    const now = Date.now()
    if (now - lastGapRefetchAtRef.current < GAP_REFETCH_THROTTLE_MS) return
    gapSeenRef.current.add(signature)
    lastGapRefetchAtRef.current = now
    try {
      onRtGap()
    } catch {
      // 自愈失败静默：缺口仍在，签名未消费完时 30s 后可重试
    }
  }

  // 通道 1：完整 forming bar（WS kline，经累积器读尾部）
  useEffect(() => {
    const series = seriesRef.current
    if (!series || period === "tick") return
    const realtimeBar = klineRealtime[activeContract]?.[period as KlinePeriod]
    if (!realtimeBar) return
    if (currentBars.length === 0) return

    const lastBar = currentBars[currentBars.length - 1]
    const lastT = normalizeBarTime(period, lastBar.time)
    const tailBars = readRtTail(rtAccKey(activeContract, period), lastT)
    const built = tailBars.length
      ? mergeTailWithHistory(currentBars, tailBars, period)
      : null
    if (!built) return
    const { chartBar, applyBars, mergedBars } = built

    try {
      // 断线恢复跳根时把 series 缺的中间根补齐（升序逐根写入）
      for (const b of applyBars) applyBarToSeries(series, volumeRef, b, period)
      updateAllIndicators(indicatorRefs(), mergedBars, period)

      const isNewBar = chartBar.time !== lastRealtimeTime.current
      lastRealtimeTime.current = chartBar.time
      if (isNewBar && isNearLatest.current && mainApiRef.current) {
        const n = mergedBars.length
        if (n > 0) scrollToLatestHalfEmpty(mainApiRef.current, n)
      }
      // 缺口自愈：尾段时间跳变超阈值 → 单周期 force 重拉
      maybeHealGap(detectTailGap(period, lastT, tailBars))
    } catch (err) {
      console.warn("[K线实时更新失败]", err)
      if (isOldestDataError(err)) {
        recoverSeriesData(indicatorRefs(), mergedBars, period, lastRecoverAtRef)
      }
    }
  }, [
    klineRealtime,
    activeContract,
    period,
    currentBars,
    config,
    seriesRef,
    volumeRef,
    maSeriesRef,
    bollSeriesRef,
    subHandlesRef,
    pivotMarkersRef,
    mainApiRef,
    lastRealtimeTime,
    isNearLatest,
    onRtGap,
  ])

  // 通道 2：行情 last_price 每秒驱动最新 close（不依赖历史重拉）
  useEffect(() => {
    const series = seriesRef.current
    if (!series || period === "tick") return
    if (currentBars.length === 0) return
    const quote =
      quotes[activeContract] ??
      quotes[activeContract.toLowerCase()] ??
      quotes[activeContract.toUpperCase()]
    const lastPrice = quote?.last_price
    if (!lastPrice || lastPrice <= 0) return

    // 已有同周期 kline realtime 时仍用 quote 校正 close（WS 两路可能略有先后）。
    // 仅当 rt 是当前时段的 forming bar 时才允许修补图表最后一根：
    // rt 缺失/陈旧（跨休市、昨夜末根）时跳过——此时最后一根是已收盘的
    // 历史 bar，用新报价盲改会把跳空价画进旧 K 线。
    const rt = klineRealtime[activeContract]?.[period as KlinePeriod]
    if (!rt || !realtimeBarFresh(period, rt.time)) return
    const lastBar = currentBars[currentBars.length - 1]
    const lastT = normalizeBarTime(period, lastBar.time)
    const tailBars = readRtTail(rtAccKey(activeContract, period), lastT)
    const built = tailBars.length
      ? mergeTailWithHistory(currentBars, tailBars, period)
      : null
    if (!built) return
    const chartBar = patchBarWithPrice(built.chartBar, lastPrice)
    // 无变化则跳过，减少无效 update
    const prev = built.mergedBars[built.mergedBars.length - 1]
    if (
      prev &&
      prev.close === chartBar.close &&
      prev.high === chartBar.high &&
      prev.low === chartBar.low &&
      prev.time === chartBar.time
    ) {
      return
    }
    built.mergedBars[built.mergedBars.length - 1] = chartBar
    try {
      // 断线恢复跳根时把 series 缺的中间根补齐（最后一根用修补后的）
      for (let k = 0; k < built.applyBars.length - 1; k++) {
        applyBarToSeries(series, volumeRef, built.applyBars[k], period)
      }
      applyBarToSeries(series, volumeRef, chartBar, period)
      updateAllIndicators(indicatorRefs(), built.mergedBars, period)
    } catch (err) {
      console.warn("[K线行情驱动更新失败]", err)
      if (isOldestDataError(err)) {
        recoverSeriesData(
          indicatorRefs(),
          built.mergedBars,
          period,
          lastRecoverAtRef,
        )
      }
    }
  }, [
    quotes,
    activeContract,
    period,
    currentBars,
    klineRealtime,
    seriesRef,
    volumeRef,
    maSeriesRef,
    bollSeriesRef,
    subHandlesRef,
    pivotMarkersRef,
    config,
  ])

  // 切品种或切周期后分时序列会重建为空，旧数据点时间已不在序列上，一并清掉
  useEffect(() => {
    tickDataRef.current = []
    if (tickSeriesRef.current) tickSeriesRef.current.setData([])
  }, [activeContract, period, tickDataRef, tickSeriesRef])

  useEffect(() => {
    if (period !== "tick" || !tickSeriesRef.current) return
    const quote =
      quotes[activeContract] ??
      quotes[activeContract.toLowerCase()] ??
      quotes[activeContract.toUpperCase()]
    if (!quote) return
    const now = Math.floor(Date.now() / 1000)
    tickDataRef.current.push({ time: now, value: quote.last_price })
    try {
      tickSeriesRef.current.update({
        time: now as unknown as string,
        value: quote.last_price,
      })
    } catch {
      // 忽略
    }
  }, [quotes, activeContract, period, tickSeriesRef, tickDataRef])
}

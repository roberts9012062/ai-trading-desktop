/**
 * 客户端 K 线合成引擎 —— 后端 services/kline.py `update_realtime_klines` 的 TS 移植
 *
 * 职责:消费 WS quote 流,在客户端本地合成全部周期(1m/5m/15m/30m/60m/240m/1d)的
 * forming bar,语义与服务端逐字对齐:
 * - 分钟 bar 时间键 = 交易分钟轴上的桶**起点**(跨休盘由轴对齐,非墙钟近似)
 * - 分钟级 open 锁定周期首 tick;close=last_price;high/low 跟 tick;
 *   volume = 累计量 - 周期起点累计量(负数说明跨交易日/重置,重新锚定)
 * - 日线 = 期货交易日(夜盘 21:00 归次日):open=交易所开盘价,high/low/量跟交易所
 * - 休市不产幽灵 bar:非交易时段仅保留「未封桶且确实跨休盘延续」的长周期状态
 *
 * 与服务端 kline 消息的关系(单写者模式):
 * - 本引擎是 klineRealtime 的唯一写入来源;
 * - 服务端 kline 消息只作「种子/追赶」:重连快照或服务端桶领先(交易轴修正)
 *   时整体采纳服务端状态,否则忽略——两路同源,不会来回打架。
 *
 * 纯逻辑、无 zustand 依赖;nowMs 显式传入(fake-UTC 北京时间),便于测试。
 */

import type { QuoteData } from "@/lib/websocket"
import type { KlineBar } from "@/types"
import {
  barTimeKey,
  extractProductCode,
  formatDayTime,
  formatMinuteTime,
  getTradingDayMs,
  isMinuteBarInSession,
  isSymbolTradingMs,
  periodEndForProduct,
  periodStartForProduct,
  wallClockBucketMs,
} from "@/lib/trading-sessions"

/** 转发:market store 从引擎模块一并取北京时钟 */
export { bjNowMs } from "@/lib/trading-sessions"

/**
 * 当前时间下可采信的最大 bar 时间键(容忍客户端时钟略慢:约 2 个周期;日线 2 天)。
 * 服务端推送/历史/本地缓存里超出该键的「未来时间戳」bar 一律视为脏数据拒绝——
 * 58 曾出现过 forming bar 带未来时间戳的故障,采纳会污染图表甚至写进本地缓存,
 * 且会让实时 bar 永远"落后"于缓存里的未来 bar、停止更新。
 */
export function maxPlausibleBarKey(symbol: string, period: string, nowMs: number): string {
  if (period === "1d") {
    return barTimeKey("1d", formatDayTime(getTradingDayMs(nowMs + 48 * 3600 * 1000)))
  }
  const minutes = PERIOD_MINUTES[period] ?? 1
  const probe = nowMs + minutes * 2 * 60000
  const start =
    periodStartForProduct(extractProductCode(symbol), probe, minutes) ??
    wallClockBucketMs(probe, minutes)
  return formatMinuteTime(start)
}

const MINUTE_PERIODS = ["1m", "5m", "15m", "30m", "60m", "240m"] as const
const PERIOD_MINUTES: Record<string, number> = {
  "1m": 1, "5m": 5, "15m": 15, "30m": 30, "60m": 60, "240m": 240,
}
export const ENGINE_PERIODS = [...MINUTE_PERIODS, "1d"] as const

/** 引擎对外输出的实时 bar 项(与 store 的 KlineRealtimeBar 结构一致) */
export interface EngineKlineUpdate {
  symbol: string
  period: string
  bar: KlineBar
}

/** ingestQuotes 结果:updates=forming bar 变化;closed=换桶时已收盘的上一根(本地历史累积用) */
export interface EngineQuoteResult {
  updates: EngineKlineUpdate[]
  closed: EngineKlineUpdate[]
}

interface EngineState {
  bar: KlineBar
  barTime: string
  periodStartVolume: number
  openLocked: boolean
  /** 采纳服务端 bar 时无法立即反推增量基准,等下一笔 quote 重锚 */
  pendingRebase?: boolean
}

interface LastQuote {
  lastPrice: number
  volume: number
  tickTime: string
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function sameBar(a: KlineBar | undefined, b: KlineBar): boolean {
  if (!a) return false
  return (
    a.time === b.time &&
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.volume === b.volume &&
    (a.open_interest ?? null) === (b.open_interest ?? null)
  )
}

export class KlineEngine {
  private states = new Map<string, Map<string, EngineState>>()
  private lastQuotes = new Map<string, LastQuote>()

  private stateFor(symbol: string): Map<string, EngineState> {
    let m = this.states.get(symbol)
    if (!m) {
      m = new Map()
      this.states.set(symbol, m)
    }
    return m
  }

  reset(): void {
    this.states.clear()
    this.lastQuotes.clear()
  }

  /**
   * 消费一批 quote(WS type:"quote")。
   * - updates:发生变化的 forming bar(写 klineRealtime)
   * - closed:换桶时已收盘的上一根 bar 最终态(由 store 追加进本地历史并持久化,
   *   桌面端不再依赖服务端历史库累积新数据)
   * 无新 tick 的合约直接跳过(休盘/停牌期间天然静止,也省 CPU)。
   */
  ingestQuotes(quotes: QuoteData[], nowMs: number): EngineQuoteResult {
    const out: EngineKlineUpdate[] = []
    const closed: EngineKlineUpdate[] = []
    for (const q of quotes) {
      if (!q || !q.symbol) continue
      const last = num(q.last_price)
      if (last <= 0) continue
      const total = num(q.volume)
      const prev = this.lastQuotes.get(q.symbol)
      this.lastQuotes.set(q.symbol, {
        lastPrice: last,
        volume: total,
        tickTime: String(q.tick_time ?? ""),
      })
      if (
        prev &&
        prev.lastPrice === last &&
        prev.volume === total &&
        prev.tickTime === String(q.tick_time ?? "")
      ) {
        continue
      }

      const symbol = q.symbol
      const product = extractProductCode(symbol)
      const symbolOpen = isSymbolTradingMs(symbol, nowMs)
      const position = q.position
      const states = this.stateFor(symbol)

      // ---- 分钟级 ----
      for (const period of MINUTE_PERIODS) {
        const minutes = PERIOD_MINUTES[period]
        const axisStart = periodStartForProduct(product, nowMs, minutes)
        const startMs = axisStart ?? wallClockBucketMs(nowMs, minutes)
        const barTime = formatMinuteTime(startMs)
        // 双保险:分钟 bar 时间必须在粗粒度交易时段内(不产 18:xx 幽灵 K)
        if (!isMinuteBarInSession(barTime)) continue

        const st = states.get(period)
        const prevBar = st?.bar

        if (!symbolOpen) {
          // 休盘:只保留尚未封桶、确实跨休盘延续的长周期状态,其余丢弃
          if (st && barTimeKey(period, st.barTime) === barTimeKey(period, barTime)) {
            const bucketEnd = symbol ? periodEndForProduct(product, nowMs, minutes) : null
            if (bucketEnd === null || bucketEnd > nowMs) continue
          }
          states.delete(period)
          continue
        }

        let bar: KlineBar
        if (!st || barTimeKey(period, st.barTime) !== barTimeKey(period, barTime)) {
          // 跨入新周期:上一根已收盘 → 交出最终态给本地历史(时间不合理则丢弃,防脏数据入库)
          if (st && barTimeKey(period, st.barTime) <= maxPlausibleBarKey(symbol, period, nowMs)) {
            closed.push({ symbol, period, bar: { ...st.bar } })
          }
          bar = {
            time: barTime,
            open: last,
            high: last,
            low: last,
            close: last,
            volume: 0,
            settle: undefined,
            open_interest: position != null ? position : undefined,
          }
          states.set(period, {
            bar,
            barTime,
            periodStartVolume: total,
            openLocked: true,
          })
        } else {
          // 更新现有 bar
          const prevBar = st.bar
          if (st.pendingRebase) {
            st.periodStartVolume = Math.max(0, total - num(prevBar.volume))
            st.pendingRebase = false
          }
          bar = {
            ...prevBar,
            time: barTime,
            close: last,
            high: Math.max(prevBar.high, last),
            low: Math.min(prevBar.low, last),
            open_interest: position != null ? position : prevBar.open_interest,
          }
          const delta = total - st.periodStartVolume
          if (delta < 0) {
            st.periodStartVolume = total
            bar.volume = 0
          } else {
            bar.volume = delta
          }
          st.bar = bar
          st.barTime = barTime
        }

        if (!sameBar(prevBar, bar)) out.push({ symbol, period, bar })
      }

      // ---- 日线(全天可更新,含收盘后定格) ----
      const dayTime = formatDayTime(getTradingDayMs(nowMs))
      const stD = states.get("1d")
      const prevDailyBar = stD?.bar
      let dailyBar: KlineBar
      const h = num(q.high_price) > 0 ? num(q.high_price) : last
      const l = num(q.low_price) > 0 ? num(q.low_price) : last
      const o = num(q.open_price) > 0 ? num(q.open_price) : last
      if (!stD || barTimeKey("1d", stD.barTime) !== dayTime) {
        // 换交易日:上一交易日日线收盘 → 交出最终态(时间不合理则丢弃)
        if (stD && barTimeKey("1d", stD.barTime) <= maxPlausibleBarKey(symbol, "1d", nowMs)) {
          closed.push({ symbol, period: "1d", bar: { ...stD.bar } })
        }
        dailyBar = {
          time: dayTime,
          open: o,
          high: h,
          low: l,
          close: last,
          volume: total,
          settle: undefined,
          open_interest: position != null ? position : undefined,
        }
        states.set("1d", { bar: dailyBar, barTime: dayTime, periodStartVolume: total, openLocked: true })
      } else {
        dailyBar = {
          ...stD.bar,
          time: dayTime,
          high: h,
          low: l,
          close: last,
          volume: total,
          open_interest: position != null ? position : stD.bar.open_interest,
        }
        stD.bar = dailyBar
        stD.barTime = dayTime
      }
      if (!sameBar(prevDailyBar, dailyBar)) out.push({ symbol, period: "1d", bar: dailyBar })
    }
    return { updates: out, closed }
  }

  /**
   * 服务端 kline 消息:仅在「无本地状态」或「服务端桶领先(且时间合理)」时采纳
   * (重连快照/交易轴修正场景),同桶忽略(本地更新鲜),落后忽略,
   * 未来时间戳(超出当前时间 2 个周期)视为脏数据拒绝。
   * 返回被采纳的项,供 store 写入。
   */
  ingestServerBars(items: EngineKlineUpdate[], nowMs: number): EngineKlineUpdate[] {
    const out: EngineKlineUpdate[] = []
    for (const item of items) {
      if (!item || !item.symbol || !item.bar) continue
      if (!(ENGINE_PERIODS as readonly string[]).includes(item.period)) continue
      const bar = item.bar
      if (!(num(bar.open) > 0 && num(bar.close) > 0)) continue
      const serverKey = barTimeKey(item.period, bar.time)
      if (!serverKey) continue
      if (serverKey > maxPlausibleBarKey(item.symbol, item.period, nowMs)) continue

      const states = this.stateFor(item.symbol)
      const st = states.get(item.period)
      const localKey = st ? barTimeKey(item.period, st.barTime) : ""
      if (st && localKey === serverKey) continue
      if (st && localKey > serverKey) continue

      // 采纳服务端状态;分钟级用最近 quote 的累计量重锚增量基准
      let periodStartVolume = 0
      let pendingRebase = false
      if (item.period !== "1d") {
        const total = this.lastQuotes.get(item.symbol)?.volume
        if (total != null && total >= num(bar.volume)) {
          periodStartVolume = Math.max(0, total - num(bar.volume))
        } else {
          pendingRebase = true
        }
      }
      const adopted: KlineBar = { ...bar }
      states.set(item.period, {
        bar: adopted,
        barTime: String(bar.time),
        periodStartVolume,
        openLocked: true,
        pendingRebase,
      })
      out.push({ symbol: item.symbol, period: item.period, bar: adopted })
    }
    return out
  }
}

/** 引擎单例:market store 消费 */
export const klineEngine = new KlineEngine()

import { closedBars, ema, type Bar } from "./rules"
import { MACD_PERIODS, macdMa20Entry, macdMa20ShortEntry, reboundLongEntry, reboundShortEntry, type MacdPeriod } from "./macd-ma20"

/** One closed candle with the indicator overlays the detail chart draws. */
export interface SignalViewPoint {
  ts: number; open: number; high: number; low: number; close: number
  ma20: number | null; dif: number; dea: number
}

export interface SignalViewModel {
  points: SignalViewPoint[]
  /** Index range (inclusive) of the consecutive bodies that carry the signal streak. */
  streakFrom: number | null
  streakCount: number
  /** Side of the latest streak: above MA20 (long side) or below (short side). */
  streakSide: "long" | "short" | null
  macdGolden: boolean; macdFreshGolden: boolean; macdDead: boolean
  maRising: boolean; maFalling: boolean
  longSignal: boolean; shortSignal: boolean
  reboundLong: boolean; reboundShort: boolean; reboundSignal: boolean
  lastClosedAt: number
  /** Signal-candle open's distance to its own MA20, in price-percent terms. */
  ma20GapPct: number | null
}

/**
 * Build the chart model from raw bars: same indicator math as the entry rules,
 * plus the exact candle range whose bodies form the qualifying streak, so the
 * dialog can outline the candles that make the signal true.
 */
export function buildSignalView(rows: Bar[], period: MacdPeriod, now: number, lookback = 90, reboundThreshold = .10): SignalViewModel {
  const seconds = MACD_PERIODS[period]
  const bars = closedBars(rows, seconds, now)
  const points: SignalViewPoint[] = []
  let ma: number[] = [], dif: number[] = [], dea: number[] = []
  if (bars.length >= 26) {
    const prices = bars.map(b=>b[4]), fast = ema(prices, 12), slow = ema(prices, 26)
    dif = fast.map((v,i)=>v-slow[i]), dea = ema(dif, 9)
    ma = prices.map((_, i)=>i >= 19 ? prices.slice(i-19, i+1).reduce((a,b)=>a+b, 0)/20 : NaN)
  }
  const start = Math.max(0, bars.length-lookback)
  for (let i = start; i < bars.length; i++) {
    points.push({ ts: bars[i][0], open: bars[i][1], high: bars[i][2], low: bars[i][3], close: bars[i][4],
      ma20: i >= 19 && Number.isFinite(ma[i]) ? ma[i] : null, dif: dif[i] ?? NaN, dea: dea[i] ?? NaN })
  }
  const last = bars.length-1
  const view: SignalViewModel = {
    points, streakFrom: null, streakCount: 0, streakSide: null,
    macdGolden: Number.isFinite(dif[last]) && dif[last] > dea[last],
    macdFreshGolden: Number.isFinite(dif[last-1]) && dif[last-1] <= dea[last-1] && dif[last] > dea[last],
    macdDead: Number.isFinite(dif[last]) && dif[last] < dea[last],
    maRising: last >= 2 && ma[last] > ma[last-1] && ma[last-1] >= ma[last-2],
    maFalling: last >= 2 && ma[last] < ma[last-1],
    longSignal: Boolean(macdMa20Entry(rows, period, now)),
    shortSignal: Boolean(macdMa20ShortEntry(rows, period, now)),
    reboundLong: Boolean(reboundLongEntry(rows, period, now, reboundThreshold)),
    reboundShort: Boolean(reboundShortEntry(rows, period, now, reboundThreshold)),
    reboundSignal: false,
    lastClosedAt: bars.length ? bars[last][0]/1000+seconds : 0,
    ma20GapPct: last >= 19 && Number.isFinite(ma[last])
      ? (ma[last]-bars[last][1])/bars[last][1]*100 : null,
  }
  if (last < 19 || points.length === 0) return view
  // Mirror the entry loops: walk back over closed bodies strictly on one side
  // of their own MA20; the first crossing/touching body ends the streak.
  let count = 0, side: "long" | "short" | null = null
  for (let i = last; i >= 19; i--) {
    const body = Math.min(bars[i][1], bars[i][4])
    if (body > ma[i]) { if (side === "short") break; side = "long"; count++ }
    else {
      const upper = Math.max(bars[i][1], bars[i][4])
      if (upper < ma[i]) { if (side === "long") break; side = "short"; count++ }
      else break
    }
  }
  if (side) {
    view.streakSide = side
    view.streakCount = count
    view.streakFrom = Math.max(0, points.length-count)
  }
  view.reboundSignal = view.reboundLong || view.reboundShort
  return view
}

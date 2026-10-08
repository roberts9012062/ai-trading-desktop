import { closedBars, ema, type Bar } from "./rules"

export const MACD_MA20_VERSION = "hunter-macd-ma20" as const
export const MACD_PERIODS = { "30m": 1800, "60m": 3600 } as const
export type MacdPeriod = keyof typeof MACD_PERIODS
export const MACD_MA20_NAME = "macd金叉+K线3根以上在ma20均线上"
export const MACD_MA20_SHORT_NAME = "macd死叉+MA20向下+K线2-3根实体在ma20均线下"

export function macdMa20Entry(rows: Bar[], period: MacdPeriod, now: number) {
  const seconds = MACD_PERIODS[period]
  const bars = closedBars(rows, seconds, now)
  if (bars.length < 100 || now - (bars.at(-1)![0]/1000 + seconds) >= seconds) return null
  if (bars.some((b, i) => i > 0 && b[0]-bars[i-1][0] !== seconds*1000)) return null
  const prices = bars.map(b=>b[4]), fast = ema(prices, 12), slow = ema(prices, 26)
  const dif = fast.map((v,i)=>v-slow[i]), dea = ema(dif, 9)
  const ma = prices.map((_, i)=>i >= 19 ? prices.slice(i-19, i+1).reduce((a,b)=>a+b, 0)/20 : NaN)
  let count = 0
  for (let i = bars.length-1; i >= 19 && Math.min(bars[i][1], prices[i]) > ma[i]; i--) count++
  const last = bars.length-1
  // Golden-cross REGIME (DIF above DEA), not a fresh cross — mirrors the short side.
  if (count < 3 || count > 4 || ma[last] <= ma[last-1] || ma[last-1] < ma[last-2] || dif[last] <= dea[last]) return null
  const close = bars[last][0]/1000+seconds
  return { direction: "long" as const, entry: prices[last], signal_at: close, expires_at: close+seconds,
    above_count: count, above_basis: "body" as const, entry_kind: "macd_ma20" as const }
}

export function macdMa20ShortEntry(rows: Bar[], period: MacdPeriod, now: number, leverage?: number) {
  const seconds = MACD_PERIODS[period]
  const bars = closedBars(rows, seconds, now)
  if (bars.length < 100 || now - (bars.at(-1)![0]/1000 + seconds) >= seconds) return null
  if (bars.some((b, i) => i > 0 && b[0]-bars[i-1][0] !== seconds*1000)) return null
  const prices = bars.map(b=>b[4]), fast = ema(prices, 12), slow = ema(prices, 26)
  const dif = fast.map((v,i)=>v-slow[i]), dea = ema(dif, 9)
  const ma = prices.map((_, i)=>i >= 19 ? prices.slice(i-19, i+1).reduce((a,b)=>a+b, 0)/20 : NaN)
  let count = 0
  // Only the body must stay strictly under MA20; an upper wick may touch or pierce it.
  for (let i = bars.length-1; i >= 19 && Math.max(bars[i][1], prices[i]) < ma[i]; i--) count++
  const last = bars.length-1
  // Dead-cross regime (not a fresh cross), strictly falling MA20, and the complete
  // streak must be exactly 2-3 candles; four or more never chases the short.
  if (count < 2 || count > 3 || ma[last] >= ma[last-1] || dif[last] >= dea[last]) return null
  // MA20-distance guard: a mere reversion to the line costing more than 4% of
  // the margin means the candle stretched too far below — never chase it.
  const gap = ma[last]-bars[last][1]
  if (leverage && gap > bars[last][1]*.04/leverage) return null
  const close = bars[last][0]/1000+seconds
  return { direction: "short" as const, entry: prices[last], signal_at: close, expires_at: close+seconds,
    below_count: count, below_basis: "body" as const, entry_kind: "macd_ma20" as const, ma20_gap: gap }
}

export function hunterCycleLabel(cycle: string): string {
  return ({ short: "短线", medium: "中线", long: "长线", "30m": "30分钟", "60m": "60分钟" } as Record<string, string>)[cycle] ?? cycle
}

export function macdDirectionLabel(direction: string | undefined): string {
  return ({ long: "仅做多", short: "仅做空", both: "多空双向" } as Record<string, string>)[direction ?? "long"] ?? "仅做多"
}

export const REBOUND_VERSION = "hunter-rebound" as const
export const REBOUND_LONG_NAME = "急跌两根柱体合计超MA20的10%后抢反弹做多"
export const REBOUND_SHORT_NAME = "急涨两根柱体合计超MA20的10%且第三根递减回落卖空"

function indicatorsFor(rows: Bar[], period: MacdPeriod, now: number) {
  const seconds = MACD_PERIODS[period]
  const bars = closedBars(rows, seconds, now)
  if (bars.length < 100 || now - (bars.at(-1)![0]/1000 + seconds) >= seconds) return null
  if (bars.some((b, i) => i > 0 && b[0]-bars[i-1][0] !== seconds*1000)) return null
  const prices = bars.map(b=>b[4])
  const ma = prices.map((_, i)=>i >= 19 ? prices.slice(i-19, i+1).reduce((a,b)=>a+b, 0)/20 : NaN)
  return { bars, ma }
}

/** 反弹做多：前两根合计柱体 ≥ 阈值×MA20 的阴线——第二根收盘（第三根开盘）立即挂单，
 *  信号只在第三根K线内有效，绝不等到第三根收盘。 */
export function reboundLongEntry(rows: Bar[], period: MacdPeriod, now: number, threshold = .10) {
  const data = indicatorsFor(rows, period, now)
  if (!data) return null
  const { bars, ma } = data
  const [b1, b2] = [bars.at(-2)!, bars.at(-1)!]
  const down1 = b1[1]-b1[4], down2 = b2[1]-b2[4]
  if (down1 <= 0 || down2 <= 0 || down1+down2 < threshold*ma.at(-1)!) return null
  const seconds = MACD_PERIODS[period], close = b2[0]/1000+seconds
  return { direction: "long" as const, entry: b2[4], signal_at: close, expires_at: close+seconds,
    entry_kind: "rebound" as const, thrust: down1+down2, thrust_ratio: (down1+down2)/ma.at(-1)! }
}

/** 反弹做空：前两根合计柱体 ≥ 阈值×MA20 的阳线，第三根递减且距均线距离缩短。 */
export function reboundShortEntry(rows: Bar[], period: MacdPeriod, now: number, threshold = .10) {
  const data = indicatorsFor(rows, period, now)
  if (!data) return null
  const { bars, ma } = data
  const [b1, b2, b3] = [bars.at(-3)!, bars.at(-2)!, bars.at(-1)!]
  const up1 = b1[4]-b1[1], up2 = b2[4]-b2[1]
  if (up1 <= 0 || up2 <= 0 || up1+up2 < threshold*ma.at(-1)!) return null
  if (Math.abs(b3[1]-b3[4]) >= Math.min(up1, up2)) return null
  if (Math.abs(b3[4]-ma.at(-1)!) >= Math.abs(b2[4]-ma.at(-2)!)) return null
  const seconds = MACD_PERIODS[period], close = b3[0]/1000+seconds
  return { direction: "short" as const, entry: b3[4], signal_at: close, expires_at: close+seconds,
    entry_kind: "rebound" as const, thrust: up1+up2, thrust_ratio: (up1+up2)/ma.at(-1)! }
}

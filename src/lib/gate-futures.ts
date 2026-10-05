import type { KlineBar } from "@/types"
import { barTimeToMs, msToBarTime, normalizeInterval, type BinanceKlinePage } from "@/lib/binance-kline"
import { cryptoPair, GATE_FUTURES, optionalNumber, publicJson } from "@/lib/crypto-direct"

const SECONDS: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400 }
interface Candle { t: number; o: string; h: string; l: string; c: string; v: number; sum?: string }
export interface Funding { t: number; r: string }
export interface ContractStat {
  time: number; open_interest: number | string; lsr_account?: number
  long_taker_size?: number | string; short_taker_size?: number | string
  long_liq_size?: number | string; short_liq_size?: number | string
}

/** A date-only candle is UTC midnight even though intraday labels use Beijing time. */
function candleTime(time: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(time) ? Date.parse(`${time}T00:00:00Z`) : barTimeToMs(time)
}

async function fundingHistory(pair: string, from: number, to: number): Promise<Funding[]> {
  const out: Funding[] = []
  let cursor = to
  for (let page = 0; page < 30; page++) {
    const rows = await publicJson<Funding[]>(`${GATE_FUTURES}/funding_rate?${new URLSearchParams({ contract: pair, from: String(from), to: String(cursor), limit: "1000" })}`)
    if (!Array.isArray(rows) || rows.some((r) => !Number.isFinite(r.t) || optionalNumber(r.r) === null)) throw new Error("Gate 资金费率格式异常")
    const valid = rows.filter((r) => r.t >= from && r.t <= cursor)
    if (!valid.length) return out
    out.push(...valid)
    const oldest = Math.min(...valid.map((r) => r.t))
    // Do not assume the exchange honors the requested limit.
    if (oldest <= from) return out
    cursor = oldest - 1
  }
  throw new Error("资金费率分页达到上限，请缩小日期区间")
}

/** Join only already published history. Stats get a conservative full-interval publication lag.
 * Nothing from the current order book enters historical bars. Missing coverage is an error,
 * not zero filling or a silent switch to another exchange.
 */
export function joinGateHistory(bars: KlineBar[], funding: Funding[], stats: ContractStat[], statsSeconds: number): KlineBar[] {
  const f = [...funding].sort((a, b) => a.t - b.t)
  const s = [...stats].sort((a, b) => a.time - b.time)
  let fi = -1, si = -1
  return bars.map((b) => {
    const at = b.open_time! / 1000
    while (fi + 1 < f.length && f[fi + 1].t < at) fi++
    while (si + 1 < s.length && s[si + 1].time + statsSeconds < at) si++
    const rate = fi >= 0 && at - f[fi].t <= 86400 ? f[fi] : null
    const stat = si >= 0 && at - (s[si].time + statsSeconds) <= statsSeconds * 2 ? s[si] : null
    const oi = optionalNumber(stat?.open_interest)
    if (!rate || !stat || oi === null || oi <= 0) {
      throw new Error(`Gate 衍生品历史覆盖不足（${b.time}），请缩小日期区间；未用零值补齐资金费率或持仓量`)
    }
    const long = optionalNumber(stat.long_taker_size), short = optionalNumber(stat.short_taker_size)
    const ll = optionalNumber(stat.long_liq_size), sl = optionalNumber(stat.short_liq_size)
    return { ...b, open_interest: oi, funding_rate: Number(rate.r), funding_time: rate.t * 1000,
      derivatives_time: (stat.time + statsSeconds) * 1000,
      taker_imbalance: long !== null && short !== null && long + short > 0 ? (long - short) / (long + short) : long === 0 && short === 0 ? 0 : null,
      long_short_ratio: optionalNumber(stat.lsr_account),
      liquidation_imbalance: ll !== null && sl !== null && ll + sl > 0 ? (ll - sl) / (ll + sl) : ll === 0 && sl === 0 ? 0 : null,
    }
  })
}

export async function getGateFuturesKlineApi(symbol: string, period: string, options?: { limit?: number; endTime?: string }): Promise<BinanceKlinePage> {
  const interval = normalizeInterval(period), seconds = SECONDS[interval]
  if (!seconds) throw new Error(`Gate 永续暂不支持 ${period} 周期`)
  const pair = cryptoPair(symbol), limit = Math.min(Math.max(options?.limit ?? 500, 2), 500)
  const params = new URLSearchParams({ contract: pair, interval })
  if (options?.endTime) {
    const to = Math.floor(candleTime(options.endTime) / 1000)
    params.set("from", String(Math.max(0, to - (limit - 1) * seconds)))
    params.set("to", String(to))
  } else params.set("limit", String(limit))
  const rows = await publicJson<Candle[]>(`${GATE_FUTURES}/candlesticks?${params}`)
  if (!Array.isArray(rows)) throw new Error("Gate 永续 K 线格式异常")
  const now = Date.now()
  const bars: KlineBar[] = rows.filter((r) => (r.t + seconds) * 1000 <= now).sort((a, b) => a.t - b.t).map((r) => {
    if (![r.t, r.o, r.h, r.l, r.c, r.v].every((n) => optionalNumber(n) !== null) || Number(r.c) <= 0) throw new Error("Gate 永续 K 线包含无效数值")
    return { time: msToBarTime(r.t * 1000, interval === "1d"), open_time: r.t * 1000,
      open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v),
      quote_volume: optionalNumber(r.sum), market_source: "gate_usdt", settle: null, open_interest: null }
  })
  if (!bars.length) return { bars: [], has_more: false }
  return { bars, has_more: rows.length >= limit }
}

/** Fetch supplemental history once after the user's date range has been selected. */
export async function enrichGateBars(symbol: string, period: string, bars: KlineBar[]): Promise<KlineBar[]> {
  if (!bars.length) return bars
  const pair = cryptoPair(symbol), interval = normalizeInterval(period)
  const seconds = SECONDS[interval]
  if (!seconds) throw new Error(`Gate 永续暂不支持 ${period} 周期`)
  const from = bars[0].open_time! / 1000, to = bars[bars.length - 1].open_time! / 1000
  if (from < Date.now() / 1000 - 175 * 86400) {
    throw new Error("Gate 资金费率/持仓统计接口仅支持近180天，预留对齐窗口后请选择最近175天内的区间；服务器转发也不能突破交易所历史限制")
  }
  const statsInterval = seconds < 300 ? "5m" : interval, statsSeconds = SECONDS[statsInterval]
  async function statsHistory(): Promise<ContractStat[]> {
    const all: ContractStat[] = []
    let cursor = Math.max(0, from - 3 * statsSeconds)
    for (let page = 0; page < 200; page++) {
      const rows = await publicJson<ContractStat[]>(`${GATE_FUTURES}/contract_stats?${new URLSearchParams({ contract: pair,
        interval: statsInterval, from: String(cursor), limit: "500" })}`)
      if (!Array.isArray(rows) || rows.some((r) => !Number.isFinite(r.time))) throw new Error("Gate 持仓统计格式异常")
      const valid = rows.filter((r) => r.time >= cursor)
      if (!valid.length) return all
      all.push(...valid.filter((r) => r.time <= to))
      const newest = Math.max(...valid.map((r) => r.time))
      if (newest >= to) return all
      cursor = newest + 1
    }
    throw new Error("Gate 持仓统计分页达到上限，请缩小日期区间")
  }
  const [funding, stats] = await Promise.all([fundingHistory(pair, Math.max(0, from - 86400), to), statsHistory()])
  return joinGateHistory(bars, funding, stats, statsSeconds)
}

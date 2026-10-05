/**
 * Binance Vision 公开数据客户端 —— 桌面端 K 线/逐笔直连源
 *
 * - 最新 K 线 / aggTrades:https://data-api.binance.vision(公开行情专用域,免鉴权)
 * - 历史逐笔全量 zip 直链:https://data.binance.vision/data/spot/monthly/trades
 *
 * 时间口径:bar.time 与后端 kline_crypto 一致——北京时间(TZ Asia/Shanghai,固定
 * UTC+8)的 naive 字符串;日线 "YYYY-MM-DD",日内 "YYYY-MM-DD HH:MM:SS"。
 * settle/open_interest 恒为 null(现货公开数据无此二字段,与后端加密 bar 同构)。
 *
 * CORS:data-api.binance.vision 开放跨域,浏览器 dev 可直连;Tauri 下全局 fetch
 * 已被 desktop-boot 换成 plugin-http 实现,不受 CORS 约束。
 *
 * 本地计算栈(回测/因子/挖掘)的取数入口统一走 getBinanceKlineApi——与原服务端
 * getKlineApi 同契约({bars, has_more} + endTime 闭区间回溯),fetchBacktestBars
 * 的分页/去重/截断逻辑零改动。
 */
import type { KlineBar } from "@/types"
import { cryptoPair, optionalNumber } from "@/lib/crypto-direct"

const REST_BASE = "https://data-api.binance.vision/api/v3"
export const HISTORICAL_TRADES_BASE = "https://data.binance.vision/data/spot/monthly/trades"

/** 北京时间固定偏移(无夏令时) */
const BJ_OFFSET_MS = 8 * 60 * 60 * 1000

/** 本地周期 → Binance interval(60m/240m 映射为小时) */
export function normalizeInterval(period: string): string {
  if (period === "60m") return "1h"
  if (period === "240m") return "4h"
  return period
}

/** 统一规范符号(btcusdt / BTC-USDT) → Binance 原生符号(BTCUSDT) */
export function toBinanceSymbol(symbol: string): string {
  return cryptoPair(symbol).replace("_", "")
}

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/** epoch ms → 北京时间 naive bar time(与后端 _ts_to_bar_time 同构) */
export function msToBarTime(ms: number, isDaily: boolean): string {
  const d = new Date(ms + BJ_OFFSET_MS)
  const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
  if (isDaily) return date
  return `${date} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
}

/** 北京时间 naive bar time → epoch ms(endTime 闭区间回溯用) */
export function barTimeToMs(time: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?/.exec(time.trim())
  if (!m) throw new Error(`无法解析 bar time: ${time}`)
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = m
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) - BJ_OFFSET_MS
}

type RawKline = [number, string, string, string, string, string, ...unknown[]]

export interface BinanceKlinePage {
  bars: KlineBar[]
  /** 是否可能还有更老数据(满页即视为有;与后端 has_more 语义对齐) */
  has_more: boolean
}

/**
 * 拉一页 K 线(endTime 为该 bar 的 time,闭区间,边界 bar 会重复出现——
 * 上层 fetchBacktestBars 已按 time 去重)。endTime 缺省 = 最新一页。
 */
export async function getBinanceKlineApi(
  symbol: string,
  period: string,
  options?: { limit?: number; endTime?: string },
): Promise<BinanceKlinePage> {
  const interval = normalizeInterval(period)
  const limit = Math.min(Math.max(options?.limit ?? 500, 1), 1000)
  const params = new URLSearchParams({
    symbol: toBinanceSymbol(symbol),
    interval,
    limit: String(limit),
  })
  if (options?.endTime) params.set("endTime", String(barTimeToMs(options.endTime)))

  const resp = await fetch(`${REST_BASE}/klines?${params.toString()}`, { signal: AbortSignal.timeout(60_000) })
  if (!resp.ok) {
    const body = (await resp.json().catch(() => null)) as { msg?: string } | null
    throw new Error(`Binance K线拉取失败(${resp.status}${body?.msg ? `: ${body.msg}` : ""})`)
  }
  const rows = (await resp.json()) as RawKline[]
  const isDaily = interval === "1d" || interval === "3d" || interval === "1w" || interval === "1M"
  const bars: KlineBar[] = rows.map((r) => ({
    time: msToBarTime(r[0], isDaily),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
    open_time: r[0],
    market_source: "binance_spot",
    quote_volume: optionalNumber(r[7]),
    trade_count: optionalNumber(r[8]),
    taker_buy_volume: optionalNumber(r[9]),
    taker_buy_quote_volume: optionalNumber(r[10]),
    settle: null,
    open_interest: null,
  }))
  return { bars, has_more: bars.length >= limit }
}

/** aggTrades 逐笔成交(最新一页,按时间升序) */
export interface AggTrade {
  /** 北京时间 "YYYY-MM-DD HH:MM:SS" */
  time: string
  price: number
  qty: number
  /** 成交编号(聚合 id) */
  id: number
  isBuyerMaker: boolean
}

export async function fetchAggTrades(
  symbol: string,
  options?: { limit?: number; endTime?: string },
): Promise<AggTrade[]> {
  const limit = Math.min(Math.max(options?.limit ?? 500, 1), 1000)
  const params = new URLSearchParams({
    symbol: toBinanceSymbol(symbol),
    limit: String(limit),
  })
  if (options?.endTime) params.set("endTime", String(barTimeToMs(options.endTime)))
  const resp = await fetch(`${REST_BASE}/aggTrades?${params.toString()}`, { signal: AbortSignal.timeout(60_000) })
  if (!resp.ok) throw new Error(`Binance aggTrades 拉取失败(${resp.status})`)
  const rows = (await resp.json()) as Array<{
    a: number
    p: string
    q: string
    T: number
    m: boolean
  }>
  return rows.map((r) => ({
    time: msToBarTime(r.T, false),
    price: Number(r.p),
    qty: Number(r.q),
    id: r.a,
    isBuyerMaker: r.m,
  }))
}

/** 历史逐笔全量月包 zip 直链(如 BTCUSDT-trades-2017-08.zip) */
export function historicalTradesZipUrl(symbol: string, year: number, month: number): string {
  const s = toBinanceSymbol(symbol)
  return `${HISTORICAL_TRADES_BASE}/${s}/${s}-trades-${year}-${pad2(month)}.zip`
}

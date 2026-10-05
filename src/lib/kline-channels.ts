/**
 * 多渠道历史 K 线适配器 —— 回测 / 因子实验室 / 超级因子挖掘共用
 * (对齐后端 app/data/history_channels.py 的三渠道定义)
 *
 * - binance_spot：Binance 现货 data-api.binance.vision 本地直连(免 Key,
 *   主流币 2017-08 起)——默认渠道
 * - gate_spot：Gate 现货 api.gateio.ws 本地直连(免 Key)
 * - okx：OKX 官方历史 ZIP 归档，本机下载和缓存，不转发服务器
 *
 * 统一契约:与 binance-kline 的 getBinanceKlineApi 相同({bars, has_more} +
 * endTime "YYYY-MM-DD[ HH:MM:SS]" 北京时间闭区间回溯),fetchBacktestBars 的
 * 分页/去重/截断逻辑零改动。
 *
 * 分页语义差异(去重层已兜底,此处仅备注):
 * - Binance/Gate/后端: endTime 闭区间 → 页间重叠一根,按 time 去重
 */
import {
  getBinanceKlineApi,
  msToBarTime,
  barTimeToMs,
  type BinanceKlinePage,
} from "@/lib/binance-kline"

export type { BinanceKlinePage }
import type { KlineBar } from "@/types"
import { getGateFuturesKlineApi } from "@/lib/gate-futures"
import { getBinanceFuturesKlineApi } from "@/lib/binance-futures"
import { cryptoPair, optionalNumber } from "@/lib/crypto-direct"
import { getOkxArchiveKlineApi, latestOkxArchiveDay, OKX_CANDLE_FLOOR } from "@/lib/okx-history"

export type KlineChannelId = "okx" | "binance_spot" | "gate_spot" | "gate_usdt" | "binance_usdt"

/** Offered only by local mining forms; the server does not implement this channel. */
export const LOCAL_DERIVATIVE_CHANNELS = [
  { id: "binance_usdt", name: "Binance USDT 永续（本地直连·归档口径）", kind: "swap", note: "Binance USDT-M 本尊K线+资金费率（2019-09 起，归档近端滞后 1-2 天）；持仓量类特征不可用；仅本地 CPU/GPU（需桌面端网络）" },
  { id: "gate_usdt", name: "Gate USDT 永续（本地直连·含衍生数据）", kind: "swap", note: "同源合约K线、历史资金费率与持仓统计；仅本地 CPU/GPU" },
]

/** 桌面端默认渠道:Binance 现货(国内直连可达 + 2017-08 起超长历史) */
export const DEFAULT_KLINE_CHANNEL: KlineChannelId = "binance_spot"

/** 渠道元数据(history-channels.ts 的 getHistoryChannels 后端不可用时的本地兜底) */
export const LOCAL_HISTORY_CHANNELS: Array<{
  id: KlineChannelId
  name: string
  kind: string
  note: string
}> = [
  {
    id: "okx",
    name: "OKX 合约（本地官方归档）",
    kind: "swap",
    note: "本机下载官方 K线/资金费率归档，不转发服务器；K线2023-07起，近期文件有发布延迟，未发布资金费标记缺失",
  },
  {
    id: "binance_spot",
    name: "Binance 现货（binance.vision）",
    kind: "spot",
    note: "免 Key 公共数据域，主流币 2017-08 起超长历史",
  },
  {
    id: "gate_spot",
    name: "Gate 现货",
    kind: "spot",
    note: "免 Key，直连 api.gateio.ws；单页最多 1000 根",
  },
]

export function isKlineChannel(v: unknown): v is KlineChannelId {
  return v === "okx" || v === "binance_spot" || v === "gate_spot" || v === "gate_usdt" || v === "binance_usdt"
}

/** 规范化渠道:未知/缺省值回退默认渠道 */
export function normalizeChannel(v: unknown): KlineChannelId {
  return isKlineChannel(v) ? v : DEFAULT_KLINE_CHANNEL
}

// ===== Gate 现货 =====

const GATE_BASE = "https://api.gateio.ws/api/v4/spot"

function gatePair(symbol: string): string {
  return cryptoPair(symbol)
}

function gateInterval(period: string): string {
  if (period === "60m") return "1h"
  return period
}

async function getGateKlineApi(
  symbol: string,
  period: string,
  options?: { limit?: number; endTime?: string },
): Promise<BinanceKlinePage> {
  const limit = Math.min(Math.max(options?.limit ?? 500, 1), 1000)
  const params = new URLSearchParams({
    currency_pair: gatePair(symbol),
    interval: gateInterval(period),
    limit: String(limit),
  })
  if (options?.endTime) {
    params.set("to", String(Math.floor(barTimeToMs(options.endTime) / 1000)))
  }
  const resp = await fetch(`${GATE_BASE}/candlesticks?${params.toString()}`)
  if (!resp.ok) throw new Error(`Gate K线拉取失败(${resp.status})`)
  // Gate v4 返回数组行:[ts秒, 计价成交量, close, high, low, open, 基础成交量, 窗口关闭]
  const rows = (await resp.json()) as Array<
    [number, string, string, string, string, string, string, string]
  >
  const isDaily = gateInterval(period) === "1d"
  // Gate 返回已按时间升序(旧→新),无需再排
  const bars: KlineBar[] = rows.map((r) => ({
    time: msToBarTime(r[0] * 1000, isDaily),
    open: Number(r[5]),
    high: Number(r[3]),
    low: Number(r[4]),
    close: Number(r[2]),
    volume: Number(r[6]),
    open_time: Number(r[0]) * 1000,
    market_source: "gate_spot",
    quote_volume: optionalNumber(r[1]),
    settle: null,
    open_interest: null,
  }))
  return { bars, has_more: bars.length >= limit }
}

// ===== 统一分流 =====

/** 按渠道拉一页 K 线(契约同 getBinanceKlineApi) */
export function getChannelKlineApi(
  symbol: string,
  period: string,
  options?: { limit?: number; endTime?: string },
  channel: KlineChannelId = DEFAULT_KLINE_CHANNEL,
): Promise<BinanceKlinePage> {
  if (channel === "gate_usdt") return getGateFuturesKlineApi(symbol, period, options)
  if (channel === "binance_usdt") return getBinanceFuturesKlineApi(symbol, period, options)
  if (channel === "okx") return getOkxArchiveKlineApi(symbol, period, options)
  if (channel === "gate_spot") return getGateKlineApi(symbol, period, options)
  return getBinanceKlineApi(symbol, period, options)
}

// ===== 本地范围探测(数据渠道选择器的日期 clamp 辅助) =====

/** UTC 日期 YYYY-MM-DD(bar 起时口径,与后端 ChannelRange 一致) */
function tsToUtcDate(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

export interface LocalChannelRange {
  min_ts: number
  max_ts: number
  min_date: string
  max_date: string
}

/**
 * 直连渠道的可用历史范围探测(日线口径):
 * - binance_spot:startTime=0 一次拿到精确上线日(如 BTC 2017-08-17)
 * - gate_spot:窗口上限 1000 根 → 取最近 1000 根日线,首根为保守下界
 *   (保证可选即有数据;真实起点可能更早,低估不误导)
 * - okx:官方归档总范围(品种具体上线日期由文件缺失报告)
 */
export async function probeLocalChannelRange(
  channel: KlineChannelId,
  symbol: string,
): Promise<LocalChannelRange | null> {
  if (channel === "okx") {
    const max = Date.parse(`${latestOkxArchiveDay()}T23:59:59Z`)
    return {min_ts:OKX_CANDLE_FLOOR,max_ts:max,min_date:"2023-07-01",max_date:tsToUtcDate(max)}
  }
  if (channel === "binance_spot") {
    const sym = symbol.replace(/[-_/]/g, "").toUpperCase()
    const base = "https://data-api.binance.vision/api/v3"
    const [earliest, latest] = await Promise.all([
      fetch(`${base}/klines?symbol=${sym}&interval=1d&startTime=0&limit=1`).then(
        (r) => (r.ok ? r.json() : null),
      ),
      fetch(`${base}/klines?symbol=${sym}&interval=1d&limit=1`).then((r) =>
        r.ok ? r.json() : null,
      ),
    ])
    if (!Array.isArray(earliest) || !earliest.length) return null
    if (!Array.isArray(latest) || !latest.length) return null
    const minTs = Number(earliest[0][0])
    const maxTs = Number(latest[0][0])
    return {
      min_ts: minTs,
      max_ts: maxTs,
      min_date: tsToUtcDate(minTs),
      max_date: tsToUtcDate(maxTs),
    }
  }
  if (channel === "gate_spot") {
    const pair = gatePair(symbol)
    const resp = await fetch(
      `${GATE_BASE}/candlesticks?currency_pair=${pair}&interval=1d&limit=1000`,
    )
    if (!resp.ok) return null
    const rows = (await resp.json()) as Array<[number, ...unknown[]]>
    if (!Array.isArray(rows) || !rows.length) return null
    const minTs = rows[0][0] * 1000
    const maxTs = rows[rows.length - 1][0] * 1000
    return {
      min_ts: minTs,
      max_ts: maxTs,
      min_date: tsToUtcDate(minTs),
      max_date: tsToUtcDate(maxTs),
    }
  }
  return null
}

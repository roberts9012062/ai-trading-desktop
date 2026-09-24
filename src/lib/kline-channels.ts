/**
 * 多渠道历史 K 线适配器 —— 回测 / 因子实验室 / 超级因子挖掘共用
 * (对齐后端 app/data/history_channels.py 的三渠道定义)
 *
 * - binance_spot：Binance 现货 data-api.binance.vision 本地直连(免 Key,
 *   主流币 2017-08 起)——默认渠道
 * - gate_spot：Gate 现货 api.gateio.ws 本地直连(免 Key)
 * - okx：OKX 国内网络直连不可达 → 走后端 /api/market/kline 转发
 *   (服务器侧 OKX 主链路 + Gate 容灾,与 Web 端"系统默认"渠道同源)
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

export type KlineChannelId = "okx" | "binance_spot" | "gate_spot"

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
    name: "系统默认（OKX 合约）",
    kind: "swap",
    note: "OKX 合约 K 线，直连 www.okx.com；深度受交易所历史接口限制",
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
  return v === "okx" || v === "binance_spot" || v === "gate_spot"
}

/** 规范化渠道:未知/缺省值回退默认渠道 */
export function normalizeChannel(v: unknown): KlineChannelId {
  return isKlineChannel(v) ? v : DEFAULT_KLINE_CHANNEL
}

// ===== okx 渠道:后端转发 =====
// OKX API(www.okx.com/aws.okx.com)国内网络不可达(实测 DNS/连接秒断),
// 该渠道走后端 /api/market/kline(服务器在海外,OKX 主链路 + Gate 容灾,
// 与 Web 端"系统默认"渠道同源);Binance/Gate 渠道仍为本地直连。

const OKX_BACKEND_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")

async function getOkxKlineApi(
  symbol: string,
  period: string,
  options?: { limit?: number; endTime?: string },
): Promise<BinanceKlinePage> {
  const params = new URLSearchParams({ symbol, period })
  if (options?.limit) params.set("limit", String(options.limit))
  if (options?.endTime) params.set("end_time", options.endTime)
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  try {
    const token = localStorage.getItem("access_token")
    if (token) headers.Authorization = `Bearer ${token}`
  } catch {
    // localStorage 不可用时裸请求(后端会 401,由上层报错)
  }
  const resp = await fetch(
    `${OKX_BACKEND_BASE}/api/market/kline?${params.toString()}`,
    { headers },
  )
  if (!resp.ok) throw new Error(`okx 渠道(后端)拉取失败(${resp.status})`)
  const body = (await resp.json()) as { bars?: KlineBar[]; has_more?: boolean }
  return { bars: body.bars ?? [], has_more: Boolean(body.has_more) }
}

// ===== Gate 现货 =====

const GATE_BASE = "https://api.gateio.ws/api/v4/spot"

function gatePair(symbol: string): string {
  return `${symbol.replace(/[-_/]/g, "").toUpperCase().replace(/USDT$/, "")}_USDT`
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
  if (channel === "okx") return getOkxKlineApi(symbol, period, options)
  if (channel === "gate_spot") return getGateKlineApi(symbol, period, options)
  return getBinanceKlineApi(symbol, period, options)
}

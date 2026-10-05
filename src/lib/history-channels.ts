/** 历史数据渠道 API 客户端 —— 回测 / 因子实验室 / 超级因子挖掘共用 */

import { LOCAL_HISTORY_CHANNELS, probeLocalChannelRange, isKlineChannel } from "@/lib/kline-channels"

export interface HistoryChannel {
  id: string
  name: string
  kind: string
  note: string
}

export interface ChannelRange {
  channel: string
  symbol: string
  timeframe: string
  min_ts: number
  max_ts: number
  /** UTC 日期 YYYY-MM-DD（bar 起时口径） */
  min_date: string
  max_date: string
}

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")

async function historyRequest<T>(path: string): Promise<T> {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("access_token") : null
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (token) headers["Authorization"] = `Bearer ${token}`
  const response = await fetch(`${API_BASE}${path}`, { headers })
  if (response.status === 401 && typeof window !== "undefined") {
    window.location.href = "/login"
    throw new Error("认证过期")
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "请求失败" }))
    const detail = error?.detail
    throw new Error(
      typeof detail === "string" ? detail : `请求失败: ${response.status}`
    )
  }
  return response.json() as Promise<T>
}

/** 可选历史数据渠道列表(后端不可达时回退内置三渠道,UI 不空) */
export async function getHistoryChannels(): Promise<HistoryChannel[]> {
  try {
    const res = await historyRequest<{ channels: HistoryChannel[] }>(
      "/api/history/channels"
    )
    return res.channels.map((channel) => channel.id === "okx" ? LOCAL_HISTORY_CHANNELS.find((c) => c.id === "okx")! : channel)
  } catch {
    return LOCAL_HISTORY_CHANNELS
  }
}


/** 探测渠道对某品种某周期的可用历史范围（后端缓存 6h） */
export async function getChannelRange(
  channel: string,
  symbol: string,
  timeframe: string
): Promise<ChannelRange> {
  if (channel === "gate_usdt") {
    const max = Date.now(), min = max - 175 * 86400000
    return { channel, symbol, timeframe, min_ts: min, max_ts: max,
      min_date: new Date(min).toISOString().slice(0, 10), max_date: new Date(max).toISOString().slice(0, 10) }
  }
  if (isKlineChannel(channel)) {
    const range = await probeLocalChannelRange(channel, symbol)
    if (range) return { ...range, channel, symbol, timeframe }
    if (channel === "okx") throw new Error("OKX 本地归档范围不可用，不回退服务器")
  }
  const qs = new URLSearchParams({ channel, symbol, timeframe })
  return historyRequest<ChannelRange>(`/api/history/range?${qs.toString()}`)
}

/** 超级因子挖掘：按渠道拉可挖掘品种清单 */
export async function getMiningSymbolsApi(
  channel: string
): Promise<{ symbol: string; symbol_name: string }[]> {
  const qs = new URLSearchParams({ channel })
  const res = await historyRequest<{
    items: { symbol: string; symbol_name: string }[]
  }>(`/api/factor-mining/symbols?${qs.toString()}`)
  return res.items
}

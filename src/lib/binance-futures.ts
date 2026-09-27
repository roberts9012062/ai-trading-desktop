/**
 * Binance USDT-M 永续(合约)归档客户端 —— data.binance.vision 静态 zip 直连
 *
 * 背景:fapi.binance.com REST 域对受限地区一律拒绝(代理出口亦被封),
 * 但官方归档 CDN data.binance.vision 全量可达:
 * - K 线月/日包:data/futures/um/{monthly,daily}/klines/{SYM}/{interval}/…
 * - 资金费率月/日包:data/futures/um/{monthly,daily}/fundingRate/{SYM}/…
 *
 * 网络约束:静态域无 CORS 头,依赖桌面端 plugin-http(desktop-boot 已把
 * 全局 fetch 替换为 Rust 侧实现,不受 CORS 约束);纯浏览器 dev 不可用。
 * 归档口径:月包次月初发布、日包 T+1,近端最多滞后 1-2 天(研究口径可接受)。
 *
 * 分页契约与 getBinanceKlineApi 相同({bars, has_more} + endTime 回溯),
 * fetchBacktestBars 的分页/去重/截断逻辑零改动;锚点=endTime 前一月/日,
 * 返回 time ≤ endTime 的 bar(严格不重)。
 */
import type { KlineBar } from "@/types"
import { barTimeToMs, msToBarTime, normalizeInterval, toBinanceSymbol } from "@/lib/binance-kline"

import { unzipSync } from "fflate"

const UM_BASE = "https://data.binance.vision/data/futures/um"
/** Binance USDT-M 永续全所上线(2019-09);更早的月包请求会 404 */
const UM_INCEPTION = Date.UTC(2019, 8, 2)

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`
}

function dayKey(d: Date): string {
  return `${monthKey(d)}-${pad2(d.getUTCDate())}`
}

function klinesZipUrl(symbol: string, interval: string, daily: boolean, key: string): string {
  const s = toBinanceSymbol(symbol)
  return `${UM_BASE}/${daily ? "daily" : "monthly"}/klines/${s}/${interval}/${s}-${interval}-${key}.zip`
}

function fundingZipUrl(symbol: string, daily: boolean, key: string): string {
  const s = toBinanceSymbol(symbol)
  return `${UM_BASE}/${daily ? "daily" : "monthly"}/fundingRate/${s}/${s}-fundingRate-${key}.zip`
}

/** 下载并解包 zip 的首个 CSV(文本)。404 返回 null;其他网络错误抛错。 */
async function fetchZipCsv(url: string): Promise<string | null> {
  const resp = await fetch(url)
  if (resp.status === 404) return null
  if (!resp.ok) throw new Error(`Binance 归档下载失败(${resp.status}: ${url.slice(-60)})`)
  const buf = new Uint8Array(await resp.arrayBuffer())
  const files = unzipSync(buf)
  const name = Object.keys(files).find((f) => f.endsWith(".csv"))
  if (!name) return null
  return new TextDecoder().decode(files[name])
}

function csvRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => l.split(","))
}

/** 跳过表头行(新归档带 header,旧归档无;按首列是否数字判断) */
function dropHeader(rows: string[][]): string[][] {
  if (rows.length && !/^\d+$/.test(rows[0][0] ?? "")) return rows.slice(1)
  return rows
}

/** um K 线 CSV → KlineBar(列序与 fapi REST 数组一致) */
export function parseUmKlinesCsv(text: string, interval: string): KlineBar[] {
  const isDaily = interval === "1d"
  const bars = dropHeader(csvRows(text)).map((r) => {
    const openTime = Number(r[0])
    return {
      time: msToBarTime(openTime, isDaily),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
      open_time: openTime,
      market_source: "binance_usdt",
      quote_volume: r[7] !== "" && Number.isFinite(Number(r[7])) ? Number(r[7]) : null,
      trade_count: r[8] !== "" && Number.isFinite(Number(r[8])) ? Number(r[8]) : null,
      taker_buy_volume: r[9] !== "" && Number.isFinite(Number(r[9])) ? Number(r[9]) : null,
      taker_buy_quote_volume: r[10] !== "" && Number.isFinite(Number(r[10])) ? Number(r[10]) : null,
      settle: null,
      open_interest: null,
    } as KlineBar
  })
  return bars.filter((b) => Number.isFinite(b.open_time) && b.close > 0)
}

export interface FundingEvent {
  /** epoch ms(结算时刻) */
  t: number
  /** 费率(小数) */
  r: number
}

/** 资金费率 CSV → 事件列表;兼容新旧两种表头 */
export function parseFundingCsv(text: string): FundingEvent[] {
  const rows = dropHeader(csvRows(text))
  const out: FundingEvent[] = []
  for (const r of rows) {
    // 新格式: calc_time,funding_interval_hours,last_funding_rate
    // 旧格式: symbol,fundingTime,fundingRate,markPrice
    if (r.length >= 3 && /^\d+$/.test(r[0]) && /^-?\d/.test(r[2])) {
      out.push({ t: Number(r[0]), r: Number(r[2]) })
    } else if (r.length >= 3 && /^\d+$/.test(r[1]) && /^-?\d/.test(r[2])) {
      out.push({ t: Number(r[1]), r: Number(r[2]) })
    }
  }
  return out.filter((e) => Number.isFinite(e.t) && Number.isFinite(e.r))
}

/** 拉一页永续 K 线(endTime 回溯锚点=其前一日/月;闭区间过滤 time ≤ endTime) */
export async function getBinanceFuturesKlineApi(
  symbol: string,
  period: string,
  options?: { limit?: number; endTime?: string },
): Promise<{ bars: KlineBar[]; has_more: boolean }> {
  const interval = normalizeInterval(period)
  const s = toBinanceSymbol(symbol)
  const now = new Date()

  if (!options?.endTime) {
    // 最新一页:从昨天起回找最近的日包(≤8 天),再退到上月月包
    for (let back = 1; back <= 8; back++) {
      const d = new Date(now.getTime() - back * 86400000)
      const text = await fetchZipCsv(klinesZipUrl(s, interval, true, dayKey(d)))
      if (text !== null) {
        const bars = parseUmKlinesCsv(text, interval)
        if (bars.length) return { bars, has_more: true }
      }
    }
    const m = new Date(now.getTime() - 32 * 86400000) // 上月(月包次月才发布)
    const text = await fetchZipCsv(klinesZipUrl(s, interval, false, monthKey(m)))
    const bars = text === null ? [] : parseUmKlinesCsv(text, interval)
    return { bars, has_more: bars.length > 0 }
  }

  const endTimeMs = barTimeToMs(options.endTime)
  // 锚点 = endTime 前一毫秒所在的日/月:保证与上一页严格不重叠
  const anchor = new Date(endTimeMs - 1)
  const inCurrentMonth =
    anchor.getUTCFullYear() === now.getUTCFullYear() && anchor.getUTCMonth() === now.getUTCMonth()
  let bars: KlineBar[] = []
  if (inCurrentMonth) {
    // 本月无月包:逐日回溯日包(缺日自动前跳,≤4 天)
    for (let back = 0; back < 4 && bars.length === 0; back++) {
      const d = new Date(anchor.getTime() - back * 86400000)
      const text = await fetchZipCsv(klinesZipUrl(s, interval, true, dayKey(d)))
      if (text !== null) bars = parseUmKlinesCsv(text, interval)
    }
  } else {
    // 历史月:锚点月包(缺月自动前跳,≤3 个月)
    for (let back = 0; back < 3 && bars.length === 0; back++) {
      const m = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - back, 1))
      const text = await fetchZipCsv(klinesZipUrl(s, interval, false, monthKey(m)))
      if (text !== null) bars = parseUmKlinesCsv(text, interval)
    }
  }
  // 页 = 整个归档包(15m 月包 2880 根):fetchBacktestBars 的 150 页上限
  // 若按 limit=500 截断,15m 全量(24.6 万根)需 492 页会被截断报错;
  // 归档渠道以文件为自然分页单位,忽略 limit
  const selected = bars.filter((b) => (b.open_time ?? 0) <= endTimeMs)
  if (!selected.length) return { bars: [], has_more: false }
  const oldest = selected[0].open_time ?? 0
  return { bars: selected, has_more: oldest > UM_INCEPTION }
}

/** 并发受控的批量下载(归档月包数量可达 ~90) */
async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

/** 拉齐 [from, to] 的资金费率事件(月包为主,当月用日包补) */
export async function fetchFundingHistory(
  symbol: string,
  fromMs: number,
  toMs: number,
  onProgress?: (msg: string) => void,
): Promise<FundingEvent[]> {
  const s = toBinanceSymbol(symbol)
  const now = new Date()
  const months: string[] = []
  const cur = new Date(Math.max(fromMs, UM_INCEPTION))
  // 按月首迭代:同日推进会因 31→30/28 日溢出跳过区间末尾的整月
  cur.setUTCDate(1)
  cur.setUTCHours(0, 0, 0, 0)
  while (cur.getTime() <= toMs) {
    months.push(monthKey(cur))
    cur.setUTCMonth(cur.getUTCMonth() + 1)
  }
  const texts = await pool(months, 6, async (m) => {
    onProgress?.(`拉取资金费率归档(${m})…`)
    let text = await fetchZipCsv(fundingZipUrl(s, false, m))
    if (text === null) {
      // 当月月包未发布:用当月日包拼(至多 31 天)
      const parts: string[] = []
      const [y, mo] = m.split("-").map(Number)
      const days = new Date(Date.UTC(y, mo, 0)).getUTCDate()
      const isCurrent = y === now.getUTCFullYear() && mo === now.getUTCMonth() + 1
      const lastDay = isCurrent ? now.getUTCDate() : days
      for (let d = 1; d <= lastDay; d++) {
        const t = await fetchZipCsv(fundingZipUrl(s, true, `${m}-${pad2(d)}`))
        if (t !== null) parts.push(t)
      }
      text = parts.length ? parts.join("\n") : null
    }
    return text
  })
  const events = texts
    .filter((t): t is string => t !== null)
    .flatMap((t) => parseFundingCsv(t))
    .filter((e) => e.t >= fromMs && e.t <= toMs)
    .sort((a, b) => a.t - b.t)
  return events
}

/** 资金费率并入 K 线(Gate 同款口径:结算后生效、86400s 有效窗,缺失即报错不补零) */
export function joinFunding(bars: KlineBar[], funding: FundingEvent[]): KlineBar[] {
  const f = [...funding].sort((a, b) => a.t - b.t)
  let fi = -1
  return bars.map((b) => {
    const at = (b.open_time ?? barTimeToMs(String(b.time))) / 1000
    while (fi + 1 < f.length && f[fi + 1].t / 1000 <= at) fi++
    const ev = fi >= 0 && at - f[fi].t / 1000 <= 86400 ? f[fi] : null
    if (!ev) {
      throw new Error(
        `Binance 永续资金费率覆盖不足（${String(b.time).slice(0, 10)}），请缩小日期区间；未用零值补齐`,
      )
    }
    return { ...b, funding_rate: ev.r, funding_time: ev.t }
  })
}

/** 取数后补齐资金费率(fetchBacktestBars 的 binance_usdt 收尾步骤) */
export async function enrichBinanceFuturesBars(
  symbol: string,
  bars: KlineBar[],
  onProgress?: (msg: string) => void,
): Promise<KlineBar[]> {
  if (!bars.length) return bars
  const from = (bars[0].open_time ?? 0) - 86400000 // 预留一天对齐窗
  const to = bars[bars.length - 1].open_time ?? 0
  const funding = await fetchFundingHistory(symbol, from, to, onProgress)
  if (!funding.length) throw new Error("Binance 永续资金费率归档为空，请检查品种或缩小区间")
  return joinFunding(bars, funding)
}

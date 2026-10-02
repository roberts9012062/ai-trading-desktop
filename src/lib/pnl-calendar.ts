/**
 * 盈亏日历数据层：业务服务器转发的实盘账单 → 按日聚合 → 本地缓存。
 *
 * 数据源为 /api/live/bills（复用「实盘交易所接入」保存在服务器上的凭证，
 * 桌面端不再本地签名直连交易所）；聚合口径与缓存展示全部在本地完成。
 */

import { getLiveBillsApi, type LiveBill } from "./live-api"

/** 单次同步拉取上限：服务器接口无分页游标，一次拉全 */
export const BILLS_LIMIT = 2000

/** 缓存 10 分钟内视为新鲜，避免每次进工作台都重拉 */
export const CACHE_FRESH_MS = 10 * 60 * 1000

export interface DailyPnlEntry {
  /** 已实现盈亏 + 手续费（服务器账单口径，USDT 计价） */
  pnl: number
  /** 平仓/交割/强平类账单笔数 */
  count: number
}

export type DailyPnlMap = Record<string, DailyPnlEntry>

/** 账单毫秒时间戳 → 本机时区自然日 key（YYYY-MM-DD），与日历视图同一口径 */
export function dayKeyLocal(tsMs: number): string {
  const d = new Date(tsMs)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 按日聚合：跳过纯转账；盈亏 = pnl + fee；amount（余额变动）不可加，会把充值提现算进盈亏 */
export function aggregateDailyPnl(bills: LiveBill[]): DailyPnlMap {
  const days: DailyPnlMap = {}
  for (const b of bills) {
    const ts = Number(b.ts_ms)
    if (!Number.isFinite(ts)) continue
    const type = String(b.type ?? "")
    if (type === "1") continue
    const v = (Number(b.pnl) || 0) + (Number(b.fee) || 0)
    const isTrade = type === "2" || type === "3" || type === "5"
    if (v === 0 && !isTrade) continue
    const key = dayKeyLocal(ts)
    const day = days[key] ?? { pnl: 0, count: 0 }
    day.pnl += v
    if (isTrade) day.count += 1
    days[key] = day
  }
  return days
}

export interface DailyPnlCache {
  version: 2
  venue: string
  fetchedAt: number
  /** 本次拉到的账单条数（受 BILLS_LIMIT 截断） */
  billCount: number
  /** 最早一条账单时间，用于判断覆盖范围 */
  earliestTsMs: number | null
  days: DailyPnlMap
}

const CACHE_KEY = "atd-pnl-calendar-cache-v2"

export function loadDailyPnlCache(venue: string): DailyPnlCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as Partial<DailyPnlCache>
    if (c.version !== 2 || c.venue !== venue || !c.days) return null
    return {
      version: 2,
      venue,
      fetchedAt: Number(c.fetchedAt) || 0,
      billCount: Number(c.billCount) || 0,
      earliestTsMs: Number.isFinite(Number(c.earliestTsMs)) ? Number(c.earliestTsMs) : null,
      days: c.days,
    }
  } catch {
    return null
  }
}

export function saveDailyPnlCache(c: DailyPnlCache): void {
  localStorage.setItem(CACHE_KEY, JSON.stringify(c))
}

export function clearDailyPnlCache(): void {
  localStorage.removeItem(CACHE_KEY)
}

/** 拉取服务器账单并落缓存 */
export async function refreshDailyPnl(opts: {
  venue: string
}): Promise<DailyPnlCache> {
  const bills = await getLiveBillsApi(opts.venue, BILLS_LIMIT)
  let earliestTsMs: number | null = null
  for (const b of bills) {
    const ts = Number(b.ts_ms)
    if (Number.isFinite(ts) && (earliestTsMs == null || ts < earliestTsMs)) {
      earliestTsMs = ts
    }
  }
  const cache: DailyPnlCache = {
    version: 2,
    venue: opts.venue,
    fetchedAt: Date.now(),
    billCount: bills.length,
    earliestTsMs,
    days: aggregateDailyPnl(bills),
  }
  saveDailyPnlCache(cache)
  return cache
}

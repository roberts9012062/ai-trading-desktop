/**
 * 盈亏日历数据层：业务服务器 /api/live/daily-pnl（账户日收益统计）→ 本地缓存。
 *
 * 服务器基于 OKX 成交明细（fills-history，覆盖约 90 天）聚合：
 * 每日净 = Σ平仓腿盈亏 − Σ|手续费|（不含资金费），按北京自然日分桶。
 * 桌面端只缓存 days 数组，月度汇总/曲线在本地按月重算。
 */

import { getLiveDailyPnlApi } from "./live-api"

/** 服务器 days 参数上限（le=90，≈fills 覆盖范围） */
export const WINDOW_DAYS = 90

/** 缓存 10 分钟内视为新鲜（服务器侧另有 TTL 缓存，双保险） */
export const CACHE_FRESH_MS = 10 * 60 * 1000

export interface DailyPnlEntry {
  /** 当日净盈亏（平仓盈亏 − 手续费，USDT） */
  net: number
  /** 当日平仓腿已实现盈亏（不含手续费） */
  gross: number
  /** 当日手续费合计（正数，方便展示时取负） */
  fee: number
  /** 当日成交笔数 */
  count: number
}

export type DailyPnlMap = Record<string, DailyPnlEntry>

export interface DailyPnlCache {
  version: 3
  venue: string
  fetchedAt: number
  /** 最早有数据的日期（YYYY-MM-DD），用于翻月下限 */
  earliestDate: string | null
  days: DailyPnlMap
}

const CACHE_KEY = "atd-pnl-calendar-cache-v3"

export function loadDailyPnlCache(venue: string): DailyPnlCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as Partial<DailyPnlCache>
    if (c.version !== 3 || c.venue !== venue || !c.days) return null
    const days: DailyPnlMap = {}
    for (const [k, v] of Object.entries(c.days)) {
      if (v && Number.isFinite(Number(v.net))) {
        days[k] = {
          net: Number(v.net),
          gross: Number(v.gross) || 0,
          fee: Number(v.fee) || 0,
          count: Number(v.count) || 0,
        }
      }
    }
    return {
      version: 3,
      venue,
      fetchedAt: Number(c.fetchedAt) || 0,
      earliestDate: typeof c.earliestDate === "string" ? c.earliestDate : null,
      days,
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

/** 拉取服务器日收益统计并落缓存 */
export async function refreshDailyPnl(opts: {
  venue: string
}): Promise<DailyPnlCache> {
  const res = await getLiveDailyPnlApi(opts.venue, WINDOW_DAYS)
  const days: DailyPnlMap = {}
  // 服务器把无交易日也补成 0 行；只留有成交的日子，日历上其余自然显示空
  for (const r of Array.isArray(res.days) ? res.days : []) {
    if (r.trades > 0 || r.net !== 0) {
      days[r.date] = {
        net: r.net,
        gross: r.pnl,
        fee: r.fee,
        count: r.trades,
      }
    }
  }
  const dates = Object.keys(days).sort()
  const cache: DailyPnlCache = {
    version: 3,
    venue: opts.venue,
    fetchedAt: Date.now(),
    earliestDate: dates.length > 0 ? dates[0] : null,
    days,
  }
  saveDailyPnlCache(cache)
  return cache
}

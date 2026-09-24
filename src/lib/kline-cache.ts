/**
 * K 线历史本地缓存(IndexedDB)—— 桌面端离线/秒开能力
 *
 * 策略(stale-while-revalidate):
 * - 冷启动/切合约时先用缓存整段画出(store.setKlineBars),网络成功后覆盖并回写;
 * - 翻页前插后把合并结果整体回写;
 * - 缓存永不作为唯一真相:网络刷新永远会执行,失败时保留缓存画面。
 *
 * 环境兜底:非浏览器(node 测试/SSR)全部 no-op,不抛错。
 */

import type { KlineBar, KlinePeriod } from "@/types"
import { bjNowMs, maxPlausibleBarKey } from "@/lib/kline-engine"
import { isValidMinuteBarTime } from "@/lib/trading-sessions"
import { openDb, KLINE_HISTORY_STORE as STORE } from "@/lib/idb"

export interface KlineCacheEntry {
  key: string
  symbol: string
  period: KlinePeriod
  bars: KlineBar[]
  hasMore: boolean
  savedAt: number
}

// DB openDb/升级统一走 @/lib/idb(全应用唯一版本入口),本模块只保留
// fail-open 的读写封装

/** 读取缓存;无库/无键/异常 → null(调用方按无缓存处理)。
 *  读取时过滤未来时间戳的脏 bar——旧版本可能已把服务端坏数据写进缓存,
 *  这类 bar 会让实时 forming bar 永远"落后"而停止更新。 */
export async function readKlineCache(
  symbol: string,
  period: KlinePeriod,
): Promise<KlineCacheEntry | null> {
  const db = await openDb()
  if (!db) return null
  const raw = await new Promise<KlineCacheEntry | null>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly")
      const req = tx.objectStore(STORE).get(`${symbol}:${period}`)
      req.onsuccess = () => {
        const v = req.result as KlineCacheEntry | undefined
        resolve(v && Array.isArray(v.bars) && v.bars.length > 0 ? v : null)
      }
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  if (!raw) return null
  const limit = maxPlausibleBarKey(symbol, period, bjNowMs())
  const bars = raw.bars.filter(
    (b) =>
      b &&
      typeof b.time === "string" &&
      b.time <= limit &&
      (period === "1d" || period === "tick" || isValidMinuteBarTime(symbol, period, b.time)),
  )
  return bars.length > 0 ? { ...raw, bars } : null
}

/** 回写缓存(整段覆盖);失败静默 */
export async function writeKlineCache(
  symbol: string,
  period: KlinePeriod,
  bars: KlineBar[],
  hasMore: boolean,
): Promise<void> {
  if (!Array.isArray(bars) || bars.length === 0) return
  const db = await openDb()
  if (!db) return
  const entry: KlineCacheEntry = {
    key: `${symbol}:${period}`,
    symbol,
    period,
    bars,
    hasMore,
    savedAt: Date.now(),
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).put(entry)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

/** 翻页前插后持久化:取 store 当前(已合并)列表回写 */
export async function persistPrependedKline(
  symbol: string,
  period: KlinePeriod,
  bars: KlineBar[],
  hasMore: boolean,
): Promise<void> {
  await writeKlineCache(symbol, period, bars, hasMore)
}

/** 清空全部 K 线缓存(设置页手动清理用) */
export async function clearKlineCache(): Promise<void> {
  const db = await openDb()
  if (!db) return
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

// ========== 本地优先(local-first)合并与回写 ==========

/**
 * 本地优先合并:服务端与本地按 bar 时间做**并集**,同时间以服务端为准
 * (TqSdk 定时修正的权威值),任何一侧缺失的 bar 都不会丢。
 * 提供 symbol/period 时按交易轴校验分钟 bar 时间,剔除旧口径(墙钟/结束点
 * 语义)存量 bar——否则与新口径 axis bar 并存成双 K(30m/60m 症状最明显)。
 * 超出 cap 根丢弃最旧的。
 */
export function mergeServerBarsWithLocal(
  server: KlineBar[],
  local: KlineBar[],
  cap = 2000,
  symbol?: string,
  period?: string,
): KlineBar[] {
  const byTime = new Map<string, KlineBar>()
  const collect = (bars: KlineBar[]) => {
    if (!symbol || !period) {
      for (const b of bars) byTime.set(b.time, b)
      return
    }
    for (const b of bars) {
      if (period !== "1d" && !isValidMinuteBarTime(symbol, period, b.time)) continue
      byTime.set(b.time, b)
    }
  }
  if (local.length > 0) collect(local) // 本地先入
  if (server.length > 0) collect(server) // 服务端覆盖同时间
  if (byTime.size === 0) return server.length > 0 ? server : local
  const merged = [...byTime.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
  return merged.length > cap ? merged.slice(merged.length - cap) : merged
}

const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * 防抖回写:本地收盘 bar 追加后按 key 合并落盘
 * (1m 换桶时全市场同时触发,直接写会造成 IndexedDB 风暴)。
 * 延迟读取 store 当前列表,天然拿到合并后的最终结果。
 */
export function scheduleKlineCacheWrite(symbol: string, period: KlinePeriod): void {
  const key = `${symbol}:${period}`
  const existing = pendingWrites.get(key)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    pendingWrites.delete(key)
    void (async () => {
      // 动态引入避免与 store 的静态循环依赖
      const { useMarketStore } = await import("@/stores/market")
      const state = useMarketStore.getState()
      const bars = state.klineBars[symbol]?.[period] ?? []
      if (bars.length > 0) {
        await writeKlineCache(symbol, period, bars, state.klineHasMore[key] ?? true)
      }
    })()
  }, 800)
  pendingWrites.set(key, timer)
}

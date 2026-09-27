/**
 * 研究用 K 线深历史缓存(IndexedDB)—— 挖掘/回测的增量取数底座
 *
 * 与实时图表的 kline-cache(2000 根 stale-while-revalidate)不同:本缓存按
 * `channel:symbol:timeframe` 存**整段深历史**(含已补齐的资金费率等衍生
 * 字段),fetchBacktestBars 每次只增量拉缺口(通常仅最近几天)再拼接,
 * 重复挖掘同一币种从分钟级取数降到亚秒级。超级因子/因子实验室/历史回测
 * 共用同一漏斗,自动生效。
 *
 * 修订自愈:尾部增量从「缓存末根前 1 天」重叠拉取,同 time 以新拉为准,
 * 交易所对近期 bar 的修正自动覆盖;更深的历史修订靠个人页手动清理。
 * 环境兜底:非浏览器(node 测试)全部 no-op 降级为无缓存。
 */

import type { KlineBar } from "@/types"
import { openDb, RESEARCH_KLINE_STORE as STORE } from "@/lib/idb"

/** 单条目 bar 数上限(15m 永续全量 2019 起 ≈ 24.6 万;超限丢最旧) */
const MAX_BARS_PER_ENTRY = 300_000

export interface ResearchKlineEntry {
  key: string
  channel: string
  symbol: string
  timeframe: string
  bars: KlineBar[]
  savedAt: number
}

export function researchCacheKey(channel: string, symbol: string, timeframe: string): string {
  return `${channel}:${symbol.trim().toLowerCase()}:${timeframe}`
}

/** 读取整段缓存;无库/无键/异常 → null(调用方按无缓存处理) */
export async function readResearchKlines(
  channel: string,
  symbol: string,
  timeframe: string,
): Promise<KlineBar[] | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const req = db
        .transaction(STORE, "readonly")
        .objectStore(STORE)
        .get(researchCacheKey(channel, symbol, timeframe))
      req.onsuccess = () => {
        const v = req.result as ResearchKlineEntry | undefined
        resolve(v && Array.isArray(v.bars) && v.bars.length > 0 ? v.bars : null)
      }
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/** 整段回写(超上限丢最旧);失败静默——缓存不可用不应影响取数本身 */
export async function writeResearchKlines(
  channel: string,
  symbol: string,
  timeframe: string,
  bars: KlineBar[],
): Promise<void> {
  if (!Array.isArray(bars) || bars.length === 0) return
  const db = await openDb()
  if (!db) return
  const trimmed = bars.length > MAX_BARS_PER_ENTRY ? bars.slice(bars.length - MAX_BARS_PER_ENTRY) : bars
  const entry: ResearchKlineEntry = {
    key: researchCacheKey(channel, symbol, timeframe),
    channel,
    symbol: symbol.trim().toLowerCase(),
    timeframe,
    bars: trimmed,
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

/** 清空全部研究 K 线缓存(个人页手动清理用;清后下次取数重新下载) */
export async function clearResearchKlines(): Promise<void> {
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

export interface ResearchKlineStats {
  entries: number
  bars: number
  approximateMB: number
  oldestSavedAt: number | null
}

/** 缓存统计(个人页展示用) */
export async function researchKlineStats(): Promise<ResearchKlineStats> {
  const db = await openDb()
  const empty: ResearchKlineStats = { entries: 0, bars: 0, approximateMB: 0, oldestSavedAt: null }
  if (!db) return empty
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll()
      req.onsuccess = () => {
        const rows = (req.result ?? []) as ResearchKlineEntry[]
        const bars = rows.reduce((n, r) => n + (r.bars?.length ?? 0), 0)
        resolve({
          entries: rows.length,
          bars,
          approximateMB: Math.round((bars * 160) / 1048576 * 10) / 10,
          oldestSavedAt: rows.length ? Math.min(...rows.map((r) => r.savedAt || 0)) : null,
        })
      }
      req.onerror = () => resolve(empty)
    } catch {
      resolve(empty)
    }
  })
}

/** 并集合并,同 time 以 newer 为准(网络新拉覆盖缓存,修订自愈),升序返回 */
export function mergeBarsPreferNew(base: KlineBar[], newer: KlineBar[]): KlineBar[] {
  if (!newer.length) return base
  if (!base.length) return newer
  const byTime = new Map<string, KlineBar>()
  for (const b of base) byTime.set(String(b.time), b)
  for (const b of newer) byTime.set(String(b.time), b)
  return [...byTime.values()].sort((a, b) => {
    const ta = String(a.time)
    const tb = String(b.time)
    return ta < tb ? -1 : ta > tb ? 1 : 0
  })
}

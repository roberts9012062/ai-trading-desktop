/**
 * 本地挖掘数据层(M1) —— 历史 K 线由本机按交易所下载,冻结为 IndexedDB 快照
 *
 * 两种挖掘模式(本地算力/服务端算力)共用同一份 bars 语义:本地走本模块
 * 拉取+冻结,服务端自己取数但校验规则对齐,保证同一品种同一区间两端得到
 * 相同的 bars,"本地/服务端结果可对比"才有前提。
 *
 * 为什么必须冻结快照(正确性关键):search_stepwise 断点续训用
 * start_generation 跳代 + seed_best 注入历史最优,隐含假设 bars 不变——
 * rng 从头重放,若 bars 变了,特征矩阵变、评估结果变,续训轨迹与中断前
 * 不再连续。本地任务可能跨天恢复,期间 K 线一定有新增,因此快照一经
 * 冻结永不回写,续训只读快照。
 *
 * 存储:IndexedDB store `mining-bars`(keyPath "id"),DB 版本升级统一走
 * @/lib/idb(全应用唯一入口)。总量上限 200MB,按 fetchedAt LRU 淘汰
 * refCount=0 的快照,被活跃任务引用的跳过。
 */

import type { KlineBar } from "@/types"
import { fetchBacktestBars, KLINE_MAX_PAGES } from "@/lib/local-backtest"
import { normalizeChannel } from "@/lib/kline-channels"
import { factorMaxDaysFor } from "@/components/factor-lab/factor-range-limits"
import { openDb, idbGet, idbPut, idbGetAll, idbDelete, MINING_BARS_STORE } from "@/lib/idb"
import { maxResearchBars } from "@/lib/device-profile"

export interface BarsSnapshot {
  /** `${symbol}:${channel}:${timeframe}:${from}:${to}:${sourceHash}` */
  id: string
  symbol: string
  /** 数据渠道(快照按渠道隔离,不同渠道数据不混用) */
  channel: string
  timeframe: string
  /** 实际首根 bar 时间(日期) */
  from: string
  /** 实际末根 bar 时间(日期) */
  to: string
  bars: KlineBar[]
  count: number
  fetchedAt: number
  /** bars 的 FNV-1a 32 位哈希;亦作为 Python 侧 bars_signature 的替代,
   *  由 JS 显式传入内核,规避内核三点采样的碰撞风险(第一部分 P2-14) */
  sourceHash: string
}

export interface AcquireBarsRequest {
  symbol: string
  timeframe: string
  /** 数据渠道(okx/binance_spot/gate_spot;缺省 binance_spot)——进快照 id,不同渠道数据不混用 */
  channel?: string
  startDate: string
  endDate: string
  maxPages?: number
}

/** 内部持久化记录:快照字段 + 引用计数与体积估算(不进对外接口) */
interface SnapshotRecord extends BarsSnapshot {
  /** 活跃任务引用数;LRU 淘汰只动 refCount<=0 的快照 */
  refCount: number
  sizeEstimate: number
}

/** 与回测/因子共用同一分页上限:150 页×500=7.5 万根,覆盖区间上限
 *  1m×30 天(≈3.3 万根)及深历史区间(rb 15m 全量≈134 页)不被截断 */
const MAX_PAGES_DEFAULT = KLINE_MAX_PAGES
/** 结构化克隆体积估算(日线 5 年 1200 根≈200KB → ~180B/bar) */
const BYTES_PER_BAR = 180
let maxTotalBytes = 200 * 1024 * 1024
const MIN_BARS = 30

/** FNV-1a 32 位哈希,输出 8 位十六进制小写 */
export function fnv1a32(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/** 调整快照总量上限(测试注入用;单位字节) */
export function configureSnapshotLimits(opts: { maxTotalBytes?: number }): void {
  if (opts.maxTotalBytes != null && opts.maxTotalBytes > 0) maxTotalBytes = opts.maxTotalBytes
}

function toSnapshot(r: SnapshotRecord): BarsSnapshot {
  const { refCount: _rc, sizeEstimate: _sz, ...snap } = r
  return snap
}

/** 清洗:丢弃 close<=0 的坏 bar,并断言时间严格递增(fetchBacktestBars
 *  已做去重+排序,这里防御上游回归) */
function cleanBars(raw: KlineBar[]): KlineBar[] {
  const ok = raw.filter(
    (b) => b && typeof b.time === "string" && b.time && Number.isFinite(Number(b.close)) && Number(b.close) > 0,
  )
  for (let i = 1; i < ok.length; i++) {
    if (!(ok[i - 1].time < ok[i].time)) {
      throw new Error(`K 线时间序列非严格递增(${ok[i - 1].time} → ${ok[i].time}),数据异常`)
    }
  }
  return ok
}

/** 超总量上限时按 fetchedAt LRU 淘汰 refCount<=0 的快照(活跃任务引用的跳过) */
async function pruneSnapshots(db: IDBDatabase): Promise<void> {
  const all = await idbGetAll<SnapshotRecord>(db, MINING_BARS_STORE)
  const sizeOf = (r: SnapshotRecord) => r.sizeEstimate ?? r.count * BYTES_PER_BAR
  let total = all.reduce((acc, r) => acc + sizeOf(r), 0)
  if (total <= maxTotalBytes) return
  const evictable = all
    .filter((r) => (r.refCount ?? 0) <= 0)
    .sort((a, b) => a.fetchedAt - b.fetchedAt)
  for (const r of evictable) {
    if (total <= maxTotalBytes) break
    await idbDelete(db, MINING_BARS_STORE, r.id)
    total -= sizeOf(r)
  }
}

/**
 * 从服务器拉取并冻结快照;已有同 id 快照直接复用(不重拉),refCount+1。
 * 区间跨度超过 factor-range-limits 上限、页数上限截断、数据不足均抛
 * 明确错误——绝不静默截断。
 */
export async function acquireBarsSnapshot(req: AcquireBarsRequest): Promise<BarsSnapshot> {
  const symbol = req.symbol.trim().toLowerCase()
  const timeframe = req.timeframe
  const maxDays = factorMaxDaysFor(timeframe)
  const start = req.startDate.slice(0, 10)
  const end = req.endDate.slice(0, 10)
  const spanDays = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000)
  if (!Number.isFinite(spanDays) || spanDays < 0) {
    throw new Error(`区间无效:${start} ~ ${end}`)
  }
  if (spanDays > maxDays) {
    throw new Error(
      `区间 ${start}~${end} 跨度 ${spanDays} 天,超过 ${timeframe} 允许的 ${maxDays} 天上限`,
    )
  }

  const channel = normalizeChannel(req.channel)
  const stopInfo = { truncated: false }
  const raw = await fetchBacktestBars(
    symbol,
    timeframe,
    start,
    end,
    req.maxPages ?? MAX_PAGES_DEFAULT,
    stopInfo,
    undefined,
    channel,
  )
  if (raw.length > maxResearchBars()) {
    throw new Error(
      `区间过大(${raw.length.toLocaleString()} 根 K 线):本机内存档位上限 ${maxResearchBars().toLocaleString()} 根,请缩小区间后重试`,
    )
  }
  if (stopInfo.truncated) {
    throw new Error(
      `K 线拉取达到 ${req.maxPages ?? MAX_PAGES_DEFAULT} 页上限仍未能覆盖 ${start},请缩小区间后重试`,
    )
  }
  const bars = cleanBars(raw)
  if (bars.length < MIN_BARS) {
    throw new Error(`该区间可用 K 线不足(仅 ${bars.length} 根,至少 ${MIN_BARS} 根)`)
  }

  const from = bars[0].time.slice(0, 10)
  const to = bars[bars.length - 1].time.slice(0, 10)
  // Include every frozen input: volume, OI, funding and provenance can change
  // independently of close. Never reuse an old snapshot after such corrections.
  const serialized = JSON.stringify(bars)
  const sourceHash = fnv1a32(serialized)
  const id = `${symbol}:${channel}:${timeframe}:${from}:${to}:${sourceHash}`

  const db = await openDb()
  if (!db) throw new Error("IndexedDB 不可用,无法冻结本地挖掘数据快照")

  const existing = await idbGet<SnapshotRecord | undefined>(db, MINING_BARS_STORE, id)
  if (existing) {
    // 同 id 快照直接复用:bars 冻结不变,刷新 fetchedAt(LRU 语义)并计数
    const updated: SnapshotRecord = { ...existing, refCount: (existing.refCount ?? 0) + 1, fetchedAt: Date.now() }
    await idbPut(db, MINING_BARS_STORE, updated)
    return toSnapshot(updated)
  }
  const fresh: SnapshotRecord = {
    id,
    symbol,
    channel,
    timeframe,
    from,
    to,
    bars,
    count: bars.length,
    fetchedAt: Date.now(),
    sourceHash,
    refCount: 1,
    sizeEstimate: new TextEncoder().encode(serialized).byteLength,
  }
  await idbPut(db, MINING_BARS_STORE, fresh)
  await pruneSnapshots(db)
  return toSnapshot(fresh)
}

/**
 * 短线实验室:给已冻结快照的 bars 附加确定性派生列(如 sl_of0..7)。
 * 快照 id/sourceHash 不变——它们标识基础 K 线;派生列由 aggTrades digest
 * 确定性生成(digest 相同 → 列逐位相同),续训可复现。
 */
export async function patchBarsSnapshotColumns(
  id: string,
  mutate: (bars: KlineBar[]) => Promise<void> | void,
): Promise<boolean> {
  const db = await openDb()
  if (!db) return false
  const rec = await idbGet<SnapshotRecord | undefined>(db, MINING_BARS_STORE, id)
  if (!rec) return false
  await mutate(rec.bars)
  rec.sizeEstimate = rec.bars.length * BYTES_PER_BAR
  await idbPut(db, MINING_BARS_STORE, rec)
  return true
}

export async function getBarsSnapshot(id: string): Promise<BarsSnapshot | null> {
  const db = await openDb()
  if (!db) return null
  const rec = await idbGet<SnapshotRecord | undefined>(db, MINING_BARS_STORE, id)
  return rec ? toSnapshot(rec) : null
}

/**
 * 任务删除时回收引用:refCount-1。归零不立即删除——作为热缓存保留,
 * 由 LRU 总量上限统一淘汰。
 */
export async function releaseBarsSnapshot(id: string): Promise<void> {
  const db = await openDb()
  if (!db) return
  const rec = await idbGet<SnapshotRecord | undefined>(db, MINING_BARS_STORE, id)
  if (!rec) return
  await idbPut(db, MINING_BARS_STORE, {
    ...rec,
    refCount: Math.max(0, (rec.refCount ?? 0) - 1),
  })
  await pruneSnapshots(db)
}

/**
 * 应用启动时按当前活跃任务清单校准引用计数:崩溃/强关会泄漏 refCount
 * (永远归不了零),LRU 因此失效。M3 的 local-runner 启动时以全部
 * pending/running/paused 任务的 snapshotId 调用本函数。
 */
export async function reconcileSnapshotRefs(activeIds: Iterable<string>): Promise<void> {
  const db = await openDb()
  if (!db) return
  const counts = new Map<string, number>()
  for (const id of activeIds) counts.set(id, (counts.get(id) ?? 0) + 1)
  const all = await idbGetAll<SnapshotRecord>(db, MINING_BARS_STORE)
  for (const rec of all) {
    const want = counts.get(rec.id) ?? 0
    if ((rec.refCount ?? 0) !== want) {
      await idbPut(db, MINING_BARS_STORE, { ...rec, refCount: want })
    }
  }
}

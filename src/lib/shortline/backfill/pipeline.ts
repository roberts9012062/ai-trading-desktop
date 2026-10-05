/**
 * aggTrades 回填管道 —— Binance Vision UM daily 归档 → 1 秒 digest（IDB 存储）。
 *
 * 断点续传：按日状态记录（done/failed/missing）；磁盘预算：默认 3GB 上限，
 * 下载前校验预计占用；raw zip 即下即弃（不落盘 zip）。
 * 每日 digest 记录 SHA256（冻结数据集协议：dataset SHA 进任务元数据）。
 */

import { unzipSync } from "fflate"
import { openDb, SHORTLINE_DIGEST_STORE } from "@/lib/idb"
import { BucketAccumulator, parseAggTradesCsv } from "../bucket-stream"
import { decodeDigest, digestSha256, encodeDigest, type TickBucket } from "../digest"

const VISION_BASE =
  import.meta.env.DEV && typeof window !== "undefined"
    ? "/__vision__"
    : "https://data.binance.vision"

export const SHORTLINE_BACKFILL_BUDGET_BYTES = 3 * 1024 * 1024 * 1024 // 3GB

export function aggTradesZipUrl(symbol: string, day: string): string {
  return `${VISION_BASE}/data/futures/um/daily/aggTrades/${symbol}/${symbol}-aggTrades-${day}.zip`
}

/**
 * 下载归档 zip：404 → null；每次尝试 180s 硬超时（国内到 data.binance.vision
 * 仅 100-250KB/s 且偶发连接挂起——无超时的 fetch 会无限等待,回填循环卡死）；
 * 超时/网络错重试,外部 signal(用户停止)立即中止不再重试。
 */
const FETCH_ATTEMPT_TIMEOUT_MS = 180_000

async function fetchZipBytes(
  url: string,
  retries = 4,
  externalSignal?: AbortSignal,
): Promise<Uint8Array | null> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (externalSignal?.aborted) throw new DOMException("已停止", "AbortError")
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_ATTEMPT_TIMEOUT_MS)
    const relay = () => controller.abort()
    externalSignal?.addEventListener("abort", relay, { once: true })
    try {
      const resp = await fetch(url, { signal: controller.signal })
      if (resp.status === 404) return null
      if (!resp.ok) throw new Error(`aggTrades 归档下载失败(${resp.status}: ${url.slice(-60)})`)
      return new Uint8Array(await resp.arrayBuffer())
    } catch (e) {
      if (externalSignal?.aborted) throw new DOMException("已停止", "AbortError")
      lastErr = e
    } finally {
      clearTimeout(timer)
      externalSignal?.removeEventListener("abort", relay)
    }
  }
  const tail = url.slice(-60)
  throw lastErr instanceof Error
    ? new Error(`${lastErr.message}（重试 ${retries} 次仍失败: ${tail}）`)
    : new Error(`aggTrades 归档下载失败（重试 ${retries} 次）: ${tail}`)
}

export interface DayDigestEntry {
  key: string
  symbol: string
  day: string
  sha256: string
  count: number
  firstTs: number
  lastTs: number
  bytes: ArrayBuffer
  savedAt: number
}

export interface DayBackfillResult {
  day: string
  status: "done" | "missing" | "empty" | "failed"
  sha256?: string
  count?: number
  bytes?: number
  error?: string
}

/** 下载+聚合单日 → digest 元数据（探测/展示用；不写库） */
export async function fetchDayDigest(symbol: string, day: string): Promise<DayBackfillResult> {
  const url = aggTradesZipUrl(symbol, day)
  const zip = await fetchZipBytes(url)
  if (!zip) return { day, status: "missing" }
  const result = dayZipToDigest(zip)
  return { day, ...result }
}

/** zip 字节 → 桶序列（纯函数，测试可注入） */
export function dayZipToDigest(zip: Uint8Array): { status: "done" | "empty" | "missing"; buckets?: TickBucket[]; sha256?: string; count?: number; bytes?: number } {
  const files = unzipSync(zip)
  const name = Object.keys(files).find((f) => f.endsWith(".csv"))
  if (!name) return { status: "missing" }
  const acc = new BucketAccumulator()
  const rows = parseAggTradesCsv(new TextDecoder().decode(files[name]!), (r) => acc.pushCsvRow(r))
  if (rows === 0 || acc.length === 0) return { status: "empty" }
  const buckets = [...acc.list()]
  return { status: "done", buckets, sha256: digestSha256(buckets), count: buckets.length, bytes: encodeDigest(buckets).byteLength }
}

// ── IDB 存取 ─────────────────────────────────────────────

function digestKey(symbol: string, day: string): string {
  return `${symbol}:${day}`
}

async function idbRun<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const req = fn(db.transaction(SHORTLINE_DIGEST_STORE, mode).objectStore(SHORTLINE_DIGEST_STORE))
      req.onsuccess = () => resolve(req.result as T)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

export async function saveDayDigest(symbol: string, day: string, buckets: readonly TickBucket[]): Promise<void> {
  const payload = encodeDigest(buckets)
  const entry: DayDigestEntry = {
    key: digestKey(symbol, day), symbol, day,
    sha256: digestSha256(buckets), count: buckets.length,
    firstTs: buckets[0]!.ts, lastTs: buckets[buckets.length - 1]!.ts,
    bytes: payload.buffer as ArrayBuffer, savedAt: Date.now(),
  }
  await idbRun("readwrite", (s) => s.put(entry))
}

export async function loadDayDigest(symbol: string, day: string): Promise<TickBucket[] | null> {
  const entry = await idbRun<DayDigestEntry>("readonly", (s) => s.get(digestKey(symbol, day)))
  if (!entry) return null
  return decodeDigest(new Uint8Array(entry.bytes))
}

export async function listDayDigests(symbol: string): Promise<DayDigestEntry[]> {
  const all = await idbRun<DayDigestEntry[]>("readonly", (s) => s.getAll())
  return (all ?? []).filter((e) => e.symbol === symbol).sort((a, b) => a.day.localeCompare(b.day))
}

/** Review needs metadata only. A cursor avoids retaining the entire 3GB archive. */
export async function listDayDigestMetadata(symbol: string): Promise<Array<Omit<DayDigestEntry, "bytes">>> {
  const db = await openDb()
  if (!db) return []
  return new Promise((resolve, reject) => {
    const entries: Array<Omit<DayDigestEntry, "bytes">> = []
    const req = db.transaction(SHORTLINE_DIGEST_STORE, "readonly").objectStore(SHORTLINE_DIGEST_STORE)
      .openCursor(IDBKeyRange.bound(`${symbol}:`, `${symbol}:\uffff`))
    req.onerror = () => reject(new Error("归档目录读取失败"))
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) { resolve(entries.sort((a, b) => a.day.localeCompare(b.day))); return }
      const entry = cursor.value as DayDigestEntry
      if (entry.symbol === symbol) {
        const { bytes: _bytes, ...metadata } = entry
        entries.push(metadata)
      }
      cursor.continue()
    }
  })
}

export async function deleteDayDigests(symbol: string, days: readonly string[]): Promise<void> {
  for (const day of days) {
    await idbRun("readwrite", (s) => s.delete(digestKey(symbol, day)))
  }
}

// ── 回填管线（断点续传 + 预算） ──────────────────────────

export interface BackfillProgress {
  day: string
  index: number
  total: number
  status: DayBackfillResult["status"]
  cumulativeBytes: number
}

export interface BackfillOptions {
  symbol: string
  /** 含首尾（YYYY-MM-DD，UTC） */
  fromDay: string
  toDay: string
  budgetBytes?: number
  /** 跳过已有 digest 的日子（断点续传默认 true） */
  skipExisting?: boolean
  /** 用户停止：每日循环开始与下载中检查，中止后 summary 注明 */
  signal?: AbortSignal
  onProgress?: (p: BackfillProgress) => void
}

export function listDays(fromDay: string, toDay: string): string[] {
  const out: string[] = []
  const start = Date.parse(`${fromDay}T00:00:00Z`)
  const end = Date.parse(`${toDay}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return out
  for (let t = start; t <= end; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10))
  }
  return out
}

export interface BackfillSummary {
  done: number
  missing: number
  empty: number
  failed: number
  skipped: number
  totalBytes: number
  errors: Array<{ day: string; error: string }>
}

/** 完整回填（下载 → 聚合 → 入库；断点续传 + 预算）。依赖可注入（测试）。 */
export interface BackfillDeps {
  fetchZip?: (url: string, signal?: AbortSignal) => Promise<Uint8Array | null>
  listSavedDays?: (symbol: string) => Promise<string[]>
  saveDay?: (symbol: string, day: string, buckets: readonly TickBucket[]) => Promise<void>
}

export async function runBackfillWithStore(opts: BackfillOptions, deps: BackfillDeps = {}): Promise<BackfillSummary> {
  const fetchZip = deps.fetchZip ?? ((url: string, signal?: AbortSignal) => fetchZipBytes(url, 4, signal))
  const listSavedDays = deps.listSavedDays ?? (async (symbol) => (await listDayDigests(symbol)).map((e) => e.day))
  const saveDay = deps.saveDay ?? saveDayDigest
  const budget = opts.budgetBytes ?? SHORTLINE_BACKFILL_BUDGET_BYTES
  const days = listDays(opts.fromDay, opts.toDay)
  const summary: BackfillSummary = { done: 0, missing: 0, empty: 0, failed: 0, skipped: 0, totalBytes: 0, errors: [] }
  const existing = new Set(await listSavedDays(opts.symbol))
  let cumulative = 0
  let stopped = false
  for (let i = 0; i < days.length; i++) {
    if (opts.signal?.aborted) {
      stopped = true
      summary.errors.push({ day: days[i]!, error: `已手动停止（完成 ${i}/${days.length} 天，未下载的天数下次回填自动补齐）` })
      break
    }
    const day = days[i]!
    const report = (status: DayBackfillResult["status"]) =>
      opts.onProgress?.({ day, index: i, total: days.length, status, cumulativeBytes: cumulative })
    if (opts.skipExisting !== false && existing.has(day)) {
      summary.skipped++
      report("done")
      continue
    }
    try {
      const zip = await fetchZip(aggTradesZipUrl(opts.symbol, day), opts.signal)
      if (!zip) {
        summary.missing++
        report("missing")
        continue
      }
      const result = dayZipToDigest(zip)
      if (result.status !== "done" || !result.buckets) {
        summary[result.status === "empty" ? "empty" : "missing"]++
        report(result.status)
        continue
      }
      const buckets = result.buckets
      const bytes = result.bytes ?? encodeDigest(buckets).byteLength
      if (cumulative + bytes > budget) {
        summary.errors.push({ day, error: `磁盘预算不足(已用 ${(cumulative / 1e9).toFixed(2)}GB / 上限 ${(budget / 1e9).toFixed(1)}GB)，已停止` })
        report("failed")
        break
      }
      await saveDay(opts.symbol, day, buckets)
      cumulative += bytes
      summary.done++
      summary.totalBytes = cumulative
      report("done")
    } catch (e) {
      if (opts.signal?.aborted) {
        stopped = true
        summary.errors.push({ day, error: `已手动停止（完成 ${i}/${days.length} 天，未下载的天数下次回填自动补齐）` })
        break
      }
      summary.failed++
      summary.errors.push({ day, error: e instanceof Error ? e.message : String(e) })
      report("failed")
    }
  }
  if (stopped) summary.failed = Math.max(0, summary.failed)
  return summary
}

/**
 * 增量回填区间计算——"下次只下载最新的数据拼接"：
 * 给定建议区间与已缓存日集合，返回实际还需下载的区间与缓存统计。
 * 已缓存日自动跳过（runBackfillWithStore 的 skipExisting），此处供表单
 * 预填与覆盖展示。
 */
export function missingRange(
  fromDay: string,
  toDay: string,
  existingDays: readonly string[],
): { from: string, to: string, cachedCount: number, firstGap: string | null } {
  const have = new Set(existingDays)
  const days = listDays(fromDay, toDay)
  const missing = days.filter((d) => !have.has(d))
  return {
    from: missing[0] ?? toDay,
    to: missing.length ? missing[missing.length - 1]! : toDay,
    cachedCount: have.size ? days.filter((d) => have.has(d)).length : 0,
    firstGap: missing[0] ?? null,
  }
}

/** 汇总占用（UI 展示与清理入口用） */
export async function digestUsage(symbol?: string): Promise<{ days: number, bytes: number }> {
  const all = await idbRun<DayDigestEntry[]>("readonly", (s) => s.getAll())
  const rows = symbol ? (all ?? []).filter((e) => e.symbol === symbol) : (all ?? [])
  return { days: rows.length, bytes: rows.reduce((s, e) => s + (e.bytes?.byteLength ?? 0), 0) }
}

/** 载入日期范围内的桶序列（重放器输入；跨日拼接并校验连续性） */
export async function loadDigestRange(symbol: string, fromDay: string, toDay: string): Promise<{ buckets: TickBucket[], sha: string } | null> {
  const days = listDays(fromDay, toDay)
  const entries = await listDayDigests(symbol)
  const byDay = new Map(entries.map((e) => [e.day, e]))
  const out: TickBucket[] = []
  let ok = true
  for (const day of days) {
    const entry = byDay.get(day)
    if (!entry) { ok = false; continue }
    const buckets = decodeDigest(new Uint8Array(entry.bytes))
    for (const b of buckets) {
      if (out.length && b.ts <= out[out.length - 1]!.ts) { ok = false; continue }
      out.push(b)
    }
  }
  if (!ok) return null
  return { buckets: out, sha: digestSha256(out) }
}

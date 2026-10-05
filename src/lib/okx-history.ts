/** OKX official ZIP archives. Desktop fetch is native HTTP (desktop-boot).
 * The CloudFront host is static.okx.com's verified DNS CNAME, not a relay.
 * Only historical research uses this module; live execution is unchanged.
 */
import { unzipSync } from "fflate"
import type { KlineBar } from "@/types"
import { barTimeToMs, msToBarTime } from "./binance-kline"
import { cryptoPair } from "./crypto-direct"
import { openDb, idbGet, idbPut, idbDelete, OKX_ARCHIVE_STORE } from "./idb"
import { sha256Hex, type TickBucket } from "./shortline/digest"
import { BucketAccumulator } from "./shortline/bucket-stream"

export type OkxArchiveKind = "candles" | "trades" | "funding"
export type ShortlineHistorySource = "okx" | "binance_usdt"
export interface OkxFundingEvent { t: number; r: number }
type MinuteBar = KlineBar & { contract_volume?: number }
const CDN = "https://dfccd2aelcoyz.cloudfront.net"
const OFFICIAL = "https://static.okx.com"
const DAY = 86400000
const BJ = 8 * 3600000
export const OKX_CANDLE_FLOOR = Date.UTC(2023, 6, 1)-BJ
const CACHE_BUDGET = 256 * 1024 * 1024
interface ArchiveEntry { key: string; bytes: Uint8Array; sha256: string; savedAt: number; byteLength: number }

export function okxInstrument(symbol: string): string { return `${cryptoPair(symbol).replace("_", "-")}-SWAP` }
/** OKX archive file names are Beijing days/months; CSV timestamps are epoch ms. */
export function okxArchiveDayStart(day: string): number { return Date.parse(`${day}T00:00:00Z`)-BJ }
export function okxArchiveDate(t: number): string { return new Date(t+BJ).toISOString().slice(0,10) }
export function latestOkxArchiveDay(now = Date.now()): string { return okxArchiveDate(now - 2 * DAY) }

export function okxArchiveUrl(kind: OkxArchiveKind, symbol: string, key: string, origin = CDN): string {
  if (!/^\d{4}-\d{2}(-\d{2})?$/.test(key)) throw new Error("OKX 归档日期非法")
  const date = new Date(`${key.length === 7 ? key + "-01" : key}T00:00:00Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,key.length) !== key) throw new Error("OKX 归档日期非法")
  if (kind === "funding" && key.length !== 7) throw new Error("OKX 资金费率仅支持月归档")
  const folder = kind === "candles" ? "candlesticks" : kind === "funding" ? "swaprates" : "trades"
  const name = kind === "candles" ? "candlesticks" : kind === "funding" ? "fundingrates" : "trades"
  const base = import.meta.env.DEV && typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)
    ? (origin === CDN ? "/__okx_archive__" : "/__okx_static__") : origin
  return `${base}/cdn/okex/traderecords/${folder}/${key.length === 7 ? "monthly" : "daily"}/${key.replaceAll("-", "")}/${okxInstrument(symbol)}-${name}-${key}.zip`
}

/** Large CSVs are iterated without allocating an array of millions of lines. */
function eachCsv(text: string, expected: string[], row: (cols: string[]) => void): void {
  let offset = 0, header = false
  while (offset < text.length) {
    const end = text.indexOf("\n", offset)
    const line = text.slice(offset, end < 0 ? text.length : end).trim().replace(/^\uFEFF/, "")
    offset = end < 0 ? text.length : end + 1
    if (!line) continue
    const cols = line.split(",")
    if (!header) {
      if (expected.some((key, i) => cols[i] !== key)) throw new Error("OKX 归档 CSV 表头不匹配")
      header = true; continue
    }
    if (cols.length < expected.length) throw new Error("OKX 归档 CSV 行不完整")
    row(cols)
  }
  if (!header) throw new Error("OKX 归档 CSV 为空")
}
const numeric = (s: string | undefined): number => {
  const n = s?.trim() ? Number(s) : NaN
  if (!Number.isFinite(n)) throw new Error("OKX 归档包含无效数值")
  return n
}
const optionalArchiveNumber = (s: string | undefined): number | null =>
  s != null && ["", "none", "null"].includes(s.trim().toLowerCase()) ? null : numeric(s)
class MissingContractVolume extends Error {
  constructor(readonly time: number) { super("OKX 旧归档缺基础币成交量，需要校验同期合约面值") }
}
class ArchiveContentsError extends Error {}
// Earliest legacy packages omit vol_ccy. Validate units against an official
// contemporaneous complete archive, rather than hardcoding BTC/ETH multipliers.
const LEGACY_UNIT_DAY = "2023-08-25"
const legacyUnits = new Map<string, number>()

export function parseOkxCandles(text: string, symbol: string, contractValue?: number): MinuteBar[] {
  const instrument = okxInstrument(symbol), bars: MinuteBar[] = []
  const byTime = new Map<number, MinuteBar>()
  let unit = contractValue
  if (unit != null && (!Number.isFinite(unit) || unit <= 0)) throw new Error("OKX 合约面值非法")
  eachCsv(text, ["instrument_name","open","high","low","close","vol","vol_ccy","vol_quote","open_time","confirm"], (c) => {
    if (c[0] !== instrument) throw new Error("OKX K线归档品种不匹配")
    const [o,h,l,cl,contracts] = c.slice(1,6).map(numeric), t = numeric(c[8])
    const base = optionalArchiveNumber(c[6]), quote = optionalArchiveNumber(c[7])
    if (!["0","1"].includes(c[9]!) || !Number.isSafeInteger(t) || t % 60000 || Math.min(o,h,l,cl) <= 0 || h < Math.max(o,l,cl) || l > Math.min(o,h,cl)
      || contracts < 0 || (base != null && base < 0) || (quote != null && quote < 0)) throw new Error("OKX K线归档 OHLC/时间/数量非法")
    // Historical official files also tag fully elapsed candles with confirm=0.
    // Completion follows elapsed minute time in this archive-only reader.
    if (t+60000 > Date.now()) return
    if (base != null && contracts > 0) {
      const ratio = base/contracts
      if (!(ratio > 0) || (unit != null && Math.abs(ratio/unit-1) > 1e-7)) throw new Error("OKX 合约数量换算不一致")
      unit = ratio
    }
    const bar: MinuteBar = {time:msToBarTime(t,false), open:o,high:h,low:l,close:cl,volume:base ?? (contracts === 0 ? 0 : NaN),quote_volume:quote,
      contract_volume:contracts,open_time:t,market_source:"okx",settle:null,open_interest:null,is_closed:true}
    const prior = byTime.get(t)
    if (prior) {
      if (["open","high","low","close","contract_volume","quote_volume"].some(k => prior[k as keyof MinuteBar] !== bar[k as keyof MinuteBar])
        || !(prior.volume === bar.volume || (Number.isNaN(prior.volume) && Number.isNaN(bar.volume)))) throw new Error("OKX K线归档同一时间存在冲突数据")
      return // Official monthly packages may repeat identical blocks.
    }
    if (bars.length && t < bars.at(-1)!.open_time!) throw new Error("OKX K线归档时间回退")
    byTime.set(t,bar); bars.push(bar)
  })
  for (const bar of bars) if (!Number.isFinite(bar.volume)) {
    const value = unit ?? (bar.open_time! < okxArchiveDayStart(LEGACY_UNIT_DAY) ? legacyUnits.get(instrument) : undefined)
    if (value == null) throw new MissingContractVolume(bar.open_time!)
    bar.volume = bar.contract_volume! * value
    if (!Number.isFinite(bar.volume)) throw new Error("OKX 合约成交量换算溢出")
  }
  return bars
}

export function contractValueFromCandles(bars: readonly MinuteBar[]): number {
  let value = NaN
  for (const b of bars) {
    if (!b.contract_volume || b.volume <= 0) continue
    const v = b.volume / b.contract_volume
    if (!Number.isFinite(value)) value = v
    else if (Math.abs(v/value-1) > 1e-7) throw new Error("OKX 合约数量换算不一致，停止订单流回填")
  }
  if (!Number.isFinite(value) || value <= 0) throw new Error("OKX 缺少可校验的合约面值")
  return value
}

export function parseOkxTrades(text: string, symbol: string, day: string, contractValue: number): TickBucket[] {
  if (!(contractValue > 0) || !Number.isFinite(contractValue)) throw new Error("OKX 合约面值非法")
  const instrument = okxInstrument(symbol), start = okxArchiveDayStart(day)
  const acc = new BucketAccumulator()
  let last = -1, lastId = -1n
  eachCsv(text, ["instrument_name","trade_id","side","price","size","created_time"], (c) => {
    if (c[0] !== instrument || !/^[0-9]+$/.test(c[1]!) || !["buy","sell"].includes(c[2]!)) throw new Error("OKX 成交品种/方向/编号非法")
    const id = BigInt(c[1]!), p = numeric(c[3]), q = numeric(c[4]), t = numeric(c[5])
    if (p <= 0 || q <= 0 || !Number.isSafeInteger(t) || t < start || t >= start+DAY) throw new Error("OKX 成交数值或归档日期不匹配")
    if (t < last || id <= lastId) throw new Error("OKX 成交重复或时间/编号回退")
    acc.pushCsvRow({price:p,qty:q*contractValue,transactTimeMs:t,isBuyerMaker:c[2] === "sell"})
    last = t; lastId = id
  })
  return [...acc.list()]
}

export function parseOkxFunding(text: string, symbol: string): OkxFundingEvent[] {
  const instrument = okxInstrument(symbol), events: OkxFundingEvent[] = []
  eachCsv(text, ["instrument_name","funding_rate","funding_time"], (c) => {
    if (c[0] !== instrument) throw new Error("OKX 资金费率品种不匹配")
    const r = numeric(c[1]), t = numeric(c[2])
    if (!Number.isSafeInteger(t) || t <= 0 || Math.abs(r) > 1 || (events.length && t <= events.at(-1)!.t)) throw new Error("OKX 资金费率时间/数值非法")
    events.push({t,r})
  })
  return events
}

export function archiveCsv(zip: Uint8Array): string {
  const files = unzipSync(zip), names = Object.keys(files).filter((n) => n.endsWith(".csv"))
  if (names.length !== 1) throw new Error("OKX ZIP 必须包含一个 CSV")
  return new TextDecoder("utf-8", {fatal:true}).decode(files[names[0]!]!)
}

function archiveKey(kind: OkxArchiveKind, symbol: string, key: string): string { return `okx-v1:${kind}:${okxInstrument(symbol)}:${key}` }
async function validateArchive(kind: OkxArchiveKind, symbol: string, key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
  if (kind === "candles") {
    const csv = archiveCsv(bytes)
    let bars: MinuteBar[]
    try { bars = parseOkxCandles(csv,symbol) }
    catch (e) {
      if (!(e instanceof MissingContractVolume)) throw e
      if (e.time >= okxArchiveDayStart(LEGACY_UNIT_DAY) || key === LEGACY_UNIT_DAY) throw e
      const reference = await fetchOkxArchive("candles",symbol,LEGACY_UNIT_DAY,signal)
      if (!reference) throw new Error("OKX 同期合约面值校验文件未发布，无法换算旧归档成交量")
      const value = contractValueFromCandles(parseOkxCandles(archiveCsv(reference),symbol))
      legacyUnits.set(okxInstrument(symbol),value)
      bars = parseOkxCandles(csv,symbol,value)
    }
    if (!bars.length || bars.some(b => !okxArchiveDate(b.open_time!).startsWith(key))) throw new Error("OKX K线文件日期与请求不匹配或文件为空")
  }
  if (kind === "funding") {
    const events = parseOkxFunding(archiveCsv(bytes),symbol)
    if (!events.length || events.some(e => !okxArchiveDate(e.t).startsWith(key))) throw new Error("OKX 资金费文件日期与请求不匹配或文件为空")
  }
}
async function cachedArchive(kind: OkxArchiveKind, symbol: string, key: string): Promise<Uint8Array | null> {
  const db = await openDb()
  if (!db) return null
  const entry = await idbGet<ArchiveEntry>(db,OKX_ARCHIVE_STORE,archiveKey(kind,symbol,key))
  if (!entry) return null
  const bytes = new Uint8Array(entry.bytes)
  if (sha256Hex(bytes) !== entry.sha256) {
    await idbDelete(db,OKX_ARCHIVE_STORE,entry.key)
    return null // Corrupt cache is downloaded afresh; never used in a snapshot.
  }
  return bytes
}
async function saveArchive(kind: OkxArchiveKind, symbol: string, key: string, bytes: Uint8Array): Promise<void> {
  const db = await openDb()
  if (!db || kind === "trades") return // Trades are persisted as compact daily digests, not raw ZIPs.
  const entries = await new Promise<Array<{key:string,byteLength:number,savedAt:number}>>((resolve,reject) => {
    const out: Array<{key:string,byteLength:number,savedAt:number}> = []
    const req = db.transaction(OKX_ARCHIVE_STORE).objectStore(OKX_ARCHIVE_STORE).openCursor()
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const c = req.result
      if (!c) { resolve(out); return }
      const v = c.value as ArchiveEntry; out.push({key:v.key,byteLength:v.byteLength,savedAt:v.savedAt}); c.continue()
    }
  })
  let usage = entries.reduce((a,b) => a+b.byteLength,0)
  for (const e of entries.sort((a,b) => a.savedAt-b.savedAt)) {
    if (usage+bytes.byteLength <= CACHE_BUDGET) break
    await idbDelete(db,OKX_ARCHIVE_STORE,e.key); usage -= e.byteLength
  }
  await idbPut(db,OKX_ARCHIVE_STORE,{key:archiveKey(kind,symbol,key),bytes,sha256:sha256Hex(bytes),savedAt:Date.now(),byteLength:bytes.byteLength})
}

/** All network requests go to official public files, without credentials. No API_BASE fallback. */
export async function fetchOkxArchive(kind: OkxArchiveKind, symbol: string, key: string, signal?: AbortSignal): Promise<Uint8Array | null> {
  if (signal?.aborted) throw new DOMException("已停止", "AbortError")
  // Validate before cache/network lookup.
  okxArchiveUrl(kind,symbol,key)
  const saved = await cachedArchive(kind,symbol,key)
  if (saved) { await validateArchive(kind,symbol,key,saved,signal); return saved }
  let error: unknown
  for (const origin of [CDN,OFFICIAL]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw new DOMException("已停止", "AbortError")
      const controller = new AbortController(), relay = () => controller.abort()
      signal?.addEventListener("abort",relay,{once:true})
      const timer = setTimeout(relay,180000)
      try {
        const response = await fetch(okxArchiveUrl(kind,symbol,key,origin),{signal:controller.signal,credentials:"omit"})
        if (response.status === 404) return null
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (signal?.aborted) throw new DOMException("已停止", "AbortError")
        // Validate contents before persisting (trades are parsed in a Worker).
        try { await validateArchive(kind,symbol,key,bytes,signal) }
        catch (e) {
          if (signal?.aborted) throw new DOMException("已停止", "AbortError")
          throw new ArchiveContentsError(e instanceof Error ? e.message : String(e))
        }
        await saveArchive(kind,symbol,key,bytes)
        return bytes
      } catch (e) {
        if (signal?.aborted) throw new DOMException("已停止", "AbortError")
        // A validated HTTP response with invalid contents is a data error,
        // not a connection problem; don't download the same ZIP four times.
        if (e instanceof ArchiveContentsError) {
          throw new Error(`OKX 官方历史文件校验失败（${key}）：${e.message}；不会转发服务器`)
        }
        error = e
      } finally { clearTimeout(timer); signal?.removeEventListener("abort",relay) }
    }
  }
  throw new Error(`OKX 官方历史文件直连失败（${key}）：${error instanceof Error ? error.message : String(error)}；请检查本机网络，不会转发服务器`)
}

function periodWindow(t: number, period: string): [number,number] {
  if (period === "1M") { const d = new Date(t+BJ); return [Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1)-BJ,Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)-BJ] }
  if (period === "1w") { const anchor=Date.UTC(1970,0,5)-BJ; const start = Math.floor((t-anchor)/(7*DAY))*7*DAY+anchor; return [start,start+7*DAY] }
  const m = /^(\d+)(m|h|d)$/.exec(period)
  if (!m) throw new Error(`OKX 归档不支持周期 ${period}`)
  const span = Number(m[1]) * ({m:60000,h:3600000,d:DAY}[m[2] as "m"|"h"|"d"])
  if (span < 60000 || span % 60000) throw new Error("OKX 归档周期非法")
  const start = Math.floor((t+BJ)/span)*span-BJ; return [start,start+span]
}
/** Every constituent minute must exist and be closed. Never invent flat/future bars. */
export function resampleOkxBars(minutes: readonly MinuteBar[], period: string): KlineBar[] {
  const out: KlineBar[] = []
  let group: MinuteBar[] = [], start = -1, end = -1
  const flush = () => {
    if (!group.length || group.length !== (end-start)/60000 || group.some((b,i) => b.open_time !== start+i*60000)) return
    out.push({time:msToBarTime(start,["1d","3d","1w","1M"].includes(period)),open:group[0]!.open,
      high:Math.max(...group.map((b) => b.high)),low:Math.min(...group.map((b) => b.low)),close:group.at(-1)!.close,
      volume:group.reduce((s,b) => s+b.volume,0),quote_volume:group.some(b => b.quote_volume == null) ? null : group.reduce((s,b) => s+b.quote_volume!,0),
      open_time:start,market_source:"okx",settle:null,open_interest:null})
  }
  for (const b of minutes) {
    const [s,e] = periodWindow(b.open_time!,period)
    if (s !== start) { flush(); group=[]; start=s; end=e }
    group.push(b)
  }
  flush(); return out
}

export async function fetchOkxFundingHistory(symbol: string, from: number, to: number, progress?: (msg:string) => void, signal?: AbortSignal): Promise<OkxFundingEvent[]> {
  const d = new Date(from-DAY+BJ); d.setUTCDate(1); d.setUTCHours(0,0,0,0)
  const events: OkxFundingEvent[] = []
  while (d.getTime()-BJ <= to) {
    const month = d.toISOString().slice(0,7); progress?.(`本机拉取 OKX 资金费率月包 ${month}…`)
    const zip = await fetchOkxArchive("funding",symbol,month,signal)
    if (zip) events.push(...parseOkxFunding(archiveCsv(zip),symbol))
    else progress?.(`OKX ${month} 资金费率未发布/不可用，标记缺失`)
    d.setUTCMonth(d.getUTCMonth()+1)
  }
  return events.filter((e) => e.t >= from-DAY && e.t <= to).sort((a,b) => a.t-b.t)
}

export async function readCachedOkxFunding(symbol: string, from: number, to: number): Promise<OkxFundingEvent[]> {
  const events: OkxFundingEvent[] = [], d = new Date(from-DAY+BJ); d.setUTCDate(1); d.setUTCHours(0,0,0,0)
  while (d.getTime()-BJ <= to) {
    const zip = await cachedArchive("funding",symbol,d.toISOString().slice(0,7))
    if (zip) events.push(...parseOkxFunding(archiveCsv(zip),symbol))
    d.setUTCMonth(d.getUTCMonth()+1)
  }
  return events.filter((e) => e.t >= from-DAY && e.t <= to).sort((a,b) => a.t-b.t)
}

export function joinOkxFunding(bars: KlineBar[], events: OkxFundingEvent[]): KlineBar[] {
  let i = -1
  return bars.map((b) => {
    const t = b.open_time!
    while (i+1 < events.length && events[i+1]!.t <= t) i++
    const ev = i >= 0 && t-events[i]!.t <= DAY ? events[i] : undefined
    return {...b,funding_rate:ev?.r??null, ...(ev ? {funding_time:ev.t} : {})}
  })
}

export async function fetchOkxHistoryRange(symbol: string, period: string, from: number, to: number, progress?: (msg:string) => void): Promise<KlineBar[]> {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new Error("OKX 历史区间非法")
  const max = Math.min(to,okxArchiveDayStart(latestOkxArchiveDay())+DAY-1)
  const start = Math.max(OKX_CANDLE_FLOOR,periodWindow(from,period)[0])
  if (max < start) return []
  let cursor = okxArchiveDayStart(okxArchiveDate(start))
  let carry: MinuteBar[] = []
  const result: KlineBar[] = []
  const append = (part: MinuteBar[]) => {
    const byTime = new Map([...carry,...part].map((b) => [b.open_time!,b]))
    const all = [...byTime.values()].sort((a,b) => a.open_time!-b.open_time!)
    // Retain only the final unfinished bucket across day/month package boundaries.
    const last = all.at(-1)
    if (!last) return
    const [lastStart,lastEnd] = periodWindow(last.open_time!,period)
    const complete = last.open_time!+60000 === lastEnd
    const cut = complete ? all.length : all.findIndex((b) => b.open_time! >= lastStart)
    result.push(...resampleOkxBars(all.slice(0,cut),period))
    carry = all.slice(cut)
  }
  while (cursor <= max) {
    const d = new Date(cursor+BJ), month = d.toISOString().slice(0,7)
    const monthEnd = Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)-BJ
    const now = new Date(Date.now()+BJ)
    const useMonth = monthEnd <= Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)-BJ
    let zip: Uint8Array | null = null
    if (useMonth) { progress?.(`本机下载 OKX K线月包 ${month}…`); zip = await fetchOkxArchive("candles",symbol,month) }
    if (zip) {
      append(parseOkxCandles(archiveCsv(zip),symbol)); cursor=monthEnd
    } else {
      const day = d.toISOString().slice(0,10); progress?.(`本机下载 OKX K线日包 ${day}…`)
      zip = await fetchOkxArchive("candles",symbol,day)
      if (!zip) throw new Error(`OKX ${day} K线归档未发布或该合约无数据，请调整研究区间；不会转发服务器`)
      append(parseOkxCandles(archiveCsv(zip),symbol)); cursor += DAY
    }
  }
  const bars = result
    .filter((b) => b.open_time! >= from && periodWindow(b.open_time!,period)[1]-1 <= to)
  if (!bars.length) return []
  const funding = await fetchOkxFundingHistory(symbol,bars[0]!.open_time!,bars.at(-1)!.open_time!,progress)
  return joinOkxFunding(bars,funding)
}

export async function getOkxArchiveKlineApi(symbol: string, period: string, options?: {limit?:number;endTime?:string}): Promise<{bars:KlineBar[];has_more:boolean}> {
  const end = options?.endTime ? barTimeToMs(options.endTime)-1 : okxArchiveDayStart(latestOkxArchiveDay())+DAY-1
  const d = new Date(end+BJ), start = Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1)-BJ
  const bars = await fetchOkxHistoryRange(symbol,period,start,end)
  return {bars,has_more:bars.length>0 && start>OKX_CANDLE_FLOOR}
}

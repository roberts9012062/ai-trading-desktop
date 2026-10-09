/** Local OKX account analytics. Native code alone owns credentials and signing. */
import { invoke, isTauri } from "@tauri-apps/api/core"
import { ensureDesktopRouting, isServerMode, onDesktopRoutingChange } from "./desktop-routing"
import type { DailyPnlRow, DailyPnlSummary } from "./live-api"

export type DailyPnlSource = "desktop-snippet" | "server-mode" | "server-fallback"
export interface DailyPnlResult { days: DailyPnlRow[]; summary: DailyPnlSummary | null; source?: DailyPnlSource }
type Raw = Record<string, unknown>
type Read = (path: string) => Promise<{ rows: Raw[]; demo: boolean; account_id?: string }>
type Entry = { ts: number; pnl: number; fee: number; funding: number; trade: boolean }
export interface DailyPnlHistory { since: number; through: number; bills: Map<string, Raw>; billBased: boolean; accountId?: string }
export const createDailyPnlHistory = (): DailyPnlHistory => ({ since: 0, through: 0, bills: new Map(), billBased: false })
const DAY = 86_400_000
const TTL = 60_000
let generation = 0
let cache: { identity: string; until: number; data: DailyPnlResult } | null = null
let snapshot: { identity: string; history: DailyPnlHistory } | null = null
const flights = new Map<string, Promise<DailyPnlResult>>()
const progressListeners = new Set<(records: number | null) => void>()
export function onDailyPnlProgress(listener: (records: number | null) => void): () => void {
  progressListeners.add(listener); return () => { progressListeners.delete(listener) }
}
const reportProgress = (records: number | null) => progressListeners.forEach(listener => listener(records))
const number = (v: unknown): number => { const n = Number(v ?? 0); if (!Number.isFinite(n)) throw new Error("收益记录包含无效数字"); return n }
const round = (n: number) => Number(n.toFixed(4))

export class IncompletePnlHistory extends Error {}
class PnlAccountChanged extends Error {}

export function resetDesktopDailyPnl(): void {
  generation++; cache = null; snapshot = null; flights.clear()
  reportProgress(null)
  if (isTauri()) void invoke("okx_analytics_clear").catch(() => {})
}
onDesktopRoutingChange(() => resetDesktopDailyPnl())

export function aggregateDailyPnl(entries: Entry[]): DailyPnlResult {
  const grouped = new Map<string, { pnl: number; fee: number; feeCost: number; funding: number; trades: number; win: number; loss: number }>()
  for (const entry of entries) {
    if (!(entry.ts > 0)) continue
    const date = new Date(entry.ts + 8 * 3_600_000).toISOString().slice(0, 10)
    const row = grouped.get(date) ?? { pnl: 0, fee: 0, feeCost: 0, funding: 0, trades: 0, win: 0, loss: 0 }
    row.pnl += entry.pnl; row.fee += Math.abs(entry.fee); row.feeCost -= entry.fee; row.funding += entry.funding
    row.trades += Number(entry.trade); row.win += Math.max(0, entry.pnl); row.loss += Math.min(0, entry.pnl)
    grouped.set(date, row)
  }
  const keys = [...grouped.keys()].sort()
  if (!keys.length) return { days: [], summary: null }
  const days: DailyPnlRow[] = []
  let cumulative = 0, profit = 0, loss = 0
  for (let ts = Date.parse(keys[0]); ts <= Date.parse(keys.at(-1)!); ts += DAY) {
    const date = new Date(ts).toISOString().slice(0, 10)
    const r = grouped.get(date)
    const pnl = round(r?.pnl ?? 0)
    cumulative = round(cumulative + pnl); profit += Math.max(0, pnl); loss += Math.min(0, pnl)
    days.push({ date, pnl, net: pnl, fee: round(r?.fee ?? 0), fee_cost: round(r?.feeCost ?? 0), funding: round(r?.funding ?? 0),
      net_after_costs: round((r?.pnl ?? 0) - (r?.feeCost ?? 0) + (r?.funding ?? 0)),
      win_pnl: round(r?.win ?? 0), loss_pnl: round(r?.loss ?? 0), cumulative, trades: r?.trades ?? 0 })
  }
  return { days, summary: { total_profit: round(profit), total_loss: round(loss), profit_ratio: loss < 0 ? round(profit / Math.abs(loss)) : null,
    net: round(profit + loss), trade_days: days.filter(r => r.trades > 0).length, total_trades: days.reduce((s, r) => s + r.trades, 0) } }
}

/** Read full pages or throw. Never silently publish truncated account earnings. */
export async function queryDailyPnl(read: Read, days: number, now = Date.now(), pause = () => new Promise<void>(r => setTimeout(r, 250)), history?: DailyPnlHistory, progress?: (records: number) => void): Promise<DailyPnlResult> {
  const start = now - days * DAY
  const recentStart = Math.max(start, now - 7 * DAY)
  const reusable = !!history?.billBased && history.since <= start && history.through >= recentStart
  const deadline = Date.now() + 300_000
  let requests = 0
  let accountId = reusable ? history?.accountId : undefined
  const checkedRead: Read = async path => {
    if (++requests > 500 || Date.now() > deadline) throw new IncompletePnlHistory("收益记录较多，本次未能完整读取，请稍后重试")
    const result = await read(path)
    if (result.account_id && accountId && result.account_id !== accountId) throw new PnlAccountChanged("OKX 凭证已变化，正在重新同步")
    if (result.account_id) accountId = result.account_id
    if (!Array.isArray(result.rows) || result.rows.some(r => !r || typeof r !== "object" || Array.isArray(r))) throw new Error("收益记录格式错误")
    return result
  }
  const bills = new Map<string, Raw>(reusable ? history!.bills : [])
  const loadBills = async (route: string, begin: number, end: number) => {
    let after = ""
    const cursors = new Set<string>()
    for (;;) {
      const query = new URLSearchParams({ instType: "SWAP", limit: "100", begin: String(begin), end: String(end) })
      if (after) query.set("after", after)
      const { rows } = await checkedRead(`${route}?${query}`)
      for (const r of rows) {
        const id = String(r.billId ?? "")
        if (!id) throw new IncompletePnlHistory("账单缺少唯一编号，无法确认收益完整性")
        bills.set(id, r)
      }
      progress?.(bills.size)
      if (rows.length < 100) return
      const next = String(rows.at(-1)?.billId ?? "")
      if (cursors.has(next)) throw new IncompletePnlHistory("账单分页未推进，请稍后重试")
      cursors.add(next); after = next
      await pause()
    }
  }
  const recent = loadBills("/api/v5/account/bills", reusable ? Math.max(recentStart, history!.through - 3_600_000) : recentStart, now)
  // Both live and demo archives can contain records. Query them for the
  // complete window; only genuinely empty trade bills use fills below.
  const archive = days > 7 && !reusable ? loadBills("/api/v5/account/bills-archive", start, recentStart) : Promise.resolve()
  // Independent routes page sequentially, with at most two active reads.
  const completed = await Promise.allSettled([recent, archive])
  const failure = completed.find(result => result.status === "rejected")
  if (failure?.status === "rejected") throw failure.reason
  const entries: Entry[] = []
  for (const b of bills.values()) {
    const ts = number(b.ts)
    if (ts < start || ts > now || String(b.ccy) !== "USDT") continue
    const funding = ["173", "174"].includes(String(b.subType))
    const trade = ["2", "5", "9"].includes(String(b.type))
    if (!funding && !trade) continue
    entries.push({ ts, pnl: funding ? 0 : number(b.pnl), fee: funding ? 0 : number(b.fee), funding: funding ? number(b.pnl) : 0, trade: !funding })
  }
  const billBased = entries.some(e => e.trade)
  if (!billBased) {
    let end = now + 1000
    const fills = new Map<string, Raw>()
    for (;;) {
      await pause()
      const query = new URLSearchParams({ instType: "SWAP", limit: "100", begin: String(start), end: String(end) })
      const { rows } = await checkedRead(`/api/v5/trade/fills-history?${query}`)
      for (const f of rows) {
        const id = f.tradeId || f.fillId || f.billId
        if (!id || !f.instId) throw new IncompletePnlHistory("成交缺少唯一编号，无法确认收益完整性")
        fills.set(`${f.instId}:${id}`, f)
      }
      progress?.(fills.size)
      const oldest = Math.min(...rows.map(r => number(r.ts)))
      if (rows.length < 100 || oldest <= start) break
      const next = oldest + 1
      if (next >= end) throw new IncompletePnlHistory("成交分页未推进，请稍后重试")
      end = next
    }
    for (const f of fills.values()) {
      const ts = number(f.ts)
      if (ts < start || ts > now || String(f.feeCcy || "USDT") !== "USDT") continue
      entries.push({ ts, pnl: number(f.fillPnl) || number(f.realizedPnl), fee: number(f.fee), funding: 0, trade: true })
    }
  }
  const result = aggregateDailyPnl(entries)
  if (history) {
    history.since = start; history.through = now
    history.accountId = accountId
    history.billBased = billBased
    history.bills = new Map([...bills].filter(([, row]) => number(row.ts) >= start))
  }
  return result
}

export async function loadDesktopDailyPnl(days: number, fallback: () => Promise<DailyPnlResult>): Promise<DailyPnlResult> {
  await ensureDesktopRouting()
  if (!isTauri() || isServerMode()) return { ...await fallback(), source: "server-mode" }
  const token = localStorage.getItem("access_token") ?? ""
  const base = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")
  const identity = `${base}\0${token}\0${days}`
  if (!token) throw new Error("请先登录")
  if (cache?.identity === identity && Date.now() < cache.until) return cache.data
  let flight = flights.get(identity)
  if (!flight) {
    const started = generation
    if (snapshot?.identity !== identity) snapshot = { identity, history: createDailyPnlHistory() }
    const history = snapshot.history
    const active = () => started === generation && localStorage.getItem("access_token") === token && !isServerMode()
    flight = (async () => {
      let data: DailyPnlResult
      try {
        reportProgress(0)
        data = { ...await queryDailyPnl(async path => {
          if (!active()) throw new Error("会话已改变")
          return invoke("okx_analytics_read", { base, token, path })
        }, days, Date.now(), undefined, history, records => { if (active()) reportProgress(records) }), source: "desktop-snippet" }
      } catch (error) {
        if (!active() || error instanceof IncompletePnlHistory) throw error
        if (error instanceof PnlAccountChanged && snapshot?.identity === identity) snapshot = null
        data = { ...await fallback(), source: "server-fallback" }
      }
      if (!active()) throw new Error("会话已改变")
      cache = { identity, until: Date.now() + TTL, data }
      return data
    })().finally(() => { if (active()) reportProgress(null); if (flights.get(identity) === flight) flights.delete(identity) })
    flights.set(identity, flight)
  }
  return flight
}

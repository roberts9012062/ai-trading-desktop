import { beforeEach, afterEach, expect, it, vi } from "vitest"
import { aggregateDailyPnl, queryDailyPnl, IncompletePnlHistory, loadDesktopDailyPnl, resetDesktopDailyPnl, createDailyPnlHistory } from "./desktop-daily-pnl"
import type { DailyPnlResult } from "./desktop-daily-pnl"
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), server: false, native: true, token: "alice", policy: (() => {}) as () => void }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, isTauri: () => mocks.native }))
vi.mock("./desktop-routing", () => ({ ensureDesktopRouting: async () => {}, isServerMode: () => mocks.server, onDesktopRoutingChange: (f: () => void) => { mocks.policy = f } }))
const now = Date.parse("2026-10-10T12:00:00Z")
const noPause = async () => {}
const bill = (id: number, extra = {}) => ({ billId: String(id), ccy: "USDT", type: "2", ts: String(now - 1000), pnl: "10", fee: "-1", ...extra })
const empty: DailyPnlResult = { days: [], summary: null }
beforeEach(() => {
  mocks.server = false; mocks.native = true; mocks.token = "alice"
  mocks.invoke.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal("localStorage", { getItem: () => mocks.token })
  resetDesktopDailyPnl()
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it("aggregates Beijing dates, blank days, rebates and signed funding without double fees", () => {
  const row = (ts: string, pnl: number, fee: number, funding = 0, trade = true) => ({ ts: Date.parse(ts), pnl, fee, funding, trade })
  const result = aggregateDailyPnl([
    row("2026-10-03T15:59:59Z", -2, -.1), row("2026-10-03T16:00:00Z", 10, -1),
    row("2026-10-04T01:00:00Z", 0, -2), row("2026-10-04T02:00:00Z", 0, .5),
    row("2026-10-04T03:00:00Z", 0, 0, -.8, false), row("2026-10-04T04:00:00Z", 0, 0, .2, false),
    row("2026-10-05T16:00:00Z", 3, -.2),
  ])
  expect(result.days.map(r => r.date)).toEqual(["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"])
  expect(result.days[1]).toMatchObject({ pnl: 10, fee: 3.5, fee_cost: 2.5, funding: -.6, net_after_costs: 6.9, trades: 3, cumulative: 8 })
  expect(result.days[2]).toMatchObject({ net: 0, cumulative: 8 })
  expect(result.summary).toMatchObject({ total_profit: 13, total_loss: -2, net: 11, profit_ratio: 6.5, total_trades: 5 })
})

it("combines recent/archive pages, deduplicates IDs and filters non-trade/non-USDT/out-of-window bills", async () => {
  const read = vi.fn(async (path: string) => ({ demo: false, rows: path.includes("bills-archive") ? [bill(1), bill(2, { ts: String(now - 20 * 86400000), pnl: "-3" })] : [bill(1), bill(3, { ccy: "BTC" }), bill(4, { type: "1" }), bill(5, { ts: String(now + 1) })] }))
  const data = await queryDailyPnl(read, 90, now, noPause)
  expect(data.summary).toMatchObject({ net: 7, total_trades: 2 })
  expect(read).toHaveBeenCalledTimes(2)
  expect(read.mock.calls[1][0]).toContain("bills-archive")
  const recent = new URLSearchParams(read.mock.calls[0][0].split("?")[1])
  const archive = new URLSearchParams(read.mock.calls[1][0].split("?")[1])
  expect(recent.get("begin")).toBe(archive.get("end"))
  expect(Number(recent.get("begin"))).toBe(now - 7 * 86400000)
})

it("uses the bills cursor across full pages and does not treat page one as complete", async () => {
  const read = vi.fn().mockResolvedValueOnce({ demo: false, rows: Array.from({ length: 100 }, (_, i) => bill(200 - i)) }).mockResolvedValueOnce({ demo: false, rows: [bill(100)] })
  const data = await queryDailyPnl(read, 7, now, noPause)
  expect(read.mock.calls[1][0]).toContain("after=101")
  expect(data.summary?.total_trades).toBe(101)
})

it("keeps funding when demo bills are empty of trades and deduplicates fills by instrument + trade ID", async () => {
  const fill = { instId: "ADA-USDT-SWAP", tradeId: "1", ts: String(now - 1), fillPnl: "5", fee: "-1", feeCcy: "USDT" }
  const read = vi.fn().mockResolvedValueOnce({ demo: true, rows: [bill(1, { type: "8", subType: "173", pnl: "-.5" })] }).mockResolvedValueOnce({ demo: true, rows: [] }).mockResolvedValueOnce({ demo: true, rows: [fill, fill, { ...fill, instId: "BTC-USDT-SWAP" }] })
  const data = await queryDailyPnl(read, 90, now, noPause)
  expect(read.mock.calls[2][0]).toContain("fills-history")
  expect(data.days[0]).toMatchObject({ pnl: 10, fee_cost: 2, funding: -.5, net_after_costs: 7.5, trades: 2 })
})

it("rejects non-progressing bills and fills instead of silently showing partial totals", async () => {
  const page = Array.from({ length: 100 }, (_, i) => bill(i + 1))
  await expect(queryDailyPnl(async () => ({ demo: false, rows: page }), 7, now, noPause)).rejects.toBeInstanceOf(IncompletePnlHistory)
  const fills = Array.from({ length: 100 }, (_, i) => ({ instId: "ADA-USDT-SWAP", tradeId: String(i), ts: String(now - 1000), fillPnl: "1", fee: "0" }))
  const read = vi.fn().mockResolvedValueOnce({ demo: true, rows: [] }).mockResolvedValue({ demo: true, rows: fills })
  await expect(queryDailyPnl(read, 7, now, noPause)).rejects.toBeInstanceOf(IncompletePnlHistory)
})

it("never accepts malformed records or nonfinite monetary fields", async () => {
  await expect(queryDailyPnl(async () => ({ demo: false, rows: [bill(1, { pnl: "oops" })] }), 7, now, noPause)).rejects.toThrow("无效数字")
  await expect(queryDailyPnl(async () => ({ demo: false, rows: [bill(1, { billId: "" })] }), 7, now, noPause)).rejects.toBeInstanceOf(IncompletePnlHistory)
})

it("shares the local query/cache between both dashboard panels without a server earnings request", async () => {
  const fallback = vi.fn().mockResolvedValue(empty)
  mocks.invoke.mockImplementation(async command => command === "okx_analytics_read" ? { demo: true, rows: [bill(1, { ts: String(Date.now() - 1000) })] } : undefined)
  const [a, b] = await Promise.all([loadDesktopDailyPnl(90, fallback), loadDesktopDailyPnl(90, fallback)])
  expect(a).toBe(b); expect(a.source).toBe("desktop-snippet")
  await loadDesktopDailyPnl(90, fallback)
  expect(mocks.invoke.mock.calls.filter(c => c[0] === "okx_analytics_read")).toHaveLength(2)
  expect(fallback).not.toHaveBeenCalled()
})

it("uses server mode and falls back once after a proxy error, with a distinct source", async () => {
  const fallback = vi.fn().mockResolvedValue(empty)
  mocks.server = true
  expect((await loadDesktopDailyPnl(90, fallback)).source).toBe("server-mode")
  mocks.server = false
  mocks.invoke.mockRejectedValue(new Error("HTTP 429"))
  expect((await loadDesktopDailyPnl(90, fallback)).source).toBe("server-fallback")
  await loadDesktopDailyPnl(90, fallback)
  expect(fallback).toHaveBeenCalledTimes(2)
})

it("does not publish or fall back for the previous account after logout", async () => {
  const resolves: ((value: unknown) => void)[] = []
  mocks.invoke.mockImplementation(command => command === "okx_analytics_read" ? new Promise(r => { resolves.push(r) }) : Promise.resolve())
  const fallback = vi.fn().mockResolvedValue(empty)
  const promise = loadDesktopDailyPnl(90, fallback)
  await vi.waitFor(() => expect(resolves).toHaveLength(2))
  mocks.token = "bob"; resetDesktopDailyPnl()
  resolves.forEach(resolve => resolve({ demo: true, rows: [bill(1)] }))
  await expect(promise).rejects.toThrow("会话已改变")
  expect(fallback).not.toHaveBeenCalled()
})

it("refreshes only a recent overlap after a complete snapshot, retaining archived earnings without duplicates", async () => {
  const history = createDailyPnlHistory()
  const read = vi.fn(async (path: string) => ({ demo: false, rows: path.includes("archive") ? [bill(2, { ts: String(now - 20 * 86400000), pnl: "-3" })] : [bill(1)] }))
  await queryDailyPnl(read, 90, now, noPause, history)
  read.mockClear()
  read.mockResolvedValue({ demo: false, rows: [bill(1), bill(3, { ts: String(now + 1), pnl: "2" })] })
  const warm = await queryDailyPnl(read, 90, now + 60000, noPause, history)
  expect(read).toHaveBeenCalledTimes(1)
  expect(read.mock.calls[0][0]).not.toContain("archive")
  expect(new URLSearchParams(read.mock.calls[0][0].split("?")[1]).get("begin")).toBe(String(now - 3600000))
  expect(warm.summary).toMatchObject({ net: 9, total_trades: 3 })
})

it("does not update the reusable snapshot after a failed page", async () => {
  const history = createDailyPnlHistory()
  await queryDailyPnl(async () => ({ demo: true, rows: [bill(1)] }), 7, now, noPause, history)
  await expect(queryDailyPnl(async () => { throw new Error("network") }, 7, now + 60000, noPause, history)).rejects.toThrow("network")
  expect(history.through).toBe(now)
  expect(history.bills.size).toBe(1)
})

it("never merges cached earnings with a newly bound OKX account or demo mode", async () => {
  const history = createDailyPnlHistory()
  await queryDailyPnl(async () => ({ demo: true, account_id: "old", rows: [bill(1)] }), 7, now, noPause, history)
  await expect(queryDailyPnl(async () => ({ demo: false, account_id: "new", rows: [bill(2)] }), 7, now + 60000, noPause, history)).rejects.toThrow("凭证已变化")
  expect(history.accountId).toBe("old")
  expect(history.bills.size).toBe(1)
})

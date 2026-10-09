import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BalancedDiscovery, ReadQueue, mergeDelta, nextCycleScan } from "./discovery"
import { hunterApi, type Hunter, type RankingSnapshot } from "./api"
import { useHunterStore } from "@/stores/hunter"
import { startHunterRuntime } from "./scanner"
import type { Bar } from "./rules"
import * as rules from "./rules"

vi.mock("@/stores/ai-trading", () => ({ useAITradingStore: { getState: () => ({ loadTasks: vi.fn() }) } }))
vi.mock("@/stores/auth", () => ({ useAuthStore: { getState: () => ({ user: { id: "user", role: "admin", trading_mode: "virtual" } }) } }))
vi.mock("./api", () => ({ hunterApi: { universe: vi.fn(), data: vi.fn(), snapshot: vi.fn(), mount: vi.fn(), report: vi.fn().mockResolvedValue(undefined) } }))
const group = (): Hunter => ({ id: "hunter", status: "running", blocks: [], opportunities: [],
  config: { strategy_version: "hunter-v2", venue: "okx", cycles: ["short", "medium", "long"], direction: "long", max_positions: 4, scan_seconds: 60 } }) as unknown as Hunter
const rows: Bar[] = Array.from({ length: 5 }, (_, i) => [i*300000, 100, 102, 98, 101, 10])

beforeEach(() => { vi.clearAllMocks(); useHunterStore.getState().reset() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe("incremental hunter history", () => {
  it("overwrites the anchor and appends a closed candle", () => {
    const changed: Bar = [900000, 100, 102, 98, 101.5, 10]
    expect(mergeDelta(rows.slice(0, 4), { reset: false, rows: [changed, rows[4]] }, 300, 1600)).toEqual([...rows.slice(0, 3), changed, rows[4]])
  })
  it("rejects a missing anchor, a gap, an invalid correction or a forming candle", () => {
    expect(() => mergeDelta(rows.slice(0, 3), { reset: false, rows: rows.slice(3) }, 300, 1600)).toThrow(/锚点/)
    expect(() => mergeDelta([], { reset: true, rows: [rows[0], rows[2]] }, 300, 1600)).toThrow(/缺口/)
    expect(() => mergeDelta(rows.slice(0, 4), { reset: false, rows: [[900000, 100, 99, 98, 101, 10]] }, 300, 1600)).toThrow(/无效/)
    expect(() => mergeDelta([], { reset: true, rows }, 300, 1400)).toThrow(/未收盘/)
  })
  it("resets after an offline gap without mixing old history", () => {
    expect(mergeDelta(rows.slice(0, 2), { reset: true, rows: rows.slice(3) }, 300, 1600)).toEqual(rows.slice(3))
  })
})

it("prioritizes queued short reads and never exceeds two in flight", async () => {
  const queue = new ReadQueue(), signal = new AbortController().signal, order: string[] = []
  let first!: () => void, second!: () => void
  const a = queue.run("long", signal, () => new Promise<void>(resolve => { first = resolve }))
  const b = queue.run("medium", signal, () => new Promise<void>(resolve => { second = resolve }))
  const c = queue.run("long", signal, async () => { order.push("long") })
  const d = queue.run("short", signal, async () => { order.push("short") })
  expect(order).toEqual([])
  first(); await a; await Promise.resolve(); second()
  await Promise.all([b, c, d])
  expect(order).toEqual(["short", "long"])
})

it("uses scan start cadence and wakes at a new execution close", () => {
  expect(nextCycleScan("short", 60, 100000, 130000)).toBe(160000)
  expect(nextCycleScan("short", 3600, 290000, 291000)).toBe(302000)
  expect(nextCycleScan("medium", 60, 100000, 130000)).toBe(400000)
  const beforeDaily = 16*3600000-10000
  expect(nextCycleScan("long", 3600, beforeDaily, beforeDaily+1000)).toBe(16*3600000+2000)
})

it("keeps ranking complete and fails closed when one symbol is unavailable", async () => {
  const g = group(); useHunterStore.setState({ groups: [g] })
  vi.mocked(hunterApi.universe).mockResolvedValue([{ symbol: "btcusdt", spread: 0 }, { symbol: "ethusdt", spread: 0 }] as never)
  vi.mocked(hunterApi.snapshot).mockResolvedValue({ items: [{ symbol: "btcusdt", history_ok: true, relative: .1 }, { symbol: "ethusdt", error: "限流" }] } as never)
  await new BalancedDiscovery(g.id).scan(g, "short", new AbortController().signal)
  expect(hunterApi.mount).not.toHaveBeenCalled()
  expect(hunterApi.snapshot).toHaveBeenCalledTimes(1)
  expect(useHunterStore.getState().progress[g.id]).toContain("排名未完成")
})

it("loads entry context only for the 30% ranked candidates", async () => {
  const g = group(); useHunterStore.setState({ groups: [g] })
  const symbols = Array.from({ length: 10 }, (_, i) => "coin"+i+"usdt")
  vi.mocked(hunterApi.universe).mockResolvedValue(symbols.map(symbol => ({ symbol, spread: 0 })) as never)
  const contextCalls: string[] = []
  vi.mocked(hunterApi.snapshot).mockImplementation(async (_id, body) => {
    if (body.phase === "ranking") return { items: body.symbols.map(symbol => ({ symbol, history_ok: true, relative: symbols.indexOf(symbol) } as RankingSnapshot)) } as never
    contextCalls.push(...body.symbols)
    return { items: body.symbols.map(symbol => ({ symbol, error: "test missing context" })) } as never
  })
  await new BalancedDiscovery(g.id).scan(g, "short", new AbortController().signal)
  expect(contextCalls).toEqual(["coin9usdt", "coin8usdt", "coin7usdt"])
  expect(hunterApi.mount).not.toHaveBeenCalled()
})

it("adaptive ranking continues with one isolated failure at 80% coverage and reports the blocker", async () => {
  const g = group(); g.config.strategy_version = "hunter-v3"; useHunterStore.setState({ groups: [g] })
  const symbols = Array.from({ length: 10 }, (_, i) => "coin"+i+"usdt")
  vi.mocked(hunterApi.universe).mockResolvedValue(symbols.map(symbol => ({ symbol, spread: 0 })) as never)
  const contextCalls: string[] = []
  vi.mocked(hunterApi.snapshot).mockImplementation(async (_id, body) => {
    if (body.phase === "ranking") return { items: body.symbols.map(symbol => symbol === symbols[0] ? { symbol, error: "限流" } : { symbol, history_ok: true, relative: symbols.indexOf(symbol) }) } as never
    contextCalls.push(...body.symbols)
    return { items: body.symbols.map(symbol => ({ symbol, error: "test context" })) } as never
  })
  await new BalancedDiscovery(g.id).scan(g, "short", new AbortController().signal)
  expect(contextCalls).toEqual(["coin9usdt", "coin8usdt", "coin7usdt", "coin6usdt"])
  expect(hunterApi.report).toHaveBeenCalled()
  expect(useHunterStore.getState().progress[g.id]).toContain("行情失败")
})

it("runs the short cycle again while the long cycle is still reading", async () => {
  vi.useFakeTimers(); vi.setSystemTime(100000)
  vi.stubGlobal("navigator", { locks: { request: vi.fn((_name, _options, callback) => callback()) } })
  const g = group(); useHunterStore.setState({ groups: [g], refresh: vi.fn().mockResolvedValue(undefined) })
  let finishLong!: () => void
  const scan = vi.spyOn(BalancedDiscovery.prototype, "scan").mockImplementation(async (_g, cycle) => {
    if (cycle === "long") await new Promise<void>(resolve => { finishLong = resolve })
  })
  const stop = startHunterRuntime()
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(scan.mock.calls.map(c => c[1])).toEqual(["short", "medium", "long"])
    await vi.advanceTimersByTimeAsync(65000)
    expect(scan.mock.calls.filter(c => c[1] === "short")).toHaveLength(2)
    expect(scan.mock.calls.filter(c => c[1] === "long")).toHaveLength(1)
    stop(); finishLong(); await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(65000)
    expect(scan.mock.calls.filter(c => c[1] === "short")).toHaveLength(2)
  } finally { stop() }
})

it("serializes mounts from independent cycles and refreshes reservations", async () => {
  const g = group(), at = Math.floor(Date.now()/1000)
  const refresh = vi.fn().mockResolvedValue(undefined)
  useHunterStore.setState({ groups: [g], refresh })
  vi.spyOn(rules, "trend").mockReturnValue(true)
  vi.spyOn(rules, "watchStage").mockReturnValue({ stage: "趋势回调观察", expires: at+100 })
  vi.spyOn(rules, "entrySignal").mockReturnValue({ entry: 100, stop: 99, direction: "long", atr: 1, breakout: 100, signal_at: at, expires_at: at+180, reason: "test", entry_kind: "pullback" })
  vi.mocked(hunterApi.universe).mockResolvedValue([{ symbol: "btcusdt", spread: 0 }, { symbol: "ethusdt", spread: 0 }] as never)
  vi.mocked(hunterApi.snapshot).mockImplementation(async (_id, body) => {
    if (body.phase === "ranking") return { items: body.symbols.map(symbol => ({ symbol, history_ok: true, relative: Number(symbol === (body.cycle === "short" ? "btcusdt" : "ethusdt")) })) } as never
    const delta = { reset: true, rows: [[0, 100, 101, 99, 100, 10]] }
    const bars = body.cycle === "short" ? { "5m": delta, "15m": delta, "1h": delta, "1d": delta } : { "4h": delta, "1h": delta, "1d": delta }
    return { items: body.symbols.map(symbol => ({ symbol, bars, market: delta, market_week: { reset: true, rows: [] }, now: at })) } as never
  })
  let finishFirst!: (value: never) => void
  vi.mocked(hunterApi.mount).mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve })).mockResolvedValue({ id: "o", task_id: "t", duplicate: false })
  const discovery = new BalancedDiscovery(g.id)
  const scans = [discovery.scan(g, "short", new AbortController().signal), discovery.scan(g, "medium", new AbortController().signal)]
  await vi.waitFor(() => expect(hunterApi.mount).toHaveBeenCalledTimes(1))
  expect(refresh).toHaveBeenCalledTimes(1)
  finishFirst({ id: "first", task_id: "task", duplicate: false } as never)
  await Promise.all(scans)
  expect(hunterApi.mount).toHaveBeenCalledTimes(2)
  expect(refresh).toHaveBeenCalledTimes(4)
})

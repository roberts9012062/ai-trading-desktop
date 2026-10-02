import { afterEach, describe, expect, it, vi } from "vitest"
import {
  aggregateDailyPnl,
  dayKeyLocal,
  loadDailyPnlCache,
  saveDailyPnlCache,
} from "./pnl-calendar"
import type { LiveBill } from "./live-api"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function fakeStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size
    },
  } as Storage
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe("pnl-calendar server-source aggregation", () => {
  it("buckets live bills into local calendar days with pnl+fee only", () => {
    const base = new Date(2026, 9, 2, 9, 30).getTime()
    const bills: LiveBill[] = [
      { ts_ms: base, symbol: "BTC-USDT-SWAP", type: "2", sub_type: "2", amount: 0, fee: -2, pnl: 100, notes: "" },
      { ts_ms: base + 3_600_000, symbol: "BTC-USDT-SWAP", type: "2", sub_type: "2", amount: 0, fee: -1, pnl: -40, notes: "" },
      // 纯转账：amount 是转账额，绝不能算进盈亏
      { ts_ms: base + 7_200_000, symbol: "", type: "1", sub_type: "0", amount: 9999, fee: 0, pnl: 0, notes: "" },
      // 强平平仓
      { ts_ms: base + 86_400_000, symbol: "ETH-USDT-SWAP", type: "5", sub_type: "0", amount: 0, fee: -0.5, pnl: -80.75, notes: "" },
      // 零值非交易账单不产生日期条目
      { ts_ms: base, symbol: "", type: "9", sub_type: "0", amount: 0, fee: 0, pnl: 0, notes: "" },
    ]
    const days = aggregateDailyPnl(bills)
    expect(days[dayKeyLocal(base)]).toEqual({ pnl: 100 - 2 - 40 - 1, count: 2 })
    expect(days[dayKeyLocal(base + 86_400_000)]).toEqual({ pnl: -81.25, count: 1 })
    expect(Object.keys(days)).toHaveLength(2)
  })

  it("round-trips the daily cache per venue through localStorage", () => {
    vi.stubGlobal("localStorage", fakeStorage())
    saveDailyPnlCache({
      version: 2,
      venue: "okx",
      fetchedAt: 123,
      billCount: 10,
      earliestTsMs: 456,
      days: { "2026-10-02": { pnl: 5, count: 1 } },
    })
    expect(loadDailyPnlCache("okx")?.days["2026-10-02"]).toEqual({ pnl: 5, count: 1 })
    // 换 venue 视为缓存失效
    expect(loadDailyPnlCache("binance")).toBeNull()
  })
})

import { afterEach, describe, expect, it, vi } from "vitest"
import type { LiveBill } from "./live-api"

// live-api 的 API_BASE 是模块顶层常量（读 globalThis.__QH_API_BASE__），
// 必须先设全局再动态 import，否则已被求值为空串
;(globalThis as Record<string, unknown>).__QH_API_BASE__ = "http://mock"
const {
  aggregateDailyPnl,
  dayKeyLocal,
  loadDailyPnlCache,
  refreshDailyPnl,
  saveDailyPnlCache,
} = await import("./pnl-calendar")

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
      usedLimit: 500,
      earliestTsMs: 456,
      days: { "2026-10-02": { pnl: 5, count: 1 } },
    })
    expect(loadDailyPnlCache("okx")?.days["2026-10-02"]).toEqual({ pnl: 5, count: 1 })
    // 换 venue 视为缓存失效
    expect(loadDailyPnlCache("binance")).toBeNull()
  })

  it("steps the limit down on 422 and keeps other errors loud", async () => {
    vi.stubGlobal("localStorage", fakeStorage())
    // live-api 的 API_BASE 来自 globalThis.__QH_API_BASE__（vite define 注入），测试里直接给全 URL 前缀
    ;(globalThis as Record<string, unknown>).__QH_API_BASE__ = "http://mock"
    const urls: string[] = []
    const bill: LiveBill = {
      ts_ms: new Date(2026, 9, 2, 9, 30).getTime(),
      symbol: "BTC-USDT-SWAP", type: "2", sub_type: "2", amount: 0, fee: -1, pnl: 50, notes: "",
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input)
        urls.push(url)
        const limit = new URL(url).searchParams.get("limit")
        if (Number(limit) > 500) {
          return new Response(JSON.stringify({ detail: [{ loc: ["query", "limit"], msg: "less than or equal to 500" }] }), { status: 422 })
        }
        return new Response(JSON.stringify({ bills: [bill] }), { status: 200 })
      }),
    )
    const cache = await refreshDailyPnl({ venue: "okx" })
    expect(urls.map((u) => new URL(u).searchParams.get("limit"))).toEqual(["2000", "500"])
    expect(cache.usedLimit).toBe(500)
    expect(cache.billCount).toBe(1)
    expect(cache.days[dayKeyLocal(bill.ts_ms)]).toEqual({ pnl: 49, count: 1 })

    // 非 422 错误不降档，直接抛
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "内部错误" }), { status: 500 })),
    )
    await expect(refreshDailyPnl({ venue: "okx" })).rejects.toThrow("内部错误")
  })
})

import { afterEach, describe, expect, it, vi } from "vitest"

// live-api 的 API_BASE 是模块顶层常量（读 globalThis.__QH_API_BASE__），
// 必须先设全局再动态 import，否则已被求值为空串
;(globalThis as Record<string, unknown>).__QH_API_BASE__ = "http://mock"
const { loadDailyPnlCache, refreshDailyPnl, saveDailyPnlCache } = await import("./pnl-calendar")

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

describe("pnl-calendar daily-pnl source", () => {
  it("round-trips the daily cache per venue through localStorage", () => {
    vi.stubGlobal("localStorage", fakeStorage())
    saveDailyPnlCache({
      version: 3,
      venue: "okx",
      fetchedAt: 123,
      earliestDate: "2026-09-01",
      days: { "2026-10-02": { net: -9.41, gross: 10.62, fee: 20.03, count: 96 } },
    })
    expect(loadDailyPnlCache("okx")?.days["2026-10-02"]).toEqual({
      net: -9.41, gross: 10.62, fee: 20.03, count: 96,
    })
    // 换 venue 视为缓存失效
    expect(loadDailyPnlCache("binance")).toBeNull()
  })

  it("refreshes from server daily rows and drops zero-trade filler days", async () => {
    vi.stubGlobal("localStorage", fakeStorage())
    const urls: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input)
        urls.push(url)
        return ok({
          days: [
            { date: "2026-09-30", pnl: 100, fee: 2, net: 98, cumulative: 98, trades: 4 },
            { date: "2026-10-01", pnl: -40, fee: 1, net: -41, cumulative: 57, trades: 2 },
            // 服务器补零的无交易日：应被丢弃，不占日历格子
            { date: "2026-10-02", pnl: 0, fee: 0, net: 0, cumulative: 57, trades: 0 },
          ],
          summary: {
            total_profit: 98, total_loss: -41, profit_ratio: 2.3902, net: 57,
            trade_days: 2, total_trades: 6,
          },
        })
      }),
    )
    const cache = await refreshDailyPnl({ venue: "okx" })
    expect(urls[0]).toContain("/api/live/daily-pnl?venue=okx&days=90")
    expect(cache.earliestDate).toBe("2026-09-30")
    expect(cache.days["2026-09-30"]).toEqual({ net: 98, gross: 100, fee: 2, count: 4 })
    expect(cache.days["2026-10-01"]).toEqual({ net: -41, gross: -40, fee: 1, count: 2 })
    expect(cache.days["2026-10-02"]).toBeUndefined()
    // 落缓存可读回
    expect(loadDailyPnlCache("okx")?.days["2026-10-01"]).toEqual({ net: -41, gross: -40, fee: 1, count: 2 })
  })

  it("surfaces server errors instead of swallowing them", async () => {
    vi.stubGlobal("localStorage", fakeStorage())
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "内部错误" }), { status: 500 })),
    )
    await expect(refreshDailyPnl({ venue: "okx" })).rejects.toThrow("内部错误")
  })
})

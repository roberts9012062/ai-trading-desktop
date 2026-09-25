import { afterEach, describe, expect, it, vi } from "vitest"
import { cryptoPair, fetchBookSnapshot, optionalNumber } from "./crypto-direct"
import { enrichGateBars, getGateFuturesKlineApi, joinGateHistory } from "./gate-futures"
import { getBinanceKlineApi } from "./binance-kline"
import type { KlineBar } from "@/types"

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
function bar(at: number): KlineBar { return { time: new Date(at * 1000).toISOString(), open_time: at * 1000, open: 10, high: 11, low: 9, close: 10, volume: 20 } }

describe("direct crypto data", () => {
  it("normalizes perpetual and CCXT symbols without accepting arbitrary URLs", () => {
    expect(cryptoPair("BTC-USDT-SWAP")).toBe("BTC_USDT")
    expect(cryptoPair("eth/usdt:usdt")).toBe("ETH_USDT")
    expect(() => cryptoPair("https://example.com")).toThrow()
    expect(optionalNumber(null)).toBeNull()
    expect(optionalNumber("0")).toBe(0)
  })
  it("keeps Binance historical taker volume, quote volume and trade count", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([[1000, "1", "2", "1", "2", "5", 1999, "8", 3, "2", "3", "0"]])))
    const { bars } = await getBinanceKlineApi("BTCUSDT", "1m")
    expect(bars[0]).toMatchObject({ quote_volume: 8, trade_count: 3, taker_buy_volume: 2, taker_buy_quote_volume: 3, open_interest: null })
  })
  it("joins only prior published funding and stats, never next settlements", () => {
    const rows = [bar(7200), bar(7500)]
    const funding = [{ t: 1, r: "0.001" }, { t: 7200, r: "-0.002" }]
    const stats = [{ time: 3600, open_interest: 10 }, { time: 3900, open_interest: 20 }]
    expect(joinGateHistory(rows, funding, stats, 3000).map((r) => [r.funding_rate, r.open_interest])).toEqual([[.001, 20], [-.002, 20]])
    expect(() => joinGateHistory([bar(100000)], funding, stats, 3000)).toThrow("覆盖不足")
    expect(() => joinGateHistory(rows, [], stats, 3000)).toThrow("覆盖不足")
  })
  it("lags interval statistics strictly past their end and preserves missing fields", () => {
    const out = joinGateHistory([bar(7200), bar(7500)], [{ t: 1, r: "0" }],
      [{ time: 6300, open_interest: 10 }, { time: 6900, open_interest: 20 }], 300)
    expect(out.map((r) => r.open_interest)).toEqual([10, 20])
    expect(out[0].taker_imbalance).toBeNull()
    expect(out[0].funding_rate).toBe(0)
  })
  it("uses UTC daily pagination and never combines Gate limit with from/to", async () => {
    const f = vi.fn().mockResolvedValue(response([{ t: 1704067200, o: "10", h: "11", l: "9", c: "10", v: 30, sum: "300" }]))
    vi.stubGlobal("fetch", f)
    const out = await getGateFuturesKlineApi("BTCUSDT", "1d", { limit: 3, endTime: "2024-01-03" })
    const url = new URL(f.mock.calls[0][0])
    expect(url.searchParams.has("limit")).toBe(false)
    expect(url.searchParams.get("from")).toBe("1704067200")
    expect(url.searchParams.get("to")).toBe("1704240000")
    expect(out.bars[0]).toMatchObject({ time: "2024-01-01", market_source: "gate_usdt", quote_volume: 300 })
  })
  it("excludes a forming candle", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([{ t: Math.floor(Date.now() / 1000), o: "10", h: "11", l: "9", c: "10", v: 30 }])))
    expect((await getGateFuturesKlineApi("BTCUSDT", "1m")).bars).toEqual([])
  })
  it("paginates stats forward and funding backward even if a server returns short pages", async () => {
    const urls: URL[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const u = new URL(input); urls.push(u)
      if (u.pathname.endsWith("funding_rate")) return response(Number(u.searchParams.get("to")) >= 1 ? [{ t: 1, r: ".001" }] : [])
      const from = Number(u.searchParams.get("from"))
      return response(from <= 6900 ? [{ time: 6600, open_interest: 10 }, { time: 6900, open_interest: 11 }] : [{ time: 7200, open_interest: 12 }, { time: 7500, open_interest: 13 }])
    }))
    vi.spyOn(Date, "now").mockReturnValue(10000 * 1000)
    const out = await enrichGateBars("BTCUSDT", "5m", [bar(7200), bar(7500)])
    expect(out.map((r) => r.open_interest)).toEqual([10, 11])
    expect(urls.some((u) => u.searchParams.get("from") === "6901")).toBe(true)
  })
  it("validates real book depth and rejects crossed books", async () => {
    const f = vi.fn().mockResolvedValueOnce(response({ bids: [{ p: "100", s: 3 }], asks: [{ p: "101", s: 1 }], update: 123 }))
      .mockResolvedValueOnce(response({ bids: [["101", "2"]], asks: [["100", "1"]] }))
    vi.stubGlobal("fetch", f)
    const out = await fetchBookSnapshot("gate_usdt", "BTCUSDT")
    expect(out).toMatchObject({ bid: 100, ask: 101, imbalance: .5, exchange_at: 123000 })
    expect(out.spread_bps).toBeCloseTo(1 / 100.5 * 10000)
    await expect(fetchBookSnapshot("binance_spot", "BTCUSDT")).rejects.toThrow("盘口价差")
  })
})

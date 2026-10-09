import { afterEach, expect, it, vi } from "vitest"
import { getKlineApi, getKlineBundleApi } from "./api"
vi.mock('./desktop-routing', () => ({ ensureDesktopRouting: async () => {}, isServerMode: () => true }))

afterEach(() => vi.unstubAllGlobals())

it("loads chart pages through the server and retains OKX candle provenance", async () => {
  const body = { symbol: "dotusdt", period: "60m", bars: [{ time: "2026-10-05 08:00:00", open: 1.2, high: 1.21, low: 1.19, close: 1.2052, volume: 30, market_source: "okx", version: 123, kind: "correction" }], has_more: true }
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)))
  vi.stubGlobal("fetch", fetcher)
  expect(await getKlineApi("dotusdt", "60m", { limit: 240, endTime: "2026-10-05 09:00:00" })).toEqual(body)
  const url = new URL(fetcher.mock.calls[0][0], "http://server")
  expect(url.pathname).toBe("/api/market/kline")
  expect(url.searchParams.get("end_time")).toBe("2026-10-05 09:00:00")
  expect(url.searchParams.get("limit")).toBe("240")
})

it("loads all chart periods in one server bundle request", async () => {
  const body = { symbol: "dotusdt", periods: [] }
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)))
  vi.stubGlobal("fetch", fetcher)
  expect(await getKlineBundleApi("dotusdt", 240)).toEqual(body)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(new URL(fetcher.mock.calls[0][0], "http://server").pathname).toBe("/api/market/kline/bundle")
})

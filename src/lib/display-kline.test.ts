import { expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ tail: vi.fn(), merge: vi.fn(), gap: vi.fn(), fresh: vi.fn(), observe: vi.fn() }))
vi.mock("@/components/market/kline/realtime/accumulator", () => ({ readRtTail: mock.tail, rtAccKey: (s: string, p: string) => `${s}:${p}`, mergeTailWithHistory: mock.merge, detectTailGap: mock.gap }))
vi.mock("./okx-snippet-ws", () => ({ getOkxSnippetWebSocket: () => ({ hasFreshCandle: mock.fresh, observeVersion: mock.observe }) }))
vi.mock("./okx-forming", () => ({}))
import { readDisplayCandles } from "./display-kline"
const bar = { time: "2026-10-09 17:00:00", open: 1, high: 2, low: 1, close: 2, volume: 10 }
it("uses the direct stream for forecast display without polling server history", async () => {
  mock.fresh.mockReturnValue(true); mock.tail.mockReturnValue([bar]); mock.gap.mockReturnValue(null)
  mock.merge.mockReturnValue({ mergedBars: [bar] })
  const history = vi.fn()
  expect(await readDisplayCandles("adausdt", "15m", [bar], history)).toEqual([bar])
  expect(history).not.toHaveBeenCalled()
})
it("loads initial history and repairs a detected gap", async () => {
  mock.fresh.mockReturnValue(false); mock.tail.mockReturnValue([])
  const history = vi.fn().mockResolvedValue([bar])
  expect(await readDisplayCandles("adausdt", "15m", [], history)).toEqual([bar])
  mock.fresh.mockReturnValue(true); mock.tail.mockReturnValue([bar]); mock.gap.mockReturnValue("gap")
  await readDisplayCandles("adausdt", "15m", [bar], history)
  expect(history).toHaveBeenCalledTimes(2)
})

/**
 * fetchBacktestBars 分页去重/排序单测（P2-17 回归）
 *
 * 服务端 end_time 为闭区间时,相邻两页各含同一根边界 bar;重复 bar 会在
 * next_ret 里产生一根 0 收益、使时间序列非严格递增。这里锁定
 * 「无重复、时间严格升序、日期过滤仍生效、分页回溯契约不变」。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/kline-channels", () => ({
  getChannelKlineApi: vi.fn(),
  DEFAULT_KLINE_CHANNEL: "binance_spot",
  normalizeChannel: (v: unknown) =>
    v === "okx" || v === "gate_spot" ? (v as string) : "binance_spot",
}))

import { getChannelKlineApi, type BinanceKlinePage } from "@/lib/kline-channels"
import type { KlineBarApi } from "@/lib/api"
import { fetchBacktestBars } from "@/lib/local-backtest"

const mockedGet = vi.mocked(getChannelKlineApi)

function bar(time: string, close = 100): KlineBarApi {
  return { time, open: close, high: close, low: close, close, volume: 10, settle: null, open_interest: null }
}

function reply(bars: KlineBarApi[], has_more: boolean): Promise<BinanceKlinePage> {
  return Promise.resolve({ bars, has_more })
}

function times(bars: readonly { time: string }[]): string[] {
  return bars.map((b) => b.time)
}

beforeEach(() => {
  mockedGet.mockReset()
})

describe("fetchBacktestBars 分页去重/排序", () => {
  it("闭区间边界重复 bar 被去重,结果严格升序", async () => {
    mockedGet
      .mockReturnValueOnce(
        reply(
          [bar("2026-01-29T00:00:00", 3), bar("2026-01-30T00:00:00", 4), bar("2026-01-31T00:00:00", 5)],
          true,
        ),
      )
      // 第二页 endTime 为闭区间:再含一根 01-29 的重复 bar
      .mockReturnValueOnce(
        reply(
          [bar("2026-01-27T00:00:00", 1), bar("2026-01-28T00:00:00", 2), bar("2026-01-29T00:00:00", 3)],
          false,
        ),
      )

    const out = await fetchBacktestBars("rb2610", "1d", "2026-01-01", "2026-01-31")

    expect(times(out)).toEqual([
      "2026-01-27T00:00:00",
      "2026-01-28T00:00:00",
      "2026-01-29T00:00:00",
      "2026-01-30T00:00:00",
      "2026-01-31T00:00:00",
    ])
    // 分页回溯契约:第二页以上一页最老一根为 end_time
    expect(mockedGet).toHaveBeenCalledTimes(2)
    expect(mockedGet.mock.calls[1][2]).toEqual({ limit: 500, endTime: "2026-01-29T00:00:00" })
  })

  it("无重叠时原样返回,不丢 bar", async () => {
    mockedGet.mockReturnValueOnce(
      reply([bar("2026-01-29T00:00:00"), bar("2026-01-30T00:00:00")], false),
    )
    const out = await fetchBacktestBars("rb2610", "1d", "2026-01-01", "2026-01-31")
    expect(times(out)).toEqual(["2026-01-29T00:00:00", "2026-01-30T00:00:00"])
  })

  it("页内乱序时输出仍按时间升序", async () => {
    mockedGet.mockReturnValueOnce(
      reply([bar("2026-01-30T00:00:00"), bar("2026-01-29T00:00:00"), bar("2026-01-28T00:00:00")], false),
    )
    const out = await fetchBacktestBars("rb2610", "1d", "2026-01-01", "2026-01-31")
    expect(times(out)).toEqual([
      "2026-01-28T00:00:00",
      "2026-01-29T00:00:00",
      "2026-01-30T00:00:00",
    ])
  })

  it("日期过滤仍生效(超出的 endDate 之后被滤掉)", async () => {
    mockedGet.mockReturnValueOnce(
      reply(
        [bar("2026-01-30T00:00:00"), bar("2026-01-31T00:00:00"), bar("2026-02-01T00:00:00")],
        false,
      ),
    )
    const out = await fetchBacktestBars("rb2610", "1d", "2026-01-01", "2026-01-31")
    expect(times(out)).toEqual(["2026-01-30T00:00:00", "2026-01-31T00:00:00"])
  })
})

describe("fetchBacktestBars 截断信号(M1:超限报错而非静默截断)", () => {
  it("耗尽页数上限仍有更老数据 → truncated=true", async () => {
    mockedGet
      .mockReturnValueOnce(
        reply([bar("2026-01-28T00:00:00"), bar("2026-01-29T00:00:00"), bar("2026-01-30T00:00:00")], true),
      )
      .mockReturnValueOnce(
        reply([bar("2026-01-25T00:00:00"), bar("2026-01-26T00:00:00"), bar("2026-01-27T00:00:00")], true),
      )

    const stop = { truncated: false }
    const out = await fetchBacktestBars("rb2610", "1d", "2026-01-01", "2026-01-31", 2, stop)

    expect(stop.truncated).toBe(true)
    expect(out.length).toBe(6) // 已拉到的部分仍然返回,由调用方决定报错
  })

  it("has_more=false 正常收尾 → truncated=false", async () => {
    mockedGet.mockReturnValueOnce(
      reply([bar("2026-01-30T00:00:00"), bar("2026-01-31T00:00:00")], false),
    )
    const stop = { truncated: false }
    await fetchBacktestBars("rb2610", "1d", "2026-01-01", "2026-01-31", 2, stop)
    expect(stop.truncated).toBe(false)
  })

  it("已覆盖 startDate 提前收尾 → truncated=false", async () => {
    mockedGet.mockReturnValueOnce(
      reply([bar("2026-01-01T00:00:00"), bar("2026-01-02T00:00:00")], true),
    )
    const stop = { truncated: false }
    await fetchBacktestBars("rb2610", "1d", "2026-01-01", "2026-01-31", 5, stop)
    expect(stop.truncated).toBe(false)
  })
})

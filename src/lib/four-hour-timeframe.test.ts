import { describe, expect, it } from "vitest"
import { normalizeInterval } from "./binance-kline"
import { resampleOkxBars } from "./okx-history"
import { backtestDataTimeframe, backtestWarmupBars } from "./backtest-history"
import { TIMEFRAME_MAX_DAYS, multiSegmentMinDays } from "@/components/backtest/timeframe-limits"
import { PERIOD_MINUTES, computeRemainingSec } from "@/components/market/kline/next-bar-countdown-utils"
import { barStartMs, buildFormingBar } from "./shortline/forming-bar"
import { TIMEFRAME_SECONDS } from "./shortline/spec"
import { detectTailGap } from "@/components/market/kline/realtime/accumulator"
import type { KlineBar } from "@/types"

describe("four-hour history and live clock", () => {
  it("uses native Binance four-hour bars and completes only full OKX groups", () => {
    expect(normalizeInterval("240m")).toBe("4h")
    const start = Date.UTC(2026, 8, 30, 16) // Beijing 00:00
    const rows = Array.from({ length: 480 }, (_, i) => ({
      time: "", open_time: start+i*60000, open: 100+i, high: 101+i,
      low: 99+i, close: 100.5+i, volume: .25, is_closed: true,
    })) as KlineBar[]
    const bars = resampleOkxBars(rows, "240m")
    expect(bars.map(b => b.time)).toEqual(["2026-10-01 00:00:00", "2026-10-01 04:00:00"])
    expect(bars[0]).toMatchObject({open:100, high:340, low:99, close:339.5, volume:60})
    expect(resampleOkxBars(rows.slice(1), "240m")).toHaveLength(1)
    expect(resampleOkxBars(rows.slice(0, 239), "240m")).toHaveLength(0)
  })
  it("downloads the shorter resonance period and enough warmup", () => {
    const body = {symbol:"btcusdt", timeframe:"240m", start_date:"2026-09-01", end_date:"2026-09-02", strategy_type:"swing_pro" as const, strategy_params:{htf_tf:"60m"}}
    expect(backtestDataTimeframe(body)).toBe("60m")
    expect(backtestWarmupBars(body)).toBe(960)
    expect(TIMEFRAME_MAX_DAYS["240m"]).toBe(365)
    expect(multiSegmentMinDays("240m", 2)).toBe(730)
  })
  it("counts down to 04:00 and normalizes forming volume across four hours", () => {
    const at = Date.UTC(2026,9,1,3,59,59)/1000
    expect(computeRemainingSec([{start:"00:00",end:"24:00",cross_midnight:false}],at,PERIOD_MINUTES["240m"])).toBe(1)
    const span = TIMEFRAME_SECONDS["240m"]
    expect(span).toBe(14400)
    expect(barStartMs(14_399_999, span)).toBe(0)
    expect(barStartMs(14_400_000, span)).toBe(14_400_000)
    const rows = [{ts:0, open:100,high:101,low:99,close:100,vol:3,quote:300,takerBuyVol:1,takerBuyQuote:100,count:1}]
    const opts = {barSpanSeconds:span,normalizeVolume:true}
    const half = buildFormingBar(rows,0,1,0,7_200_000,opts,NaN,()=>[])
    expect(half.volume).toBe(6)
    expect(half.forming).toBe(true)
    const closed = buildFormingBar(rows,0,1,0,14_400_000,opts,NaN,()=>[])
    expect(closed.volume).toBe(3)
    expect(closed.forming).toBe(false)
  })
  it("repairs gaps spanning more than the old six-hour session limit", () => {
    expect(detectTailGap("240m", "2026-10-01 00:00:00", [{time:"2026-10-01 12:00:00",open:100,high:101,low:99,close:100,volume:3}])).toBe("2026-10-01 00:00:00=>2026-10-01 12:00:00")
  })
})

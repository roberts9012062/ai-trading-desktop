import {existsSync,readFileSync} from "node:fs"
import {describe,it,expect} from "vitest"
import {archiveCsv,parseOkxCandles,parseOkxTrades,contractValueFromCandles} from "./okx-history"
import {digestSha256} from "./shortline/digest"
const base = ".local-data/okx/BTC-USDT-SWAP-"
describe.skipIf(!existsSync(`${base}trades-2026-09-28.zip`))("Real OKX official archive verification",() => {
  it("matches per-minute base/quote volume and price against independent candle file",{timeout:90000},() => {
    const bars = parseOkxCandles(archiveCsv(new Uint8Array(readFileSync(`${base}candlesticks-2026-09-28.zip`))),"BTCUSDT")
    const value = contractValueFromCandles(bars)
    const buckets = parseOkxTrades(archiveCsv(new Uint8Array(readFileSync(`${base}trades-2026-09-28.zip`))),"BTCUSDT","2026-09-28",value)
    expect(bars).toHaveLength(1440);expect(value).toBeCloseTo(.01)
    for (const bar of bars) {
      const sec = bar.open_time!/1000, selected = buckets.filter((b) => b.ts >= sec && b.ts < sec+60)
      expect(selected[0]!.open).toBe(bar.open);expect(selected.at(-1)!.close).toBe(bar.close)
      expect(Math.max(...selected.map((b) => b.high))).toBe(bar.high)
      expect(Math.min(...selected.map((b) => b.low))).toBe(bar.low)
      expect(selected.reduce((s,b) => s+b.vol,0)).toBeCloseTo(bar.volume,6)
      expect(selected.reduce((s,b) => s+b.quote,0)).toBeCloseTo(bar.quote_volume!,3)
    }
    console.log(`[OKX-real] candles=${bars.length} seconds=${buckets.length} contract_value=${value} digest_sha=${digestSha256(buckets)}`)
  })
})

import { expect, it } from "vitest"
import { reboundLongEntry, reboundShortEntry } from "./macd-ma20"
import type { Bar } from "./rules"
const now = 1800000000
function bars(...pairs: [number, number][]): Bar[] {
  const candles: [number, number][] = [...Array.from({length:110}, (): [number,number] => [100,100]), ...pairs]
  return candles.map(([o,c],i)=>[(now-(candles.length-i)*1800)*1000,o,Math.max(o,c)+.05,Math.min(o,c)-.05,c,10])
}
it("requires an actual bearish third candle rather than MA20 catching a rising price", () => {
  expect(reboundShortEntry(bars([100,106],[106,111],[111,111.1]),"30m",now)).toBeNull()
  expect(reboundShortEntry(bars([100,106],[106,111],[111,110.9]),"30m",now)).toBeTruthy()
})
it("only buys mean reversion below MA20", () => {
  expect(reboundLongEntry(bars([120,114],[114,108]),"30m",now)).toBeNull()
  expect(reboundLongEntry(bars([100,95],[95,89.5]),"30m",now)).toBeTruthy()
})

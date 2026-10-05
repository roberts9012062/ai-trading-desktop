import {existsSync,readFileSync} from "node:fs"
import {describe,it,expect,vi} from "vitest"
import {archiveCsv,parseOkxCandles,parseOkxTrades,contractValueFromCandles,fetchOkxHistoryRange} from "./okx-history"
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
describe.skipIf(!existsSync(`${base}candlesticks-2023-07.zip`))("Real legacy OKX archive verification",()=>{
 it("reads all July minutes and local research bars with verified contract volume and missing turnover",async()=>{
  const reference=parseOkxCandles(archiveCsv(new Uint8Array(readFileSync(`${base}candlesticks-2023-08-25.zip`))),"BTCUSDT")
  const unit=contractValueFromCandles(reference)
  expect(unit).toBeCloseTo(.01)
  const old=parseOkxCandles(archiveCsv(new Uint8Array(readFileSync(`${base}candlesticks-2023-07.zip`))),"BTCUSDT",unit)
  expect(old).toHaveLength(44640)
  expect(old[0]).toMatchObject({volume:229.59,quote_volume:null,close:30028.799999999999})
  vi.stubGlobal("fetch",vi.fn(async(url:string)=>{
   const filename=decodeURIComponent(url.split("/").at(-1)!)
   const path=`.local-data/okx/${filename}`
   return existsSync(path)?new Response(new Uint8Array(readFileSync(path)) as BodyInit):new Response(null,{status:404})
  }))
  try{
   const from=Date.UTC(2023,6,1)-8*3600000
   const bars=await fetchOkxHistoryRange("BTCUSDT","15m",from,from+31*86400000-1)
   expect(bars).toHaveLength(2976)
   expect(bars[0]!.quote_volume).toBeNull()
   expect(bars.some(b=>b.funding_rate!=null)).toBe(true)
   expect(bars.every(b=>Number.isFinite(b.volume)&&b.volume>=0)).toBe(true)
  }finally{vi.unstubAllGlobals()}
 })
 it("retains elapsed October candles tagged zero and deduplicates identical repeated blocks",()=>{
  const bars=parseOkxCandles(archiveCsv(new Uint8Array(readFileSync(`${base}candlesticks-2023-10.zip`))),"BTCUSDT")
  expect(bars).toHaveLength(44640)
  expect(new Set(bars.map(b=>b.open_time)).size).toBe(44640)
 })
})

import { describe, expect, it, vi, afterEach } from "vitest"
import { okxArchiveUrl, parseOkxCandles, parseOkxFunding, parseOkxTrades,
  resampleOkxBars, fetchOkxArchive, contractValueFromCandles } from "./okx-history"

const t = Date.UTC(2026, 8, 28)-8*3600000
const head = "instrument_name,open,high,low,close,vol,vol_ccy,vol_quote,open_time,confirm"
const candle = (at: number, close = 101) => `BTC-USDT-SWAP,100,106,99,${close},200,2,201,${at},1`
const csv = [head, ...Array.from({length:5}, (_,i) => candle(t+i*60000,101+i))].join("\n")
afterEach(() => vi.unstubAllGlobals())
describe("OKX official local history", () => {
  it("uses official CDN with validated symbols and archive paths", () => {
    expect(okxArchiveUrl("trades","btcusdt","2026-09-28")).toContain("/trades/daily/20260928/BTC-USDT-SWAP-trades-2026-09-28.zip")
    expect(okxArchiveUrl("funding","BTC-USDT-SWAP","2026-09")).toContain("/swaprates/monthly/202609/BTC-USDT-SWAP-fundingrates-2026-09.zip")
    expect(() => okxArchiveUrl("candles","../BTCUSDT","2026-09")).toThrow()
    expect(() => okxArchiveUrl("candles","BTCUSDT","2026-02-30")).toThrow()
  })
  it("reads base volume and UTC timestamp, resamples only complete buckets", () => {
    const bars = parseOkxCandles(csv,"BTCUSDT")
    expect(bars[0]).toMatchObject({time:"2026-09-28 00:00:00",volume:2,open_time:t,market_source:"okx"})
    expect(contractValueFromCandles(bars)).toBeCloseTo(.01)
    expect(resampleOkxBars(bars,"5m")).toMatchObject([{open:100,close:105,volume:10,quote_volume:1005}])
    expect(resampleOkxBars(bars.slice(0,4),"5m")).toEqual([])
    expect(parseOkxCandles(head+"\n"+candle(t)+"\n"+candle(t),"BTCUSDT")).toHaveLength(1)
    expect(() => parseOkxCandles(head+"\n"+candle(t)+"\n"+candle(t,102),"BTCUSDT")).toThrow()
    expect(() => parseOkxCandles(csv.replace("BTC-USDT-SWAP,100","ETH-USDT-SWAP,100"),"BTCUSDT")).toThrow()
  })
  it("recovers legacy missing base volume from verified contract units and preserves missing quote volume", () => {
    const old = head+"\n"+candle(t).replace(",2,201,",",None,None,")
    expect(parseOkxCandles(old,"BTCUSDT",.01)[0]).toMatchObject({volume:2,quote_volume:null,contract_volume:200})
    expect(() => parseOkxCandles(old,"BTCUSDT")).toThrow(/合约面值/)
    expect(() => parseOkxCandles(old.replace(",None,None,",",broken,None,"),"BTCUSDT",.01)).toThrow()
  })
  it("infers units within the mixed August archive and retains historical closed rows tagged zero", () => {
    const old = candle(t).replace(",2,201,",",None,None,")
    const normal = candle(t+60000).replace(/,1$/,",0")
    const bars = parseOkxCandles(head+"\n"+old+"\n"+normal,"BTCUSDT")
    expect(bars).toHaveLength(2)
    expect(bars[0]!.volume).toBe(2)
    expect(resampleOkxBars(bars,"1m")[0]!.quote_volume).toBeNull()
    const future=candle(Math.ceil(Date.now()/60000)*60000).replace(/,1$/,",0")
    expect(parseOkxCandles(head+"\n"+future,"BTCUSDT")).toEqual([])
  })
  it("converts contract sizes and taker side; rejects wrong day or order", () => {
    const h = "instrument_name,trade_id,side,price,size,created_time,source\n"
    const rows = [`BTC-USDT-SWAP,1,buy,100,10,${t},0`,`BTC-USDT-SWAP,2,sell,101,20,${t+400},0`]
    const b = parseOkxTrades(h+rows.join("\n"),"BTCUSDT","2026-09-28",.01)
    expect(b).toHaveLength(1)
    expect(b[0]!.vol).toBeCloseTo(.3)
    expect(b[0]!.takerBuyVol).toBeCloseTo(.1)
    expect(b[0]!.quote).toBeCloseTo(30.2)
    expect(() => parseOkxTrades(h+rows.reverse().join("\n"),"BTCUSDT","2026-09-28",.01)).toThrow()
    expect(() => parseOkxTrades(h+rows.join("\n"),"BTCUSDT","2026-09-29",.01)).toThrow()
  })
  it("parses funding without replacing missing rows with zero", () => {
    expect(parseOkxFunding(`instrument_name,funding_rate,funding_time\nBTC-USDT-SWAP,-0.0001,${t}`,"BTCUSDT")).toEqual([{t,r:-.0001}])
    expect(() => parseOkxFunding(`instrument_name,funding_rate,funding_time\nBTC-USDT-SWAP,,${t}`,"BTCUSDT")).toThrow()
  })
  it("returns missing for 404 and never requests a trading server", async () => {
    const fn = vi.fn().mockResolvedValue(new Response(null,{status:404})); vi.stubGlobal("fetch",fn)
    expect(await fetchOkxArchive("candles","BTCUSDT","2026-09-28")).toBeNull()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(String(fn.mock.calls[0]![0])).toContain("cloudfront.net/cdn/")
    const c = new AbortController(); c.abort()
    await expect(fetchOkxArchive("candles","BTCUSDT","2026-09-27",c.signal)).rejects.toMatchObject({name:"AbortError"})
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

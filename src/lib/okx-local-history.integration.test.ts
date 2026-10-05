import {beforeEach,afterEach,describe,it,expect,vi} from "vitest"
import {IDBFactory,IDBKeyRange} from "fake-indexeddb"
import {zipSync} from "fflate"
const t = Date.UTC(2026,8,28)-8*3600000, day = "2026-09-28"
const encode = (text:string) => zipSync({"test.csv":new TextEncoder().encode(text)})
const candles = encode("instrument_name,open,high,low,close,vol,vol_ccy,vol_quote,open_time,confirm\n"+
  Array.from({length:1440},(_,i) => `BTC-USDT-SWAP,100,101,99,100,200,2,200,${t+i*60000},1`).join("\n"))
const trades = encode("instrument_name,trade_id,side,price,size,created_time,source\n"+
  `BTC-USDT-SWAP,1,buy,100,10,${t},0\nBTC-USDT-SWAP,2,sell,100,20,${t+1000},0`)
const funding = encode(`instrument_name,funding_rate,funding_time\nBTC-USDT-SWAP,.0001,${t}`)

beforeEach(() => {
  vi.resetModules();vi.stubGlobal("indexedDB",new IDBFactory());vi.stubGlobal("IDBKeyRange",IDBKeyRange)
})
afterEach(() => vi.unstubAllGlobals())
describe("OKX local data provenance and persistence",() => {
  it("downloads official files once, reuses local cache, and marks unpublished funding missing",async () => {
    const request = vi.fn(async (url:string) => {
      expect(url).toMatch(/^https:\/\/(dfccd2aelcoyz.cloudfront.net|static.okx.com)\/cdn\//)
      if (url.includes("candlesticks")) return new Response(candles as BodyInit)
      if (url.includes("fundingrates-2026-09")) return new Response(funding as BodyInit)
      return new Response(null,{status:404})
    });vi.stubGlobal("fetch",request)
    const history = await import("./okx-history")
    const first = await history.fetchOkxHistoryRange("BTCUSDT","15m",t,t+86400000-1)
    expect(first).toHaveLength(96);expect(first[0]!.volume).toBe(30)
    expect(first[0]!.funding_rate).toBe(.0001)
    const count = request.mock.calls.length
    expect(await history.fetchOkxHistoryRange("BTCUSDT","15m",t,t+86400000-1)).toEqual(first)
    expect(request).toHaveBeenCalledTimes(count)
    expect(history.joinOkxFunding([{...first[0]!,open_time:t+2*86400000}], [{t,r:.0001}])[0]!.funding_rate).toBeNull()
  })
  it("keeps old Binance keys unchanged and isolates OKX digest, usage, and timezone injection",async () => {
    const p = await import("./shortline/backfill/pipeline")
    const bucket = {ts:t/1000,open:100,high:100,low:100,close:100,vol:1,quote:100,takerBuyVol:1,takerBuyQuote:100,count:1}
    expect(p.digestKey("BTCUSDT",day)).toBe(`BTCUSDT:${day}`)
    await p.saveDayDigest("BTCUSDT",day,[bucket])
    await p.saveDayDigest("BTCUSDT",day,[{...bucket,vol:2,quote:200}],"okx")
    expect((await p.loadDayDigest("BTCUSDT",day))![0]!.vol).toBe(1)
    expect((await p.loadDayDigest("BTCUSDT",day,"okx"))![0]!.vol).toBe(2)
    expect(await p.listDayDigestMetadata("BTCUSDT","okx")).toMatchObject([{source:"okx",day}])
    expect((await p.digestUsage("BTCUSDT","okx")).days).toBe(1)
    expect((await p.digestUsage()).days).toBe(2)
    const {enrichBarsWithOrderflow} = await import("./shortline/task-enrich")
    const rows = [{time:"2026-09-28 00:00:00",close:100}]
    expect((await enrichBarsWithOrderflow(rows,"BTCUSDT","1m","okx")).enrichedBars).toBe(1)
    await p.deleteDayDigests("BTCUSDT",[day],"okx")
    expect(await p.loadDayDigest("BTCUSDT",day,"okx")).toBeNull()
    expect(await p.loadDayDigest("BTCUSDT",day)).not.toBeNull()
  })
  it("aggregates OKX trades with verified contract units and resumes without network",async () => {
    const p = await import("./shortline/backfill/pipeline")
    const request = vi.fn(async (url:string) => new Response((url.includes("candlesticks") ? candles : trades) as BodyInit))
    vi.stubGlobal("fetch",request)
    const summary = await p.runBackfillWithStore({symbol:"BTCUSDT",source:"okx",fromDay:day,toDay:day})
    expect(summary).toMatchObject({done:1,failed:0,missing:0})
    const buckets = await p.loadDayDigest("BTCUSDT",day,"okx")
    expect(buckets![0]!.vol).toBeCloseTo(.1);expect(buckets![1]!.takerBuyVol).toBe(0)
    const calls = request.mock.calls.length
    expect(await p.runBackfillWithStore({symbol:"BTCUSDT",source:"okx",fromDay:day,toDay:day})).toMatchObject({done:0,skipped:1})
    expect(request).toHaveBeenCalledTimes(calls)
  })
  it("does not mark a day downloaded when local storage cannot commit",async () => {
    vi.stubGlobal("indexedDB",undefined)
    const p = await import("./shortline/backfill/pipeline")
    vi.stubGlobal("fetch",vi.fn(async (url:string) => new Response((url.includes("candlesticks") ? candles : trades) as BodyInit)))
    expect(await p.runBackfillWithStore({symbol:"BTCUSDT",source:"okx",fromDay:day,toDay:day})).toMatchObject({done:0,failed:1})
  })
  it("keeps OKX research entirely local and separates it from old forwarded caches",async () => {
    const cache = await import("./research-kline-cache")
    await cache.writeResearchKlines("okx","BTCUSDT","15m",[{time:"2026-09-28 00:00:00",open:999,high:999,low:999,close:999,volume:1}])
    const request = vi.fn(async (url:string) => {
      if (url.includes("candlesticks")) return new Response(candles as BodyInit)
      if (url.includes("fundingrates")) return new Response(funding as BodyInit)
      throw new Error(`unexpected server request ${url}`)
    });vi.stubGlobal("fetch",request)
    const {fetchBacktestBars} = await import("./local-backtest")
    const bars = await fetchBacktestBars("BTCUSDT","15m",day,day,150,undefined,undefined,"okx")
    expect(bars).toHaveLength(96);expect(bars[0]!.close).toBe(100)
    expect(request.mock.calls.every(([u]) => !u.includes("/api/"))).toBe(true)
    const {getChannelRange} = await import("./history-channels")
    const before = request.mock.calls.length
    expect((await getChannelRange("okx","BTCUSDT","15m")).min_date).toBe("2023-07-01")
    expect(request).toHaveBeenCalledTimes(before)
  })
})

import {afterEach,beforeEach,describe,expect,it,vi} from "vitest"
import {zipSync} from "fflate"
import {IDBFactory,IDBKeyRange} from "fake-indexeddb"
beforeEach(()=>{vi.resetModules();vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-05T01:00:00Z"))})
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()})
describe("Binance local research channel",()=>{
  it("exposes a local archive date range without server or private API requests",async()=>{
    const request=vi.fn();vi.stubGlobal("fetch",request)
    const {getChannelRange}=await import("./history-channels")
    expect(await getChannelRange("binance_usdt","btcusdt","15m")).toMatchObject({channel:"binance_usdt",min_date:"2019-09-02",max_date:"2026-10-03"})
    expect(request).not.toHaveBeenCalled()
    const {researchFactorRangeFor}=await import("@/components/factor-lab/factor-range-limits")
    expect(researchFactorRangeFor("1d","binance_usdt").end).toBe("2026-10-03")
  })
  it("retains candles when the monthly funding archive is not published, without inventing zero funding",async()=>{
    vi.stubGlobal("fetch",vi.fn(async(url:string)=>{
      expect(url).toMatch(/^https:\/\/data.binance.vision\/data\/futures\/um\/monthly\/fundingRate\//)
      return new Response(null,{status:404})
    }))
    const {enrichBinanceFuturesBars,parseUmKlinesCsv}=await import("./binance-futures")
    const start=Date.UTC(2026,9,1)
    const candles=parseUmKlinesCsv(`${start},100,101,99,100,2,${start+3599999},200,2,1,100,0`,"1h")
    const enriched=await enrichBinanceFuturesBars("btcusdt",candles)
    expect(enriched).toHaveLength(1)
    expect(enriched[0]).toMatchObject({market_source:"binance_usdt",volume:2,funding_rate:null,funding_time:null})
    expect(fetch).toHaveBeenCalledTimes(2) // preceding September + unpublished October
  })
  it("downloads official perpetual candles and settled funding with their original units",async()=>{
    const start=Date.UTC(2024,0,1)
    const zip=(csv:string)=>zipSync({"archive.csv":new TextEncoder().encode(csv)})
    const request=vi.fn(async(url:string)=>{
      expect(url).toMatch(/^https:\/\/data.binance.vision\/data\/futures\/um\//)
      if(url.includes("/klines/"))return new Response(zip(`${start},100,101,99,100,2,${start+3599999},200,2,1,100,0`) as BodyInit)
      return new Response(zip(`calc_time,funding_interval_hours,last_funding_rate\n${start},8,0.0001`) as BodyInit)
    });vi.stubGlobal("fetch",request)
    const {getChannelKlineApi}=await import("./kline-channels")
    const {enrichBinanceFuturesBars}=await import("./binance-futures")
    const page=await getChannelKlineApi("btcusdt","60m",{endTime:"2024-01-02 00:00:00"},"binance_usdt")
    expect((await enrichBinanceFuturesBars("btcusdt",page.bars))[0]).toMatchObject({market_source:"binance_usdt",volume:2,quote_volume:200,funding_rate:.0001})
  })
  it("loads only the requested historical month and reuses Binance cache without taking OKX bars",async()=>{
    vi.useRealTimers();vi.stubGlobal("indexedDB",new IDBFactory());vi.stubGlobal("IDBKeyRange",IDBKeyRange)
    const {writeResearchKlines,readResearchKlines}=await import("./research-kline-cache")
    await writeResearchKlines("okx","btcusdt","15m",[{time:"2024-01-02 00:00:00",open:999,high:999,low:999,close:999,volume:999}])
    const start=Date.UTC(2024,0,1),zip=(csv:string)=>zipSync({"archive.csv":new TextEncoder().encode(csv)})
    const request=vi.fn(async(url:string)=>{
      expect(url).toMatch(/^https:\/\/data.binance.vision\/data\/futures\/um\//)
      if(url.includes("/klines/")){
        expect(url).toContain("BTCUSDT-15m-2024-01.zip")
        return new Response(zip(Array.from({length:288},(_,i)=>`${start+i*900000},100,101,99,100,2,${start+(i+1)*900000-1},200,2,1,100,0`).join("\n")) as BodyInit)
      }
      return new Response(zip("calc_time,funding_interval_hours,last_funding_rate\n"+Array.from({length:9},(_,i)=>`${start+i*8*3600000},8,.0001`).join("\n")) as BodyInit)
    });vi.stubGlobal("fetch",request)
    const {fetchBacktestBars}=await import("./local-backtest")
    const bars=await fetchBacktestBars("btcusdt","15m","2024-01-02","2024-01-03",undefined,undefined,undefined,"binance_usdt")
    expect(bars).toHaveLength(192);expect(bars.every(b=>b.volume===2&&b.market_source==="binance_usdt")).toBe(true)
    await vi.waitFor(async()=>expect(await readResearchKlines("binance_usdt","btcusdt","15m")).not.toBeNull())
    const count=request.mock.calls.length
    const cached=await fetchBacktestBars("btcusdt","15m","2024-01-02","2024-01-02",undefined,undefined,undefined,"binance_usdt")
    expect(cached).toHaveLength(96);expect(request).toHaveBeenCalledTimes(count)
    expect((await readResearchKlines("okx","btcusdt","15m"))![0]!.close).toBe(999)
  })
})

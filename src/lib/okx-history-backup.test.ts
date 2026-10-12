import {afterEach,beforeEach,describe,expect,it,vi} from "vitest"
import {IDBFactory,IDBKeyRange} from "fake-indexeddb"
import {zipSync} from "fflate"

const day="2026-09-28", start=Date.UTC(2026,8,28)-8*3600000, end=start+86400000
const header="instrument_name,open,high,low,close,vol,vol_ccy,vol_quote,open_time,confirm\n"
const rows=Array.from({length:1440},(_,i)=>[String(start+i*60000),"100","101","99","100","200","2","200","1"])
const archive=(data=rows)=>zipSync({"candles.csv":new TextEncoder().encode(header+data.map(r=>`ADA-USDT-SWAP,${r.slice(1,8).join(",")},${r[0]},1`).join("\n"))})
beforeEach(()=>{vi.resetModules();vi.stubGlobal("indexedDB",new IDBFactory());vi.stubGlobal("IDBKeyRange",IDBKeyRange)})
afterEach(()=>vi.unstubAllGlobals())
function network(mode:"missing"|"offline"|"gap"|"bad"="missing", apiRows=rows) {
  const api:string[]=[]
  const fetcher=vi.fn(async(url:string,init?:RequestInit)=>{
    if(url.includes("/cdn/")) {
      if(url.includes("fundingrates"))return new Response(null,{status:404})
      if(mode==="offline")throw new TypeError("connection unavailable")
      if(mode==="bad")return new Response("invalid zip")
      if(mode==="gap")return new Response(archive(rows.filter((_,i)=>i!==600)) as BodyInit)
      return new Response(null,{status:404})
    }
    expect(init?.credentials).toBe("omit");expect(init?.headers).toBeUndefined()
    const u=new URL(url);expect(u.pathname).toBe("/api/v5/market/history-candles")
    expect(u.searchParams.get("instId")).toBe("ADA-USDT-SWAP")
    expect(u.searchParams.get("bar")).toBe("1m");expect(u.searchParams.get("limit")).toBe("100")
    api.push(url)
    const after=Number(u.searchParams.get("after"))
    return Response.json({code:"0",data:apiRows.filter(r=>Number(r[0])<after).toReversed().slice(0,100)})
  })
  vi.stubGlobal("fetch",fetcher);return {api,fetcher}
}
describe("OKX backup download source",()=>{
  it("falls back from unpublished archives to official REST, caches a complete day and preserves OKX units",async()=>{
    const {api}=network();const h=await import("./okx-history");const progress=vi.fn()
    const bars=await h.fetchOkxHistoryRange("ADAUSDT","15m",start,end-1,progress)
    expect(bars).toHaveLength(96);expect(bars[0]).toMatchObject({volume:30,market_source:"okx",funding_rate:null})
    expect(api).toHaveLength(15);expect(progress.mock.calls.flat().join(" ")).toContain("备用")
    expect(await h.fetchOkxHistoryRange("ADAUSDT","15m",start,end-1)).toEqual(bars)
    expect(api).toHaveLength(15)
  },12000)
  it("also falls back after both archive hosts fail",async()=>{
    const {api}=network("offline");const h=await import("./okx-history")
    expect(await h.fetchOkxHistoryRange("ADAUSDT","15m",start,end-1)).toHaveLength(96)
    expect(api).toHaveLength(15)
  },12000)
  it("manual REST mode skips candle archive requests",async()=>{
    const {api,fetcher}=network();const h=await import("./okx-history")
    expect(await h.fetchOkxHistoryRange("ADAUSDT","15m",start,end-1,undefined,{source:"rest"})).toHaveLength(96)
    expect(api).toHaveLength(15)
    expect(fetcher.mock.calls.some(([u])=>u.includes("candlesticks"))).toBe(false)
  },12000)
  it("archive-only mode never silently enables the backup",async()=>{
    const {api}=network();const h=await import("./okx-history")
    await expect(h.fetchOkxHistoryRange("ADAUSDT","15m",start,end-1,undefined,{source:"archive"})).rejects.toThrow(/归档/)
    expect(api).toHaveLength(0)
  })
  it("fills a missing archive minute only after REST matches every overlapping candle",async()=>{
    const {api}=network("gap");const h=await import("./okx-history")
    expect(await h.fetchOkxHistoryRange("ADAUSDT","15m",start,end-1)).toHaveLength(96)
    expect(api).toHaveLength(15)
  },12000)
  it("rejects conflicting archive and REST values rather than mixing incompatible histories",async()=>{
    const changed=rows.map(r=>[...r]);changed[0]![4]="100.5"
    network("gap",changed);const h=await import("./okx-history")
    await expect(h.fetchOkxHistoryRange("ADAUSDT","15m",start,end-1)).rejects.toThrow(/不一致/)
  },12000)
  it("does not fabricate an absent REST minute or accept the incomplete day",async()=>{
    network("missing",rows.filter((_,i)=>i!==600));const h=await import("./okx-history")
    await expect(h.fetchOkxHistoryRange("ADAUSDT","15m",start,end-1)).rejects.toThrow(/缺失|不完整/)
  },12000)
  it("does not bypass invalid archive contents with REST",async()=>{
    const {api}=network("bad");const h=await import("./okx-history")
    await expect(h.fetchOkxHistoryRange("ADAUSDT","15m",start,end-1)).rejects.toThrow(/校验失败/)
    expect(api).toHaveLength(0)
  })
  it("honors cancellation before starting any download",async()=>{
    const {fetcher}=network();const h=await import("./okx-history");const controller=new AbortController();controller.abort()
    await expect(h.fetchOkxHistoryRange("ADAUSDT","15m",start,end-1,undefined,{signal:controller.signal})).rejects.toMatchObject({name:"AbortError"})
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("retries an incomplete upstream page on the next run instead of caching its hole",async()=>{
    const data=rows.filter((_,i)=>i!==600)
    const {api}=network("missing",data);const h=await import("./okx-history")
    await expect(h.fetchOkxHistoryRange("ADAUSDT","15m",start,end-1)).rejects.toThrow(/缺失/)
    const before=api.length
    data.splice(600,0,rows[600]!)
    expect(await h.fetchOkxHistoryRange("ADAUSDT","15m",start,end-1)).toHaveLength(96)
    expect(api.length-before).toBeLessThan(15)
    expect(api.length-before).toBeGreaterThan(0)
  },12000)
  it.each(["duplicate","unclosed","oversized"])("rejects %s REST pages before committing them",async(kind)=>{
    network();const h=await import("./okx-history")
    vi.stubGlobal("fetch",vi.fn(async()=>{
      const data=rows.slice(-100).toReversed().map(r=>[...r])
      if(kind==="duplicate")data[1]=data[0]!
      if(kind==="unclosed")data[0]![8]="0"
      if(kind==="oversized")data.push([...rows[0]!])
      return Response.json({code:"0",data})
    }))
    await expect(h.fetchOkxHistoryRange("ADAUSDT","15m",start,end-1,undefined,{source:"rest"})).rejects.toThrow(/分页|未收盘/)
  })
  it("keeps backup candles usable if the funding archive host is offline, with missing funding explicitly null",async()=>{
    const {fetcher}=network();const load=fetcher.getMockImplementation()!
    fetcher.mockImplementation(async(url,init)=>{
      if(url.includes("fundingrates"))throw new TypeError("archive offline")
      return load(url,init)
    })
    const h=await import("./okx-history"),progress=vi.fn()
    const bars=await h.fetchOkxHistoryRange("ADAUSDT","15m",start,end-1,progress,{source:"rest"})
    expect(bars).toHaveLength(96);expect(bars.every(b=>b.funding_rate===null)).toBe(true)
    expect(progress.mock.calls.flat().join(" ")).toContain("资金费率归档连接失败")
  },12000)
})

import {afterEach,beforeEach,describe,expect,it,vi} from "vitest"
import {IDBFactory,IDBKeyRange} from "fake-indexeddb"
import {zipSync,unzipSync} from "fflate"

// Actual SOL April 2024 archive rows. Official API agrees on OHLC, contract
// volume and turnover, but returns 2253.3/911.6/1585.7 SOL instead of 2252/905/1589.
const head="instrument_name,open,high,low,close,vol,vol_ccy,vol_quote,open_time,confirm\n"
const rows=[
  ["1712816640000","173.88","173.92","173.76","173.79","2253.3","2253.3","391728.408","1"],
  ["1712816700000","173.78","173.94","173.76","173.88","911.6","911.6","158453.052","1"],
  ["1712816760000","173.87","173.92","173.78","173.79","1585.7","1585.7","275704.569","1"],
]
const csv=head+rows.map((r,i)=>`SOL-USDT-SWAP,${r.slice(1,6).join(",")},${[2252,905,1589][i]},${r[7]},${r[0]},0`).join("\n")
const zip=zipSync({"original.csv":new TextEncoder().encode(csv)})
const payload=(data:unknown=rows.toReversed())=>Response.json({code:"0",data})

beforeEach(()=>{
  vi.resetModules();vi.stubGlobal("indexedDB",new IDBFactory());vi.stubGlobal("IDBKeyRange",IDBKeyRange)
})
afterEach(()=>vi.unstubAllGlobals())

function network(api:(url:URL)=>Response|Promise<Response>,archive=zip) {
  const fn=vi.fn(async(url:string,init?:RequestInit)=>{
    expect(init?.credentials).toBe("omit")
    if(url.includes("/cdn/"))return new Response(archive as BodyInit)
    const parsed=new URL(url)
    expect(["www.okx.com","app.okx.com"]).toContain(parsed.hostname)
    expect(parsed.pathname).toBe("/api/v5/market/history-candles")
    expect(parsed.searchParams.get("instId")).toBe("SOL-USDT-SWAP")
    expect(parsed.searchParams.get("bar")).toBe("1m")
    return api(parsed)
  })
  vi.stubGlobal("fetch",fn);return fn
}

describe("verified official API repair of corrupt archive base volume",()=>{
  it("repairs the real SOL rows only after cross-checking, records provenance and reuses cache",async()=>{
    const fn=network(()=>payload())
    const h=await import("./okx-history")
    expect(()=>h.parseOkxCandles(csv,"SOLUSDT")).toThrow(/换算不一致/)
    const result=await h.fetchOkxArchive("candles","SOLUSDT","2024-04")
    const bars=h.parseOkxCandles(h.archiveCsv(result!),"SOLUSDT")
    expect(bars.map(b=>b.volume)).toEqual([2253.3,911.6,1585.7])
    expect(h.contractValueFromCandles(bars)).toBe(1)
    const manifest=JSON.parse(new TextDecoder().decode(unzipSync(result!)["repair.json"]))
    expect(manifest).toMatchObject({source:"okx-history-candles",instrument:"SOL-USDT-SWAP",key:"2024-04",rows:3})
    expect(manifest.originalSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(await h.fetchOkxArchive("candles","SOLUSDT","2024-04")).toEqual(result)
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it("paginates exclusively backwards across multiple API pages",async()=>{
    const fn=network(url=>Number(url.searchParams.get("after"))>Number(rows[2]![0])
      ?payload([rows[2]]) :payload(rows.slice(0,2).toReversed()))
    const h=await import("./okx-history")
    const result=await h.fetchOkxArchive("candles","SOLUSDT","2024-04")
    expect(h.parseOkxCandles(h.archiveCsv(result!),"SOLUSDT")).toHaveLength(3)
    expect(fn).toHaveBeenCalledTimes(3)
  })
  it("tries the second official API host after a transport failure",async()=>{
    const fn=network(url=>url.hostname==="www.okx.com" ?new Response(null,{status:503}):payload())
    const h=await import("./okx-history")
    const result=await h.fetchOkxArchive("candles","SOLUSDT","2024-04")
    expect(h.parseOkxCandles(h.archiveCsv(result!),"SOLUSDT")[0]!.volume).toBe(2253.3)
    expect(fn).toHaveBeenCalledTimes(3)
  })
  it("repairs and replaces a hash-valid old cache entry without redownloading the ZIP",async()=>{
    const {openDb,idbPut,OKX_ARCHIVE_STORE}=await import("./idb")
    const {sha256Hex}=await import("./shortline/digest")
    await idbPut((await openDb())!,OKX_ARCHIVE_STORE,{key:"okx-v1:candles:SOL-USDT-SWAP:2024-04",bytes:zip,
      sha256:sha256Hex(zip),savedAt:Date.now(),byteLength:zip.byteLength})
    const fn=network(()=>payload())
    const h=await import("./okx-history")
    const result=await h.fetchOkxArchive("candles","SOLUSDT","2024-04")
    expect(h.parseOkxCandles(h.archiveCsv(result!),"SOLUSDT")[0]!.volume).toBe(2253.3)
    expect(await h.fetchOkxArchive("candles","SOLUSDT","2024-04")).toEqual(result)
    expect(fn).toHaveBeenCalledTimes(1)
  })
  it("preserves gaps in the archive even when API has the missing minute",async()=>{
    const lines=csv.split("\n");lines.splice(2,1)
    network(()=>payload(),zipSync({"gap.csv":new TextEncoder().encode(lines.join("\n"))}))
    const h=await import("./okx-history")
    const result=await h.fetchOkxArchive("candles","SOLUSDT","2024-04")
    const bars=h.parseOkxCandles(h.archiveCsv(result!),"SOLUSDT")
    expect(bars.map(b=>b.open_time)).toEqual([Number(rows[0]![0]),Number(rows[2]![0])])
  })
  it.each(["open","contracts","quote"])("rejects conflicting API %s and never persists a partial repair",async(field)=>{
    const index={open:1,contracts:5,quote:7}[field]!
    const wrong=rows.map(r=>[...r]);wrong[0]![index]=String(Number(wrong[0]![index])+(field==="open"?.01:1))
    if(field==="contracts")wrong[0]![6]=wrong[0]![5]!
    network(()=>payload(wrong.toReversed()))
    const h=await import("./okx-history")
    await expect(h.fetchOkxArchive("candles","SOLUSDT","2024-04")).rejects.toThrow(/交叉校验/)
    const fn=network(()=>payload())
    expect(await h.fetchOkxArchive("candles","SOLUSDT","2024-04")).not.toBeNull()
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it("fails closed when API omits an archive minute",async()=>{
    network(()=>payload([rows[2],rows[0]]))
    const h=await import("./okx-history")
    await expect(h.fetchOkxArchive("candles","SOLUSDT","2024-04")).rejects.toThrow(/缺少/)
  })
  it("rejects unclosed or inconsistent API base volumes",async()=>{
    const bad=rows.map(r=>[...r]);bad[1]![8]="0"
    network(()=>payload(bad.toReversed()))
    const h=await import("./okx-history")
    await expect(h.fetchOkxArchive("candles","SOLUSDT","2024-04")).rejects.toThrow(/未收盘/)
    bad[1]![8]="1";bad[1]![6]="905"
    await expect(h.fetchOkxArchive("candles","SOLUSDT","2024-04")).rejects.toThrow(/换算不一致/)
  })
  it("stops on cancellation without retrying API or caching",async()=>{
    const controller=new AbortController()
    const fn=network(()=>{controller.abort();return payload()})
    const h=await import("./okx-history")
    await expect(h.fetchOkxArchive("candles","SOLUSDT","2024-04",controller.signal)).rejects.toMatchObject({name:"AbortError"})
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it.skipIf(process.env.RUN_OKX_SOL_REPAIR_REAL!=="1")("cross-checks every minute in the actual SOL April 2024 monthly archive",async()=>{
    const {readFileSync,writeFileSync}=await import("node:fs")
    const archive=new Uint8Array(readFileSync(".local-data/SOL-USDT-SWAP-candlesticks-2024-04.zip"))
    const data=JSON.parse(readFileSync(".local-data/SOL-USDT-SWAP-api-2024-04.json","utf8")).rows as string[][]
    const fn=network(url=>payload(data.filter(r=>Number(r[0])<Number(url.searchParams.get("after"))).slice(-300).reverse()),archive)
    const h=await import("./okx-history")
    expect(()=>h.parseOkxCandles(h.archiveCsv(archive),"SOLUSDT")).toThrow(/换算不一致/)
    const result=await h.fetchOkxArchive("candles","SOLUSDT","2024-04")
    const bars=h.parseOkxCandles(h.archiveCsv(result!),"SOLUSDT")
    expect(bars).toHaveLength(43200)
    expect(bars.every((b,i)=>b.volume===Number(data[i]![6]) && b.open_time===Number(data[i]![0]))).toBe(true)
    expect(h.resampleOkxBars(bars,"1d")).toHaveLength(30)
    expect(h.contractValueFromCandles(bars)).toBe(1)
    writeFileSync(".local-data/SOL-USDT-SWAP-repaired-2024-04.zip",result!)
    writeFileSync(".local-data/okx-sol-repair-verification.json",JSON.stringify({archiveMinutes:bars.length,dailyBars:30,apiPages:fn.mock.calls.length-1,
      contractUnit:1,allPricesContractsTurnoverMatch:true,allRepairedBaseVolumesMatchApi:true,
      provenance:JSON.parse(new TextDecoder().decode(unzipSync(result!)["repair.json"]))},null,2))
  },90000)
})

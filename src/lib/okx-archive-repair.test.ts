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
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()})

function network(api:(url:URL)=>Response|Promise<Response>,archive=zip) {
  const fn=vi.fn(async(url:string,init?:RequestInit)=>{
    if(url.endsWith("/api/market/snippet-pool/lease"))return Response.json({nodes:{rest:{id:"assigned",name:"assigned",kind:"rest",url:"https://assigned.example"}}})
    expect(init?.credentials).toBe("omit")
    if(url.includes("/cdn/"))return new Response(archive as BodyInit)
    const parsed=new URL(url)
    expect(["okx-rest-test.kins.eu.org","assigned.example"]).toContain(parsed.hostname)
    expect(init?.headers).toBeUndefined()
    expect(parsed.pathname).toBe("/api/v5/market/history-candles")
    expect(parsed.searchParams.get("instId")).toBe("SOL-USDT-SWAP")
    expect(parsed.searchParams.get("bar")).toBe("1m")
    expect(parsed.searchParams.get("limit")).toBe("100") // Snippets history whitelist.
    return api(parsed)
  })
  vi.stubGlobal("fetch",fn);return fn
}

describe("verified official API repair of corrupt archive base volume",()=>{
  it("continues the same page through a healthy assigned route after HTTP 429 without a cooldown blocking that route",async()=>{
    vi.stubGlobal("localStorage",{getItem:()=>"test-token"})
    const requests:string[]=[]
    vi.stubGlobal("fetch",vi.fn(async(url:string,init?:RequestInit)=>{
      if(url.endsWith("/api/market/snippet-pool/lease")) {
        const excluded=JSON.parse(String(init?.body)).excluded
        return Response.json({nodes:{rest:{id:excluded.includes("one")?"two":"one",name:"route",kind:"rest",url:excluded.includes("one")?"https://two.example":"https://one.example"}}})
      }
      if(url.includes("/cdn/"))return new Response(zip as BodyInit)
      requests.push(url)
      return url.startsWith("https://one.example")?Response.json({code:"50011",msg:"Too Many Requests"},{status:429}):payload()
    }))
    const h=await import("./okx-history")
    const result=await h.fetchOkxArchive("candles","SOLUSDT","2024-04")
    expect(h.parseOkxCandles(h.archiveCsv(result!),"SOLUSDT")).toHaveLength(3)
    expect(requests).toHaveLength(2)
    expect(new URL(requests[0]!).search).toBe(new URL(requests[1]!).search)
    const manifest=JSON.parse(new TextDecoder().decode(unzipSync(result!)["repair.json"]))
    expect(manifest.proxyOrigins).toEqual(["https://two.example"])
  })
  it("waits for Retry-After then retries a rate limited page and preserves actionable terminal errors",async()=>{
    const h=await import("./okx-history")
    vi.useFakeTimers()
    let n=0
    network(()=>++n===1?Response.json({code:"50011"},{status:429,headers:{"Retry-After":"90"}}):payload())
    const progress=vi.fn()
    const work=h.fetchOkxArchive("candles","SOLUSDT","2024-04",undefined,progress)
    const checked=expect(work).resolves.not.toBeNull()
    void checked.catch(()=>{})
    // IDB uses real task dispatch even when timer waits are mocked.
    for(let i=0;i<100 && n===0;i++)await vi.advanceTimersByTimeAsync(1)
    expect(n).toBe(1)
    await vi.advanceTimersByTimeAsync(89000)
    expect(n).toBe(1)
    await vi.advanceTimersByTimeAsync(1100)
    await checked
    expect(n).toBe(2)
    expect(progress.mock.calls.flat().join(" ")).toContain("限流")
  })
  it("bounds persistent 50011 retries and distinguishes upstream unavailability from invalid archive data",async()=>{
    const h=await import("./okx-history")
    vi.useFakeTimers()
    let n=0
    network(()=>{n++;return Response.json({code:"50011",msg:"Too Many Requests"},{status:429})})
    const outcome=h.fetchOkxArchive("candles","SOLUSDT","2024-04").then(()=>null,e=>e as Error)
    await vi.advanceTimersByTimeAsync(190000)
    const error=await outcome
    expect(n).toBe(4)
    expect(error?.message).toContain("校验暂不可用")
    expect(error?.message).toContain("HTTP 429 / OKX 50011")
    expect(error?.message).not.toContain("文件校验失败")
  })
  it("cancels a rate-limit wait immediately without another request",async()=>{
    const h=await import("./okx-history")
    vi.useFakeTimers()
    const controller=new AbortController()
    let n=0
    network(()=>{n++;return Response.json({code:"50011"},{status:429})})
    const outcome=h.fetchOkxArchive("candles","SOLUSDT","2024-04",controller.signal).then(()=>null,e=>e as Error)
    for(let i=0;i<100 && n===0;i++)await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    expect(await outcome).toMatchObject({name:"AbortError"})
    expect(n).toBe(1)
  })
  it("reuses previously verified pages after cancellation without redownloading or accepting partial data",async()=>{
    const controller=new AbortController()
    let n=0
    network(()=>{n++;if(n===1)return payload([rows[2]]);controller.abort();return payload(rows.slice(0,2).toReversed())})
    const h=await import("./okx-history")
    await expect(h.fetchOkxArchive("candles","SOLUSDT","2024-04",controller.signal)).rejects.toMatchObject({name:"AbortError"})
    vi.resetModules()
    const calls=network(url=>{
      expect(Number(url.searchParams.get("after"))).toBe(Number(rows[2]![0]))
      return payload(rows.slice(0,2).toReversed())
    })
    const reloaded=await import("./okx-history")
    const result=await reloaded.fetchOkxArchive("candles","SOLUSDT","2024-04")
    expect(reloaded.parseOkxCandles(reloaded.archiveCsv(result!),"SOLUSDT")).toHaveLength(3)
    expect(calls).toHaveBeenCalledTimes(2) // ZIP + only the unfinished page.
  })
  it("repairs the real SOL rows only after cross-checking, records provenance and reuses cache",async()=>{
    const fn=network(()=>payload())
    const h=await import("./okx-history")
    expect(()=>h.parseOkxCandles(csv,"SOLUSDT")).toThrow(/换算不一致/)
    const result=await h.fetchOkxArchive("candles","SOLUSDT","2024-04")
    const bars=h.parseOkxCandles(h.archiveCsv(result!),"SOLUSDT")
    expect(bars.map(b=>b.volume)).toEqual([2253.3,911.6,1585.7])
    expect(h.contractValueFromCandles(bars)).toBe(1)
    const manifest=JSON.parse(new TextDecoder().decode(unzipSync(result!)["repair.json"]))
    expect(manifest).toMatchObject({source:"okx-history-candles",transport:"snippets",proxyOrigins:["https://okx-rest-test.kins.eu.org"],instrument:"SOL-USDT-SWAP",key:"2024-04",rows:3})
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
  it("uses the authenticated pool assignment without sending the product token to the proxy",async()=>{
    vi.stubGlobal("localStorage",{getItem:(key:string)=>key==="access_token"?"test-product-token":null})
    const fn=network(()=>payload())
    const h=await import("./okx-history")
    const result=await h.fetchOkxArchive("candles","SOLUSDT","2024-04")
    expect(h.parseOkxCandles(h.archiveCsv(result!),"SOLUSDT")[0]!.volume).toBe(2253.3)
    const requests=fn.mock.calls.filter(([url])=>url.includes("/history-candles"))
    expect(requests).toHaveLength(1)
    expect(requests[0]![0]).toContain("https://assigned.example/")
    expect(requests[0]![1]?.headers).toBeUndefined()
    expect(fn.mock.calls.every(([url])=>!url.includes("www.okx.com")&&!url.includes("app.okx.com"))).toBe(true)
  })
  it("reports a proxy failure without trying unreachable official domains",async()=>{
    const fn=network(()=>{throw new Error("proxy network unavailable")})
    const h=await import("./okx-history")
    await expect(h.fetchOkxArchive("candles","SOLUSDT","2024-04")).rejects.toThrow(/校验暂不可用.*Snippets.*连接失败/)
    expect(fn).toHaveBeenCalledTimes(2)
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
  it.skipIf(process.env.RUN_OKX_SNIPPET_LIVE!=="1")("repairs real corrupt SOL rows through the deployed Snippets endpoint",async()=>{
    const {execFile}=await import("node:child_process")
    const {promisify}=await import("node:util")
    const {writeFileSync}=await import("node:fs")
    const curl=promisify(execFile)
    const requested:string[]=[]
    vi.stubGlobal("fetch",async(url:string,init?:RequestInit)=>{
      if(url.includes("/cdn/"))return new Response(zip as BodyInit)
      expect(url.startsWith("https://okx-rest-test.kins.eu.org/api/v5/market/history-candles?")).toBe(true)
      expect(new URL(url).searchParams.get("limit")).toBe("100")
      expect(init?.headers).toBeUndefined();expect(init?.credentials).toBe("omit")
      requested.push(url)
      // Use this session's configured transport proxy without placing its value
      // in command arguments/logs. The application URL remains the Snippets URL.
      const {stdout}=await curl("curl.exe",["-sS","--fail-with-body","--max-time","25",url],{
        env:{...process.env,...(process.env.HTTP_PROXY?{HTTPS_PROXY:process.env.HTTP_PROXY}:{})},
        signal:init?.signal??undefined,maxBuffer:1024*1024,
      })
      return new Response(stdout,{headers:{"Content-Type":"application/json"}})
    })
    const h=await import("./okx-history")
    const result=await h.fetchOkxArchive("candles","SOLUSDT","2024-04")
    expect(h.parseOkxCandles(h.archiveCsv(result!),"SOLUSDT").map(b=>b.volume)).toEqual([2253.3,911.6,1585.7])
    expect(requested).toHaveLength(1)
    writeFileSync(".local-data/okx-sol-snippet-live-verification.json",JSON.stringify({at:new Date().toISOString(),ok:true,
      transport:"snippets",requests:requested,repairedMinutes:3,baseVolumes:[2253.3,911.6,1585.7],
      provenance:JSON.parse(new TextDecoder().decode(unzipSync(result!)["repair.json"]))},null,2))
  },60000)
  it.skipIf(process.env.RUN_OKX_SOL_REPAIR_REAL!=="1")("cross-checks every minute in the actual SOL April 2024 monthly archive",async()=>{
    const {readFileSync,writeFileSync}=await import("node:fs")
    const archive=new Uint8Array(readFileSync(".local-data/SOL-USDT-SWAP-candlesticks-2024-04.zip"))
    const data=JSON.parse(readFileSync(".local-data/SOL-USDT-SWAP-api-2024-04.json","utf8")).rows as string[][]
    const fn=network(url=>payload(data.filter(r=>Number(r[0])<Number(url.searchParams.get("after"))).slice(-100).reverse()),archive)
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
  },180000)
})

import { afterEach, expect, it, vi } from "vitest"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { unzipSync } from "fflate"

afterEach(() => vi.unstubAllGlobals())

// Real deployment nodes read from production's trusted snippet-pool config.
// Lease responses are replayed locally; no product credentials are used.
const origins = ["https://okx-rest-test.kins.eu.org", "https://okx-rest.aeeu.eu.org", "https://okx-rest.zdds.eu.org"]
it.skipIf(process.env.RUN_OKX_SNIPPET_MONTH_LIVE !== "1")("verifies all 43200 SOL April archive minutes over real Snippets with route failover", async () => {
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const { readFileSync, writeFileSync } = await import("node:fs")
  const curl = promisify(execFile)
  vi.resetModules()
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
  vi.stubGlobal("localStorage", { getItem: () => "local-diagnostic-no-credentials" })
  const archive = new Uint8Array(readFileSync(".local-data/SOL-USDT-SWAP-candlesticks-2024-04.zip"))
  const requests: Array<{ origin: string; after: string | null; status: number; code: string; rows: number }> = []
  let assigned = 0
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/market/snippet-pool/lease")) {
      const excluded = JSON.parse(String(init?.body)).excluded as string[]
      if (assigned < 0 || excluded.includes(`route-${assigned}`)) assigned = origins.findIndex((_,i) => !excluded.includes(`route-${i}`))
      return Response.json({ nodes: assigned < 0 ? {} : { rest: {
        id: `route-${assigned}`, kind: "rest", name: "production route", url: origins[assigned],
      } } })
    }
    if (url.includes("/cdn/")) return new Response(archive as BodyInit)
    const target = new URL(url)
    expect(origins).toContain(target.origin)
    expect(target.pathname).toBe("/api/v5/market/history-candles")
    expect(init?.headers).toBeUndefined()
    expect(init?.credentials).toBe("omit")
    const { stdout } = await curl("curl.exe", ["-sS", "--max-time", "25",
      ...(process.env.RUN_OKX_SNIPPET_DIRECT === "1" ? ["--noproxy","*"] : []), "-w", "\n%{http_code}", url], {
      env: { ...process.env, ...(process.env.HTTP_PROXY ? { HTTPS_PROXY: process.env.HTTP_PROXY } : {}) },
      signal: init?.signal ?? undefined, maxBuffer: 1024*1024,
    })
    const split = stdout.lastIndexOf("\n")
    const status = Number(stdout.slice(split+1)), body = stdout.slice(0,split)
    let data: {code?:string;data?:unknown[]}
    try { data=JSON.parse(body) } catch { data={} }
    requests.push({ origin: target.origin, after: target.searchParams.get("after"), status, code: data.code ?? "non-json", rows: data.data?.length ?? 0 })
    if (requests.length % 25 === 0 || status !== 200) console.log(JSON.stringify({ liveRequests: requests.length, ...requests.at(-1) }))
    return new Response(body, { status, headers: { "Content-Type": "application/json" } })
  })
  const h = await import("./okx-history")
  const repaired = await h.fetchOkxArchive("candles", "SOLUSDT", "2024-04", undefined,
    message => { if (message.includes("限流") || message.includes("重试")) console.log(message) })
  const bars = h.parseOkxCandles(h.archiveCsv(repaired!), "SOLUSDT")
  expect(bars).toHaveLength(43200)
  expect(h.resampleOkxBars(bars,"1d")).toHaveLength(30)
  expect(h.contractValueFromCandles(bars)).toBe(1)
  const apiPages = requests.filter(r => r.code === "0")
  expect(apiPages).toHaveLength(432)
  expect(new Set(apiPages.map(r => r.after)).size).toBe(432)
  const before = requests.length
  expect(await h.fetchOkxArchive("candles","SOLUSDT","2024-04")).toEqual(repaired)
  expect(requests).toHaveLength(before)
  writeFileSync(".local-data/SOL-USDT-SWAP-snippets-live-repaired-2024-04.zip",repaired!)
  writeFileSync(".local-data/okx-snippets-month-live.json",JSON.stringify({ at:new Date().toISOString(),
    month:"2024-04", minutes:bars.length, dailyBars:30, requests,
    clientTransport:process.env.RUN_OKX_SNIPPET_DIRECT === "1" ? "local direct to Snippets" : "session transport proxy to Snippets",
    leaseMode:"replayed trusted production config; all candle pages live",
    manifest:JSON.parse(new TextDecoder().decode(unzipSync(repaired!)["repair.json"])) },null,2))
},900000)

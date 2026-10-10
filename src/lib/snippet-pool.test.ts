import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { refreshSnippetPool, resetSnippetPool, snippetFailed, snippetOrigin } from "./snippet-pool"
import { snippetPublicGet, resetSnippetRest } from "./snippet-rest"
import { OkxSnippetWebSocket } from "./okx-snippet-ws"

let current = "account-a"
const node = (id = "one") => ({ id, name: id, kind: "rest", url: `https://${id}.example` })
const lease = (id = "one") => ({ version: 1, nodes: { rest: node(id), public_ws: { ...node(id), kind: "public_ws", url: `wss://${id}.example` } } })
beforeEach(() => { current = "account-a"; vi.stubGlobal("localStorage", { getItem: () => current }); resetSnippetPool(false); resetSnippetRest() })
afterEach(() => { resetSnippetPool(false); vi.unstubAllGlobals(); vi.useRealTimers() })

it("gets authenticated assignments and reuses them between heartbeats", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(lease())))
  vi.stubGlobal("fetch", fetch)
  await refreshSnippetPool(); await refreshSnippetPool()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer account-a")
  expect(snippetOrigin("rest")).toBe("https://one.example")
  expect(() => snippetOrigin("private_ws")).toThrow("暂无可用")
})
it("uses assigned REST and never sends the product token to the proxy", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(lease())))
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: "0", data: ["ok"] })))
    .mockResolvedValue(new Response(JSON.stringify(lease())))
  vi.stubGlobal("fetch", fetch); await refreshSnippetPool()
  expect(await snippetPublicGet("/api/v5/public/time")).toEqual(["ok"])
  expect(fetch.mock.calls[1][0]).toBe("https://one.example/api/v5/public/time")
  expect(fetch.mock.calls[1][1].headers).toBeUndefined()
})
it("fails over only this user and records rate limits without excluding a healthy proxy", async () => {
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(lease(fetch.mock.calls.length > 1 ? "two" : "one"))))
  vi.stubGlobal("fetch", fetch); await refreshSnippetPool()
  await snippetFailed("rest", "https://one.example", true)
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ excluded: [], event: { outcome: "limited" } })
  await snippetFailed("rest", "https://two.example")
  expect(JSON.parse(fetch.mock.calls[2][1].body).excluded).toEqual(["two"])
})
it("ignores an old account response after logout and rejects unsafe server configuration", async () => {
  let resolve!: (response: Response) => void
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(r => { resolve = r })))
  const pending = refreshSnippetPool(); resetSnippetPool(false); current = "account-b"
  resolve(new Response(JSON.stringify(lease("old")))); await pending
  expect(snippetOrigin("rest")).not.toContain("old")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ nodes: { rest: { ...node(), url: "http://127.0.0.1" } } }))))
  await refreshSnippetPool(); expect(snippetOrigin("rest")).toBe("https://okx-rest-test.kins.eu.org")
})
it("keeps healthy WS connections through heartbeats and replaces a disabled endpoint once", async () => {
  vi.useFakeTimers()
  class Socket {
    static all: Socket[] = []
    readyState = 0
    onopen: (() => void) | null = null; onmessage: ((e: { data: string }) => void) | null = null
    onerror: (() => void) | null = null; onclose: (() => void) | null = null
    send = vi.fn(); close = vi.fn(() => { this.readyState = 3 })
    constructor(public url: string) { Socket.all.push(this) }
  }
  let selected = "one"
  vi.stubGlobal("WebSocket", Socket)
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(lease(selected)))))
  await refreshSnippetPool()
  const ws = new OkxSnippetWebSocket(); ws.setQuoteSymbols(["btcusdt"]); ws.connect()
  await vi.advanceTimersByTimeAsync(2000)
  expect(Socket.all[0].url).toBe("wss://one.example/ws/v5/public")
  await refreshSnippetPool(true); await vi.advanceTimersByTimeAsync(1000)
  expect(Socket.all).toHaveLength(1)
  selected = "two"; await refreshSnippetPool(true); await vi.advanceTimersByTimeAsync(6000)
  expect(Socket.all).toHaveLength(2); expect(Socket.all[0].close).toHaveBeenCalledOnce()
  expect(Socket.all[1].url).toBe("wss://two.example/ws/v5/public")
  ws.disconnect()
})

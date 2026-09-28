import { decode, encode } from "@msgpack/msgpack"
import { describe, expect, it, vi } from "vitest"
import { NativeEngineClient } from "./ipc"

const hello = { engine_version: "native-gpu-v1-m1.1", backend: "cuda", fp64_supported: true,
  device_name: "fixture", sm_count: 20, vram_mb: 6140,
  selfcheck: { passed: true, token_count: 20, eval_precision: "f64" as const, coarse_passed: null }, precision: "f64" }
const endpoint = { port: 12345, token: "test-secret-32-characters-long", pid: 1, hello }

class Socket extends EventTarget {
  readyState = 1
  binaryType = "arraybuffer"
  sent: Array<Record<string, unknown>> = []
  send(frame: string | Uint8Array) {
    const message = typeof frame === "string" ? JSON.parse(frame) : decode(frame)
    this.sent.push(message)
    if (message.type === "hello") queueMicrotask(() => this.reply(message, hello))
  }
  reply(request: Record<string, unknown>, payload: unknown, binary = false) {
    const envelope = { ...request, payload }
    this.dispatchEvent(new MessageEvent("message", { data: binary ? encode(envelope).slice().buffer : JSON.stringify(envelope) }))
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")) }
}

async function connected() {
  const socket = new Socket()
  const client = new NativeEngineClient({ heartbeatMs: 0, socketFactory: () => {
    queueMicrotask(() => socket.dispatchEvent(new Event("open")))
    return socket as unknown as WebSocket
  } })
  await client.connect(endpoint)
  return { client, socket }
}

describe("Native IPC", () => {
  it("keeps coarse ranking distinct from authoritative metrics", async () => {
    const { client, socket } = await connected()
    const pending = client.rankShards("s", [[0]])
    const request = socket.sent.at(-1)!
    expect(request.payload).toEqual({ candidates: [[0]], coarse: true })
    socket.reply(request, { ranked: [{ tokens: [0], score: .123 }] }, true)
    expect(await pending).toEqual({ ranked: [{ tokens: [0], score: .123 }] })
    const authority = client.evalShards("s", [[0]])
    expect(socket.sent.at(-1)!.payload).toEqual({ candidates: [[0]] })
    socket.reply(socket.sent.at(-1)!, { evaluated: [] }, true)
    await authority
    client.close()
  })

  it("pairs out-of-order binary results by request id", async () => {
    const { client, socket } = await connected()
    const a = client.evalShards("s", [[0]])
    const b = client.evalShards("s", [[1]])
    const [ra, rb] = socket.sent.slice(-2)
    socket.reply(rb, { evaluated: [{ tokens: [1] }] }, true)
    socket.reply(ra, { evaluated: [{ tokens: [0] }] }, true)
    expect((await a).evaluated[0].tokens).toEqual([0])
    expect((await b).evaluated[0].tokens).toEqual([1])
    client.close()
  })

  it("rejects pending work immediately when the sidecar disconnects", async () => {
    const { client, socket } = await connected()
    const promise = client.evalShards("s", [[0]])
    const expected = expect(promise).rejects.toThrow(/断开/)
    socket.close()
    await expected
  })

  it("closes a failed transport and rejects pending work", async () => {
    const { client, socket } = await connected()
    const promise = client.evalShards("s", [[0]])
    const expected = expect(promise).rejects.toThrow(/失败/)
    socket.dispatchEvent(new Event("error"))
    await expected
    expect(socket.readyState).toBe(3)
  })

  it("times out a stalled request without resolving a later request", async () => {
    const { client, socket } = await connected()
    vi.useFakeTimers()
    try {
      const promise = client.evalShards("s", [[0]])
      const expected = expect(promise).rejects.toMatchObject({ code: "TIMEOUT" })
      const request = socket.sent.at(-1)!
      await vi.advanceTimersByTimeAsync(900_000)
      await expected
      const next = client.disposeSession("s")
      socket.reply(request, { evaluated: [] })
      socket.reply(socket.sent.at(-1)!, { disposed: true })
      await next
    } finally { client.close(); vi.useRealTimers() }
  })

  it("aborts one pending request without consuming another result", async () => {
    const { client, socket } = await connected()
    const abort = new AbortController()
    const promise = client.evalShards("s", [[0]], abort.signal)
    const expected = expect(promise).rejects.toMatchObject({ name: "AbortError" })
    abort.abort()
    await expected
    const next = client.disposeSession("s")
    socket.reply(socket.sent.at(-1)!, { disposed: true })
    await next
    client.close()
  })

  it("preserves binary f64 columns and metadata", async () => {
    const { client, socket } = await connected()
    const data = new Float64Array([1.25, NaN, 3])
    const promise = client.loadBars("s", { close: data }, { count: 3, max_bars: 100000 })
    const request = socket.sent.at(-1)!
    expect(request.Authorization).toBe(`Bearer ${endpoint.token}`)
    const bytes = (request.payload as { columns: { close: Uint8Array } }).columns.close
    expect(new Float64Array(bytes.slice().buffer)[1]).toBeNaN()
    socket.reply(request, { loaded: true })
    await promise
    client.close()
  })

  it("closes the connection on forged response authentication", async () => {
    const { client, socket } = await connected()
    const promise = client.evalShards("s", [[0]])
    const expected = expect(promise).rejects.toThrow(/鉴权/)
    socket.reply({ ...socket.sent.at(-1), Authorization: "Bearer wrong" }, {})
    await expected
    expect(socket.readyState).toBe(3)
  })
})

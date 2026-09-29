import { decode, encode } from "@msgpack/msgpack"
import { describe, expect, it, vi } from "vitest"
import { NativeEngineClient } from "./ipc"
import { NATIVE_ENGINE_VERSION } from "./version"

const hello = { engine_version: NATIVE_ENGINE_VERSION, backend: "cuda", fp64_supported: true,
  device_name: "fixture", sm_count: 20, vram_mb: 6140,
  selfcheck: { passed: true, token_count: 20, eval_precision: "f64" as const, coarse_passed: null,
    features_passed: true, reports_passed: true, selection_passed: true, portfolio_passed: true }, precision: "f64" }
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
  it.each(["features_passed", "reports_passed", "selection_passed", "portfolio_passed"])("refuses failed or missing %s startup checks", async (key) => {
    for (const value of [false, undefined]) {
      const socket = new Socket()
      socket.send = (frame) => {
        const message = typeof frame === "string" ? JSON.parse(frame) : decode(frame)
        socket.sent.push(message)
        queueMicrotask(() => socket.reply(message, { ...hello, selfcheck: { ...hello.selfcheck, [key]: value } }))
      }
      const client = new NativeEngineClient({ heartbeatMs: 0, socketFactory: () => {
        queueMicrotask(() => socket.dispatchEvent(new Event("open")))
        return socket as unknown as WebSocket
      } })
      await expect(client.connect(endpoint)).rejects.toMatchObject({ code: "SELF_CHECK_FAILED" })
      expect(socket.readyState).toBe(3)
    }
  })

  it("preserves precise authority, strict prefetch and sealed-generation control", async () => {
    const { client, socket } = await connected()
    const strict = client.strictEval("frozen", [[0], [1]])
    const strictRequest = socket.sent.at(-1)!
    expect(strictRequest.type).toBe("strict_eval")
    const verdicts = [{ tokens: [0], pass: true, cross_scores: {} }]
    socket.reply(strictRequest, { strict: verdicts })
    expect((await strict).strict).toEqual(verdicts)
    const evaluated = [{ tokens: [0], composite: .1, metrics: { sortino: 1, kernel_version: "native-gpu-v1", native_eval_precision: "f64" } }]
    const payload = { evaluated, best_seen: [], prefetched_strict: verdicts, trials: 3000, final_generation: false }
    const precise = client.precise("frozen", payload)
    const request = socket.sent.at(-1)!
    expect(request.type).toBe("precise")
    expect(request.session_id).toBe("frozen")
    expect(request.payload).toEqual(payload)
    socket.reply(request, { champions: [], best_seen: evaluated, research_candidates: [],
      pending_candidates: [], rejected_candidates: [], qualification_requirements: {} }, true)
    expect((await precise).best_seen).toEqual(evaluated)
    client.close()
  })

  it("refuses research or pending factors labeled as public champions", async () => {
    for (const status of [undefined, "pending", "rejected", "qualified"]) {
      const { client, socket } = await connected()
      const pending = client.precise("frozen", { final_generation: true })
      const check = expect(pending).rejects.toMatchObject({ code: "INVALID_QUALIFICATION" })
      const candidate = { tokens: [0], composite: 1, text: "f", metrics: {
        kernel_version: "native-gpu-v1", native_eval_precision: "f64", native_strict_passed: false },
        qualification: { status, reasons: [] } }
      socket.reply(socket.sent.at(-1)!, { champions: [candidate], best_seen: [], research_candidates: [candidate],
        pending_candidates: [], rejected_candidates: [], qualification_requirements: {} })
      await check
      client.close()
    }
  })

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

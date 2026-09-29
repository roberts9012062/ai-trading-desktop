import { describe, expect, it, vi } from "vitest"
import { NativeProcessQueue } from "./process-lease"

const endpoint = { port: 1234, pid: 7, token: "a".repeat(32) }
describe("shared native process lease", () => {
  it("serializes both entrances and switches precision only after release", async () => {
    const launch = vi.fn(async () => endpoint), stop = vi.fn(async () => {})
    const queue = new NativeProcessQueue(launch, stop)
    const first = await queue.acquire("mixed", new AbortController().signal)
    let entered = false
    const pending = queue.acquire("f64", new AbortController().signal).then(lease => { entered = true; return lease })
    await Promise.resolve()
    expect(entered).toBe(false)
    expect(stop).not.toHaveBeenCalled()
    first.release()
    const second = await pending
    expect(stop).toHaveBeenCalledTimes(1)
    expect(launch.mock.calls).toEqual([[{ precision: "mixed" }], [{ precision: "f64" }]])
    second.release()
    second.release()
  })
  it("removes a cancelled waiter without killing the active process", async () => {
    const stop = vi.fn(async () => {})
    const queue = new NativeProcessQueue(async () => endpoint, stop)
    const first = await queue.acquire("mixed", new AbortController().signal)
    const abort = new AbortController()
    const waiting = queue.acquire("f64", abort.signal)
    abort.abort()
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" })
    first.release()
    const last = await queue.acquire("mixed", new AbortController().signal)
    expect(stop).not.toHaveBeenCalled()
    last.release()
  })
  it("releases the queue on failed startup and on cancellation during startup", async () => {
    const controller = new AbortController()
    const launch = vi.fn().mockRejectedValueOnce(new Error("driver"))
      .mockImplementationOnce(async () => { controller.abort(); return endpoint }).mockResolvedValue(endpoint)
    const queue = new NativeProcessQueue(launch, async () => {})
    await expect(queue.acquire("mixed", new AbortController().signal)).rejects.toThrow("driver")
    await expect(queue.acquire("mixed", controller.signal)).rejects.toMatchObject({ name: "AbortError" })
    const lease = await queue.acquire("mixed", new AbortController().signal)
    lease.release()
  })
})

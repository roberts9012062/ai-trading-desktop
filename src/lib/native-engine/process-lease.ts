import { launchNativeEngine, stopNativeEngine } from "./launcher"
import type { NativeEndpoint, NativePrecision } from "./types"

export interface NativeProcessLease { endpoint: NativeEndpoint; release(): void; invalidate(): Promise<void> }
interface Waiting { resolve: () => void; reject: (error: unknown) => void; signal: AbortSignal; abort: () => void }

/** One resident numerical job across both runners; precision switches only idle. */
export class NativeProcessQueue {
  #busy = false
  #waiting: Waiting[] = []
  #precision?: NativePrecision
  constructor(private launch = launchNativeEngine, private stop = stopNativeEngine) {}

  async acquire(precision: NativePrecision, signal: AbortSignal): Promise<NativeProcessLease> {
    if (signal.aborted) throw new DOMException("已取消", "AbortError")
    if (this.#busy) await new Promise<void>((resolve, reject) => {
      const item: Waiting = { resolve, reject, signal, abort: () => {
        this.#waiting = this.#waiting.filter(row => row !== item)
        reject(new DOMException("已取消", "AbortError"))
      } }
      this.#waiting.push(item)
      signal.addEventListener("abort", item.abort, { once: true })
    })
    this.#busy = true
    let released = false
    const release = () => {
      if (released) return
      released = true
      const next = this.#waiting.shift()
      if (next) {
        next.signal.removeEventListener("abort", next.abort)
        next.resolve()
      } else this.#busy = false
    }
    try {
      if (signal.aborted) throw new DOMException("已取消", "AbortError")
      if (this.#precision && this.#precision !== precision) await this.stop()
      // Never pass a task abort to the shared process launcher.
      const endpoint = await this.launch({ precision })
      this.#precision = precision
      if (signal.aborted) throw new DOMException("已取消", "AbortError")
      return { endpoint, release, invalidate: async () => {
        if (released) throw new Error("已释放的原生任务不能终止共享进程")
        await this.stop()
        this.#precision = undefined
      } }
    } catch (error) { release(); throw error }
  }
}

export const nativeProcessQueue = new NativeProcessQueue()

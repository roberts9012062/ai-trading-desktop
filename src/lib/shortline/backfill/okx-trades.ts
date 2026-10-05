import { archiveCsv, parseOkxTrades } from "@/lib/okx-history"
import type { TickBucket } from "../digest"

/** Native network fetch stays on the main thread; decompression/aggregation is off-thread. */
export async function okxTradeBuckets(zip:Uint8Array,symbol:string,day:string,contractValue:number,signal?:AbortSignal):Promise<TickBucket[]> {
  if (signal?.aborted) throw new DOMException("已停止","AbortError")
  if (typeof Worker === "undefined") return parseOkxTrades(archiveCsv(zip),symbol,day,contractValue)
  return new Promise((resolve,reject) => {
    const worker = new Worker(new URL("./okx-trades.worker.ts",import.meta.url),{type:"module"})
    const clean = () => {worker.terminate();signal?.removeEventListener("abort",abort)}
    const abort = () => {clean();reject(new DOMException("已停止","AbortError"))}
    signal?.addEventListener("abort",abort,{once:true})
    worker.onerror = (e) => {clean();reject(new Error(e.message))}
    worker.onmessage = ({data}:MessageEvent<{buckets?:TickBucket[];error?:string}>) => {
      clean();if (data.error) reject(new Error(data.error));else resolve(data.buckets!)
    }
    const bytes = new Uint8Array(zip) // The transferred buffer must be owned by this worker.
    worker.postMessage({zip:bytes,symbol,day,contractValue},[bytes.buffer])
  })
}

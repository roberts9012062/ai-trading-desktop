import { archiveCsv, parseOkxTrades } from "@/lib/okx-history"
self.onmessage = ({data}:MessageEvent<{zip:Uint8Array;symbol:string;day:string;contractValue:number}>) => {
  try { self.postMessage({buckets:parseOkxTrades(archiveCsv(data.zip),data.symbol,data.day,data.contractValue)}) }
  catch (e) { self.postMessage({error:e instanceof Error ? e.message : String(e)}) }
}

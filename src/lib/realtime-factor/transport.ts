import {isTauri,invoke} from '@tauri-apps/api/core'

interface NativeResponse {status:number;body:string;headers:[string,string][]}
/** The plugin's fetch builds a new Rust client per request. Seconds-mode
 * traffic needs one persistent connection pool across snapshots and heartbeats. */
export async function tryRealtimeRequest(base:string,path:string,options:RequestInit):Promise<Response|null> {
  if(!/^\/api\/ai-trading\/tasks\/[^/]+\/realtime\/(seed|candle|start|heartbeat|stop|decision)$/.test(path)||!isTauri())return null
  if(options.signal?.aborted)throw new DOMException('请求已取消','AbortError')
  const runtimeBase=(globalThis as typeof globalThis&{__QH_API_BASE__?:string}).__QH_API_BASE__
  const result=await invoke<NativeResponse>('realtime_http_request',{
    serverBase:base||runtimeBase||'https://b.00n.top',path,method:options.method??'GET',
    headers:options.headers??{},body:typeof options.body==='string'?options.body:null,
  }).catch(error=>{throw error instanceof Error?error:new Error(String(error))})
  // Native timeout covers response-body consumption too. Never replay a failed
  // write through plugin fetch: an exchange decision may already be processing.
  return new Response([101,103,204,205,304].includes(result.status)?null:result.body,{status:result.status,headers:result.headers})
}

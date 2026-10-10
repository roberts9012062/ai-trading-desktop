/** One authenticated RPC channel; exchange secrets never enter this module. */
import { resolveWsBase } from "./websocket"
import { ensureDesktopRouting, isServerMode, onDesktopRoutingChange } from "./desktop-routing"
import { snippetOrigin, snippetFailed, snippetSucceeded } from "./snippet-pool"

class UnavailableBeforeCall extends Error {}
export class ExchangeOutcomeUnknown extends Error {}
const allowed = /^\/api\/live\/(?:account|positions|positions\/close|positions\/tpsl|orders|orders\/amend|orders\/[A-Za-z0-9:_-]+|leverage|account-mode|bills|fee-rates)$/
const analyticsRead = /^\/api\/(?:live\/daily-pnl(?:\/tasks)?|ai-trading\/(?:tasks(?:\/[a-fA-F0-9-]{36}(?:\/(?:trades|trade-marks))?)?|profit-bars|funding-source))$/
let socket: WebSocket | null = null
let connecting: Promise<void> | null = null
let cancelConnect: (() => void) | null = null
let identity = ""
let heartbeat: ReturnType<typeof setInterval> | null = null
let lastReceive = 0
let privateRetryAt = 0
const pending = new Map<string, { resolve: (response: Response) => void; reject: (error: Error) => void; write: boolean; timer: ReturnType<typeof setTimeout> }>()
const controllers = new Set<AbortController>()
const readCalls = new Map<string, Promise<Response | null>>()

export function disconnectDesktopExchange(): void {
  const cancel = cancelConnect; cancelConnect = null; connecting = null; cancel?.()
  const old = socket; socket = null; identity = ""
  if (heartbeat !== null) clearInterval(heartbeat)
  heartbeat = null
  if (old) { old.onopen = old.onclose = old.onerror = old.onmessage = null; old.close(1000,"desktop transport replaced") }
  for (const controller of controllers) controller.abort()
  controllers.clear()
  for (const item of pending.values()) {
    clearTimeout(item.timer)
    item.reject(item.write ? new ExchangeOutcomeUnknown("连接中断，交易结果未知，请查询订单后再操作；不会自动重发") : new Error("桌面代理连接中断"))
  }
  pending.clear()
}
onDesktopRoutingChange(server => { if (server) disconnectDesktopExchange() })

async function forward(frame: Record<string, unknown>, target: WebSocket): Promise<void> {
  const method = frame.method, path = frame.path
  if (!['GET','POST'].includes(String(method)) || typeof path !== "string" || !/^\/api\/v5\/(account|trade|public)\/[a-z-]+(?:\?[^#]*)?$/.test(path)) return
  const controller = new AbortController(); controllers.add(controller)
  const timeout = setTimeout(() => controller.abort(),8000)
  let result: { status: number; data: unknown } = { status:0,data:null }
  let origin = ""
  const started = Date.now()
  try {
    if (method === 'GET' && Date.now() < privateRetryAt) throw new Error("cooldown")
    // No product JWT, Cookie or API Secret. Signed method/path/body are unchanged.
    origin = snippetOrigin("rest")
    const response = await fetch(origin+path, {method:String(method),headers:frame.headers as Record<string,string>,body:method==='POST' ? String(frame.body) : undefined,signal:controller.signal,redirect:'error',cache:'no-store'})
    const data = await response.json()
    result={status:response.status,data}
    if (response.status===429 || data.code==='50011') void snippetFailed("rest",origin,true)
    else if (response.status>=500) void snippetFailed("rest",origin)
    else if (response.ok && data.code==='0') snippetSucceeded("rest",origin,Date.now()-started)
    if (method==='GET' && (response.status===429 || data.code==='50011' || response.status>=500)) privateRetryAt=Date.now()+60000
  } catch { if (origin) void snippetFailed("rest",origin); if (method==='GET') privateRetryAt=Math.max(privateRetryAt,Date.now()+15000) }
  finally { clearTimeout(timeout);controllers.delete(controller) }
  if (target === socket && target.readyState===1) target.send(JSON.stringify({type:'exchange_result',id:frame.id,...result}))
}

async function connect(): Promise<void> {
  const token = localStorage.getItem("access_token") || ""
  if (!token) throw new UnavailableBeforeCall()
  if (identity !== token) disconnectDesktopExchange()
  if (connecting) return connecting
  if (socket?.readyState===1) return
  const opening = new Promise<void>((resolve,reject) => {
    let target: WebSocket
    try { target = new WebSocket(resolveWsBase(window.location)+"/ws/desktop-exchange") }
    catch { reject(new UnavailableBeforeCall()); return }
    socket=target; identity=token
    const timeout=setTimeout(() => { fail(); },5000)
    cancelConnect = () => { clearTimeout(timeout); reject(new UnavailableBeforeCall()) }
    const fail=() => { clearTimeout(timeout); if (socket===target) disconnectDesktopExchange();reject(new UnavailableBeforeCall()) }
    target.onopen=() => target.send(JSON.stringify({token}))
    target.onerror=fail
    target.onclose=fail
    target.onmessage=event => {
      if (target!==socket || typeof event.data!=="string") return
      lastReceive=Date.now()
      let frame: Record<string,unknown>
      try { frame=JSON.parse(event.data) } catch { return }
      if (frame.type==='ready') {
        clearTimeout(timeout)
        cancelConnect = null
        if (heartbeat !== null) clearInterval(heartbeat)
        heartbeat=setInterval(() => {
          if (target!==socket) return
          if (Date.now()-lastReceive>45000) { disconnectDesktopExchange();return }
          if (target.readyState===1) target.send(JSON.stringify({type:'ping'}))
        },15000)
        resolve()
      } else if (frame.type==='exchange') void forward(frame,target)
      else if (frame.type==='result') {
        const item=pending.get(String(frame.id)); if (!item) return
        pending.delete(String(frame.id));clearTimeout(item.timer)
        item.resolve(new Response(JSON.stringify(frame.data),{status:Number(frame.status),headers:{'Content-Type':'application/json'}}))
      }
    }
  }).finally(() => { if (connecting === opening) connecting=null })
  connecting = opening
  return opening
}

export async function tryDesktopLiveRequest(path: string, options: RequestInit = {}): Promise<Response | null> {
  if (typeof localStorage === 'undefined') return null
  if (options.method !== undefined && options.method !== 'GET') return sendDesktopRequest(path, options)
  const key = (localStorage.getItem('access_token') || '') + '\0' + path
  let shared = readCalls.get(key)
  if (!shared) {
    shared = sendDesktopRequest(path, options).finally(() => { if (readCalls.get(key) === shared) readCalls.delete(key) })
    readCalls.set(key, shared)
  }
  return (await shared)?.clone() ?? null
}

async function sendDesktopRequest(path: string, options: RequestInit): Promise<Response | null> {
  const route = path.split('?')[0]
  const analytics = analyticsRead.test(route)
  if ((!allowed.test(route) && !analytics) || (analytics && options.method !== undefined && options.method !== 'GET')) return null
  const payload = typeof options.body==='string' ? JSON.parse(options.body || '{}') : {}
  const venue = new URLSearchParams(path.split('?')[1] || '').get('venue') || payload.venue || 'okx'
  if (venue!=='okx') return null
  await ensureDesktopRouting()
  if (isServerMode()) return null
  try { await connect() } catch (error) { if (error instanceof UnavailableBeforeCall) return null;throw error }
  const target=socket
  if (!target || target.readyState!==1) return null // no command has been dispatched
  const write=options.method!==undefined && options.method!=='GET'
  const id=crypto.randomUUID()
  const response=await new Promise<Response>((resolve,reject) => {
    const timer=setTimeout(() => {
      pending.delete(id)
      reject(write ? new ExchangeOutcomeUnknown('交易响应超时，请查询订单后再操作；不会自动重发') : new Error('查询超时'))
    },analytics ? 120000 : 60000)
    pending.set(id,{resolve,reject,write,timer})
    try { target.send(JSON.stringify({type:'call',id,path,method:options.method || 'GET',body:options.body || ''})) }
    catch { clearTimeout(timer);pending.delete(id);reject(write ? new ExchangeOutcomeUnknown('交易结果未知，请先查询订单') : new Error('连接中断')) }
  }).catch(error => { if (!write) return null;throw error })
  return response
}

if (typeof window!=='undefined') window.addEventListener('pagehide',disconnectDesktopExchange)

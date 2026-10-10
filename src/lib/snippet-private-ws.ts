/** Ephemeral WS login proofs; push data only invalidates normalized UI reads. */
import { ensureDesktopRouting, isServerMode, onDesktopRoutingChange } from "./desktop-routing"
import type { MessageHandler } from "./websocket"
import { snippetOrigin, snippetFailed, snippetSucceeded } from "./snippet-pool"

let nextDial = 0

class PrivateChannel {
  private socket: WebSocket | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private controller: AbortController | null = null
  private active = false
  private attempt = 0
  private rx = 0
  private token = ""
  private activeOrigin = ""
  connected = false
  constructor(private business: boolean, private event: (channels: string[]) => void) {}
  start(): void { if (this.active) return;this.active=true;this.schedule(this.business ? 1500 : 0) }
  stop(): void {
    this.active=false;this.attempt=0;this.release();this.connected=false
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer=null
  }
  private release(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat)
    this.heartbeat=null;this.controller?.abort();this.controller=null
    const old=this.socket;this.socket=null
    if (old) { old.onopen=old.onmessage=old.onclose=old.onerror=null;old.close(1000,"account transport replaced") }
  }
  private schedule(delay: number): void {
    if (!this.active || isServerMode() || this.timer !== null) return
    const at = Math.max(Date.now() + delay, nextDial)
    nextDial = at + 1500
    this.timer=setTimeout(() => {this.timer=null;void this.open()},at - Date.now())
  }
  private retry(): void {
    this.release();this.connected=false;this.event([])
    const delay=Math.min(30000,2000*2**Math.min(this.attempt++,4))+Math.floor(Math.random()*1000)
    if (this.attempt>=2 && this.activeOrigin) void snippetFailed("private_ws",this.activeOrigin).finally(()=>this.schedule(delay))
    else this.schedule(delay)
  }
  private async open(): Promise<void> {
    if (!this.active || isServerMode()) return
    this.token=localStorage.getItem("access_token") || ""
    if (!this.token) return
    const controller=new AbortController();this.controller=controller
    const deadline=setTimeout(() => controller.abort(),5000)
    try {
      const base=(process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/,"")
      const response=await fetch(base+"/api/live/desktop-ws-login",{method:"POST",headers:{Authorization:`Bearer ${this.token}`},signal:controller.signal,cache:"no-store"})
      if (!response.ok) throw new Error("login proof unavailable")
      const proof=await response.json()
      if (controller.signal.aborted || !this.active || isServerMode()) return
      this.activeOrigin=snippetOrigin("private_ws")
      const target=new WebSocket(`${this.activeOrigin}${proof.demo ? '/demo' : ''}/ws/v5/${this.business ? 'business' : 'private'}`)
      this.socket=target;this.rx=Date.now()
      const born = Date.now()
      const channels=this.business ? ['orders-algo','algo-advance'] : ['account','positions','orders']
      const waiting=new Set(channels)
      target.onopen=() => {
        if (target!==this.socket) return
        target.send(JSON.stringify({op:'login',args:proof.args}))
        proof.args=[]
      }
      target.onmessage=event => {
        if (target!==this.socket || typeof event.data!=='string') return
        this.rx=Date.now()
        if (event.data==='pong') return
        let frame: Record<string,unknown>
        try {frame=JSON.parse(event.data)} catch{return}
        if (frame.event==='error') {this.retry();return}
        if (frame.event==='login') {
          if (frame.code!=='0') {this.retry();return}
          target.send(JSON.stringify({op:'subscribe',args:channels.map(channel => channel==='account' ? {channel,ccy:'USDT'} : {channel,instType:'SWAP'})}))
        }
        const channel=(frame.arg as {channel?:string}|undefined)?.channel
        if (frame.event==='subscribe' && channel) {
          waiting.delete(channel)
          if (!waiting.size) {this.connected=true;this.attempt=0;this.event(channels);snippetSucceeded("private_ws",this.activeOrigin)}
        }
        if (Array.isArray(frame.data) && channel) this.event([channel])
      }
      target.onerror=target.onclose=() => {if (target===this.socket) this.retry()}
      this.heartbeat=setInterval(() => {
        if (target!==this.socket) return
        try { if (snippetOrigin("private_ws")!==this.activeOrigin) {this.release();this.connected=false;this.schedule(500+Math.random()*3000);return} }
        catch {this.release();this.connected=false;this.schedule(5000);return}
        if (localStorage.getItem('access_token')!==this.token || Date.now()-this.rx>35000 || (!this.connected && Date.now()-born>12000)) {this.retry();return}
        if (target.readyState===1) target.send('ping')
      },5000)
    } catch { if (this.active && !isServerMode()) this.retry() }
    finally {clearTimeout(deadline);if (this.controller===controller) this.controller=null}
  }
}

const handlers=new Set<MessageHandler>()
let running=false
function emit(channels: string[]): void {
  if (!running || isServerMode()) return
  const normalized=channels.map(c => c==='orders-algo' || c==='algo-advance' ? 'orders' : c)
  handlers.forEach(handler => handler({type:'live_account_tick',data:{venue:'okx',trading_mode:'live',connected:privateChannel.connected,business_connected:businessChannel.connected,channels:[...new Set(normalized)]}}))
}
const privateChannel=new PrivateChannel(false,emit)
const businessChannel=new PrivateChannel(true,emit)
export function subscribeSnippetPrivate(handler: MessageHandler): () => void {handlers.add(handler);return () => {handlers.delete(handler)}}
export async function startSnippetPrivate(): Promise<void> {
  running=true;await ensureDesktopRouting()
  if (!running || isServerMode()) return
  privateChannel.start();businessChannel.start()
}
export function stopSnippetPrivate(): void {running=false;privateChannel.stop();businessChannel.stop()}
onDesktopRoutingChange(server => {
  privateChannel.stop();businessChannel.stop()
  if (!server && running) {privateChannel.start();businessChannel.start()}
})
if (typeof window!=='undefined') window.addEventListener('pagehide',stopSnippetPrivate)

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const policy=vi.hoisted(()=>({server:false,change:null as null|((server:boolean)=>void)}))
vi.mock('./desktop-routing',()=>({ensureDesktopRouting:async()=>{},isServerMode:()=>policy.server,onDesktopRoutingChange:(callback:(server:boolean)=>void)=>{policy.change=callback}}))
import { startSnippetPrivate, stopSnippetPrivate } from './snippet-private-ws'
class Socket {
  static all:Socket[]=[]
  readyState=0
  onopen:(()=>void)|null=null;onclose:(()=>void)|null=null;onerror:(()=>void)|null=null
  onmessage:((event:{data:string})=>void)|null=null
  send=vi.fn();close=vi.fn(()=>{this.readyState=3})
  constructor(public url:string){Socket.all.push(this)}
  frame(frame:unknown){this.onmessage?.({data:typeof frame==='string'?frame:JSON.stringify(frame)})}
  open(){this.readyState=1;this.onopen?.()}
}
beforeEach(()=>{
  vi.useFakeTimers();policy.server=false;Socket.all=[]
  vi.stubGlobal('WebSocket',Socket);vi.stubGlobal('localStorage',{getItem:()=> 'test-token'})
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({demo:true,expires_in:15,args:[{sign:'short-proof'}]}))))
})
afterEach(()=>{stopSnippetPrivate();vi.useRealTimers();vi.unstubAllGlobals()})
it('opens one socket per private endpoint; repeated start and shutdown leave no reconnects',async()=>{
  await startSnippetPrivate();await startSnippetPrivate();await vi.advanceTimersByTimeAsync(2000)
  expect(Socket.all).toHaveLength(2)
  for(const socket of Socket.all){expect(socket.url).toContain('/demo/ws/v5/');expect(socket.url).not.toContain('test-token');socket.open()}
  stopSnippetPrivate();await vi.advanceTimersByTimeAsync(60000)
  expect(Socket.all).toHaveLength(2);expect(Socket.all.every(s=>s.close.mock.calls.length===1)).toBe(true)
})
it('pong traffic cannot keep an unauthenticated or unsubscribed connection alive',async()=>{
  await startSnippetPrivate();await vi.advanceTimersByTimeAsync(2000)
  const sockets=[...Socket.all];sockets.forEach(socket=>socket.open())
  for(let i=0;i<3;i++){sockets.forEach(socket=>socket.frame('pong'));await vi.advanceTimersByTimeAsync(5000)}
  expect(sockets.every(s=>s.close.mock.calls.length===1)).toBe(true)
  policy.server=true;policy.change?.(true);const count=Socket.all.length
  await vi.advanceTimersByTimeAsync(60000);expect(Socket.all).toHaveLength(count)
})

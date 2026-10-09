import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const policy=vi.hoisted(()=>({server:false}))
vi.mock('./desktop-routing',()=>({ensureDesktopRouting:async()=>{},isServerMode:()=>policy.server,onDesktopRoutingChange:vi.fn()}))
vi.mock('./websocket',()=>({resolveWsBase:()=> 'wss://product.example'}))
import { disconnectDesktopExchange, ExchangeOutcomeUnknown, tryDesktopLiveRequest } from './desktop-exchange'
class Socket {
  static all:Socket[]=[]
  readyState=0
  onopen:(()=>void)|null=null
  onclose:(()=>void)|null=null
  onerror:(()=>void)|null=null
  onmessage:((event:{data:string})=>void)|null=null
  send=vi.fn()
  close=vi.fn(()=>{this.readyState=3})
  constructor(public url:string){Socket.all.push(this)}
  ready(){this.readyState=1;this.onopen?.();this.frame({type:'ready'})}
  frame(frame:unknown){this.onmessage?.({data:JSON.stringify(frame)})}
}
beforeEach(()=>{
  policy.server=false;Socket.all=[];vi.useFakeTimers()
  vi.stubGlobal('WebSocket',Socket);vi.stubGlobal('localStorage',{getItem:()=> 'test-jwt'})
  vi.stubGlobal('window',{location:{}})
})
afterEach(()=>{disconnectDesktopExchange();vi.useRealTimers();vi.unstubAllGlobals()})
async function settle(){await vi.advanceTimersByTimeAsync(0)}
it('shares one authenticated RPC connection and returns normalized server output',async()=>{
  const first=tryDesktopLiveRequest('/api/live/account?venue=okx');await settle()
  const second=tryDesktopLiveRequest('/api/live/positions?venue=okx');await settle()
  expect(Socket.all).toHaveLength(1);const socket=Socket.all[0];socket.ready();await settle()
  expect(socket.url).not.toContain('test-jwt')
  const calls=socket.send.mock.calls.map(([raw])=>JSON.parse(raw)).filter(f=>f.type==='call')
  expect(calls).toHaveLength(2)
  for(const call of calls) socket.frame({type:'result',id:call.id,status:200,data:{ok:true}})
  expect(await (await first)!.json()).toEqual({ok:true});expect(await (await second)!.json()).toEqual({ok:true})
})
it('never replays a dispatched write after connection loss; reads can fall back',async()=>{
  const write=tryDesktopLiveRequest('/api/live/orders',{method:'POST',body:'{"venue":"okx"}'})
  const rejected=expect(write).rejects.toBeInstanceOf(ExchangeOutcomeUnknown)
  await settle();Socket.all[0].ready();await settle()
  expect(Socket.all[0].send.mock.calls.some(([raw])=>JSON.parse(raw).type==='call')).toBe(true)
  const read=tryDesktopLiveRequest('/api/live/positions?venue=okx');await settle()
  disconnectDesktopExchange();await rejected;expect(await read).toBeNull()
  expect(Socket.all).toHaveLength(1)
})
it('returns to HTTP before dispatch if the global switch is enabled',async()=>{
  policy.server=true;expect(await tryDesktopLiveRequest('/api/live/account')).toBeNull()
  expect(Socket.all).toHaveLength(0)
})

it('shares overlapping dashboard statistics reads and gives each consumer its own response',async()=>{
  const first=tryDesktopLiveRequest('/api/live/daily-pnl?venue=okx&days=90');await settle()
  Socket.all[0].ready();await settle()
  const second=tryDesktopLiveRequest('/api/live/daily-pnl?venue=okx&days=90');await settle()
  const calls=Socket.all[0].send.mock.calls.map(([raw])=>JSON.parse(raw)).filter(f=>f.type==='call')
  expect(calls).toHaveLength(1)
  Socket.all[0].frame({type:'result',id:calls[0].id,status:200,data:{days:[{net_after_costs:8}],summary:{net:10}}})
  expect(await (await first)!.json()).toEqual(await (await second)!.json())
})

it.each(['/api/live/daily-pnl/tasks','/api/ai-trading/tasks','/api/ai-trading/profit-bars?limit=500',
  '/api/ai-trading/funding-source','/api/ai-trading/tasks/11111111-1111-1111-1111-111111111111/trades'])(
  'relays analytics reads only: %s',async path=>{
    expect(await tryDesktopLiveRequest(path,{method:'POST',body:'{}'})).toBeNull()
    expect(Socket.all).toHaveLength(0)
    const read=tryDesktopLiveRequest(path);await settle();const socket=Socket.all[0];socket.ready();await settle()
    const call=socket.send.mock.calls.map(([raw])=>JSON.parse(raw)).find(f=>f.type==='call')
    expect(call.path).toBe(path);expect(call.method).toBe('GET')
    socket.frame({type:'result',id:call.id,status:200,data:{ok:true}})
    expect(await (await read)!.json()).toEqual({ok:true})
  })

it('keeps analytics on HTTP in forced server mode',async()=>{
  policy.server=true
  expect(await tryDesktopLiveRequest('/api/live/daily-pnl?venue=okx&days=90')).toBeNull()
  expect(await tryDesktopLiveRequest('/api/ai-trading/tasks')).toBeNull()
  expect(Socket.all).toHaveLength(0)
})

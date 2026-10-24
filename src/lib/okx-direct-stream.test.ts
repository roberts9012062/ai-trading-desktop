import {afterEach,expect,it,vi} from 'vitest'
class Socket {
  static all:Socket[]=[];readyState=0
  onopen:(()=>void)|null=null;onmessage:((event:{data:string})=>void)|null=null;onerror:(()=>void)|null=null;onclose:(()=>void)|null=null
  send=vi.fn();close=vi.fn(()=>{this.readyState=3})
  constructor(readonly url:string){Socket.all.push(this)}
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.resetModules();Socket.all=[]})
it('opens only official public and business endpoints, without asking the legacy pool for a route',async()=>{
  vi.useFakeTimers();vi.stubGlobal('WebSocket',Socket)
  const {enableDirectOkxMode}=await import('./market-provider');enableDirectOkxMode()
  const {OkxSnippetWebSocket}=await import('./okx-snippet-ws')
  const stream=new OkxSnippetWebSocket()
  stream.setQuoteSymbols(['btcusdt']);stream.setChartSubscription([{symbol:'btcusdt',period:'1m'}]);stream.connect()
  await vi.advanceTimersByTimeAsync(2000)
  expect(Socket.all.map(s=>s.url).sort()).toEqual(['wss://ws.okx.com/ws/v5/business','wss://ws.okx.com/ws/v5/public'])
  stream.disconnect()
})

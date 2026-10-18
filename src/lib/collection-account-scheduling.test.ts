import {afterEach,beforeEach,expect,it,vi} from 'vitest'

const state=vi.hoisted(()=>({requests:vi.fn(),epoch:0,token:'session',framesPerCall:1,calls:[] as number[],signed:[] as number[],results:[] as string[]}))
vi.mock('./collection-config',()=>({COLLECTION_BASE:'https://lium.eu.org',collectionMode:()=>true,collectionScope:()=> 'test',collectionGeneration:()=>state.epoch,onCollectionChange:()=>()=>{},loadCollectionConfig:async()=>{},collectionStatus:()=>({configured:true,permissions:{active_packages:[{markets:['crypto'],capabilities:['okx_private']}]}}),collectionRequest:state.requests}))
vi.mock('./desktop-routing',()=>({ensureDesktopRouting:async()=>{},isServerMode:()=>false,onDesktopRoutingChange:()=>()=>{}}))
vi.mock('./websocket',()=>({resolveWsBase:()=> 'wss://business.example'}))
import {collectionHttpSlot} from './collection-api'
import {tryDesktopLiveRequest,disconnectDesktopExchange} from './desktop-exchange'

class Socket {
  readyState=1
  onopen:(()=>void)|null=null
  onmessage:((event:{data:string})=>void)|null=null
  onclose=null;onerror=null
  pending=new Map<string,{call:string;remaining:number}>()
  constructor(){queueMicrotask(()=>{this.onopen?.();this.frame({type:'ready'})})}
  frame(value:unknown){this.onmessage?.({data:JSON.stringify(value)})}
  close(){this.readyState=3}
  send(raw:string){
    const frame=JSON.parse(raw)
    if(frame.type==='call'){
      state.calls.push(Date.now());state.signed.push(Date.now())
      const call={call:frame.id,remaining:state.framesPerCall}
      for(let i=0;i<state.framesPerCall;i++){
        const id=frame.id+':'+i;this.pending.set(id,call)
        this.frame({type:'exchange',id,method:'GET',path:'/api/v5/account/positions?instType=SWAP',headers:{'OK-ACCESS-KEY':'test','OK-ACCESS-SIGN':'signature','OK-ACCESS-TIMESTAMP':new Date().toISOString(),'OK-ACCESS-PASSPHRASE':'test'}})
      }
    }
    if(frame.type==='exchange_result'){
      state.results.push(frame.data.code)
      const call=this.pending.get(frame.id)!
      if(--call.remaining===0)this.frame({type:'result',id:call.call,status:frame.data.code==='0'?200:400,data:frame.data})
    }
  }
}
let testClock=Date.now()
beforeEach(()=>{
  vi.useFakeTimers();testClock+=120000;vi.setSystemTime(testClock);state.epoch=0;state.token='session';state.framesPerCall=1;state.calls=[];state.signed=[];state.results=[]
  vi.stubGlobal('localStorage',{getItem:()=>state.token});vi.stubGlobal('window',{location:{}});vi.stubGlobal('WebSocket',Socket)
  state.requests.mockImplementation(async(path:string)=>{
    if(path==='/api/tickets')return {url:'/edge/okx?ticket=single-use'}
    await new Promise(resolve=>setTimeout(resolve,2000))
    return {raw:JSON.stringify({code:'0',data:[]})}
  })
})
afterEach(()=>{disconnectDesktopExchange();vi.useRealTimers();vi.unstubAllGlobals();vi.clearAllMocks()})

it('waits for slow history before asking the business service to sign an account request',async()=>{
  let release!:()=>void
  const history=collectionHttpSlot(()=>new Promise<void>(resolve=>{release=resolve}))
  await vi.advanceTimersByTimeAsync(0)
  const read=tryDesktopLiveRequest('/api/live/positions?venue=okx')
  await vi.advanceTimersByTimeAsync(12000)
  const callsBeforeRelease=state.calls.length,resultsBeforeRelease=[...state.results]
  release();await history;await vi.advanceTimersByTimeAsync(2100)
  const reply=await read
  expect(callsBeforeRelease).toBe(0)
  expect(resultsBeforeRelease).toEqual([])
  expect(reply?.status).toBe(200)
  expect(state.results).toEqual(['0'])
})

it('queues a burst before signing, so each signed request gets its own response budget',async()=>{
  const reads=Array.from({length:8},(_,i)=>tryDesktopLiveRequest(`/api/live/positions?venue=okx&request=${i}`))
  await vi.advanceTimersByTimeAsync(21000)
  expect((await Promise.all(reads)).map(reply=>reply?.status)).toEqual(Array(8).fill(200))
  expect(state.results).toEqual(Array(8).fill('0'))
  expect(state.signed[7]-state.signed[0]).toBeGreaterThanOrEqual(14000)
})

it('gives queued account operations priority over further history pages without overlapping HTTP',async()=>{
  const order:string[]=[]
  let release!:()=>void
  const busy=collectionHttpSlot(()=>new Promise<void>(resolve=>{release=resolve}))
  await vi.advanceTimersByTimeAsync(0)
  const history=collectionHttpSlot(async()=>{order.push('history')})
  const account=collectionHttpSlot(async()=>{order.push('account')},1)
  release();await Promise.all([busy,history,account])
  expect(order).toEqual(['account','history'])
})

it('runs several exchange endpoints inside one business reservation without reacquiring its HTTP slot',async()=>{
  state.framesPerCall=3
  const read=tryDesktopLiveRequest('/api/live/positions?venue=okx')
  await vi.advanceTimersByTimeAsync(6500)
  expect((await read)?.status).toBe(200)
  expect(state.results).toEqual(['0','0','0'])
})

it('still serves history during a sustained account burst',async()=>{
  const order:string[]=[]
  let release!:()=>void
  const busy=collectionHttpSlot(()=>new Promise<void>(resolve=>{release=resolve}))
  await vi.advanceTimersByTimeAsync(0)
  const history=collectionHttpSlot(async()=>{order.push('history')})
  const accounts=Array.from({length:6},(_,i)=>collectionHttpSlot(async()=>{order.push('account'+i)},1))
  release();await Promise.all([busy,history,...accounts])
  expect(order).toEqual(['account0','account1','account2','account3','history','account4','account5'])
})

it('cancels a queued write before business dispatch if the login changes',async()=>{
  let release!:()=>void
  const busy=collectionHttpSlot(()=>new Promise<void>(resolve=>{release=resolve}))
  await vi.advanceTimersByTimeAsync(0)
  const write=tryDesktopLiveRequest('/api/live/orders',{method:'POST',body:'{"venue":"okx"}'})
  const rejected=expect(write).rejects.toThrow('账号已切换')
  await vi.advanceTimersByTimeAsync(0);state.token='other-session'
  release();await busy;await rejected
  expect(state.calls).toEqual([])
  expect(state.requests).not.toHaveBeenCalled()
})

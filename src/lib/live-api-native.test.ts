import {afterEach,beforeEach,expect,it,vi} from 'vitest'
const state=vi.hoisted(()=>({invoke:vi.fn(),rpc:vi.fn(),binding:'a'.repeat(64)}))
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>true,invoke:state.invoke}))
vi.mock('./collection-config',()=>({collectionMode:()=>true,nativeCollection:()=>true,collectionScope:()=> 'https://business:user-a',collectionGeneration:()=>0,loadCollectionConfig:async()=>{},onCollectionChange:()=>()=>{}}))
vi.mock('./collection-api',()=>({collectionHttpSlot:(work:()=>Promise<unknown>)=>work()}))
vi.mock('./collection-exchange',()=>({requireCollectionPrivate:async()=>{}}))
vi.mock('./desktop-exchange',()=>({tryDesktopLiveRequest:state.rpc}))
vi.mock('./desktop-daily-pnl',()=>({loadDesktopDailyPnl:vi.fn(),resetDesktopDailyPnl:vi.fn()}))
import {getLiveAccountApi,getLivePositionsApi,getLiveOrdersApi,placeLiveOrderApi,cancelLiveOrderApi,closeLivePositionApi} from './live-api'

beforeEach(()=>{
  state.rpc.mockReset().mockResolvedValue(null)
  state.invoke.mockReset().mockImplementation(async(command,args)=>{
    expect(command).toBe('desktop_local_exchange')
    if(args.path==='/api/live/credentials')return {credentials:[{venue:'okx',account_binding:state.binding}]}
    expect(args.expectedBinding).toBe(state.binding)
    if(args.path.startsWith('/api/live/account?'))return {equity:123,available:100,unrealized_pnl:2,demo:true,venue_name:'OKX'}
    if(args.path.startsWith('/api/live/positions?'))return {positions:[{symbol:'btcusdt',direction:'long',quantity:2,available_quantity:0.5,source:'exchange'}]}
    if(args.path.startsWith('/api/live/orders?'))return {orders:[{id:'100',symbol:'btcusdt',status:'filled',quantity:1,source:'exchange'}],has_more:false}
    throw new Error('Unexpected native request')
  })
  vi.stubGlobal('window',{dispatchEvent:vi.fn(),location:{}})
  const memory=new Map<string,string>([['access_token','session']])
  vi.stubGlobal('localStorage',{getItem:(key:string)=>memory.get(key)??null,setItem:(key:string,value:string)=>memory.set(key,value),removeItem:(key:string)=>memory.delete(key)})
  vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('business server blocked')))
})
afterEach(()=>{vi.clearAllMocks();vi.unstubAllGlobals()})

it('reads native account, positions and history with every business request blocked',async()=>{
  expect(await getLiveAccountApi('okx')).toMatchObject({total_equity:123,available_margin:100,demo:true})
  expect((await getLivePositionsApi('okx'))[0]).toMatchObject({available_quantity:0.5,source:'exchange'})
  expect((await getLiveOrdersApi('okx',true))[0]).toMatchObject({id:'100',source:'exchange'})
  expect(state.rpc).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled()
})

it('submits through native fencing with a durable client id and the business server unavailable',async()=>{
  state.invoke.mockImplementation(async(_command,args)=>{
    if(args.path==='/api/live/credentials')return {credentials:[{account_binding:state.binding}]}
    expect(args.expectedBinding).toBe(state.binding);expect(args.body.client_request_id).toMatch(/^[a-f0-9]{32}$/)
    return {id:'123',status:'live',filled_qty:0}
  })
  expect(await placeLiveOrderApi({venue:'okx',symbol:'btcusdt',direction:'buy',offset:'open',order_type:'market',price:null,quantity:1})).toMatchObject({id:'123',filled_qty:0})
  expect(state.rpc).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled()
})

it('does not retry a rejected native account binding or fall back to the server',async()=>{
  state.invoke.mockImplementation(async(_command,args)=>args.path==='/api/live/credentials'?{credentials:[{account_binding:state.binding}]}:Promise.reject(new Error('本机与服务器交易账户不一致')))
  await expect(placeLiveOrderApi({venue:'okx',symbol:'btcusdt',direction:'buy',offset:'open',order_type:'market',price:null,quantity:1})).rejects.toThrow('账户不一致')
  expect(state.rpc).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled()
})

it('routes cancellation and closing through native fencing with the business server unavailable',async()=>{
  state.invoke.mockImplementation(async(_command,args)=>{
    if(args.path==='/api/live/credentials')return {credentials:[{account_binding:state.binding}]}
    expect(args.expectedBinding).toBe(state.binding)
    expect(args.path).toMatch(/^\/api\/live\/(?:orders\/algo%3A123|positions\/close)/)
    return {ok:true}
  })
  await cancelLiveOrderApi('okx','algo:123','btcusdt')
  await closeLivePositionApi('okx','btcusdt','long')
  expect(state.invoke.mock.calls.filter(([,args])=>args.method!=='GET')).toHaveLength(2)
  expect(state.rpc).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled()
})

it('never retries or falls back to the business server after an uncertain native write',async()=>{
  state.invoke.mockImplementation(async(_command,args)=>{
    if(args.path==='/api/live/credentials')return {credentials:[{account_binding:state.binding}]}
    throw new Error('交易结果尚未确认，已阻止重复发送')
  })
  await expect(closeLivePositionApi('okx','btcusdt','long')).rejects.toThrow('尚未确认')
  expect(state.invoke.mock.calls.filter(([,args])=>args.method==='POST')).toHaveLength(1)
  expect(state.rpc).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled()
})

it('cancels a financial action when the login changes during native account preparation',async()=>{
  const action=closeLivePositionApi('okx','btcusdt','long')
  localStorage.setItem('access_token','other-login')
  await expect(action).rejects.toThrow('账号已切换')
  expect(state.invoke.mock.calls.filter(([,args])=>args.method==='POST')).toHaveLength(0)
  expect(state.rpc).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled()
})

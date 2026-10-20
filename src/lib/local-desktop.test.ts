import {afterEach,beforeEach,expect,it,vi} from 'vitest'
const state=vi.hoisted(()=>({native:true,epoch:0,scope:'https://business.example:user-a',invoke:vi.fn(),granted:true,hold:false,work:null as null|(()=>Promise<unknown>)}))
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>state.native,invoke:state.invoke}))
vi.mock('./collection-config',()=>({collectionMode:()=>true,collectionScope:()=>state.scope,collectionGeneration:()=>state.epoch,loadCollectionConfig:async()=>{}}))
vi.mock('./collection-exchange',()=>({requireCollectionPrivate:async()=>{if(!state.granted)throw new Error('未开通私有权限')}}))
vi.mock('./collection-api',()=>({collectionHttpSlot:(work:()=>Promise<unknown>)=>{if(!state.hold)return work();return new Promise((resolve,reject)=>{state.work=()=>work().then(value=>{resolve(value);return value},error=>{reject(error);throw error})})}}))
import {tryLocalLiveRequest,tryPreparedLocalLiveRequest,localLiveBinding,importLocalExchangeAccount,confirmLocalExchangeFlat,stopLocalAccountTasks} from './local-desktop'
beforeEach(()=>{state.native=true;state.epoch=0;state.scope='https://business.example:user-a';state.granted=true;state.hold=false;state.work=null;state.invoke.mockResolvedValue({positions:[]});vi.stubGlobal('localStorage',{getItem:()=> 'session'});vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('business server blocked')}))})
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks()})
it('queries native center-backed positions without creating a business HTTP request',async()=>{
  const response=await tryLocalLiveRequest('/api/live/positions?venue=okx')
  expect(await response!.json()).toEqual({positions:[]})
  expect(state.invoke).toHaveBeenCalledWith('desktop_local_exchange',expect.objectContaining({scope:state.scope,path:'/api/live/positions?venue=okx',method:'GET'}))
  expect(fetch).not.toHaveBeenCalled()
})
it('stores credentials and produces private WS proofs locally even while the business server is down',async()=>{
  await tryLocalLiveRequest('/api/live/credentials',{method:'PUT',body:JSON.stringify({venue:'okx',api_key:'sample',secret:'sample',passphrase:'sample',demo:true})})
  await tryLocalLiveRequest('/api/live/desktop-ws-login',{method:'POST'})
  expect(state.invoke).toHaveBeenCalledTimes(2);expect(fetch).not.toHaveBeenCalled()
})
it('does not dispatch an already queued write after the data identity changes',async()=>{
  state.hold=true
  const response=tryLocalLiveRequest('/api/live/orders',{method:'POST',body:'{"venue":"okx"}'})
  const rejected=expect(response).rejects.toThrow('已变化')
  await vi.waitFor(()=>expect(state.work).not.toBeNull());state.epoch++
  await state.work!().catch(()=>{});await rejected
  expect(state.invoke).not.toHaveBeenCalled()
})
it('fails closed on missing center capabilities and leaves browser compatibility unchanged',async()=>{
  state.granted=false
  await expect(tryLocalLiveRequest('/api/live/account?venue=okx')).rejects.toThrow('未开通')
  expect(state.invoke).not.toHaveBeenCalled()
  state.native=false
  expect(await tryLocalLiveRequest('/api/live/account?venue=okx')).toBeNull()
})

it('uses native reads after a server-bound preparation and leaves unsupported financial actions on the server',async()=>{
  const binding='a'.repeat(64)
  state.invoke.mockImplementation(async(_command,args)=>args.path==='/api/live/credentials'?{credentials:[{account_binding:binding}]}:{positions:[]})
  expect(await (await tryPreparedLocalLiveRequest('/api/live/positions?venue=okx'))!.json()).toEqual({positions:[]})
  expect(state.invoke).toHaveBeenLastCalledWith('desktop_local_exchange',expect.objectContaining({expectedBinding:binding,path:'/api/live/positions?venue=okx'}))
  state.invoke.mockClear()
  expect(await tryPreparedLocalLiveRequest('/api/live/leverage',{method:'POST',body:'{}'})).toBeNull()
  expect(state.invoke).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled()
})

it('checks flat state natively without a business request or an implicit task start',async()=>{
  const binding='a'.repeat(64)
  state.invoke.mockImplementation(async(_command,args)=>args.path==='/api/live/credentials'?{credentials:[{account_binding:binding}]}:{message:'已核对，任务仍停止'})
  expect(await confirmLocalExchangeFlat()).toEqual({message:'已核对，任务仍停止'})
  expect(state.invoke).toHaveBeenLastCalledWith('desktop_local_exchange',expect.objectContaining({expectedBinding:binding,path:'/api/live/local-execution/confirm-flat',method:'POST'}))
  expect(fetch).not.toHaveBeenCalled()
})

it('stops registered account tasks explicitly through native center control without a business request',async()=>{
  const binding='a'.repeat(64)
  state.hold=true // A queued market/history operation cannot block stop control.
  state.invoke.mockImplementation(async(_command,args)=>args.path==='/api/live/credentials'?{credentials:[{account_binding:binding}]}:{message:'任务已停止，持仓需手动处理',unresolved_commands:false})
  expect(await stopLocalAccountTasks()).toEqual({message:'任务已停止，持仓需手动处理',unresolved_commands:false})
  expect(state.invoke).toHaveBeenLastCalledWith('desktop_local_exchange',expect.objectContaining({expectedBinding:binding,path:'/api/live/local-execution/stop-account',method:'POST'}))
  expect(fetch).not.toHaveBeenCalled()
})

it('keeps legacy/unprepared credentials on the existing server path',async()=>{
  state.invoke.mockResolvedValue({credentials:[{account_binding:null}]})
  expect(await localLiveBinding()).toBeNull()
  expect(await tryPreparedLocalLiveRequest('/api/live/account?venue=okx')).toBeNull()
})

it('does not accept an old-user import response after the account changes',async()=>{
  vi.stubGlobal('window',{__QH_API_BASE__:'https://business.example',dispatchEvent:vi.fn()})
  state.invoke.mockImplementation(async()=>{state.scope='https://business.example:user-b';return {imported:true}})
  await expect(importLocalExchangeAccount()).rejects.toThrow('账号已切换')
  expect(window.dispatchEvent).not.toHaveBeenCalled()
})

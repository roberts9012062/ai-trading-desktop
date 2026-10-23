import {beforeEach,afterEach,it,expect,vi} from 'vitest'
const state=vi.hoisted(()=>({scope:'server:user',generation:0,binding:'a'.repeat(64),query:vi.fn()}))
vi.mock('./collection-config',()=>({collectionScope:()=>state.scope,collectionGeneration:()=>state.generation}))
vi.mock('./local-desktop',()=>({localLiveBinding:async()=>state.binding,tryPreparedLocalLiveRequest:state.query}))
import {withLocalControlIntent,checkPendingLocalControl,PendingManualControlError} from './local-control-intent'
beforeEach(()=>{
  state.scope='server:user';state.generation=0;state.query.mockReset()
  const data=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v),removeItem:(k:string)=>data.delete(k)})
})
afterEach(()=>vi.unstubAllGlobals())
it('retains the same input identity for queued and uncertain results and prevents a changed action',async()=>{
  const submit=vi.fn(async(_value:Record<string,unknown>)=>({manual_control:true,state:'queued',message:'排队'}))
  const input={action:'cancel_order',symbol:'btcusdt',order_id:'123'}
  await expect(withLocalControlIntent(state.binding,input,submit)).rejects.toBeInstanceOf(PendingManualControlError)
  await expect(withLocalControlIntent(state.binding,{...input,order_id:'456'},submit)).rejects.toThrow('上一笔')
  expect(submit).toHaveBeenCalledOnce()
  await expect(withLocalControlIntent(state.binding,input,submit)).rejects.toBeInstanceOf(PendingManualControlError)
  expect(submit.mock.calls[0][0]).toEqual(submit.mock.calls[1][0])
})
it('queries rather than sends and only clears a terminal control',async()=>{
  const submit=vi.fn(async()=>({manual_control:true,state:'unknown',message:'待核对'}))
  await expect(withLocalControlIntent(state.binding,{action:'close_position'},submit)).rejects.toThrow('待核对')
  state.query.mockResolvedValue(new Response(JSON.stringify({state:'confirmed',message:'已确认'})))
  expect(await checkPendingLocalControl()).toEqual({message:'已确认'})
  expect(state.query).toHaveBeenCalledWith(expect.stringContaining('/api/live/local-control?client_request_id='),{},state.binding,expect.any(Function))
  expect(await checkPendingLocalControl()).toEqual({message:'本机没有待核对的撤单或平仓请求。'})
  expect(submit).toHaveBeenCalledOnce()
})
it('does not accept a late result after account or data identity changes',async()=>{
  await expect(withLocalControlIntent(state.binding,{action:'cancel_order'},async()=>{state.generation++;return {ok:true}})).rejects.toThrow('已变化')
})

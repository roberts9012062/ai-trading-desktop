import {beforeEach,afterEach,expect,it,vi} from 'vitest'
const state=vi.hoisted(()=>({scope:'business:user-a',binding:'a'.repeat(64),check:vi.fn()}))
vi.mock('./collection-config',()=>({collectionScope:()=>state.scope,collectionGeneration:()=>0}))
vi.mock('./local-desktop',()=>({localLiveBinding:async()=>state.binding,tryPreparedLocalLiveRequest:state.check}))
import {withLocalOrderIntent,checkPendingLocalOrder} from './local-order-intent'
const input={venue:'okx',symbol:'btcusdt',quantity:1}
beforeEach(()=>{
 state.scope='business:user-a';state.binding='a'.repeat(64);state.check.mockReset()
 const memory=new Map<string,string>()
 vi.stubGlobal('localStorage',{getItem:(key:string)=>memory.get(key)??null,setItem:(key:string,value:string)=>memory.set(key,value),removeItem:(key:string)=>memory.delete(key)})
})
afterEach(()=>vi.unstubAllGlobals())
it('retains exactly one request id through errors and reload-equivalent calls until a real response',async()=>{
 const ids:string[]=[]
 const submit=vi.fn(async value=>{ids.push(value.client_request_id);throw new Error('[ORDER_OUTCOME_UNKNOWN] waiting')})
 await expect(withLocalOrderIntent(state.binding,input,submit)).rejects.toThrow('UNKNOWN')
 await expect(withLocalOrderIntent(state.binding,input,submit)).rejects.toThrow('UNKNOWN')
 expect(ids[0]).toBe(ids[1])
 await withLocalOrderIntent(state.binding,input,async value=>{ids.push((value as {client_request_id:string}).client_request_id);return {id:'123'}})
 await withLocalOrderIntent(state.binding,input,async value=>{ids.push((value as {client_request_id:string}).client_request_id);return {id:'124'}})
 expect(ids[2]).toBe(ids[0]);expect(ids[3]).not.toBe(ids[0])
})
it('blocks changed parameters until the previous outcome is explicitly checked',async()=>{
 await expect(withLocalOrderIntent(state.binding,input,async()=>{throw new Error('unknown')})).rejects.toThrow()
 const submit=vi.fn()
 await expect(withLocalOrderIntent(state.binding,{...input,quantity:2},submit)).rejects.toThrow('核对上次下单')
 expect(submit).not.toHaveBeenCalled()
 state.check.mockResolvedValue(new Response(JSON.stringify({state:'unknown',message:'still waiting'})))
 await checkPendingLocalOrder()
 await expect(withLocalOrderIntent(state.binding,{...input,quantity:2},submit)).rejects.toThrow('核对上次下单')
 state.check.mockResolvedValue(new Response(JSON.stringify({state:'accepted',message:'order 123 accepted'})))
 expect(await checkPendingLocalOrder()).toEqual({message:'order 123 accepted'})
 await withLocalOrderIntent(state.binding,{...input,quantity:2},submit)
 expect(submit).toHaveBeenCalledOnce()
})
it.each(['ORDER_NOT_SENT','ORDER_REJECTED'])('permits a new request only after an explicit native %s proof',async code=>{
 await expect(withLocalOrderIntent(state.binding,input,async()=>{throw new Error(`[${code}] refused`)})).rejects.toThrow('refused')
 await expect(withLocalOrderIntent(state.binding,{...input,quantity:2},async()=> 'ok')).resolves.toBe('ok')
})
it('isolates pending commands by user and bound exchange account',async()=>{
 await expect(withLocalOrderIntent(state.binding,input,async()=>{throw new Error('unknown')})).rejects.toThrow()
 state.scope='business:user-b'
 await expect(withLocalOrderIntent(state.binding,{...input,quantity:2},async()=> 'ok')).resolves.toBe('ok')
 state.scope='business:user-a'
 await expect(withLocalOrderIntent('b'.repeat(64),{...input,quantity:2},async()=> 'ok')).resolves.toBe('ok')
 await expect(withLocalOrderIntent(state.binding,{...input,quantity:2},async()=> 'ok')).rejects.toThrow('核对上次下单')
})
it('never dispatches when durable request storage fails',async()=>{
 vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw new Error('storage full')})
 const submit=vi.fn()
 await expect(withLocalOrderIntent(state.binding,input,submit)).rejects.toThrow('storage full')
 expect(submit).not.toHaveBeenCalled()
})

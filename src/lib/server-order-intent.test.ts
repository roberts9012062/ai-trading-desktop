import {afterEach,beforeEach,expect,it,vi} from 'vitest'
vi.mock('./collection-config',()=>({collectionScope:()=> 'server:user-a'}))
import {withServerOrderIntent,checkPendingServerOrder} from './server-order-intent'
const payload={venue:'okx',symbol:'btcusdt',quantity:1}
const binding='a'.repeat(64)
let read:ReturnType<typeof vi.fn<(path:string,binding?:string)=>Promise<unknown>>>
let send:ReturnType<typeof vi.fn<(payload:object,binding:string)=>Promise<Record<string,unknown>>>>
beforeEach(()=>{
 const values=new Map<string,string>()
 vi.stubGlobal('localStorage',{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)})
 read=vi.fn(async()=>({protocol:1,account_binding:binding}));send=vi.fn(async()=>({id:'order-one',status:'live'}))
})
afterEach(()=>vi.unstubAllGlobals())
it('refuses legacy servers before dispatch',async()=>{
 read.mockResolvedValue({})
 await expect(withServerOrderIntent(payload,read,send)).rejects.toThrow('防重')
 expect(send).not.toHaveBeenCalled()
})
it('persists the identity before one send and only reads receipts after a lost response',async()=>{
 send.mockRejectedValue(new Error('response lost'))
 await expect(withServerOrderIntent(payload,read,send)).rejects.toThrow('response lost')
 const id=(send.mock.calls[0][0] as {client_request_id:string}).client_request_id
 expect(id).toMatch(/^[a-f0-9]{32}$/)
 read.mockResolvedValue({state:'unknown',message:'waiting'})
 await expect(withServerOrderIntent(payload,read,send)).rejects.toThrow('waiting')
 expect(read.mock.calls.at(-1)?.[0]).toContain(id);expect(send).toHaveBeenCalledOnce()
 read.mockResolvedValue({state:'accepted',order:{id:'order-one',status:'live'},message:'found'})
 expect(await withServerOrderIntent(payload,read,send)).toMatchObject({id:'order-one'})
 expect(send).toHaveBeenCalledOnce()
})
it('blocks changed inputs until an explicit receipt check resolves the old request',async()=>{
 send.mockRejectedValue(new Error('unknown'))
 await expect(withServerOrderIntent(payload,read,send)).rejects.toThrow()
 await expect(withServerOrderIntent({...payload,quantity:2},read,send)).rejects.toThrow('核对上次下单')
 read.mockResolvedValue({state:'not_sent',message:'not sent'})
 expect(await checkPendingServerOrder(read)).toEqual({message:'not sent'})
 read.mockResolvedValue({protocol:1,account_binding:binding});send.mockResolvedValue({id:'two'})
 await withServerOrderIntent({...payload,quantity:2},read,send)
 expect(send).toHaveBeenCalledTimes(2)
})
it('fails closed if persistence fails or the account changes before send',async()=>{
 const current=vi.fn(()=>{throw new Error('account changed')})
 await expect(withServerOrderIntent(payload,read,send,current)).rejects.toThrow('account changed')
 vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw new Error('disk full')})
 await expect(withServerOrderIntent(payload,read,send)).rejects.toThrow('disk full')
 expect(send).not.toHaveBeenCalled()
})
it('blocks overlapping clicks while capability lookup is pending',async()=>{
 let resolve!:(value:unknown)=>void
 read.mockImplementationOnce(()=>new Promise(done=>{resolve=done}))
 const first=withServerOrderIntent(payload,read,send)
 await expect(withServerOrderIntent(payload,read,send)).rejects.toThrow('正在提交')
 resolve({protocol:1,account_binding:binding});await first
 expect(send).toHaveBeenCalledOnce()
})
it('retains pending identity on malformed success and account changes during receipt lookup',async()=>{
 send.mockResolvedValue({})
 await expect(withServerOrderIntent(payload,read,send)).rejects.toThrow('保留请求编号')
 read.mockResolvedValue({state:'accepted',order:{id:'one'},message:'found'})
 let calls=0
 await expect(checkPendingServerOrder(read,()=>{if(++calls===2)throw new Error('account changed')})).rejects.toThrow('account changed')
 read.mockResolvedValue({state:'unknown',message:'waiting'})
 expect(await checkPendingServerOrder(read)).toEqual({message:'waiting'})
 expect(send).toHaveBeenCalledOnce()
})

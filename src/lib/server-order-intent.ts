/** A lost server response is reconciled by GET, never by a second financial POST. */
import {collectionScope} from './collection-config'
type Pending={id:string;input:string;binding:string}
type Receipt={state?:string;message?:string;order?:Record<string,unknown>}
type Read=(path:string,binding?:string)=>Promise<unknown>
const key=()=>`atd:server-order:${collectionScope()}`
const flights=new Set<string>()
function validOrder(order:unknown):order is Record<string,unknown>{return !!order&&typeof order==='object'&&typeof (order as {id?:unknown}).id==='string'&&!!(order as {id:string}).id}
function pending(name:string):Pending|null {
 const raw=localStorage.getItem(name)
 if(!raw)return null
 try {const row=JSON.parse(raw) as Pending
  if(/^[a-f0-9]{32}$/.test(row.id)&&/^[a-f0-9]{64}$/.test(row.binding)&&typeof row.input==='string'&&row.input.length<=32768)return row
 }catch{}
 throw new Error('服务器待核对下单记录损坏，请保留记录并核对交易所')
}
async function receipt(name:string,row:Pending,read:Read,current:()=>void):Promise<Receipt> {
 current()
 const result=await read(`/api/live/order-requests/${row.id}`,row.binding) as Receipt
 current()
 if(!result||!['accepted','rejected','not_sent','unknown'].includes(result.state??'')||typeof result.message!=='string')throw new Error('服务器未返回有效下单核对结果，已保留请求编号')
 if(result.state==='accepted'&&!validOrder(result.order))throw new Error('服务器原单结果缺失，已保留请求编号')
 if(result.state!=='unknown'&&pending(name)?.id===row.id)localStorage.removeItem(name)
 return result
}
export async function checkPendingServerOrder(read:Read,current:()=>void=()=>{}):Promise<{message:string}> {
 const name=key(),row=pending(name)
 if(!row)return {message:'服务器账户没有待核对的下单请求。'}
 const result=await receipt(name,row,read,current)
 return {message:result.message!}
}
export async function withServerOrderIntent(
 payload:object,read:Read,send:(payload:object,binding:string)=>Promise<Record<string,unknown>>,current:()=>void=()=>{},
):Promise<Record<string,unknown>> {
 const name=key()
 if(flights.has(name))throw new Error('已有下单正在提交，请先核对上次下单')
 flights.add(name)
 try{return await submit(payload,read,send,current)}finally{flights.delete(name)}
}
async function submit(payload:object,read:Read,send:(payload:object,binding:string)=>Promise<Record<string,unknown>>,current:()=>void):Promise<Record<string,unknown>> {
 current()
 const name=key(),input=JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a],[b])=>a.localeCompare(b))))
 if(input.length>32768)throw new Error('下单参数超过大小限制')
 const old=pending(name)
 if(old){
  if(old.input!==input)throw new Error('上一笔服务器下单尚未核对，请先点击“核对上次下单”')
  const result=await receipt(name,old,read,current)
  if(result.state==='accepted')return result.order!
  throw new Error(result.message!)
 }
 const venue=String((payload as {venue?:string}).venue??'')
 const cap=await read(`/api/live/order-requests/capabilities?venue=${encodeURIComponent(venue)}`) as {protocol?:number;account_binding?:string}
 current()
 if(cap?.protocol!==1||typeof cap.account_binding!=='string'||!/^[a-f0-9]{64}$/.test(cap.account_binding))throw new Error('服务器尚未支持持久下单防重协议，请升级服务器后再下单')
 // A simultaneous click may have reached this point while capability GET ran.
 if(pending(name))throw new Error('已有下单正在提交，请先核对上次下单')
 const row:Pending={id:crypto.randomUUID().replaceAll('-',''),input,binding:cap.account_binding}
 localStorage.setItem(name,JSON.stringify(row))
 current()
 const result=await send({...payload,client_request_id:row.id},row.binding)
 current()
 if(!validOrder(result))throw new Error('下单响应缺少有效原单，已保留请求编号，请核对上次下单')
 if(pending(name)?.id===row.id)localStorage.removeItem(name)
 return result
}

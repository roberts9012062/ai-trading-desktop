/** Durable UI request identity; no credentials or automatic financial retry. */
import {collectionScope,collectionGeneration} from './collection-config'
import {localLiveBinding,tryPreparedLocalLiveRequest} from './local-desktop'

type Pending={id:string;input:string}
function key(binding:string){return `atd:manual-order:${collectionScope()}:${binding}`}
function read(name:string):Pending|null{
  const raw=localStorage.getItem(name)
  if(!raw)return null
  try{const value=JSON.parse(raw) as Pending;if(/^[a-f0-9]{32}$/.test(value.id)&&typeof value.input==='string'&&value.input.length<=32_768)return value}catch{}
  throw new Error('本机待核对下单记录损坏，请保留记录并核对交易所')
}
export async function withLocalOrderIntent<T>(binding:string,payload:object,submit:(value:object)=>Promise<T>):Promise<T>{
  const name=key(binding),scope=collectionScope(),generation=collectionGeneration()
  const input=JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a],[b])=>a.localeCompare(b))))
  if(input.length>32_768)throw new Error('本机下单参数超过大小限制')
  const previous=read(name)
  if(previous&&previous.input!==input)throw new Error('上一笔本机下单尚未核对，请先在交易所接入中点击“核对上次下单”，再提交新的参数')
  const pending=previous??{id:crypto.randomUUID().replaceAll('-',''),input}
  const current=()=>scope===collectionScope()&&generation===collectionGeneration()
  // Failure to persist stops BEFORE dispatch; a reload must retain this ID.
  localStorage.setItem(name,JSON.stringify(pending))
  const clear=()=>{if(read(name)?.id===pending.id)localStorage.removeItem(name)}
  try{
    if(!current())throw new Error('会话已变化，已取消旧请求')
    const result=await submit({...payload,client_request_id:pending.id})
    if(!current())throw new Error('会话已变化，请在原账号核对下单结果')
    clear();return result
  }catch(error){
    const message=error instanceof Error?error.message:typeof error==='string'?error:''
    if(/^\[(?:ORDER_NOT_SENT|ORDER_REJECTED)\]/.test(message)){clear();throw new Error(message.replace(/^\[[A-Z_]+\]\s*/,''))}
    throw error
  }
}
export async function checkPendingLocalOrder():Promise<{message:string}>{
  const binding=await localLiveBinding()
  if(!binding)throw new Error('请先同步本机交易所账户')
  const name=key(binding),pending=read(name),scope=collectionScope(),generation=collectionGeneration()
  if(!pending)return {message:'本机没有待核对的下单请求。'}
  const current=()=>{if(scope!==collectionScope()||generation!==collectionGeneration())throw new Error('会话已变化，请在原账号核对下单结果')}
  const response=await tryPreparedLocalLiveRequest(`/api/live/local-order?client_request_id=${pending.id}`,{},binding,current)
  if(!response)throw new Error('本机下单核对通道不可用')
  const result=await response.json() as {state:string;message:string}
  if(typeof result.state!=='string'||typeof result.message!=='string')throw new Error('未取得有效下单核对结果，已保留原请求编号')
  if(scope!==collectionScope()||generation!==collectionGeneration())throw new Error('会话已变化，请在原账号核对下单结果')
  if(['accepted','rejected','reconciled','not_sent'].includes(result.state)&&read(name)?.id===pending.id)localStorage.removeItem(name)
  return {message:result.message}
}

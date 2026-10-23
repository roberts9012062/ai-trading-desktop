/** Human reduction requests retain identity until a positive terminal result. */
import {collectionScope,collectionGeneration} from './collection-config'
import {localLiveBinding,tryPreparedLocalLiveRequest} from './local-desktop'

type Pending={id:string;input:string}
type Receipt={manual_control?:boolean;state?:string;message?:string;ok?:boolean}
const terminal=new Set(['confirmed','rejected','expired','canceled','needs_review','not_sent'])
const key=(binding:string)=>`atd:manual-control:${collectionScope()}:${binding}`
export class PendingManualControlError extends Error {readonly pendingManualControl=true}
function read(name:string):Pending|null{
  const raw=localStorage.getItem(name);if(!raw)return null
  try{const value=JSON.parse(raw) as Pending;if(/^[a-f0-9]{32}$/.test(value.id)&&typeof value.input==='string'&&value.input.length<=8192)return value}catch{}
  throw new Error('本机人工请求记录损坏，请保留记录并核对交易所')
}
export async function withLocalControlIntent(binding:string,input:object,submit:(value:Record<string,unknown>)=>Promise<Receipt>):Promise<void>{
  const name=key(binding),scope=collectionScope(),generation=collectionGeneration()
  const encoded=JSON.stringify(Object.fromEntries(Object.entries(input).sort(([a],[b])=>a.localeCompare(b))))
  if(encoded.length>8192)throw new Error('人工请求参数过大')
  const previous=read(name)
  if(previous&&previous.input!==encoded)throw new Error('上一笔撤单或平仓尚未核对，请先在交易所接入中点击“核对人工操作”')
  const pending=previous??{id:crypto.randomUUID().replaceAll('-',''),input:encoded}
  localStorage.setItem(name,JSON.stringify(pending))
  const result=await submit({...input,client_request_id:pending.id})
  if(scope!==collectionScope()||generation!==collectionGeneration())throw new Error('账户或数据配置已变化，请在原账号核对请求')
  if(result.manual_control){
    if(typeof result.state!=='string')throw new Error('人工请求状态不完整，已保留原始编号')
    if(!terminal.has(result.state))throw new PendingManualControlError(result.message||'人工请求已保存，等待当前执行端核对；不会重复发送')
    if(read(name)?.id===pending.id)localStorage.removeItem(name)
    if(result.state!=='confirmed')throw new Error(result.message||'人工操作尚未完成，请刷新账户后核对')
  }else if(result.ok===true){if(read(name)?.id===pending.id)localStorage.removeItem(name)}
  else throw new Error('人工操作结果不完整，已保留原始编号')
}
export async function checkPendingLocalControl():Promise<{message:string}>{
  const binding=await localLiveBinding();if(!binding)throw new Error('请先同步本机交易所账户')
  const name=key(binding),pending=read(name),scope=collectionScope(),generation=collectionGeneration()
  if(!pending)return {message:'本机没有待核对的撤单或平仓请求。'}
  const current=()=>{if(scope!==collectionScope()||generation!==collectionGeneration())throw new Error('账户或数据配置已变化，请在原账号核对请求')}
  const response=await tryPreparedLocalLiveRequest(`/api/live/local-control?client_request_id=${pending.id}`,{},binding,current)
  if(!response)throw new Error('人工请求核对通道不可用')
  const result=await response.json() as Receipt;current()
  if(typeof result.state!=='string'||typeof result.message!=='string')throw new Error('人工请求核对结果不完整，已保留编号')
  if(terminal.has(result.state)&&read(name)?.id===pending.id)localStorage.removeItem(name)
  return {message:result.message}
}

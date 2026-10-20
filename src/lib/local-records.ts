/** Embedded records are independent of server availability; sync never carries trades. */
import {invoke} from '@tauri-apps/api/core'
import {collectionScope,nativeCollection} from './collection-config'

export interface LocalRecord {collection:string;id:string;value:Record<string,unknown>;revision:number;base_version:string;dirty:boolean;deleted:boolean;updated_at:number}
export interface RemoteRecord {collection:string;id:string;value:Record<string,unknown>;version:string;deleted:boolean}
export interface RecordConflict {collection:string;id:string;remote:RemoteRecord;local?:LocalRecord|null}
export interface SyncStatus {pending:number;conflicts:number;sync?:{at:string;uploaded:number}|null}
const notifyDefaults={notify_trade:true,notify_fund:true,notify_price_alert:true,notify_sound_enabled:true}
const supported=new Set(['watchlist','notify-settings'])
const flights=new Map<string,Promise<{uploaded:number;conflicts:number}>>()
const validVersion=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)

function validRemote(row:RemoteRecord):boolean{
  if(!row||!supported.has(row.collection)||typeof row.id!=='string'||!row.value||typeof row.value!=='object'||Array.isArray(row.value)||typeof row.deleted!=='boolean'||!validVersion(row.version))return false
  if(row.collection==='watchlist'&&!/^[a-z0-9]{1,16}usdt$/.test(row.id))return false
  if(row.collection==='notify-settings'&&row.id!=='current')return false
  if(row.deleted)return row.collection==='watchlist'&&Object.keys(row.value).length===0
  if(row.collection==='notify-settings')return Object.keys(row.value).length===4&&Object.keys(notifyDefaults).every(key=>typeof row.value[key]==='boolean')
  const value=row.value
  return Object.keys(value).length===4&&value.contract_symbol===row.id&&typeof value.contract_name==='string'&&value.contract_name.length>0&&value.contract_name.length<=50&&Number.isInteger(value.sort_order)&&Number(value.sort_order)>=0&&Number(value.sort_order)<=100000&&(value.group_name===null||typeof value.group_name==='string'&&value.group_name.length<=50)
}

function context(){
  if(typeof localStorage==='undefined')return null
  try{
  const user=JSON.parse(localStorage.getItem('qihuo_auth_user')||'null')
  const token=localStorage.getItem('access_token')
  if(!user?.id||!token||!['live','virtual'].includes(user.trading_mode))return null
  const scope=`${collectionScope()}:records:${user.trading_mode}`
  return {scope,token,subject:String(user.id),mode:String(user.trading_mode)}
  }catch{return null}
}
function active(scope:string){if(context()?.scope!==scope)throw new Error('账号或交易盘已切换，已取消旧同步')}
async function db<T>(scope:string,action:string,collection?:string,id?:string,value?:unknown):Promise<T>{
  active(scope)
  const result=await invoke<T>('desktop_db',{scope,action,collection:collection??null,id:id??null,value:value??null})
  active(scope)
  if(['put','delete','batch'].includes(action)&&typeof window!=='undefined')window.dispatchEvent(new Event('desktop-records-changed'))
  return result
}
function response(value:unknown,status=200){return new Response(status===204?null:JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}})}
function watchValue(value:Record<string,unknown>){
  const symbol=String(value.contract_symbol||'').toLowerCase()
  if(!/^[a-z0-9]{1,16}usdt$/.test(symbol))throw new Error('只支持加密货币 USDT 永续合约')
  const name=String(value.contract_name||symbol)
  const order=Number(value.sort_order??0),group=value.group_name??null
  if(name.length>50||!Number.isInteger(order)||order<0||order>100000||group!==null&&(typeof group!=='string'||group.length>50))throw new Error('自选记录格式无效')
  return {contract_symbol:symbol,contract_name:name,sort_order:order,group_name:group}
}

export async function tryLocalRecordRequest(path:string,options:RequestInit={}):Promise<Response|null>{
  if(!nativeCollection())return null
  const session=context();if(!session)return null
  const route=path.split('?')[0]
  if(route!=='/api/users/me/notify-settings'&&!/^\/api\/watchlist(?:\/[^/]+)?$/.test(route))return null
  const scope=session.scope,method=(options.method||'GET').toUpperCase()
  options.signal?.throwIfAborted()
  const body=options.body?JSON.parse(String(options.body)):{}
  if(route==='/api/users/me/notify-settings'){
    const saved=await db<LocalRecord|null>(scope,'get','notify-settings','current')
    const value={...notifyDefaults,...saved?.value}
    if(method==='GET')return response(value)
    if(method!=='PUT')throw new Error('不支持的本机设置操作')
    for(const [key,setting] of Object.entries(body)){
      if(!(key in notifyDefaults)||typeof setting!=='boolean')throw new Error('通知设置格式无效')
      value[key as keyof typeof notifyDefaults]=setting
    }
    await db(scope,'put','notify-settings','current',value);return response(value)
  }
  const rows=await db<LocalRecord[]>(scope,'list','watchlist')
  const item=(row:LocalRecord)=>({id:row.id,...row.value,created_at:new Date(row.updated_at*1000).toISOString()})
  if(route==='/api/watchlist'&&method==='GET')return response(rows.sort((a,b)=>Number(a.value.sort_order)-Number(b.value.sort_order)).map(item))
  if(route==='/api/watchlist'&&method==='POST'){
    if(rows.some(row=>row.value.contract_symbol===String(body.contract_symbol).toLowerCase()))return response({detail:'合约已在自选列表中'},409)
    const value=watchValue({...body,sort_order:Math.max(-1,...rows.map(row=>Number(row.value.sort_order)||0))+1})
    const saved=await db<LocalRecord>(scope,'put','watchlist',value.contract_symbol,value);return response(item(saved),201)
  }
  if(route==='/api/watchlist/sort'&&method==='PUT'){
    if(!Array.isArray(body.items)||body.items.length>1000)throw new Error('自选排序格式无效')
    const changes=body.items.map((change:{id:string;sort_order:number})=>{
      const row=rows.find(row=>row.id===change.id);if(!row)throw new Error('自选记录不存在')
      return {id:row.id,value:watchValue({...row.value,sort_order:change.sort_order})}
    })
    await db(scope,'batch','watchlist',undefined,changes);return response({message:'排序已保存在本机'})
  }
  const id=decodeURIComponent(route.split('/').at(-1)||''),row=rows.find(row=>row.id===id)
  if(!row)return response({detail:'自选记录不存在'},404)
  if(method==='DELETE'){await db(scope,'delete','watchlist',id);return response(null,204)}
  if(method==='PUT'){
    const saved=await db<LocalRecord>(scope,'put','watchlist',id,watchValue({...row.value,group_name:body.group_name??null}));return response(item(saved))
  }
  throw new Error('不支持的本机自选操作')
}

export async function localSyncStatus():Promise<SyncStatus>{
  const session=context();if(!nativeCollection()||!session)return {pending:0,conflicts:0}
  return db(session.scope,'status')
}
export async function localSyncConflicts():Promise<RecordConflict[]>{
  const session=context();if(!nativeCollection()||!session)return []
  const conflicts=await db<RecordConflict[]>(session.scope,'conflicts')
  return Promise.all(conflicts.filter(row=>supported.has(row.collection)).map(async row=>({...row,local:await db<LocalRecord|null>(session.scope,'get',row.collection,row.id)})))
}
export async function resolveSyncConflict(conflict:RecordConflict,choice:'local'|'server'){
  const session=context();if(!session)throw new Error('请先登录服务器账号')
  await db(session.scope,'resolve',conflict.collection,conflict.id,choice)
}
export async function syncDesktopRecords():Promise<{uploaded:number;conflicts:number}>{
  const session=context();if(!nativeCollection()||!session)throw new Error('请先在桌面端登录服务器账号')
  const {scope,token,subject,mode}=session
  let flight=flights.get(scope)
  if(!flight){
    flight=(async()=>{
      const pending=(await db<LocalRecord[]>(scope,'pending')).filter(row=>supported.has(row.collection))
      if(pending.length>200)throw new Error('待同步记录超过 200 条，请先分批整理后重试')
      const watches=await db<LocalRecord[]>(scope,'list','watchlist')
      const known=[...new Map([...watches,...pending].map(({collection,id})=>[`${collection}:${id}`,{collection,id}])).values()]
      active(scope)
      const base=(globalThis as typeof globalThis&{__QH_API_BASE__?:string}).__QH_API_BASE__??process.env.NEXT_PUBLIC_API_URL??''
      let reply:Response
      try{reply=await fetch(`${base.replace(/\/$/,'')}/api/desktop/sync`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
        body:JSON.stringify({known,records:pending.map(({collection,id,value,deleted,base_version,revision})=>({collection,id,value,deleted,base_version,revision}))}),signal:AbortSignal.timeout(15000)})}
      catch{active(scope);throw new Error('服务器暂时无法连接，本机记录已保留，可稍后重新同步')}
      active(scope)
      if(!reply.ok){const error=await reply.json().catch(()=>null);throw new Error(reply.status===401?'服务器登录已过期，请重新登录后同步；本机记录已保留':error?.detail||`服务器同步失败 (${reply.status})，本机记录已保留`)}
      const result=await reply.json() as {subject:string;trading_mode:string;records:RemoteRecord[];acks:Array<{collection:string;id:string;revision:number;version:string}>;conflicts:RemoteRecord[]}
      if(result.subject!==subject||result.trading_mode!==mode)throw new Error('服务器返回的账号或交易盘不匹配，本机记录已保留')
      if(!Array.isArray(result.records)||!Array.isArray(result.acks)||!Array.isArray(result.conflicts))throw new Error('服务器同步响应格式无效，本机记录已保留')
      if(result.records.length>3001||result.conflicts.length>200||result.records.some(row=>!validRemote(row))||result.conflicts.some(row=>!validRemote(row)))throw new Error('服务器返回了无效的同步记录，本机记录已保留')
      // Validate the whole reply before clearing even one uploaded revision.
      const acknowledged=new Set<string>()
      for(const ack of result.acks){
        const identity=`${ack?.collection}:${ack?.id}`
        if(!ack||!validVersion(ack.version)||acknowledged.has(identity)||!pending.some(row=>row.collection===ack.collection&&row.id===ack.id&&row.revision===ack.revision))throw new Error('服务器返回了无效的同步确认')
        acknowledged.add(identity)
      }
      for(const ack of result.acks){
        await db(scope,'ack',ack.collection,ack.id,{revision:ack.revision,version:ack.version})
      }
      await db(scope,'merge',undefined,undefined,result.records)
      await db(scope,'sync-complete',undefined,undefined,{at:new Date().toISOString(),uploaded:result.acks.length})
      return {uploaded:result.acks.length,conflicts:(await db<SyncStatus>(scope,'status')).conflicts}
    })().finally(()=>{if(flights.get(scope)===flight)flights.delete(scope)})
    flights.set(scope,flight)
  }
  return flight
}

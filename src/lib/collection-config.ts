import { invoke } from '@tauri-apps/api/core'

export const COLLECTION_BASE='https://lium.eu.org'
export interface CollectionGrant { markets:string[]; capabilities:string[]; expires_at:string; connections:number; rpm:number; market_subscriptions?:Record<string,number> }
export interface CollectionStatus { configured:boolean; lastMarketAt?:number; masked?:string; permissions?:{active_packages:CollectionGrant[]}; error?:string }
let status:CollectionStatus={configured:false}
let loadedScope='', generation=0, browserKey=''
const listeners=new Set<()=>void>()
let enabled=false
export const collectionMode=()=>enabled
export function enableCollectionMode(){enabled=true}
export const nativeCollection=()=>typeof window!=='undefined' && !!window.__TAURI_INTERNALS__
export function collectionScope():string {
  try {const user=JSON.parse(localStorage.getItem('qihuo_auth_user')||'null');return `${localStorage.getItem('atd_desktop_server')||(typeof window!=='undefined'?window.__QH_API_BASE__:'')||'default'}:${user?.id||'anonymous'}`}
  catch{return 'default:anonymous'}
}
export const collectionStatus=()=>status
export const collectionGeneration=()=>generation
export function onCollectionChange(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn)}}
function publish(next:CollectionStatus){status=next;generation++;listeners.forEach(fn=>fn())}
export async function loadCollectionConfig():Promise<CollectionStatus>{
  const scope=collectionScope()
  if(loadedScope===scope)return status
  loadedScope=scope;browserKey='';publish({configured:false})
  if(nativeCollection()){
    try {const next=await invoke<CollectionStatus>('collection_key',{scope,action:'status',key:null});if(scope===collectionScope())publish(next)}
    catch{if(scope===collectionScope())publish({configured:false,error:'行情 Key 读取失败，请重新配置'})}
  }
  return status
}
export async function collectionKeyAction(action:'test'|'save'|'clear',key=''):Promise<CollectionStatus>{
  const scope=collectionScope()
  let next:CollectionStatus
  if(nativeCollection())next=await invoke<CollectionStatus>('collection_key',{scope,action,key:key||null})
  else {
    if(action==='clear'){browserKey='';next={configured:false}}
    else {
      if(!/^ac_[A-Za-z0-9_]{17,157}$/.test(key.trim()))throw new Error('请填写有效的 API Key')
      const response=await fetch('/__collection__/v1/my/permissions',{headers:{'X-API-Key':key.trim()}})
      const data=await response.json()
      if(!response.ok||data.code!==200)throw new Error('Key 无效、已过期或未开通套餐')
      next={configured:action==='save',masked:key.slice(0,10)+'…',permissions:data.data}
      if(action==='save')browserKey=key.trim()
    }
  }
  if(scope!==collectionScope())throw new Error('账号已切换，请重新配置')
  if(action!=='test'){loadedScope=scope;publish(next)}
  return next
}
export async function collectionRequest<T>(path:string,body?:unknown):Promise<T>{
  await loadCollectionConfig()
  if(!status.configured)throw new Error('请在个人中心 → 数据配置中填写 API Key')
  const scope=collectionScope(),version=generation
  let reply:{code:number;msg:string;data:T}
  if(nativeCollection())reply=await invoke('collection_http',{scope,path,body:body??null})
  else {
    const response=await fetch('/__collection__'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(!path.startsWith('/edge/')?{'X-API-Key':browserKey}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(path.startsWith('/edge/okx?')?8000:30000)})
    reply=await response.json()
  }
  if(scope!==collectionScope()||version!==generation)throw new Error('行情配置已变化，已取消旧请求')
  if(reply.code!==200)throw new Error(reply.msg||'行情读取失败')
  return reply.data
}

export function collectionIssue(error:string){status={...status,error};listeners.forEach(fn=>fn())}
export async function refreshCollectionPermissions(){const permissions=await collectionRequest<{active_packages:CollectionGrant[]}>('/v1/my/permissions');status={...status,permissions};listeners.forEach(fn=>fn());return permissions}

export function collectionReceived(){if(Date.now()-(status.lastMarketAt||0)>1000){status={...status,lastMarketAt:Date.now(),error:undefined};listeners.forEach(fn=>fn())}}

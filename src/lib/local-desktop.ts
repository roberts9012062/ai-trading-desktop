/** Native exchange transport. Task creation always remains a server request. */
import { invoke, isTauri } from '@tauri-apps/api/core'
import { collectionMode, collectionScope, collectionGeneration, loadCollectionConfig } from './collection-config'
import { requireCollectionPrivate } from './collection-exchange'
import { collectionHttpSlot } from './collection-api'

const reads = new Map<string, Promise<Response>>()
let localEpoch = 0
export const localExchangeGeneration=()=>localEpoch
const routes = /^\/api\/live\/(?:permission|credentials(?:\/okx)?|desktop-ws-login|account|positions(?:\/close)?|orders(?:\/[^/]+)?|local-order|bills|account-mode|fee-rates|local-execution\/confirm-flat)$/
const manualWrite=(route:string,method:string)=>method==='POST'&&['/api/live/orders','/api/live/positions/close','/api/live/local-execution/confirm-flat'].includes(route)||method==='DELETE'&&/^\/api\/live\/orders\/[^/]+$/.test(route)

export async function tryLocalLiveRequest(path: string, options: RequestInit = {}, expectedBinding?: string, originCurrent?:()=>void): Promise<Response | null> {
  if (!isTauri() || !collectionMode() || !routes.test(path.split('?')[0])) return null
  await loadCollectionConfig()
  const scope = collectionScope(), epoch = collectionGeneration(), accountEpoch = localEpoch
  const method = (options.method || 'GET').toUpperCase()
  const current = () => {
    originCurrent?.()
    if (scope !== collectionScope() || epoch !== collectionGeneration() || accountEpoch !== localEpoch) throw new Error('会话或数据配置已变化，已取消旧请求')
    options.signal?.throwIfAborted()
  }
  const run = async () => {
    current()
    const route = path.split('?')[0]
    const local = route === '/api/live/permission' || route.startsWith('/api/live/credentials')
    if (!local) await requireCollectionPrivate(route === '/api/live/desktop-ws-login' ? 'okx_private_ws' : 'okx_private')
    const execute = async () => {
      current()
      if (options.body != null && typeof options.body !== 'string') throw new Error('本机交易请求需要 JSON 内容')
      const data = await invoke('desktop_local_exchange', { scope, path, method, body: options.body ? JSON.parse(options.body as string) : null, expectedBinding: expectedBinding ?? null })
      current()
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
    }
    const priority=route==='/api/live/orders'&&new URLSearchParams(path.split('?')[1]||'').get('history')==='true'?0:1
    return local || route === '/api/live/desktop-ws-login' ? execute() : collectionHttpSlot(execute, priority)
  }
  if (method !== 'GET' || options.signal) return run()
  const key = `${scope}\0${epoch}\0${accountEpoch}\0${expectedBinding ?? ''}\0${path}`
  let shared = reads.get(key)
  if (!shared) {
    shared = run().finally(() => { if (reads.get(key) === shared) reads.delete(key) })
    reads.set(key, shared)
  }
  return (await shared).clone()
}

export async function localLiveBinding(): Promise<string | null> {
  if (!isTauri() || !collectionMode()) return null
  await loadCollectionConfig()
  const scope = collectionScope(), epoch = localEpoch, generation = collectionGeneration()
  const result = await invoke<{credentials?: Array<{account_binding?: string | null}>}>('desktop_local_exchange', {
    scope, path:'/api/live/credentials', method:'GET', body:null, expectedBinding:null,
  })
  if (scope !== collectionScope() || epoch !== localEpoch || generation !== collectionGeneration()) throw new Error('会话或数据配置已变化，已取消旧请求')
  const binding = result.credentials?.[0]?.account_binding
  return typeof binding === 'string' && /^[a-f0-9]{64}$/.test(binding) ? binding : null
}

/** Native writes require a server-bound account and exclusive center authority. */
export async function tryPreparedLocalLiveRequest(path:string,options:RequestInit={},expectedBinding?:string,originCurrent?:()=>void):Promise<Response|null>{
  const route=path.split('?')[0],method=(options.method||'GET').toUpperCase()
  if (!routes.test(route) || !(method==='GET'||route==='/api/live/desktop-ws-login'&&method==='POST'||manualWrite(route,method))) return null
  const binding=await localLiveBinding()
  originCurrent?.()
  if(expectedBinding&&binding!==expectedBinding)throw new Error('本机交易账户已变化，请重新读取账户后操作')
  return binding ? tryLocalLiveRequest(path,options,binding,originCurrent) : null
}

export async function confirmLocalExchangeFlat():Promise<{message:string}>{
  const scope=collectionScope(),epoch=localEpoch,generation=collectionGeneration()
  const current=()=>{if(scope!==collectionScope()||epoch!==localEpoch||generation!==collectionGeneration())throw new Error('会话或账户已变化，请在原账号核对')}
  const response=await tryPreparedLocalLiveRequest('/api/live/local-execution/confirm-flat',{method:'POST',body:'{}'},undefined,current)
  if(!response)throw new Error('请先在桌面端同步交易所账户并配置数据 Key')
  return response.json() as Promise<{message:string}>
}

function changed(){localEpoch++;reads.clear();if(typeof window!=='undefined')window.dispatchEvent(new Event('local-exchange-changed'))}

export async function clearLocalExchangeAccount(expectedScope:string):Promise<void>{
  if(!isTauri()||!collectionMode())return
  if(expectedScope!==collectionScope())throw new Error('账号已切换，请在原账号核对保存结果')
  localEpoch++;reads.clear()
  await invoke('desktop_local_exchange',{scope:expectedScope,path:'/api/live/credentials/okx',method:'DELETE',body:null,expectedBinding:null})
  if(expectedScope===collectionScope())changed()
}

export async function importLocalExchangeAccount():Promise<{imported:boolean;reason?:string}>{
  if(!isTauri()||!collectionMode())throw new Error('请在桌面端配置数据 Key 后同步')
  const scope=collectionScope(),token=localStorage.getItem('access_token')
  const base=localStorage.getItem('atd_desktop_server')||window.__QH_API_BASE__||process.env.NEXT_PUBLIC_API_URL||''
  if(!token)throw new Error('请先登录服务器账号')
  const result=await invoke<{imported:boolean;reason?:string}>('desktop_credential_import',{scope,base,token})
  if(scope!==collectionScope())throw new Error('账号已切换，已取消旧账户同步')
  changed()
  return result
}

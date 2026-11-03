import {invoke,isTauri} from '@tauri-apps/api/core'
import {hostSession,onHostSessionChange,hostRequest,type HostSession} from './taskhost-client'
import {selectedLocalHostProfile} from './taskhost-local-profile'

export interface ServerDataAccount {credential_id:string;label:string;demo:boolean;account_id?:string;source:'direct'|'collection'|'none';status:'pending'|'ok'|'unavailable'|'identity_mismatch';code:string;observed_at?:string;stale:boolean;balances:unknown[];positions:unknown[]}
export interface ServerDataStatus {mode:'direct'|'collection';collection_configured:boolean;accounts:ServerDataAccount[];execution_authority:false;refreshed_at:string}
export interface ClientSyncReceipt {sync_id:string;credentials:{client_id:string;credential_id:string;venue:'okx';label:string;demo:boolean;api_key_masked:string}[];collection_configured:boolean;collection_status:string;data_status:'pending'|'ok'|'unavailable';execution_authority:false;tasks_created:false}
type NativeSync = {sent:false;reason:'local_configuration_missing'}|{sent:true;receipt:ClientSyncReceipt}
export interface ClientSyncStatus {state:'idle'|'syncing'|'synced'|'unavailable'|'missing_profile'|'profile_changed'|'missing_configuration'|'native_required';profileName?:string;credentialCount?:number;collectionConfigured?:boolean;syncedAt?:string;data?:ServerDataStatus}
export function validServerObservation(value:string|undefined,now=Date.now()){const observed=Date.parse(value||'');return Number.isFinite(observed)&&observed>=946684800000&&observed<=now+10000}
export function serverAccountDataFresh(account:ServerDataAccount,now=Date.now()){const observed=Date.parse(account.observed_at||'');return account.status==='ok'&&!account.stale&&validServerObservation(account.observed_at,now)&&now-observed<=60000}
export function serverAccountDataIssue(account:ServerDataAccount){const fixed:Record<string,string>={okx_credentials_rejected:'OKX 凭证未通过校验，请核对 API Key、Secret、Passphrase 和读取权限。',okx_account_identity_changed:'OKX 账户身份已变化，请重新核对绑定。',okx_data_incomplete:'账户数据返回不完整，不能确认当前完整持仓。',client_key_revoked:'客户端登录密钥已失效，请重新核对连接。',okx_unavailable_collection_key_required:'OKX 直连不可用，可配置或同步 API Collection Key。',okx_direct_unavailable:'OKX 直连暂不可用，当前通过 API Collection 读取数据。'};return fixed[account.code]||''}
let status:ClientSyncStatus={state:'idle'},attempted='',operation=0
let flight:{key:string;promise:Promise<void>}|null=null
let contextQueue:Promise<unknown>=Promise.resolve()
const listeners=new Set<()=>void>()
export const clientSyncStatus=()=>status
export function onClientSyncChange(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn)}}
function publish(next:ClientSyncStatus){status=next;listeners.forEach(fn=>fn())}
function identity(session:HostSession|null){return session?.mode==='server'?JSON.stringify([session.origin,session.ownerID,session.token,session.localProfileScope]):''}
function current(expected:HostSession,scope:string,started:number){if(identity(hostSession())!==identity(expected)||selectedLocalHostProfile()?.scope!==scope||operation!==started)throw new Error('同步所属账号已变化')}
function nativeContext(args:Record<string,unknown>,before?:()=>void){const next=contextQueue.then(()=>{before?.();return invoke<number>('taskhost_client_sync_context',args)});contextQueue=next.catch(()=>{});return next}
function validReceipt(value:ClientSyncReceipt,id:string){return value?.sync_id===id&&value.execution_authority===false&&value.tasks_created===false&&Array.isArray(value.credentials)&&value.credentials.every(c=>/^[a-f0-9]{64}$/.test(c.client_id)&&typeof c.credential_id==='string'&&c.venue==='okx'&&typeof c.demo==='boolean')}

/** The native command reads scoped DPAPI secrets and sends them directly.
 * Neither the renderer nor browser storage receives a plaintext secret export. */
export async function syncCurrentClientConfiguration(force=false):Promise<void>{
  const session=hostSession(),key=identity(session),profile=selectedLocalHostProfile()
  if(session?.mode!=='server')return
  if(!isTauri()){publish({state:'native_required'});return}
  if(!session.localProfileScope||!profile){publish({state:'missing_profile',profileName:session.localProfileName});return}
  if(profile.scope!==session.localProfileScope){publish({state:'profile_changed',profileName:session.localProfileName});return}
  if(flight?.key===key)return flight.promise
  if(!force&&attempted===key)return
  attempted=key
  const started=++operation,scope=profile.scope
  publish({state:'syncing',profileName:profile.label})
  const promise=(async()=>{
    try{
      const generation=await nativeContext({scope,origin:session.origin,ownerId:session.ownerID,token:session.token},()=>current(session,scope,started))
      current(session,scope,started)
      const requestID=crypto.randomUUID()
      const result=await invoke<NativeSync>('taskhost_client_sync',{scope,generation,origin:session.origin,ownerId:session.ownerID,token:session.token,requestId:requestID})
      current(session,scope,started)
      if(result.sent===false){publish({state:'missing_configuration',profileName:profile.label});await refreshClientServerData();return}
      if(result.sent!==true||!validReceipt(result.receipt,requestID))throw new Error('配置同步回执无效')
      publish({state:'synced',profileName:profile.label,credentialCount:result.receipt.credentials.length,collectionConfigured:result.receipt.collection_configured,syncedAt:new Date().toISOString()})
      await refreshClientServerData()
    }catch{
      if(identity(hostSession())===identity(session)&&selectedLocalHostProfile()?.scope===scope&&operation===started)publish({state:'unavailable',profileName:profile.label})
    }
  })().finally(()=>{if(flight?.promise===promise)flight=null})
  flight={key,promise};return promise
}
export async function refreshClientServerData(){
  const session=hostSession(),profile=selectedLocalHostProfile(),started=operation
  if(session?.mode!=='server'||!profile||profile.scope!==session.localProfileScope)return
  try{
    const data=await hostRequest<ServerDataStatus>('/api/v1/data/status')
    current(session,profile.scope,started)
    if(data.execution_authority!==false||!Array.isArray(data.accounts)||!['direct','collection'].includes(data.mode)||data.accounts.some(a=>!Array.isArray(a.balances)||!Array.isArray(a.positions)||typeof a.stale!=='boolean'))return
    publish({...status,data})
  }catch{if(identity(hostSession())===identity(session)&&selectedLocalHostProfile()?.scope===profile.scope&&operation===started&&status.data)publish({...status,data:{...status.data,accounts:status.data.accounts.map(account=>({...account,stale:true}))}})}
}

/** Called on every host/profile boundary. Native cancellation is independent of
 * pending responses so another profile is never silently adopted by an owner. */
export function invalidateClientSync(){
  operation++;attempted='';flight=null;publish({state:'idle'})
  if(isTauri())void nativeContext({scope:null,origin:null,ownerId:null,token:null}).catch(()=>{})
}
export function attachClientAutoSync(subscribeProfile:(fn:()=>void)=>()=>void){
  let previous='',disposed=false
  const changed=()=>{
    if(disposed)return
    const session=hostSession(),key=identity(session),profile=selectedLocalHostProfile()
    const next=JSON.stringify([key,profile?.scope||''])
    if(next===previous)return;previous=next
    invalidateClientSync()
    if(session?.mode==='server')void syncCurrentClientConfiguration()
  }
  const stopHost=onHostSessionChange(changed),stopProfile=subscribeProfile(changed)
  window.addEventListener('storage',changed)
  const timer=setInterval(()=>{if(!document.hidden&&status.state==='synced')void refreshClientServerData()},10000)
  changed()
  return()=>{disposed=true;stopHost();stopProfile();window.removeEventListener('storage',changed);clearInterval(timer);invalidateClientSync()}
}

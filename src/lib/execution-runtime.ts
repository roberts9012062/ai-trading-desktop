/** Native worker supervision; signed preparations and keys never enter this module. */
import {invoke,isTauri} from '@tauri-apps/api/core'
import {useAuthStore} from '@/stores/auth'
import {collectionMode,collectionScope,collectionGeneration,collectionStatus,onCollectionChange} from './collection-config'
import {localExchangeGeneration} from './local-desktop'

export interface ExecutionStatus {prepared:boolean;runtime_installed:boolean;enabled?:boolean;worker:{state:string;account_id?:string;error?:string};error?:string}
export interface ExecutionSnapshot {available:boolean;checkpoint_seq:number;pending_checkpoint:boolean;truncated:boolean;tasks:{id:string;name:string;symbol:string;timeframe:string;strategy_type:string;recorded_status:string;last_run_at:string|null;updated_at:string|null}[]}
const stateLabels:Record<string,string>={not_prepared:'待同步任务准备数据',prepared:'准备数据已保存',preparing:'正在验证与恢复',running:'本机持有执行权',stopping:'正在保存状态并交接',stopped:'本机执行器已停止',waiting_executor:'等待账户执行权',waiting_reconciliation:'待核对交易结果',manual_flatten_required:'任务已锁定，请手动平仓并确认',server_sync_required:'需要重新同步服务器',startup_failed:'启动失败，请重新同步准备数据'}
export const executionStateLabel=(state:string)=>stateLabels[state]||'状态待确认'
let status:ExecutionStatus={prepared:false,runtime_installed:false,worker:{state:'not_prepared'}}
const listeners=new Set<()=>void>()
export const executionStatus=()=>status
export function onExecutionChange(callback:()=>void){listeners.add(callback);return()=>{listeners.delete(callback)}}
function publish(next:ExecutionStatus){status=next;listeners.forEach(callback=>callback())}
function identity(){const auth=useAuthStore.getState();return `${collectionScope()}:${collectionGeneration()}:${localExchangeGeneration()}:${auth.loaded}:${auth.user?.id||''}:${auth.user?.trading_mode||''}:${collectionStatus().configured}`}
function activeScope(){const auth=useAuthStore.getState();return isTauri()&&collectionMode()&&collectionStatus().configured&&auth.loaded&&auth.user?.trading_mode==='live'?collectionScope():null}
interface Context {scope:string;generation:number;owner:string}
let context:Context|null=null
let opening:{owner:string;promise:Promise<Context|null>}|null=null
let contextQueue:Promise<void>=Promise.resolve()
function current(owner:string){if(owner!==identity())throw new Error('账号或数据配置已变化，已取消旧执行器请求')}
function nativeContext(owner:string,scope:string|null){
  // A delayed logout must finish before the following login reaches native
  // context mutation. Discard superseded requests before they leave the UI.
  const pending=contextQueue.then(()=>{current(owner);return invoke<number>('desktop_executor_context',{scope})})
  contextQueue=pending.then(()=>undefined,()=>undefined)
  return pending
}

export async function syncExecutionContext(restore=false):Promise<Context|null>{
  if(!isTauri())return null
  // A webview reload begins with cached auth still hydrating. It is not a
  // logout and must not retire an independently running native worker.
  // Explicit logout/mode changes complete auth first and still retire it below.
  if(!useAuthStore.getState().loaded)return null
  const owner=identity(),scope=activeScope()
  if(!scope){context=null;await nativeContext(owner,null);current(owner);publish({prepared:false,runtime_installed:false,worker:{state:'not_prepared'}});return null}
  if(opening?.owner===owner){
    const pending=opening.promise
    if(!restore)return pending
    return pending.then(async next=>{if(next)await refreshAndRestore(next,true);return next})
  }
  if(context?.owner===owner){
    // Native shutdown/update/credential invalidation can advance its generation
    // while this renderer identity stays unchanged. Refresh the opaque guard.
    const generation=await nativeContext(owner,scope);current(owner)
    context={scope,generation,owner}
    if(restore)await refreshAndRestore(context,true)
    return context
  }
  context=null;publish({prepared:false,runtime_installed:false,worker:{state:'not_prepared'}})
  const promise=(async()=>{
    const generation=await nativeContext(owner,scope);current(owner)
    const next={scope,generation,owner};context=next
    await refreshAndRestore(next,restore)
    return next
  })().finally(()=>{if(opening?.promise===promise)opening=null})
  opening={owner,promise}
  return promise
}

async function refreshExecutionStatus(captured:Context){
  const next=await invoke<ExecutionStatus>('desktop_executor_status',{scope:captured.scope,generation:captured.generation})
  current(captured.owner);publish(next)
}
async function refreshAndRestore(captured:Context,restore:boolean){
  await refreshExecutionStatus(captured)
  if(restore&&status.prepared&&status.runtime_installed&&status.enabled===true){
    current(captured.owner)
    await invoke('desktop_executor_start',{scope:captured.scope,generation:captured.generation,restore:true});current(captured.owner)
    await refreshExecutionStatus(captured)
  }
}
export async function executionAction(action:'prepare'|'start'|'stop'){
  const owner=identity()
  const token=localStorage.getItem('access_token')||''
  if(action==='prepare'&&!token)throw new Error('请先完成服务器登录，再同步任务准备数据')
  const captured=await syncExecutionContext()
  if(!captured)throw new Error('请在实盘服务器账号中配置数据 Key，并同步交易所账户')
  current(owner)
  const args={scope:captured.scope,generation:captured.generation}
  if(action==='prepare'){
    const base=localStorage.getItem('atd_desktop_server')||window.__QH_API_BASE__||''
    await invoke('desktop_executor_prepare',{...args,base,token})
  }else await invoke(`desktop_executor_${action}`,action==='start'?{...args,restore:false}:args)
  current(owner);await refreshExecutionStatus(captured)
}

export async function readExecutionSnapshot():Promise<ExecutionSnapshot>{
  const owner=identity(),captured=await syncExecutionContext()
  if(!captured)throw new Error('请在实盘服务器账号中配置数据 Key，并同步交易所账户')
  current(owner)
  const snapshot=await invoke<ExecutionSnapshot>('desktop_executor_snapshot',{scope:captured.scope,generation:captured.generation})
  current(owner);return snapshot
}

/** Hiding a window and React unmount/reload are not application shutdown. The
 * native exit/update hooks own draining; only an auth/config boundary retires
 * the current context here. Automatic restore never calls preparation/task APIs.
 */
export function attachExecutionRuntime(){
  if(!isTauri())return()=>{}
  let disposed=false,owner='',polling=false
  const changed=()=>{
    const next=identity();if(next===owner)return;owner=next
    void syncExecutionContext(true).catch(error=>{if(!disposed&&identity()===next)publish({...status,error:error instanceof Error?error.message:'本机执行器尚未准备好'})})
  }
  const stopAuth=useAuthStore.subscribe(changed),stopConfig=onCollectionChange(changed)
  window.addEventListener('local-exchange-changed',changed)
  const timer=setInterval(()=>{
    if(polling||!context||context.owner!==identity())return
    polling=true
    const captured=context
    void refreshExecutionStatus(captured).catch(error=>{if(!disposed&&captured.owner===identity()){
      context=null
      publish({...status,worker:{state:'waiting_executor'},error:error instanceof Error?error.message:'本机执行器状态不可用'})
    }}).finally(()=>{polling=false})
  },3000)
  changed()
  return()=>{disposed=true;stopAuth();stopConfig();window.removeEventListener('local-exchange-changed',changed);clearInterval(timer)}
}

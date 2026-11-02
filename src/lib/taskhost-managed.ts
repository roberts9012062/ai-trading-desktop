/** Server-owned identities and center CAS controls. No action is retried here. */
import { invoke } from '@tauri-apps/api/core';
import { hostRequest, hostSession } from './taskhost-client';

export type ControlAction = 'pause' | 'stop' | 'delete' | 'resume';
export interface ManagedTask {
  id: string; name: string; kind: 'ai'|'decision'|'forecast'|'shortline'; symbol: string;
  timeframe: string; credential_id: string; model_id?: string; account_id: string;
  status: string; revision: string; control_version: string; registration: string;
  desired_state: string; center_desired_state?: string;
}
export interface ManagedCapabilities {
  protocol: 'taskhost-managed-v1'; create_requires_server: true;
  runtime_available: boolean; managed_tasks: boolean; ai_models: boolean;
  trading_enabled: boolean; standalone_creation: false; execution_authority: false;
  center_control_protocol: 'task-control-v1';
}
export interface ModelInfo { id:string; name:string; kind:string; model_id:string }
export interface NativeTaskInput {
  request_id:string; name:string; kind:'ai'|'decision'|'forecast'|'shortline'; symbol:string;
  timeframe:string; credential_id:string; model_id?:string;
  strategy:Record<string,unknown>; settings:Record<string,unknown>;
}
export interface TaskState {
  account_id:string; task_id:string; epoch:string; revision:string;
  control_version:string; task_control_version:string; desired_state:'running'|'paused'|'stopped';
  deleted:boolean; native_resume:boolean; restart_after_revision:string;
  checkpoint_seq:string; observed_at_ms:string; execution_authority:false;
  source:'task_control_state'; stop_control_id:string;
}
const hash = /^[a-f0-9]{64}$/;
const identity = /^[A-Za-z0-9_-]{1,100}:[A-Za-z0-9_-]{1,100}$/;
const counter = (v:unknown) => typeof v==='string' && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v)<=9223372036854775807n;
const sameSession = (s:ReturnType<typeof hostSession>) => { if (!s || hostSession()!==s) throw new Error('会话已变化，请重新读取当前账户'); };
function pendingKey(){const s=hostSession();return s?.mode==='server'?`taskhost_pending_create:${s.origin}:${s.ownerID}`:null;}
export function pendingManagedRequest():string|null{try{const key=pendingKey(),value=key?sessionStorage.getItem(key):null;return value&&/^[A-Za-z0-9_-]{16,100}$/.test(value)?value:null;}catch{return null;}}
export function clearPendingManagedRequest(){try{const key=pendingKey();if(key)sessionStorage.removeItem(key);}catch{/* The current view still keeps its request identity. */}}
function rememberRequest(id:string){try{const key=pendingKey();if(key)sessionStorage.setItem(key,id);}catch{/* Memory-only UI lock remains active on unknown result. */}}
export class ManagedCreateUncertain extends Error{}
export function checkedState(raw:unknown, account:string, task?:string):TaskState {
  const v=raw as TaskState;
  if (!v || typeof v!=='object' || !hash.test(account) || v.account_id!==account || !identity.test(v.task_id) || (task && v.task_id!==task)
    || v.source!=='task_control_state' || v.execution_authority!==false || typeof v.deleted!=='boolean' || typeof v.native_resume!=='boolean'
    || !['running','paused','stopped'].includes(v.desired_state) || typeof v.stop_control_id!=='string'
    || (v.stop_control_id!=='' && !/^[a-f0-9]{32}$/.test(v.stop_control_id))
    || ![v.epoch,v.revision,v.control_version,v.task_control_version,v.restart_after_revision,v.checkpoint_seq,v.observed_at_ms].every(counter)
    || v.revision==='0' || v.task_control_version!==v.control_version) throw new Error('中心任务状态格式不兼容，请升级中心并重新核对');
  return v;
}
export async function managedCapabilities():Promise<ManagedCapabilities> {
  const v=await hostRequest<ManagedCapabilities>('/api/v1/managed-capabilities');
  if(v.protocol!=='taskhost-managed-v1' || v.create_requires_server!==true || v.execution_authority!==false || v.standalone_creation!==false || v.center_control_protocol!=='task-control-v1') throw new Error('服务器尚未支持 Go 原生任务协议');
  return v;
}
export async function createManagedTask(input:NativeTaskInput):Promise<ManagedTask> {
  const session=hostSession();
  if(session?.mode!=='server')throw new Error('新建任务必须在线连接服务器');
  const caps=await managedCapabilities();sameSession(session);
  if(caps.runtime_available!==true || caps.managed_tasks!==true)throw new Error('服务器 Go 运行时尚未开放，不能新建任务');
  const pending=pendingManagedRequest();if(pending)throw new ManagedCreateUncertain('原创建结果尚未核对，只能查询原请求，不能重新提交');
  rememberRequest(input.request_id);
  let out:{task:ManagedTask;execution_authority:false};
  try {out=await hostRequest('/api/v1/managed-tasks',{method:'POST',body:JSON.stringify(input)});}
  catch(error) {
    const rejected=error as {status?:number;code?:string};
    if(hostSession()===session && ((rejected.status===422&&rejected.code==='task_create_rejected')||(rejected.status===400&&rejected.code==='invalid_json'))){
      clearPendingManagedRequest();throw new Error('服务器已确认配置未通过，本次没有创建任务。请更正配置后重新提交。');
    }
    throw new ManagedCreateUncertain('新建结果未确认。请刷新服务器任务并核对；不会离线创建或自动重试。');
  }
  sameSession(session);
  if(out.execution_authority!==false || !out.task || !/^[a-f0-9-]{36}$/.test(out.task.id) || !counter(out.task.revision))throw new ManagedCreateUncertain('服务器任务响应未确认，请刷新核对');
  clearPendingManagedRequest();
  return out.task;
}
async function center<T>(path:string,body?:unknown):Promise<T> {
  const s=hostSession();if(s?.mode!=='standalone')throw new Error('请先完成单机登录');
  const reply=await invoke<{code:number;data:T}>('collection_http',{scope:s.scope,path,body:body??null});sameSession(s);
  if(reply?.code!==200)throw new Error('中心未确认请求，请刷新核对');
  return reply.data;
}
export async function standaloneControlAvailable():Promise<boolean> {
  const v=await center<Record<string,unknown>>('/v1/execution/task-capabilities');
  return v.protocol==='task-control-v1' && v.existing_tasks_only===true && v.counter_encoding==='decimal_string' && v.expected_control_version_required===true
    && v.delete_requires_flat_shutdown===true && v.execution_authority===false && v.resume_requires_native_server_policy===true && v.resume_requires_server_certificate===true && v.native_resume_protocol==='native-task-control-v1'
    && ['pause','stop','delete','resume'].every(k=>v[k]===true);
}
export async function readTaskState(account:string,task:string,serverID?:string):Promise<TaskState> {
  const s=hostSession();if(!s)throw new Error('请先登录');
  const raw=s.mode==='server'
    ? await hostRequest(`/api/v1/managed-tasks/${serverID}/center-state`)
    : await center('/v1/execution/task-state',{account_id:account,task_id:task});
  sameSession(s);const state=checkedState(raw,account,task||undefined);
  if(s.mode==='server' && (!serverID || !state.task_id.endsWith(':'+serverID)))throw new Error('中心任务身份不匹配');
  return state;
}
/** Fresh CAS -> one mutation -> fresh observation, including uncertain mutations. */
export async function controlExistingTask(account:string,task:string,action:ControlAction,serverID?:string):Promise<TaskState> {
  const s=hostSession();if(!s)throw new Error('请先登录');
  if(s.mode==='standalone' && !await standaloneControlAvailable())throw new Error('中心尚未支持安全逐任务控制');
  const before=await readTaskState(account,task,serverID);sameSession(s);
  if(before.deleted)throw new Error('该任务已删除');
  if(action==='resume' && !before.native_resume)throw new Error('该任务需要原服务器重新签发，不能单机恢复');
  const request={request_id:crypto.randomUUID().replaceAll('-',''),expected_epoch:before.epoch,expected_revision:before.revision,expected_control_version:before.control_version,action};
  let uncertain=false;
  try {
    const out=s.mode==='server'?await hostRequest<{receipt:Record<string,unknown>;execution_authority:false}>(`/api/v1/managed-tasks/${serverID}/control`,{method:'POST',body:JSON.stringify(request)}):null;
    const receipt=out?out.receipt:await center<Record<string,unknown>>('/v1/execution/task-control',{account_id:account,task_id:task,...request});
    if((out && out.execution_authority!==false) || receipt?.source!=='task_control_receipt' || receipt.receipt!==true || receipt.request_id!==request.request_id || receipt.action!==action
      || receipt.account_id!==account || receipt.task_id!==before.task_id || receipt.epoch!==before.epoch || receipt.revision!==before.revision
      || receipt.control_version!==(BigInt(before.control_version)+1n).toString() || receipt.execution_authority!==false)throw new Error();
  }catch {uncertain=true;}
  sameSession(s);
  const after=await readTaskState(account,task,serverID);
  if(uncertain)throw new Error(`操作结果未确认，已重新读取中心状态：${after.deleted?'已删除':after.desired_state}。请核对后再操作，不会自动重试。`);
  return after;
}
export async function reconcileManagedTask(id:string) {
  return hostRequest<{task:ManagedTask}>('/api/v1/managed-tasks/'+id+'/reconcile',{method:'POST',body:'{}'});
}
/** Explicitly publish only a never-dispatched prepared outbox; unknown uses reconcile. */
export async function registerManagedTask(id:string){return hostRequest<{task:ManagedTask}>(`/api/v1/managed-tasks/${id}/register`,{method:'POST',body:'{}'});}

/** Metadata preparation and the later user control remain separate explicit operations. */
export async function prepareManagedTask(id:string,action:'delete'|'resume'){
  const session=hostSession();if(session?.mode!=='server')throw new Error('请在服务器连接中准备任务');
  const out=await hostRequest<{prepared?:boolean;preparing?:boolean;execution_authority:false}>(`/api/v1/managed-tasks/${id}/prepare-${action}`,{method:'POST',body:'{}',signal:AbortSignal.timeout(110000)});
  sameSession(session);if(out.execution_authority!==false)throw new Error('准备结果无效');return out;
}

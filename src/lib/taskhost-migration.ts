import {invoke,isTauri} from '@tauri-apps/api/core';
import {hostRequest,hostSession} from './taskhost-client';
import type {ManagedTask} from './taskhost-managed';

export interface MigrationSelection {account_id:string;task_id:string;credential_id:string;model_id:string}
export interface MigrationReview {review:string;account_id:string;task_id:string;source_revision:string;source_control_version:string;checkpoint_seq:string;epoch:string;issues:string[];mappings:string[];convertible:boolean;center_ready:boolean;execution_authority:false}
const hash=/^[a-f0-9]{64}$/;
function online(){const session=hostSession();if(session?.mode!=='server')throw new Error('旧任务迁移必须连接服务器');return session;}
function unchanged(session:ReturnType<typeof online>){if(hostSession()!==session)throw new Error('会话已变化，请重新检查旧任务');}
function storageKey(){const session=online();return `taskhost_pending_migration:${session.origin}:${session.ownerID}`;}
export function pendingMigration():string|null{try{const id=sessionStorage.getItem(storageKey());return id&&/^[A-Za-z0-9_-]{16,100}$/.test(id)?id:null;}catch{return null;}}
function remember(id:string|null){try{const key=storageKey();if(id)sessionStorage.setItem(key,id);else sessionStorage.removeItem(key);}catch{/* The current component still retains its request lock. */}}
export async function inspectMigration(selection:MigrationSelection):Promise<MigrationReview>{
 const session=online();const out=await hostRequest<MigrationReview>('/api/v1/migrations/inspect',{method:'POST',body:JSON.stringify(selection),signal:AbortSignal.timeout(110000)});unchanged(session);
 if(out.execution_authority!==false||!hash.test(out.review)||out.account_id!==selection.account_id||out.task_id!==selection.task_id||!Array.isArray(out.issues)||!out.issues.every(v=>typeof v==='string')||!Array.isArray(out.mappings)||typeof out.convertible!=='boolean'||typeof out.center_ready!=='boolean')throw new Error('迁移检查结果无效');return out;
}
export async function witnessMigration(selection:MigrationSelection){
 const session=online();const out=await hostRequest<{witness:{state:string;code?:string};execution_authority:false;local_shutdown_acknowledged:false}>('/api/v1/migrations/witness',{method:'POST',body:JSON.stringify(selection),signal:AbortSignal.timeout(110000)});unchanged(session);
 if(out.execution_authority!==false||out.local_shutdown_acknowledged!==false||typeof out.witness?.state!=='string')throw new Error('服务器见证状态无效');return out.witness;
}
export async function stopLegacyForMigration(accountID:string){
 const session=online();if(!isTauri()||!session.centerScope||!hash.test(accountID))throw new Error('请先在桌面客户端绑定并保存同一中心身份');
 const out=await invoke<{active:boolean;shutdown_acknowledged:boolean;account_id?:string}>('taskhost_legacy_shutdown',{centerScope:session.centerScope,accountId:accountID});unchanged(session);
 if(out.active!==false||typeof out.shutdown_acknowledged!=='boolean'||(out.shutdown_acknowledged&&out.account_id!==accountID))throw new Error('本机退出结果未确认');return out;
}
export async function pauseLegacyForMigration(selection:MigrationSelection){
 const session=online();const out=await hostRequest<{execution_authority:false;refresh_required:true}>('/api/v1/migrations/pause',{method:'POST',body:JSON.stringify({selection,request_id:crypto.randomUUID().replaceAll('-','')}),signal:AbortSignal.timeout(110000)});unchanged(session);if(out.execution_authority!==false||out.refresh_required!==true)throw new Error('暂停回执未确认');return out;
}
export class MigrationUncertain extends Error{}
export async function commitMigration(selection:MigrationSelection,review:MigrationReview,requestID:string):Promise<ManagedTask>{
 const session=online();if(pendingMigration())throw new MigrationUncertain('已有结果未确认的迁移，请先查询原请求');
 if(!review.convertible||!review.center_ready||review.issues.length||!hash.test(review.review)||review.account_id!==selection.account_id||review.task_id!==selection.task_id)throw new Error('请先重新检查并解决迁移阻止原因');
 remember(requestID);
 try{
  const out=await hostRequest<{task:ManagedTask;execution_authority:false}>('/api/v1/migrations/commit',{method:'POST',body:JSON.stringify({selection,request_id:requestID,expected_review:review.review}),signal:AbortSignal.timeout(110000)});unchanged(session);
  if(out.execution_authority!==false||out.task?.id!==selection.task_id.split(':')[1])throw new Error('迁移响应无效');remember(null);return out.task;
 }catch(error){
  unchanged(session);const code=(error as {code?:string}).code;
  if(['migration_stage_rejected','migration_observation_required','center_migration_upgrade_required','invalid_json'].includes(code||'')){remember(null);throw error;}
  throw new MigrationUncertain('迁移结果未确认，已保留原请求。请只查询结果，不要重新提交。');
 }
}
export async function resolveMigration(requestID:string){
 const session=online();const out=await hostRequest<{task:ManagedTask;execution_authority:false}>('/api/v1/migration-requests/'+requestID);unchanged(session);
 if(out.execution_authority!==false||!out.task?.id)throw new Error('迁移结果尚未确认');remember(null);return out.task;
}

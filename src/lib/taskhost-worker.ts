import {invoke,isTauri} from '@tauri-apps/api/core';
import {hostSession} from './taskhost-client';

const DATA_CODES=new Set(['','okx_direct_unavailable','reader_closed','read_not_allowed','data_unavailable','authentication_failed','identity_changed','invalid_response','request_rejected','data_settings_unavailable','data_configuration_invalid']);
const PROCESS_STATES=new Set(['starting','observing','waiting_owner','reconciling','running','paused','stopped','blocked','failed']);
const PROCESS_ERRORS=new Set(['','bootstrap_invalid','center_unavailable','identity_changed','database_unavailable','existing_tasks_unavailable','runtime_blocked','shutdown_incomplete','internal_error']);
export interface LocalGoProcessStatus {state:string;event:string;checkpoint_seq:string;error_code:string;data_source:'direct'|'collection'|'none';data_code:string;data_observed_at?:string;data_stale:boolean}
export interface LocalGoWorkerStatus {installed:boolean;configured:boolean;exited?:boolean;active?:boolean;busy?:boolean;generation?:string;active_elsewhere?:boolean;execution_authority:false;status?:LocalGoProcessStatus}
export function parseLocalGoWorkerStatus(value:unknown,account:string):LocalGoWorkerStatus {
 const raw=value as Record<string,unknown>;
 if(!raw||raw.execution_authority!==false||typeof raw.installed!=='boolean'||typeof raw.configured!=='boolean'||typeof raw.generation!=='string'||!/^(?:0|[1-9]\d{0,18})$/.test(raw.generation)||BigInt(raw.generation)>9223372036854775807n)throw new Error('本机执行器状态未确认');
 const out:LocalGoWorkerStatus={installed:raw.installed,configured:raw.configured,generation:raw.generation,execution_authority:false};
 for(const key of ['exited','active','busy','active_elsewhere'] as const){if(raw[key]!==undefined){if(typeof raw[key]!=='boolean')throw new Error('本机执行器状态未确认');out[key]=raw[key]}}
 if(raw.status!==undefined){
  const s=raw.status as Record<string,unknown>;
  if(!s||typeof s.state!=='string'||!PROCESS_STATES.has(s.state)||typeof s.event!=='string'||!['ready','status','stopped','failed'].includes(s.event)||typeof s.checkpoint_seq!=='string'||!/^(?:0|[1-9]\d{0,18})$/.test(s.checkpoint_seq)||BigInt(s.checkpoint_seq)>9223372036854775807n||typeof s.error_code!=='string'||!PROCESS_ERRORS.has(s.error_code)||(s.account_id!==undefined&&s.account_id!==account))throw new Error('本机执行器状态未确认');
  const source=s.data_source??'none',code=s.data_code??'',observed=s.data_observed_at;
  if(!['direct','collection','none'].includes(String(source))||typeof code!=='string'||!DATA_CODES.has(code)||(s.data_stale!==undefined&&typeof s.data_stale!=='boolean')||(observed!==undefined&&(typeof observed!=='string'||observed.length>40||!Number.isFinite(Date.parse(observed)))))throw new Error('本机数据状态未确认');
  const observation=typeof observed==='string'?Date.parse(observed):NaN,age=Date.now()-observation,recent=Number.isFinite(observation)&&observation>=946684800000&&age>=-10000&&age<=60000;
  out.status={state:s.state,event:s.event,checkpoint_seq:s.checkpoint_seq,error_code:s.error_code,data_source:source as LocalGoProcessStatus['data_source'],data_code:code,...(typeof observed==='string'?{data_observed_at:observed}:{}),data_stale:s.data_stale!==false||s.event!=='status'||!recent||source==='none'||Boolean(code&&code!=='okx_direct_unavailable')};
 }
 return out;
}
export function localGoDataNotice(status:LocalGoProcessStatus|undefined):string {
 if(!status)return '';
 const codes:Record<string,string>={okx_direct_unavailable:'OKX 直连暂不可用，当前通过 API Collection 读取数据。可核对数据 Key 或同步当前本地 Key。',data_unavailable:'无法连接 OKX 数据。可配置 / 购买 API Collection Key，或同步当前本地 Key。',authentication_failed:'OKX 凭证校验失败，请核对 API Key、Secret、Passphrase 和读取权限。',identity_changed:'OKX 账户身份发生变化，已阻止使用原账户数据，请核对绑定。',invalid_response:'OKX 返回的数据不完整，当前持仓与账户状态尚未确认。',data_settings_unavailable:'本机数据配置暂不可读取，请核对加密配置与存储权限。',data_configuration_invalid:'本机数据配置无效，请核对并重新保存当前账户配置。',reader_closed:'执行器数据连接已关闭，当前账户数据尚未确认。',read_not_allowed:'执行器的数据读取请求未通过校验，请核对版本和配置。',request_rejected:'OKX 数据请求未被接受，请核对读取权限和配置。'};
 return codes[status.data_code]||'';
}

/** One explicit native maintenance request; it never creates or resumes a task. */
export async function prepareLocalWorker(accountID:string,action:'prepare-delete'|'prepare-resume'|'confirm-flat'){
 const session=hostSession(),scope=session?.mode==='standalone'?session.scope:session?.centerScope;
 if(!isTauri()||!scope||!/^[a-f0-9]{64}$/.test(accountID))throw new Error('请先在本机绑定同一中心身份并启动 Go 观察进程');
 const args={scope,accountId:accountID,input:null,allowTrading:false};
 const status=await invoke<{generation:string;execution_authority:false;active?:boolean;exited?:boolean;active_elsewhere?:boolean}>('taskhost_go_worker',{...args,action:'status',expectedGeneration:null});
 if(hostSession()!==session)throw new Error('会话已变化');
 if(status.execution_authority!==false||!status.active||status.exited||status.active_elsewhere||!/^\d{1,19}$/.test(status.generation))throw new Error('请先在本机启动该账户的 Go 观察进程');
 const result=await invoke<{state:string;epoch?:string;refresh_required:true;execution_authority:false}>('taskhost_go_worker',{...args,action,expectedGeneration:status.generation});
 if(hostSession()!==session)throw new Error('会话已变化');
 const expected={"prepare-delete":"delete_ready","prepare-resume":"preparing","confirm-flat":"recovery_confirmed"}[action];
 if(result.execution_authority!==false||result.refresh_required!==true||result.state!==expected)throw new Error('本机准备结果未确认');return result;
}

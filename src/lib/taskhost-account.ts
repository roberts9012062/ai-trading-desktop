import {hostRequest,hostSession,type HostCredential} from './taskhost-client'

export interface VerifiedAccountInfo {
  credential_id:string
  account_id:string
  key_fingerprint:string
  demo:boolean
  revision:string
  verified_at:string
}
type SelectedCredential=Pick<HostCredential,'id'|'venue'|'demo'>
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const digest=/^[a-f0-9]{64}$/
function input(credential:SelectedCredential){
  if(!uuid.test(credential.id))throw new Error('服务器凭证编号无效')
  if(credential.venue!=='okx')throw new Error('当前仅支持 OKX 账户验证')
  if(typeof credential.demo!=='boolean')throw new Error('服务器凭证盘别无效')
}
function parse(body:Record<string,unknown>,credential:SelectedCredential):VerifiedAccountInfo{
  if(body.execution_authority!==false||body.registration_enabled!==false)throw new Error('账户身份不能代表执行权，服务器验证响应无效')
  const info=body.account as Partial<VerifiedAccountInfo>|undefined
  if(!info||info.credential_id!==credential.id||typeof info.account_id!=='string'||!digest.test(info.account_id)
    ||typeof info.key_fingerprint!=='string'||!digest.test(info.key_fingerprint)||typeof info.demo!=='boolean'||info.demo!==credential.demo
    ||typeof info.revision!=='string'||!/^[1-9]\d{0,18}$/.test(info.revision)||BigInt(info.revision)>9223372036854775807n
    ||typeof info.verified_at!=='string'||!Number.isFinite(Date.parse(info.verified_at)))throw new Error('服务器账户验证元数据无效，请重新核对')
  return {credential_id:info.credential_id,account_id:info.account_id,key_fingerprint:info.key_fingerprint,demo:info.demo,revision:info.revision,verified_at:info.verified_at}
}
/** Explicit account-config read via the authenticated server; never retried. */
export async function verifyHostedAccount(credential:SelectedCredential):Promise<VerifiedAccountInfo>{
  input(credential)
  return parse(await hostRequest<Record<string,unknown>>(`/api/v1/credentials/${credential.id}/verify-account`,{method:'POST',body:'{}'}),credential)
}
/** Reads only the server's matching stored identity, without contacting the center. */
export async function readVerifiedAccount(credential:SelectedCredential):Promise<VerifiedAccountInfo>{
  input(credential)
  return parse(await hostRequest<Record<string,unknown>>(`/api/v1/credentials/${credential.id}/verified-account`),credential)
}

export interface HostedRecovery {account_id:string;epoch:string;recovery_required:boolean;unresolved_commands:boolean;owner_active:boolean;execution_authority:false}
export async function readHostedRecovery(credential:SelectedCredential):Promise<HostedRecovery>{
 input(credential);const out=await hostRequest<HostedRecovery>(`/api/v1/credentials/${credential.id}/recovery-state`);
 if(out.execution_authority!==false||!digest.test(out.account_id)||!/^\d{1,19}$/.test(out.epoch)||BigInt(out.epoch)>9223372036854775807n||typeof out.recovery_required!=='boolean'||typeof out.unresolved_commands!=='boolean'||typeof out.owner_active!=='boolean')throw new Error('中心恢复状态无效');return out;
}
export async function confirmHostedFlat(credential:SelectedCredential,state:HostedRecovery){
 input(credential);const session=hostSession();if(session?.mode!=='server'||!state.recovery_required||state.unresolved_commands||state.owner_active)throw new Error('请先刷新并核对恢复状态');
 const out=await hostRequest<{confirmed:true;account_id:string;execution_authority:false;tasks_resumed:false}>(`/api/v1/credentials/${credential.id}/confirm-flat`,{method:'POST',body:JSON.stringify({expected_epoch:state.epoch}),signal:AbortSignal.timeout(110000)});
 if(hostSession()!==session||out.confirmed!==true||out.account_id!==state.account_id||out.execution_authority!==false||out.tasks_resumed!==false)throw new Error('空仓恢复结果未确认');return out;
}

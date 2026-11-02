import {hostRequest,type HostCredential} from './taskhost-client'

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

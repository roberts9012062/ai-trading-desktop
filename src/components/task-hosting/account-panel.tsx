import type {HostCredential} from '@/lib/taskhost-client'
import {hostSession} from '@/lib/taskhost-client'
import type {VerifiedAccountInfo} from '@/lib/taskhost-account'
import {readHostedRecovery,confirmHostedFlat,type HostedRecovery} from '@/lib/taskhost-account'
import {useState} from 'react'

interface Props {credential:HostCredential;available:boolean;busy:boolean;info?:VerifiedAccountInfo;onVerify:()=>void;onRead:()=>void}
export function AccountPanel({credential,available,busy,info,onVerify,onRead}:Props){
  const session=hostSession(),[recovery,setRecovery]=useState<HostedRecovery|null>(null),[recoverBusy,setRecoverBusy]=useState(false),[flat,setFlat]=useState(false),[message,setMessage]=useState('')
  async function recoveryAction(confirm=false){setRecoverBusy(true);setMessage('');try{if(confirm&&recovery){await confirmHostedFlat(credential,recovery);if(hostSession()===session){setRecovery(null);setFlat(false);setMessage('中心已确认空仓恢复，任务仍保持停止。请重新核对后再单独恢复任务。')}}else{const state=await readHostedRecovery(credential);if(hostSession()===session){setRecovery(state);setFlat(false)}}}catch(error){if(hostSession()===session)setMessage(error instanceof Error?error.message:'恢复未确认，请刷新核对')}finally{if(hostSession()===session)setRecoverBusy(false)}}
  const supported=credential.venue==='okx'
  const button='rounded border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-40'
  return <section className="my-4 border-b border-[var(--border)] pb-4" aria-label="中心账户验证">
    <p className="text-sm">{credential.venue} · {credential.api_key_masked} · {credential.demo?'模拟':'实盘'}</p>
    <div className="mt-3 flex flex-wrap gap-3">
      <button className={button} disabled={busy||!available||!supported} onClick={onVerify}>验证中心账户</button>
      <button className={button} disabled={busy||!available||!supported} onClick={onRead}>读取已存验证</button>
    </div>
    {info?<div className="mt-3 text-xs text-[var(--text-secondary)]">
      <p className="font-mono break-all">账户 {info.account_id}</p>
      <p>验证版本 {info.revision} · {new Date(info.verified_at).toLocaleString('zh-CN')}</p>
      <p className="mt-2">这是已存身份记录，未注册任务、未取得执行权，也不代表当前交易权限。</p>
    </div>:<p className="mt-3 text-xs text-[var(--text-muted)]">{!supported?'此交易所尚未接入中心账户验证。':!available?'请更新 Go 服务至 v0.1.6 或以上，以使用账户验证。':'请先绑定中心 Key；验证只读取账户配置并核对中心身份，不会下单。'}</p>}
    {info&&<details className="mt-3 text-sm"><summary>故障后的空仓恢复</summary><p className="my-2 text-xs text-[var(--text-muted)]">只核对真实空仓和全部挂单，解除中心恢复锁；不会自动平仓或恢复任务。</p><button className={button} disabled={busy||recoverBusy} onClick={()=>void recoveryAction()}>读取中心恢复状态</button>{recovery&&<div className="mt-2"><p>{recovery.recovery_required?'需要空仓恢复':'未触发恢复锁'}{recovery.unresolved_commands?' · 有未决交易':''}{recovery.owner_active?' · 执行者仍在线':''}</p><label className="my-2 flex gap-2"><input type="checkbox" checked={flat} onChange={e=>setFlat(e.target.checked)} disabled={recoverBusy}/>我已核对该账户全平、全部挂单已清理</label><button className={button} disabled={busy||recoverBusy||!flat||!recovery.recovery_required||recovery.owner_active||recovery.unresolved_commands} onClick={()=>void recoveryAction(true)}>读取全部状态并解除恢复锁</button></div>}{message&&<p role="status" className="mt-2 break-all">{message}</p>}</details>}
  </section>
}

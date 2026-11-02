import type {HostCredential} from '@/lib/taskhost-client'
import type {VerifiedAccountInfo} from '@/lib/taskhost-account'

interface Props {credential:HostCredential;available:boolean;busy:boolean;info?:VerifiedAccountInfo;onVerify:()=>void;onRead:()=>void}
export function AccountPanel({credential,available,busy,info,onVerify,onRead}:Props){
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
  </section>
}

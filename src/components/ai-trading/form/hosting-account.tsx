import {useEffect,useState,useSyncExternalStore} from 'react'
import {hostSession,onHostSessionChange,hostRequest,type HostCredential} from '@/lib/taskhost-client'
import {pendingManagedRequest,clearPendingManagedRequest,type ManagedTask} from '@/lib/taskhost-managed'
import {notifyHostedCreation} from '@/lib/taskhost-original-create'

/** Reuse the original task form; this selects its explicit server-owned account. */
export function HostingAccount({open,value,onChange}:{open:boolean;value:string;onChange:(id:string)=>void}){
 const session=useSyncExternalStore(onHostSessionChange,hostSession,hostSession)
 const [accounts,setAccounts]=useState<HostCredential[]>([]),[error,setError]=useState(''),[pending,setPending]=useState(''),[querying,setQuerying]=useState(false)
 useEffect(()=>{
   if(!open)return
   let disposed=false;setAccounts([]);setError('');onChange('');setPending(pendingManagedRequest()||'')
   if(session?.mode==='server')void hostRequest<{credentials:HostCredential[]}>('/api/v1/credentials').then(out=>{if(disposed||hostSession()!==session)return;const list=out.credentials.filter(a=>a.venue==='okx');setAccounts(list);if(list.length===1)onChange(list[0].id)}).catch(()=>{if(!disposed&&hostSession()===session)setError('服务器账户读取失败，请先核对连接和本地配置同步')})
   const changed=()=>setPending(pendingManagedRequest()||'')
   window.addEventListener('taskhost-create-pending',changed)
   return()=>{disposed=true;window.removeEventListener('taskhost-create-pending',changed)}
 },[open,session,onChange])
 if(!session)return null
 if(session.mode==='standalone')return <p role="alert" className="rounded border border-amber-500/30 p-2 text-xs text-amber-400">单机模式可浏览与操作已有托管任务；新建任务必须先连接服务器。</p>
 async function reconcile(){
   setQuerying(true);setError('')
   try{const out=await hostRequest<{task:ManagedTask;execution_authority:false}>('/api/v1/managed-task-requests/'+pending);if(hostSession()!==session)return;if(out.execution_authority!==false||!out.task?.id)throw new Error();clearPendingManagedRequest();setPending('');notifyHostedCreation('已找到原创建请求的服务器任务。请核对任务状态，开始操作需另外明确执行。')}
   catch{if(hostSession()===session)setError('原创建结果仍未确认，请继续核对，不会重复创建任务')}
   finally{setQuerying(false)}
 }
 return <div className="space-y-2 rounded border border-[var(--border)] p-2 text-xs">
   <label className="block">服务器交易账户<select aria-label="服务器交易账户" value={value} onChange={e=>onChange(e.target.value)} className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] p-2"><option value="">请选择服务器上的账户</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.label||a.api_key_masked} · {a.demo?'模拟盘':'实盘'}</option>)}</select></label>
   <p className="text-[var(--text-muted)]">沿用当前创建参数，提交时会核对所选账户身份，再由服务器创建并同步托管；执行状态以服务器与中心核验结果为准。</p>
   {pending&&<div role="status" className="text-amber-400">上次创建结果待确认，已禁止重复提交。<button type="button" disabled={querying} className="ml-2 underline" onClick={()=>void reconcile()}>查询原创建结果</button></div>}
   {error&&<p role="alert" className="text-amber-400">{error}</p>}
 </div>
}

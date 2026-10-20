import {useEffect,useRef,useState,useSyncExternalStore} from 'react'
import {Button} from '@/components/ui/button'
import {Card,CardContent} from '@/components/ui/card'
import {nativeCollection} from '@/lib/collection-config'
import {executionStatus,onExecutionChange,executionAction,executionStateLabel} from '@/lib/execution-runtime'
import {useAuthStore} from '@/stores/auth'

export function ExecutionPanel(){
  const state=useSyncExternalStore(onExecutionChange,executionStatus,executionStatus)
  const owner=useAuthStore(auth=>`${auth.user?.id||''}:${auth.user?.trading_mode||''}`)
  const live=useAuthStore(auth=>auth.loaded&&auth.user?.trading_mode==='live')
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('')
  const currentOwner=useRef(owner);currentOwner.current=owner
  useEffect(()=>{setBusy(false);setMessage('')},[owner])
  if(!nativeCollection())return null
  const action=async(value:'prepare'|'start'|'stop'|'stop-account')=>{
    const active=()=>currentOwner.current===owner
    setBusy(true);setMessage('')
    try{const result=await executionAction(value);if(active())setMessage(result?.message||(value==='prepare'?'服务器任务准备数据已加密保存。':value==='start'?'已请求启动，请以执行状态为准。':'本机进程已退出，请以账户接管状态为准。'))}
    catch(error){if(active())setMessage(error instanceof Error?error.message:'执行器操作失败')}
    finally{if(active())setBusy(false)}
  }
  return <Card><CardContent className="p-5 space-y-3">
    <div className="flex items-center justify-between gap-3"><h3 className="font-medium">本机任务接管</h3><span className="text-xs text-[var(--text-secondary)]">{executionStateLabel(state.worker.state)}</span></div>
    <p className="text-sm leading-6 text-[var(--text-muted)]">任务必须由服务器登录创建和授权。同步准备数据后，本机通过 API VALUE COLLECTION 校验执行权；收起到托盘可继续运行，退出或更新会先保存状态并交接。</p>
    {!state.runtime_installed&&<p className="text-sm text-[var(--text-secondary)]">本版本尚未安装独立执行器，当前不能启用本机自动接管。</p>}
    <div className="flex gap-2 flex-wrap">
      <Button variant="outline" disabled={busy} onClick={()=>void action('prepare')}>同步任务准备</Button>
      <Button disabled={busy||!state.prepared||!state.runtime_installed} onClick={()=>void action('start')}>启用本机接管</Button>
      <Button variant="outline" disabled={busy||!state.prepared} onClick={()=>void action('stop')}>停止本机执行器</Button>
      <Button variant="outline" className="text-red-300 border-red-400/30" disabled={busy||!live} onClick={()=>void action('stop-account')}>停止 OKX 账户任务（不平仓）</Button>
    </div>
    {(busy||message||state.error)&&<p role="status" className="text-sm leading-6 text-[var(--text-secondary)] break-words">{busy?'正在处理，请等待状态确认…':message||state.error}</p>}
    <p className="text-xs leading-6 text-[var(--text-muted)]">服务器与客户端都停止且没有可用的常驻备用执行器时，任务会停止并锁定。重新打开客户端或同步不会恢复旧任务；需手动平仓、确认账户后，再通过服务器手动启动。</p>
    <p className="text-xs leading-6 text-[var(--text-muted)]">账户停止直接请求 API VALUE COLLECTION，服务器断链时也可使用，作用于本机已同步的 OKX 账户全部自动任务。该操作不会撤单或平仓；已有交易结果须先核对，恢复仍需确认账户清空并通过服务器手动启动。</p>
  </CardContent></Card>
}

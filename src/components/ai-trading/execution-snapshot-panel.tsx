import {useEffect,useRef,useState,useSyncExternalStore} from 'react'
import {Button} from '@/components/ui/button'
import {useAuthStore} from '@/stores/auth'
import {collectionScope,collectionGeneration,collectionStatus,onCollectionChange,nativeCollection} from '@/lib/collection-config'
import {localExchangeGeneration} from '@/lib/local-desktop'
import {executionStatus,onExecutionChange,executionStateLabel,readExecutionSnapshot,type ExecutionSnapshot} from '@/lib/execution-runtime'

const subscribeAccount=(callback:()=>void)=>{window.addEventListener('local-exchange-changed',callback);return()=>window.removeEventListener('local-exchange-changed',callback)}
const recordedLabels:Record<string,string>={running:'记录为运行',paused:'记录为暂停',stopped:'记录为停止'}

/** A projection cannot start/edit tasks, or turn a stale SQL row into ownership. */
export function ExecutionSnapshotPanel(){
  const user=useAuthStore(state=>state.user)
  const authReady=useAuthStore(state=>state.loaded)
  const config=useSyncExternalStore(onCollectionChange,collectionStatus,collectionStatus)
  const account=useSyncExternalStore(subscribeAccount,localExchangeGeneration,localExchangeGeneration)
  const runtime=useSyncExternalStore(onExecutionChange,executionStatus,executionStatus)
  const enabled=nativeCollection()&&config.configured&&authReady&&user?.trading_mode==='live'
  const owner=`${collectionScope()}:${user?.id||''}:${account}:${collectionGeneration()}`
  const [loaded,setLoaded]=useState<{owner:string;snapshot:ExecutionSnapshot}|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false)
  const snapshot=loaded?.owner===owner?loaded.snapshot:null
  const refresh=useRef<(()=>void)|null>(null)
  useEffect(()=>{
    setLoaded(null);setError('');setLoading(false)
    if(!enabled){refresh.current=null;return}
    let active=true,busy=false
    const load=()=>{
      if(busy)return;busy=true;setLoading(true)
      void readExecutionSnapshot().then(next=>{if(active){setLoaded({owner,snapshot:next});setError('')}}).catch(reason=>{
        if(active){setLoaded(null);setError(reason instanceof Error?reason.message:'本机任务记录暂不可读')}
      }).finally(()=>{busy=false;if(active)setLoading(false)})
    }
    refresh.current=load;load()
    const timer=setInterval(load,5000)
    return()=>{active=false;refresh.current=null;clearInterval(timer)}
  },[enabled,owner])
  if(!enabled)return null
  return <section aria-label="本机任务记录" className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-4 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-sm font-medium text-[var(--text-primary)]">本机任务记录</h2><p className="mt-1 text-xs text-[var(--text-muted)]">{executionStateLabel(runtime.worker.state)}</p></div>
      <Button size="sm" variant="outline" disabled={loading} onClick={()=>refresh.current?.()}>刷新本机记录</Button>
    </div>
    <p className="text-xs leading-5 text-[var(--text-muted)]">读取本地 SQL，服务器断开后仍可查看。以下为最近提交的任务记录；实际执行以账户执行权和交易所结果为准，创建、修改和重新启动仍需服务器登录。</p>
    {error?<p role="status" className="text-xs text-amber-400">{error}</p>:!snapshot?<p role="status" className="text-xs text-[var(--text-secondary)]">正在读取本机记录…</p>:!snapshot.available?<p className="text-xs text-[var(--text-secondary)]">尚无本机任务快照。请在个人页面同步任务准备数据，并完成首次恢复。</p>:<>
      <div className="flex flex-wrap gap-3 text-xs text-[var(--text-secondary)]"><span>本机记录 {snapshot.tasks.length} 个</span><span>已确认检查点 {snapshot.checkpoint_seq}</span>{snapshot.pending_checkpoint&&<span className="text-amber-400">有待确认的检查点</span>}</div>
      {snapshot.tasks.length?<div className="max-h-64 overflow-auto"><table className="w-full text-left text-xs"><thead className="text-[var(--text-muted)]"><tr><th className="py-2 font-normal">任务</th><th className="py-2 font-normal">品种 / 周期</th><th className="py-2 font-normal">记录状态</th><th className="py-2 font-normal">最近评估（UTC）</th></tr></thead><tbody>{snapshot.tasks.map(task=><tr key={task.id} className="border-t border-white/5"><td className="py-2 pr-3 max-w-48 truncate" title={task.name}>{task.name||'未命名任务'}</td><td className="py-2 pr-3 whitespace-nowrap">{task.symbol.toUpperCase()} / {task.timeframe}</td><td className="py-2 pr-3 whitespace-nowrap">{recordedLabels[task.recorded_status]||'状态待确认'}</td><td className="py-2 whitespace-nowrap text-[var(--text-muted)]">{task.last_run_at?.replace('T',' ').replace(/\.\d+$/,'')||'尚无评估记录'}</td></tr>)}</tbody></table></div>:<p className="text-xs text-[var(--text-secondary)]">当前快照没有可显示的任务。</p>}
      {snapshot.truncated&&<p className="text-xs text-amber-400">仅显示最近更新的 500 个任务。</p>}
    </>}
  </section>
}

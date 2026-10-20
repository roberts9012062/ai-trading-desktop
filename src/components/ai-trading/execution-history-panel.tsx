import {useEffect,useState} from 'react'
import {Button} from '@/components/ui/button'
import {readExecutionHistory,type ExecutionHistory,type ExecutionHistoryKind} from '@/lib/execution-runtime'

const kinds:{key:ExecutionHistoryKind;label:string}[]=[{key:'decisions',label:'决策记录'},{key:'logs',label:'运行日志'},{key:'equity',label:'权益记录'}]
const actions:Record<string,string>={hold:'观望',open_long:'开多',open_short:'开空',close:'平仓',close_long:'平多',close_short:'平空',error:'异常'}

/** Unmounted on account/task changes; this panel never calls business HTTP. */
export function ExecutionHistoryPanel({taskId,name,onClose}:{taskId:string;name:string;onClose:()=>void}){
  const [kind,setKind]=useState<ExecutionHistoryKind>('decisions'),[offset,setOffset]=useState(0)
  const query=`${taskId}:${kind}:${offset}`
  const [loaded,setLoaded]=useState<{query:string;page:ExecutionHistory}|null>(null)
  const [error,setError]=useState<{query:string;message:string}|null>(null)
  const page=loaded?.query===query?loaded.page:null
  const issue=error?.query===query?error.message:''
  useEffect(()=>{
    let active=true
    setError(null)
    void readExecutionHistory(taskId,kind,offset).then(page=>{if(active)setLoaded({query,page})}).catch(reason=>{
      if(active)setError({query,message:reason instanceof Error?reason.message:'本机任务历史暂不可读'})
    })
    return()=>{active=false}
  },[taskId,kind,offset,query])
  return <section aria-label="本机任务历史" className="rounded-md border border-[var(--border)] p-3 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="min-w-0 break-all text-sm">{name||'未命名任务'} · 本机历史</h3><Button size="sm" variant="ghost" onClick={onClose}>关闭历史</Button></div>
    <div className="flex flex-wrap gap-2">{kinds.map(item=><Button key={item.key} size="sm" variant={kind===item.key?'default':'outline'} onClick={()=>{setKind(item.key);setOffset(0)}}>{item.label}</Button>)}</div>
    <p className="text-xs leading-5 text-[var(--text-muted)]">本地已保存的记录，时间按 UTC 显示。断链期间可能尚未同步完整；记录动作不代表交易所已成交。</p>
    {issue?<p role="status" className="break-words text-xs text-amber-400">{issue}</p>:!page?<p role="status" className="text-xs text-[var(--text-secondary)]">正在读取本机历史…</p>:page.records.length?<ol className="max-h-80 overflow-auto space-y-2">{page.records.map(record=><li key={record.id} className="rounded bg-white/[0.025] p-2 text-xs space-y-1">
      <p className="text-[var(--text-muted)]">{(record.created_at||record.ts||'时间未记录').replace('T',' ')}</p>
      {kind==='equity'?<p>权益 {record.equity??'—'} · 已实现 {record.realized_pnl??'—'} · 未实现 {record.unrealized_pnl??'—'}</p>:<><p>{actions[record.action||'']||record.action||record.event||record.trigger_type||'记录'}</p><p className="whitespace-pre-wrap break-words text-[var(--text-secondary)]">{record.reason||'未记录说明'}</p></>}
    </li>)}</ol>:<p className="text-xs text-[var(--text-secondary)]">本机尚无此类记录，请以最近同步状态为准。</p>}
    <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-50))}>上一页</Button><span className="text-xs text-[var(--text-muted)]">第 {offset/50+1} 页</span><Button size="sm" variant="outline" disabled={!page?.has_more||offset>=10000} onClick={()=>setOffset(offset+50)}>下一页</Button></div>
  </section>
}
